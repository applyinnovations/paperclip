import { randomBytes } from "node:crypto";
import { definePlugin, readEnvironmentCreationCleanupError, type PluginContext } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentTerminationReceipt,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentInspectLeaseParams,
  PluginEnvironmentLease,
  PluginEnvironmentLeaseObservation,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginEnvironmentSyncResult,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import {
  kubernetesProviderConfigSchema,
  type KubernetesProviderConfig,
  type KubernetesLeaseMetadata,
} from "./types.js";
import { createKubeConfig, makeKubeClients } from "./kube-client.js";
import { getAdapterDefaults, buildAdapterEnv, resolveRunAdapterType } from "./adapter-defaults.js";
import { resolveImage } from "./image-allowlist.js";
import { buildJobManifest } from "./pod-spec-builder.js";
import { buildSandboxCrManifest, resolveSandboxShutdownMs } from "./sandbox-cr-builder.js";
import { ensureTenant } from "./tenant-orchestrator.js";
import { createPerRunSecret } from "./secret-manager.js";
import { FastUploadInterceptor } from "./upload-interceptor.js";
import { jobOrchestrator, JobTimeoutError } from "./job-orchestrator.js";
import {
  sandboxCrOrchestrator,
  SandboxCrTimeoutError,
} from "./sandbox-cr-orchestrator.js";
import { execInPod, execInPodStreaming, openPodPty, wrapCommandWithEnv } from "./pod-exec.js";
import { openKubernetesLoginPtySession, type LoginPodExec } from "./login-pty.js";
import { createLoginPtySessions, type LoginLeaseTarget } from "./login-pty-sessions.js";
import { performSyncIn, performSyncOut, type PodStreamExec } from "./file-sync.js";
import { checkLeaseResumable, confirmLeaseResourcesGone, destroyLeaseResources, isKubeNotFoundError } from "./lease-lifecycle.js";
import { ACQUIRE_RELEASE_RESERVE_MS, parseAcquireDeadline, SandboxAcquireDeadlineError } from "./acquire-deadline.js";
import { createQuotaGate, sandboxQuotaDemand } from "./quota.js";
import { assertCreationCleanupOwnership, createAttemptLabels, inspectCreation } from "./creation-recovery.js";
import {
  appendNetworkEgressDenyHint,
  createScopedNetworkEgressPolicyOrReleaseWorkload,
  NETWORK_EGRESS_GRANT_PATH,
  parseScopedNetworkEgressGrant,
} from "./scoped-network-egress.js";
import {
  deriveCompanySlug,
  deriveNamespaceName,
  newRunUlidDns,
  paperclipLabels,
} from "./utils.js";

// The namespace paperclip-server itself runs in. Used when building
// NetworkPolicy manifests so the tenant namespace allows inbound traffic
// from the server pod.
const PAPERCLIP_SERVER_NAMESPACE = "paperclip";

// Name of the ServiceAccount created inside each tenant namespace by ensureTenant.
const TENANT_SERVICE_ACCOUNT = "paperclip-tenant-sa";

// Resource quota defaults applied to every tenant namespace (tunable via
// config in a future iteration).
const DEFAULT_RESOURCE_QUOTA = {
  pods: "20",
  requestsCpu: "10",
  requestsMemory: "20Gi",
  limitsCpu: "20",
  limitsMemory: "40Gi",
};

function deriveTenantNamespace(config: KubernetesProviderConfig, companyId: string): string {
  // TODO: future versions could thread companyName through AcquireLeaseParams
  // to get a friendlier slug (e.g. "acme-corp") instead of the UUID-derived one.
  const slug = config.companySlug ?? deriveCompanySlug(companyId);
  return deriveNamespaceName(config.namespacePrefix, slug);
}

function generateBootstrapToken(): string {
  // TODO: tighten once the agent runtime shim (companion images PR) lands its
  // callback auth scheme; paperclip-server's callback auth is out of scope for
  // this plugin. For now this per-run random token is stored in the per-run
  // Secret and read by the runtime image entrypoint for initial registration.
  return randomBytes(32).toString("hex");
}

// One FastUploadInterceptor instance per active lease. Scoping per lease
// prevents `releaseLease` from wiping in-flight upload buffers belonging to
// other concurrent leases — a single shared singleton would do exactly that
// on `reset()`. The Map is keyed by `providerLeaseId`; entries are lazily
// created in `onEnvironmentExecute` and removed in `onEnvironmentReleaseLease`.
const uploadInterceptorsByLease = new Map<string, FastUploadInterceptor>();

function getOrCreateUploadInterceptor(leaseId: string): FastUploadInterceptor {
  let interceptor = uploadInterceptorsByLease.get(leaseId);
  if (!interceptor) {
    interceptor = new FastUploadInterceptor();
    uploadInterceptorsByLease.set(leaseId, interceptor);
  }
  return interceptor;
}

// In-memory cache of sandbox CR names we've already observed reaching the
// Ready condition during the current plugin-worker lifetime. The k8s
// sandbox-cr lifecycle means once a Sandbox pod is Running, subsequent
// execs into it don't need another readiness poll — saves one
// `getNamespacedCustomObject` round-trip per exec, which adds up across
// dozens of sequential exec calls in a typical adapter workflow.
// On worker restart this resets, which is fine: the first exec on each
// lease then re-confirms readiness from scratch.
const readySandboxesByLease = new Set<string>();

// How long onEnvironmentResumeLease waits for an existing Sandbox pod to
// report Ready before declaring the lease non-resumable. Deliberately short:
// this is a liveness check on an already-provisioned pod, not a fresh
// provision — if the pod isn't (almost) up, falling back to acquireLease is
// faster and more reliable than waiting.
const RESUME_READY_TIMEOUT_MS = 30_000;
const RESUME_READY_POLL_MS = 1_000;

// The workspace remote dir is the confinement root for native file sync. It is
// recorded on the lease metadata at realizeWorkspace time (`remoteCwd`); require
// it so a sync can never run without a concrete root to confine every sandbox
// path against.
function resolveSyncRemoteDir(lease: PluginEnvironmentLease): string {
  const remoteCwd = lease.metadata?.remoteCwd;
  if (typeof remoteCwd === "string" && remoteCwd.trim().length > 0) {
    return remoteCwd.trim();
  }
  throw new Error("Kubernetes file sync requires a workspace remote dir on the lease metadata.");
}

/**
 * Resolve the running Sandbox-CR pod for a native file-sync operation and return
 * a `PodStreamExec` bound to it, exactly like `onEnvironmentExecute` resolves its exec
 * target: parse config, derive the namespace, wait for the Sandbox pod to reach
 * Ready (cached per lease), and find the pod name. The `job` backend carries no
 * file path and is out of scope — file sync is only supported on `sandbox-cr`.
 */
async function resolveSyncPodExec(
  params:
    | PluginEnvironmentSyncInParams
    | PluginEnvironmentSyncOutParams,
): Promise<{ exec: PodStreamExec; timeoutMs: number }> {
  const { lease } = params;
  if (!lease.providerLeaseId) {
    throw new Error("Kubernetes file sync requires a provider lease ID.");
  }

  const config = kubernetesProviderConfigSchema.parse(params.config);
  const namespace =
    typeof lease.metadata?.namespace === "string"
      ? lease.metadata.namespace
      : deriveTenantNamespace(config, params.companyId);

  const leaseBackend =
    typeof lease.metadata?.backend === "string"
      ? (lease.metadata.backend as "sandbox-cr" | "job")
      : config.backend;
  if (leaseBackend !== "sandbox-cr") {
    throw new Error(
      `Kubernetes file sync is only supported on the sandbox-cr backend (lease backend: ${leaseBackend}).`,
    );
  }

  const kc = createKubeConfig({
    inCluster: config.inCluster,
    kubeconfig: config.kubeconfig,
  });
  const clients = makeKubeClients(kc);
  const timeoutMs = config.podActivityDeadlineSec * 1000;

  // Ensure the Sandbox pod is Ready (wait only the first time for this lease),
  // then resolve the pod name — mirrors the onEnvironmentExecute resolution.
  if (!readySandboxesByLease.has(lease.providerLeaseId)) {
    await sandboxCrOrchestrator.waitForCompletion(clients, namespace, lease.providerLeaseId, {
      timeoutMs,
      pollMs: 2000,
    });
    readySandboxesByLease.add(lease.providerLeaseId);
  }

  const podName =
    typeof lease.metadata?.podName === "string" && lease.metadata.podName
      ? lease.metadata.podName
      : await sandboxCrOrchestrator.findPod(clients, namespace, lease.providerLeaseId);
  if (!podName) {
    throw new Error("Kubernetes file sync could not resolve the Sandbox pod name.");
  }

  // Bind the streaming exec: raw tar bytes move over stdin/stdout straight to and
  // from a host file, so neither side buffers the whole payload. The file-sync
  // module bounds the untrusted pod's stdout with its own streamed-bytes disk
  // guard and passes the stderr cap through `io`.
  const exec: PodStreamExec = (command, io) =>
    execInPodStreaming(kc, namespace, podName, "agent", command, {
      ...io,
      timeoutMs: io.timeoutMs ?? timeoutMs,
    });
  return { exec, timeoutMs };
}

// The default working directory of a Sandbox lease: created by the agent user
// (uid 1000) inside the /workspace volume, so the agent owns its repository.
const AGENT_WORKSPACE_DIR = "/workspace/paperclip-workspace";

async function createAgentWorkspaceDir(
  config: ReturnType<typeof kubernetesProviderConfigSchema.parse>,
  companyId: string,
  lease: PluginEnvironmentRealizeWorkspaceParams["lease"],
  dir: string,
): Promise<void> {
  const namespace =
    typeof lease.metadata?.namespace === "string"
      ? lease.metadata.namespace
      : deriveTenantNamespace(config, companyId);
  const kc = createKubeConfig({ inCluster: config.inCluster, kubeconfig: config.kubeconfig });
  const clients = makeKubeClients(kc);
  const providerLeaseId = lease.providerLeaseId!;
  if (!readySandboxesByLease.has(providerLeaseId)) {
    await sandboxCrOrchestrator.waitForCompletion(clients, namespace, providerLeaseId, {
      timeoutMs: config.podStartTimeoutSec * 1000,
      pollMs: 1000,
    });
    readySandboxesByLease.add(providerLeaseId);
  }
  const podName =
    typeof lease.metadata?.podName === "string" && lease.metadata.podName
      ? lease.metadata.podName
      : await sandboxCrOrchestrator.findPod(clients, namespace, providerLeaseId);
  if (!podName) throw new Error("Kubernetes workspace setup could not resolve the Sandbox pod name.");
  const result = await execInPod(kc, namespace, podName, "agent", ["mkdir", "-p", dir], undefined, 30_000);
  if (result.exitCode !== 0) {
    throw new Error(`Kubernetes workspace setup could not create ${dir}: ${result.stderr.trim().slice(0, 500)}`);
  }
}

// How long a release or destroy waits to confirm the lease's workload and pod
// are gone. Pods get a 30 s termination grace period by default.
const TERMINATION_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * The termination receipt for a released or destroyed lease: `destroyed` once
 * its workload and pod are confirmed gone. If they are still terminating at the
 * deadline there is no receipt, and the host retries the release, which then
 * confirms. A receipt must never stand for a delete request alone.
 */
async function terminationReceiptOnceGone(
  clients: ReturnType<typeof makeKubeClients>,
  input: { namespace: string; name: string; backend: "sandbox-cr" | "job"; podName: string | null },
): Promise<PluginEnvironmentTerminationReceipt | void> {
  const gone = await confirmLeaseResourcesGone(clients, {
    ...input,
    timeoutMs: TERMINATION_CONFIRM_TIMEOUT_MS,
  });
  if (gone) return { providerLeaseId: input.name, state: "destroyed" };
}

// Login pseudo-terminals (see login-pty-sessions.ts) and the context their
// output and exit notifications go through.
const loginPtySessions = createLoginPtySessions();
let pluginContext: PluginContext | null = null;

// The host gives a login PTY open 30 s. Waiting for the pod uses most of that and
// leaves room for the session-home exec and the terminal attach.
const LOGIN_PTY_READY_TIMEOUT_MS = 20_000;
const LOGIN_PTY_HOME_EXEC_TIMEOUT_MS = 5_000;

/** Waits for the lease's Sandbox pod and binds the two execs a login needs to it. */
async function resolveLoginPodExec(target: LoginLeaseTarget): Promise<LoginPodExec> {
  const kc = createKubeConfig({
    inCluster: target.config.inCluster,
    kubeconfig: target.config.kubeconfig,
  });
  const clients = makeKubeClients(kc);
  if (!readySandboxesByLease.has(target.providerLeaseId)) {
    await sandboxCrOrchestrator.waitForCompletion(clients, target.namespace, target.providerLeaseId, {
      timeoutMs: LOGIN_PTY_READY_TIMEOUT_MS,
      pollMs: 1000,
    });
    readySandboxesByLease.add(target.providerLeaseId);
  }
  const podName =
    target.podName ??
    (await sandboxCrOrchestrator.findPod(clients, target.namespace, target.providerLeaseId));
  if (!podName) {
    throw new Error("Kubernetes login PTY could not resolve the Sandbox pod name.");
  }
  return {
    run: async (argv) => {
      const result = await execInPod(
        kc, target.namespace, podName, "agent", argv, undefined, LOGIN_PTY_HOME_EXEC_TIMEOUT_MS,
        64 * 1024, 64 * 1024,
      );
      return { exitCode: result.exitCode };
    },
    openPty: (argv) => openPodPty(kc, target.namespace, podName, "agent", argv),
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginContext = ctx;
    ctx.logger.info("Kubernetes sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Kubernetes sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((i) => i.message),
      };
    }
    const warnings: string[] = [];
    const cfg = parsed.data;
    const adapterDefaults = getAdapterDefaults(cfg.adapterType, cfg.adapters);
    const totalFqdns = [...adapterDefaults.allowFqdns, ...cfg.egressAllowFqdns];
    if (cfg.egressMode === "standard" && totalFqdns.length > 0) {
      if (cfg.egressAllowCidrs.length === 0) {
        warnings.push(
          `egressMode=standard cannot enforce FQDN-based egress rules (Kubernetes NetworkPolicy is CIDR-only). To keep the configured FQDNs reachable (${totalFqdns.join(", ")}) without operator intervention, the plugin will allow public IPv4 egress on TCP 80/443 with private/link-local/loopback/multicast ranges excluded. This is broader than exact FQDN allow-listing — switch egressMode to "cilium" (requires Cilium CNI) for precise enforcement, or set egressAllowCidrs explicitly to override the fallback.`,
        );
      } else {
        warnings.push(
          `egressMode=standard cannot enforce FQDN-based egress rules. The following FQDNs are reachable only via the operator-supplied egressAllowCidrs: ${totalFqdns.join(", ")}. Switch egressMode to "cilium" (requires Cilium CNI) for exact FQDN allow-listing.`,
        );
      }
    }
    return { ok: true, normalizedConfig: cfg as Record<string, unknown>, warnings: warnings.length > 0 ? warnings : undefined };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
    if (!parsed.success) {
      return {
        ok: false,
        summary: "Invalid Kubernetes provider configuration.",
        metadata: {
          errors: parsed.error.issues.map((i) => i.message),
        },
      };
    }
    const config = parsed.data;
    const namespace = deriveTenantNamespace(config, params.companyId);

    try {
      const kc = createKubeConfig({
        inCluster: config.inCluster,
        kubeconfig: config.kubeconfig,
      });
      const clients = makeKubeClients(kc);
      // Reachability check: list pods in the tenant namespace. If the namespace
      // doesn't exist yet this will throw a 404 which we treat as "reachable
      // but namespace not provisioned" — still a successful probe.
      try {
        await clients.core.listNamespacedPod({ namespace });
      } catch (err) {
        const code = (err as { code?: number; statusCode?: number }).code
          ?? (err as { code?: number; statusCode?: number }).statusCode;
        if (code !== 404) throw err;
        // 404 means namespace doesn't exist yet — cluster is reachable.
      }
      return {
        ok: true,
        summary: `Kubernetes cluster reachable. Tenant namespace: ${namespace}.`,
        metadata: { namespace, provider: "kubernetes" },
      };
    } catch (err) {
      return {
        ok: false,
        summary: "Kubernetes cluster probe failed.",
        metadata: {
          namespace,
          provider: "kubernetes",
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    // `adapterType` is an optional per-run hint the server may pass once the
    // SDK lease params grow that field (companion server-integration PR). The
    // plugin works without it: absent means "use the environment's configured
    // default adapter", so it stays compatible with the current SDK.
    params: PluginEnvironmentAcquireLeaseParams & {
      adapterType?: string;
      executionWorkspaceSettings?: Record<string, unknown> | null;
      // Newer hosts say whether the lease is for a run or a login.
      purpose?: "run" | "login";
      // Newer hosts say when they stop waiting for this call.
      acquireDeadlineAt?: string;
    },
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace = deriveTenantNamespace(config, params.companyId);
    // Validate the caller's deadline before anything is created in the cluster.
    const shutdown = resolveSandboxShutdownMs({
      nowMs: Date.now(),
      podActivityDeadlineSec: config.podActivityDeadlineSec,
      requestedExpiresAt: params.requestedExpiresAt,
    });

    // The adapter for THIS run is the agent's adapter (params.adapterType) when
    // supplied, so one environment can serve mixed harnesses; otherwise fall back
    // to the environment's configured default adapter. getAdapterDefaults validates
    // it is a registered adapter (throws otherwise), so a curated-out adapter fails
    // the lease as before.
    const effectiveAdapterType = resolveRunAdapterType(params.adapterType, config.adapterType);

    // Emit a runtime warning if FQDNs are configured but egressMode=standard
    // cannot enforce them. Mirrors the validateConfig warning so operators see
    // it in paperclip-server logs even if they missed the validation step.
    const adapterDefaultsForWarn = getAdapterDefaults(effectiveAdapterType, config.adapters);
    const totalFqdnsForWarn = [...adapterDefaultsForWarn.allowFqdns, ...config.egressAllowFqdns];
    if (config.egressMode === "standard" && totalFqdnsForWarn.length > 0) {
      if (config.egressAllowCidrs.length === 0) {
        console.warn(
          `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules; falling back to public-IPv4 (TCP 80/443) with private/link-local ranges excluded so the configured FQDNs (${totalFqdnsForWarn.join(", ")}) remain reachable. Switch egressMode to "cilium" for exact FQDN allow-listing.`,
        );
      } else {
        console.warn(
          `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules. The following FQDNs are reachable only via operator-supplied egressAllowCidrs: ${totalFqdnsForWarn.join(", ")}. Switch egressMode to "cilium" for exact FQDN allow-listing.`,
        );
      }
    }

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    // Ensure the tenant namespace and all its RBAC / network policy resources
    // exist before we try to create the Job.
    const adapterDefaults = getAdapterDefaults(effectiveAdapterType, config.adapters);

    await ensureTenant(clients, {
      namespace,
      companyId: params.companyId,
      paperclipServerNamespace: PAPERCLIP_SERVER_NAMESPACE,
      serviceAccountAnnotations: config.serviceAccountAnnotations,
      egressMode: config.egressMode,
      egressAllowFqdns: [...adapterDefaults.allowFqdns, ...config.egressAllowFqdns],
      egressAllowCidrs: config.egressAllowCidrs,
      resourceQuota: DEFAULT_RESOURCE_QUOTA,
    });

    const jobName = `pc-${newRunUlidDns()}`;
    const secretName = `${jobName}-env`;

    // TODO: use params.runId as stand-in for agentId in labels; future
    // versions will have a dedicated agentId on AcquireLeaseParams.
    const labels = {
      ...paperclipLabels({
        runId: params.runId,
        agentId: params.runId,
        companyId: params.companyId,
        adapterType: effectiveAdapterType,
      }),
      // The host's creation intent. If this acquire fails before the host
      // records a lease, its creation recovery finds the workload by this id.
      ...createAttemptLabels(params.creationOperationId),
    };

    const image = resolveImage(
      { imageOverride: null },
      adapterDefaults,
      { imageAllowList: config.imageAllowList, imageRegistry: config.imageRegistry },
    );

    // Pick the orchestrator and build the appropriate manifest based on backend.
    const isSandboxCrBackend = config.backend === "sandbox-cr";
    const orchestrator = isSandboxCrBackend ? sandboxCrOrchestrator : jobOrchestrator;

    const manifest = isSandboxCrBackend
      ? buildSandboxCrManifest({
          namespace,
          sandboxName: jobName,
          adapterType: effectiveAdapterType,
          image,
          envSecretName: secretName,
          serviceAccountName: TENANT_SERVICE_ACCOUNT,
          labels,
          resources: config.defaultResources ?? {},
          runtimeClassName: config.runtimeClassName,
          imagePullSecrets: config.imagePullSecrets,
          activeDeadlineSec: config.podActivityDeadlineSec,
          shutdownTime: new Date(shutdown.shutdownMs).toISOString(),
        })
      : buildJobManifest({
          namespace,
          jobName,
          adapterType: effectiveAdapterType,
          image,
          envSecretName: secretName,
          serviceAccountName: TENANT_SERVICE_ACCOUNT,
          labels,
          resources: config.defaultResources ?? {},
          runtimeClassName: config.runtimeClassName,
          activeDeadlineSec: config.podActivityDeadlineSec,
          ttlSecondsAfterFinished: config.jobTtlSecondsAfterFinished,
          imagePullSecrets: config.imagePullSecrets,
        });

    // The host discards our answer after acquireDeadlineAt. Do not create a
    // Sandbox we cannot hand out in time: nobody would ever release it.
    const acquireDeadlineMs = parseAcquireDeadline(params.acquireDeadlineAt);
    if (acquireDeadlineMs !== null && acquireDeadlineMs - Date.now() <= ACQUIRE_RELEASE_RESERVE_MS) {
      throw new SandboxAcquireDeadlineError(namespace, jobName, "before the Sandbox was created");
    }

    const { uid: ownerUid } = await orchestrator.claim(clients, namespace, manifest);
    // From here on the workload exists. Any failure deletes it before the
    // error leaves this call: a failed acquire returns no lease, so nothing
    // else would ever release it, and its pod would hold a quota slot.
    try {
      const scopedNetworkEgress = parseScopedNetworkEgressGrant(params.executionWorkspaceSettings);
      // The adapter's sign-in hosts join this run's scoped policy in cilium mode,
      // where FQDN rules are enforced (standard mode cannot enforce them; see
      // validateConfig). The sandbox-provider acquire does not say whether a lease
      // is for a login, so they apply unless the host says the lease is a run.
      const loginAllowFqdns =
        config.egressMode === "cilium" && params.purpose !== "run" ? adapterDefaults.loginAllowFqdns ?? [] : [];
      const scopedPolicyGrant = {
        allowFqdns: [...new Set([...scopedNetworkEgress.allowFqdns, ...loginAllowFqdns])],
        allowCidrs: scopedNetworkEgress.allowCidrs,
      };
      const scopedNetworkPolicyName = await createScopedNetworkEgressPolicyOrReleaseWorkload(
        {
          clients,
          namespace,
          mode: config.egressMode,
          runId: params.runId,
          workloadName: jobName,
          ownerReference: {
            apiVersion: isSandboxCrBackend ? "agents.x-k8s.io/v1beta1" : "batch/v1",
            kind: isSandboxCrBackend ? "Sandbox" : "Job",
            name: jobName,
            uid: ownerUid,
            controller: false,
            blockOwnerDeletion: false,
          },
          grant: scopedPolicyGrant,
        },
        () => orchestrator.release(clients, namespace, jobName),
      );

      // defaultEnv (non-secret base, e.g. the inference base URL) is layered first;
      // the process-env secrets named by envKeys override it.
      const adapterEnv = buildAdapterEnv(adapterDefaults);
      adapterEnv.PAPERCLIP_NETWORK_EGRESS_POLICY = "kubernetes-default-deny";
      adapterEnv.PAPERCLIP_NETWORK_EGRESS_GRANT_PATH = NETWORK_EGRESS_GRANT_PATH;
      adapterEnv.PAPERCLIP_NETWORK_EGRESS_ALLOW_FQDNS = scopedNetworkEgress.allowFqdns.join(",");
      adapterEnv.PAPERCLIP_NETWORK_EGRESS_ALLOW_CIDRS = scopedNetworkEgress.allowCidrs.join(",");
      const bootstrapToken = generateBootstrapToken();

      // Secret ownerRef: for job backend, the Job owns the Secret (cascade delete).
      // For sandbox-cr backend, the Sandbox CR owns the Secret.
      // NOTE: For sandbox-cr, if the Secret outlives the Sandbox due to a cluster
      // quirk, the release() call will still clean it up via namespace GC or
      // explicit delete in a future iteration.
      await createPerRunSecret(clients, {
        namespace,
        secretName,
        runId: params.runId,
        ownerKind: isSandboxCrBackend ? "Sandbox" : "Job",
        ownerApiVersion: isSandboxCrBackend ? "agents.x-k8s.io/v1beta1" : "batch/v1",
        ownerName: jobName,
        ownerUid,
        bootstrapToken,
        adapterEnv,
      });

      // A Sandbox lease is usable once its pod can take an exec. Wait for that
      // here, on a start-up budget of its own, so a cold image pull or slow
      // scheduling never eats the first command's timeout (a 15 s setup probe
      // lost that race on every node without the image cached). A Sandbox that
      // fails or never becomes Ready is released rather than handed out.
      //
      // The wait also ends before the host's acquire deadline, keeping enough of
      // it to delete the Sandbox. Past that deadline the host has already failed
      // the run, and a Sandbox that turned Ready then would run attached to
      // nothing.
      if (isSandboxCrBackend) {
        const startBudgetMs = config.podStartTimeoutSec * 1000;
        const deadlineBudgetMs = acquireDeadlineMs === null
          ? null
          : acquireDeadlineMs - Date.now() - ACQUIRE_RELEASE_RESERVE_MS;
        if (deadlineBudgetMs !== null && deadlineBudgetMs <= 0) {
          throw new SandboxAcquireDeadlineError(namespace, jobName, "before its pod could start");
        }
        const readyTimeoutMs = deadlineBudgetMs === null ? startBudgetMs : Math.min(startBudgetMs, deadlineBudgetMs);
        try {
          await sandboxCrOrchestrator.waitForCompletion(clients, namespace, jobName, {
            timeoutMs: readyTimeoutMs,
            pollMs: 1000,
            // A pod the tenant quota refuses never comes; fail now, naming the
            // quota, instead of at the deadline (APP-233).
            onPending: createQuotaGate({
              clients,
              namespace,
              sandboxName: jobName,
              demand: sandboxQuotaDemand(manifest),
              logger: { warn: (message, meta) => console.warn(`[plugin-kubernetes] ${message}`, meta) },
            }),
          });
        } catch (readyError) {
          throw readyError instanceof SandboxCrTimeoutError && readyTimeoutMs < startBudgetMs
            ? new SandboxAcquireDeadlineError(namespace, jobName, "before its pod became Ready", readyError)
            : readyError;
        }
        readySandboxesByLease.add(jobName);
      }

      const podName = await orchestrator.findPod(clients, namespace, jobName);

      const leaseMetadata: KubernetesLeaseMetadata = {
        namespace,
        jobName,
        podName,
        secretName,
        phase: "Pending",
        backend: config.backend,
        scopedNetworkPolicyName,
        scopedNetworkEgress,
        // Native file sync streams over a pod exec; only the sandbox-cr backend
        // exposes one. Flag the job backend so the server keeps the base64 fallback
        // rather than routing its sync to a hook that would reject immediately.
        nativeFileSyncUnsupported: config.backend !== "sandbox-cr",
      };

      // Only the Sandbox shutdown time is an absolute, controller-enforced
      // deadline. A Job's activeDeadlineSeconds counts from when it starts, so a
      // job lease attests no expiry and a caller with a deadline fails closed.
      const attestedExpiresAt =
        isSandboxCrBackend && shutdown.requested ? new Date(shutdown.shutdownMs).toISOString() : undefined;
      loginPtySessions.rememberLease({
        providerLeaseId: jobName,
        companyId: params.companyId,
        environmentId: params.environmentId,
        config,
        namespace,
        podName,
        backend: config.backend,
        expiresAtMs: isSandboxCrBackend ? shutdown.shutdownMs : null,
      });

      return {
        providerLeaseId: jobName,
        metadata: leaseMetadata as unknown as Record<string, unknown>,
        ...(attestedExpiresAt ? { expiresAt: attestedExpiresAt } : {}),
      };
    } catch (acquireError) {
      readySandboxesByLease.delete(jobName);
      try {
        await orchestrator.release(clients, namespace, jobName);
      } catch (releaseError) {
        if (!isKubeNotFoundError(releaseError)) {
          throw new AggregateError(
            [acquireError, releaseError],
            "Sandbox lease could not be acquired and its workload could not be released",
          );
        }
      }
      throw acquireError;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);
    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    // acquireLease names the per-run Secret `${jobName}-env` and uses jobName
    // as the providerLeaseId, so the suffix fallback reconstructs it exactly.
    const secretName =
      typeof params.leaseMetadata?.secretName === "string"
        ? params.leaseMetadata.secretName
        : `${params.providerLeaseId}-env`;

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    const check = await checkLeaseResumable(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      readyTimeoutMs: RESUME_READY_TIMEOUT_MS,
      pollMs: RESUME_READY_POLL_MS,
    });

    if (!check.resumable) {
      // Kubernetes pods are NOT restartable the way Daytona sandboxes are: a
      // stopped Daytona sandbox can be started again by ID, but a k8s pod that
      // is gone or terminally failed can never be revived in place. Gone = not
      // resumable, by design. Returning providerLeaseId: null tells the server
      // the lease expired so it falls back to a fresh acquireLease.
      return {
        providerLeaseId: null,
        metadata: { expired: true, reason: check.reason },
      };
    }

    // A resumed lease starts with clean per-lease state: drop any stale upload
    // interceptor buffers a previous run on this lease may have left behind.
    uploadInterceptorsByLease.delete(params.providerLeaseId);
    if (leaseBackend === "sandbox-cr") {
      // We just observed the Sandbox pod Ready, so the first exec on the
      // resumed lease can skip its readiness poll.
      readySandboxesByLease.add(params.providerLeaseId);
    }

    loginPtySessions.rememberLease({
      providerLeaseId: params.providerLeaseId,
      companyId: params.companyId,
      environmentId: params.environmentId,
      config,
      namespace,
      podName: check.podName,
      backend: leaseBackend,
      expiresAtMs: null,
    });

    const leaseMetadata: KubernetesLeaseMetadata = {
      namespace,
      jobName: params.providerLeaseId,
      podName: check.podName,
      secretName,
      phase: check.phase,
      backend: leaseBackend,
      scopedNetworkPolicyName:
        typeof params.leaseMetadata?.scopedNetworkPolicyName === "string"
          ? params.leaseMetadata.scopedNetworkPolicyName
          : null,
      scopedNetworkEgress: parseScopedNetworkEgressGrant({
        networkEgress: params.leaseMetadata?.scopedNetworkEgress,
      }),
      // See acquireLease: only the sandbox-cr backend has a pod-exec channel for
      // native sync, so a resumed job lease must keep the base64 fallback.
      nativeFileSyncUnsupported: leaseBackend !== "sandbox-cr",
    };

    return {
      providerLeaseId: params.providerLeaseId,
      metadata: {
        ...leaseMetadata,
        resumedLease: true,
      } as unknown as Record<string, unknown>,
    };
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    // Honor a caller-supplied remotePath. Otherwise a Sandbox lease works in
    // a directory the agent user creates inside the /workspace emptyDir: the
    // kubelet creates the volume root owned by root (group fsGroup), and Git
    // refuses a repository whose root another user owns ("detected dubious
    // ownership"). The run's Git launchers ignore system and global config,
    // so a safe.directory exception can't fix that; ownership does.
    const supplied = params.workspace.remotePath?.trim();
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const leaseBackend =
      typeof params.lease.metadata?.backend === "string"
        ? (params.lease.metadata.backend as "sandbox-cr" | "job")
        : config.backend;
    const cwd = supplied || (leaseBackend === "sandbox-cr" ? AGENT_WORKSPACE_DIR : "/workspace");
    if (!supplied && leaseBackend === "sandbox-cr" && params.lease.providerLeaseId) {
      await createAgentWorkspaceDir(config, params.companyId, params.lease, cwd);
    }
    return {
      cwd,
      metadata: {
        provider: "kubernetes",
        remoteCwd: cwd,
      },
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    const releaseOrchestrator =
      leaseBackend === "sandbox-cr" ? sandboxCrOrchestrator : jobOrchestrator;

    // Drop the FastUploadInterceptor associated with THIS lease (only).
    // Each lease has its own interceptor instance via uploadInterceptorsByLease,
    // so unrelated concurrent leases keep their in-flight buffers intact.
    uploadInterceptorsByLease.delete(params.providerLeaseId);
    readySandboxesByLease.delete(params.providerLeaseId);
    await loginPtySessions.forgetLease(params.providerLeaseId);

    try {
      await releaseOrchestrator.release(clients, namespace, params.providerLeaseId);
    } catch (err) {
      // If the resource is already gone (404), that's fine.
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { code?: number; statusCode?: number }).statusCode;
      if (code !== 404) throw err;
    }
    return terminationReceiptOnceGone(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      podName: typeof params.leaseMetadata?.podName === "string" && params.leaseMetadata.podName
        ? params.leaseMetadata.podName
        : null,
    });
  },

  async onEnvironmentInspectLease(
    params: PluginEnvironmentInspectLeaseParams,
  ): Promise<PluginEnvironmentLeaseObservation> {
    // Only creation recovery is answered: is there a workload an acquire with
    // this attempt id created and nobody released? Any other inspection reports
    // "unknown", so it never counts as proof that a lease's resources are gone.
    if (params.creationOperation === undefined) {
      return { providerLeaseId: params.providerLeaseId, state: "unknown" };
    }
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace = deriveTenantNamespace(config, params.companyId);
    const kc = createKubeConfig({ inCluster: config.inCluster, kubeconfig: config.kubeconfig });
    const cleanup = await inspectCreation({
      clients: makeKubeClients(kc),
      kc,
      namespace,
      backend: config.backend,
      companyId: params.companyId,
      environmentId: params.environmentId,
      creationOperation: params.creationOperation,
    });
    return cleanup
      ? { providerLeaseId: cleanup.providerLeaseId, state: "active", creationCleanup: cleanup }
      : { providerLeaseId: params.providerLeaseId, state: "unknown" };
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);
    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    const secretName =
      typeof params.leaseMetadata?.secretName === "string"
        ? params.leaseMetadata.secretName
        : `${params.providerLeaseId}-env`;
    const podName =
      typeof params.leaseMetadata?.podName === "string" &&
      params.leaseMetadata.podName.length > 0
        ? params.leaseMetadata.podName
        : null;

    // Clear per-lease in-memory state up front, regardless of what the
    // cluster says — the lease is dead either way.
    uploadInterceptorsByLease.delete(params.providerLeaseId);
    readySandboxesByLease.delete(params.providerLeaseId);
    await loginPtySessions.forgetLease(params.providerLeaseId);

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    // A lease built from a failed creation names the workload by the cleanup
    // envelope inspection returned. Delete it only while it still carries that
    // attempt's labels.
    if (params.leaseMetadata?.failedCreateCleanup !== undefined) {
      const cleanup = readEnvironmentCreationCleanupError({ data: {
        schema: "paperclip/environment-creation-cleanup/v1", cleanup: params.leaseMetadata.failedCreateCleanup,
      } });
      if (!cleanup || cleanup.providerLeaseId !== params.providerLeaseId || cleanup.companyId !== params.companyId) {
        throw new Error("Creation cleanup ownership is invalid");
      }
      await assertCreationCleanupOwnership(clients, namespace, leaseBackend, cleanup);
    }

    // Forcibly delete everything acquireLease created (Sandbox CR / Job, pod,
    // per-run Secret). 404s are success — destroy must be idempotent.
    await destroyLeaseResources(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      podName,
      secretName,
    });
    return terminationReceiptOnceGone(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      podName,
    });
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const { lease, timeoutMs } = params;

    if (!lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = kubernetesProviderConfigSchema.parse(params.config);
    const scopedNetworkEgress = parseScopedNetworkEgressGrant({
      networkEgress: lease.metadata?.scopedNetworkEgress,
    });
    const namespace =
      typeof lease.metadata?.namespace === "string"
        ? lease.metadata.namespace
        : deriveTenantNamespace(config, params.companyId);

    // Determine which backend this lease was created with.
    const leaseBackend =
      typeof lease.metadata?.backend === "string"
        ? (lease.metadata.backend as "sandbox-cr" | "job")
        : config.backend;

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? timeoutMs
        : config.podActivityDeadlineSec * 1000;

    if (leaseBackend === "sandbox-cr") {
      // ── Sandbox-CR backend ──────────────────────────────────────────────────
      // 1. Ensure the Sandbox pod is Ready (wait only on first exec for this lease).
      // 2. Exec the command into the running pod.
      // 3. Return exec result directly (no log scraping needed).

      let podName =
        typeof lease.metadata?.podName === "string" && lease.metadata.podName
          ? lease.metadata.podName
          : null;

      // Skip the readiness poll if we've already observed this Sandbox CR
      // reaching Ready during this worker's lifetime. See readySandboxesByLease
      // declaration for rationale.
      const podAlreadyKnownReady = readySandboxesByLease.has(lease.providerLeaseId);

      // The caller's timeout is a budget for the WHOLE execute call: readiness
      // wait + exec must share it, or the first exec on a fresh lease could
      // block for up to twice the requested timeout.
      const executeStartedAt = Date.now();

      if (!podAlreadyKnownReady) {
        try {
          await sandboxCrOrchestrator.waitForCompletion(
            clients,
            namespace,
            lease.providerLeaseId,
            { timeoutMs: effectiveTimeoutMs, pollMs: 2000 },
          );
          readySandboxesByLease.add(lease.providerLeaseId);
        } catch (err) {
          if (err instanceof SandboxCrTimeoutError) {
            return {
              exitCode: null,
              timedOut: true,
              stdout: "",
              stderr: `Sandbox pod did not become Ready within ${effectiveTimeoutMs}ms`,
              metadata: {
                provider: "kubernetes",
                backend: "sandbox-cr",
                namespace,
                sandboxName: lease.providerLeaseId,
              },
            };
          }
          throw err;
        }
      }

      // Resolve pod name (may now be populated in Sandbox status).
      if (!podName) {
        podName = await sandboxCrOrchestrator.findPod(
          clients,
          namespace,
          lease.providerLeaseId,
        );
      }

      if (!podName) {
        return {
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "Sandbox pod is Ready but podName could not be resolved.",
          metadata: {
            provider: "kubernetes",
            backend: "sandbox-cr",
            namespace,
            sandboxName: lease.providerLeaseId,
          },
        };
      }

      // Build the command to exec. The adapter passes shell invocations as
      // `command: "sh", args: ["-c", "<script>"]` — must combine both, NOT
      // drop args. If only command is present (no args), wrap in a login shell.
      const command = typeof params.command === "string" ? params.command.trim() : "";
      const args = Array.isArray(params.args) ? params.args : [];

      // Fast-upload interceptor: short-circuit the chunked-shell file transfer
      // protocol (adapter-utils writeFile) so an N-chunk upload becomes 1 exec
      // instead of N+2. Falls back transparently when patterns don't match.
      // See upload-interceptor.ts.
      const shellScript =
        command === "sh" && args[0] === "-c" && typeof args[1] === "string"
          ? args[1]
          : null;
      if (shellScript) {
        const decision = getOrCreateUploadInterceptor(lease.providerLeaseId).decide(shellScript);
        if (decision.action === "ack") {
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              fastUpload: "ack",
            },
          };
        }
        if (decision.action === "flush") {
          // Single exec: `head -c <N> | base64 -d > '<TARGET>'` with stdin =
          // base64 ASCII. `head -c` reads EXACTLY N bytes and exits, so we
          // don't depend on WebSocket-driven EOF detection on stdin (which is
          // racy against the `base64 -d` exit timing in @kubernetes/client-node
          // v0.21.0 — see pod-exec.ts). All bytes are sent through the
          // WebSocket data channel; size is unbounded by ARG_MAX.
          const base64Body = decision.flush.payload.toString("base64");
          const dir = decision.flush.targetPath.substring(
            0,
            decision.flush.targetPath.lastIndexOf("/"),
          );
          const script =
            `mkdir -p '${dir}' && ` +
            `head -c ${base64Body.length} | base64 -d > '${decision.flush.targetPath}'`;
          // The flush shares the caller's single execute budget (same contract
          // as the normal exec path below) and surfaces watchdog/WebSocket
          // failures as a timed-out result instead of an uncaught throw.
          const flushTimeoutMs = Math.max(
            5_000,
            effectiveTimeoutMs - (Date.now() - executeStartedAt),
          );
          let flushResult: { exitCode: number; stdout: string; stderr: string };
          try {
            flushResult = await execInPod(
              kc,
              namespace,
              podName,
              "agent",
              ["/bin/sh", "-c", script],
              base64Body,
              flushTimeoutMs,
            );
          } catch (err) {
            return {
              exitCode: null,
              timedOut: true,
              stdout: "",
              stderr: `fast-upload flush failed: ${err instanceof Error ? err.message : String(err)}`,
              metadata: {
                provider: "kubernetes",
                backend: "sandbox-cr",
                namespace,
                sandboxName: lease.providerLeaseId,
                podName,
                fastUpload: "flush",
              },
            };
          }
          return {
            exitCode: flushResult.exitCode,
            timedOut: false,
            stdout: flushResult.stdout,
            stderr: flushResult.stderr,
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              fastUpload: "flush",
              uploadedBytes: decision.flush.payload.length,
            },
          };
        }
        // decision.action === "passthrough" — fall through to normal exec
      }

      const baseExecCommand =
        command.length > 0 && args.length > 0
          ? [command, ...args]
          : command.length > 0
            ? ["/bin/sh", "-lc", command]
            : ["/bin/sh", "-l"];

      // Apply the caller-provided run env (params.env) to the in-pod process. Without
      // this the adapter's runtime env (e.g. XDG_CONFIG_HOME pointing at the shipped
      // OpenCode config, plus helper settings like small_model/provider routing) never
      // reaches the harness, which falls back to its in-image HOME config -> wrong or
      // partial behaviour.
      // The env goes over the exec's stdin, never into its argv (see wrapCommandWithEnv).
      const execWithEnv = wrapCommandWithEnv(
        baseExecCommand,
        params.env,
        typeof params.stdin === "string" ? params.stdin : undefined,
      );

      // Remaining share of the caller's budget after the readiness wait (floor
      // of 5s so an exec attempt is still made when readiness consumed most of
      // it; the watchdog then bounds it tightly).
      const remainingTimeoutMs = Math.max(
        5_000,
        effectiveTimeoutMs - (Date.now() - executeStartedAt),
      );

      let execResult: { exitCode: number; stdout: string; stderr: string };
      try {
        execResult = await execInPod(
          kc,
          namespace,
          podName,
          "agent",
          execWithEnv.command,
          execWithEnv.stdin,
          remainingTimeoutMs,
        );
      } catch (err) {
        // Watchdog-fired or WebSocket-setup error. Surface as a timeout so
        // the caller can retry instead of hanging forever.
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: appendNetworkEgressDenyHint(err instanceof Error ? err.message : String(err), scopedNetworkEgress),
          metadata: {
            provider: "kubernetes",
            backend: "sandbox-cr",
            namespace,
            sandboxName: lease.providerLeaseId,
            podName,
          },
        };
      }

      return {
        exitCode: execResult.exitCode,
        timedOut: false,
        stdout: execResult.stdout,
        stderr: appendNetworkEgressDenyHint(execResult.stderr, scopedNetworkEgress),
        metadata: {
          provider: "kubernetes",
          backend: "sandbox-cr",
          namespace,
          sandboxName: lease.providerLeaseId,
          podName,
        },
      };
    } else {
      // ── Job backend (legacy / stable fallback) ──────────────────────────────
      // The container entrypoint is baked into the Job spec (Tini + paperclip-agent-shim).
      // We do NOT re-exec command/args — instead we wait for the Job to finish
      // and collect its logs.
      //
      // params.command / params.args / params.stdin are intentionally ignored.

      let status;
      let timedOut = false;
      try {
        status = await jobOrchestrator.waitForCompletion(
          clients,
          namespace,
          lease.providerLeaseId,
          { timeoutMs: effectiveTimeoutMs, pollMs: 2000 },
        );
      } catch (err) {
        if (err instanceof JobTimeoutError) {
          timedOut = true;
          status = null;
        } else {
          throw err;
        }
      }

      // Collect logs from the pod.
      const podName =
        typeof lease.metadata?.podName === "string"
          ? lease.metadata.podName
          : await jobOrchestrator.findPod(
              clients,
              namespace,
              lease.providerLeaseId,
            );

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      if (podName) {
        await jobOrchestrator.streamLogs(
          clients,
          namespace,
          podName,
          async (stream, text) => {
            if (stream === "stdout") stdoutChunks.push(text);
            else stderrChunks.push(text);
          },
        );
      }

      return {
        exitCode: timedOut ? null : status?.phase === "Succeeded" ? 0 : 1,
        timedOut,
        stdout: stdoutChunks.join(""),
        stderr: appendNetworkEgressDenyHint(stderrChunks.join(""), scopedNetworkEgress),
        metadata: {
          provider: "kubernetes",
          backend: "job",
          namespace,
          jobName: lease.providerLeaseId,
          podName: podName ?? null,
          phase: status?.phase ?? null,
        },
      };
    }
  },

  // Opt-in native inbound transfer. Defining this hook (with onEnvironmentSyncOut)
  // makes the worker advertise `environmentSyncIn`/`environmentSyncOut`, so the
  // host runner routes workspace/asset transfers through a single pod exec per
  // operation (host tar streamed over the exec stdin → in-pod `head -c <N> | tar
  // -x` → stage-then-atomic-`mv -f`) instead of the base64-over-exec chunk loop.
  // Only the sandbox-cr backend is supported; the job backend carries no file
  // path. Providers that do not define these keep the byte-identical fallback.
  async onEnvironmentSyncIn(
    params: PluginEnvironmentSyncInParams,
  ): Promise<PluginEnvironmentSyncResult> {
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const { exec, timeoutMs } = await resolveSyncPodExec(params);
    return await performSyncIn({
      exec,
      operations: params.operations,
      remoteDir,
      timeoutMs,
    });
  },

  // Opt-in native outbound transfer. See onEnvironmentSyncIn.
  async onEnvironmentSyncOut(
    params: PluginEnvironmentSyncOutParams,
  ): Promise<PluginEnvironmentSyncResult> {
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const { exec, timeoutMs } = await resolveSyncPodExec(params);
    return await performSyncOut({
      exec,
      operations: params.operations,
      remoteDir,
      timeoutMs,
    });
  },

  // Login pseudo-terminal for the provider-generic sign-in flow. The fixed
  // command runs on a terminal exec in the lease's Sandbox pod, never in the
  // server or worker process. Output and exit go through `ctx.loginPty`. A lease
  // this worker did not acquire or resume, a lease of another company or
  // environment, and a job-backend lease fail closed.
  async onLoginPtyOpen(params) {
    return await loginPtySessions.open(params, {
      openSession: async (target, request) =>
        openKubernetesLoginPtySession(await resolveLoginPodExec(target), {
          loginCommandKey: request.loginCommandKey,
          sessionHome: request.sessionHome,
        }),
      output: (hostRouteId, workerSessionId, chunk) =>
        pluginContext?.loginPty.output(hostRouteId, workerSessionId, chunk),
      exit: (hostRouteId, workerSessionId, exitCode) =>
        pluginContext?.loginPty.exit(hostRouteId, workerSessionId, exitCode),
    });
  },

  async onLoginPtyInput(params) {
    loginPtySessions.input(params);
  },

  async onLoginPtyStop(params) {
    loginPtySessions.stop(params);
  },

  // Idempotent: acknowledges a route that is already closed or never opened.
  async onLoginPtyClose(params) {
    return await loginPtySessions.close(params);
  },

  async onShutdown() {
    await loginPtySessions.closeAll();
  },
});

export default plugin;
