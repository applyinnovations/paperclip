# @paperclipai/plugin-kubernetes (alpha)

First-party Paperclip sandbox-provider plugin for Kubernetes.

**Alpha provider:** the default backend (`sandbox-cr`) uses the `kubernetes-sigs/agent-sandbox` v1beta1 API. A stable fallback backend (`job`, using `batch/v1` Job) is available for clusters without agent-sandbox installed, but it does NOT support multi-command exec (paperclip-server's adapter-install pattern requires sandbox-cr).

## Prerequisites

### For `sandbox-cr` backend (default, recommended)

1. A Kubernetes cluster running k8s 1.27+
2. A pinned [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox) controller serving `sandboxes.agents.x-k8s.io/v1beta1`
3. Paperclip-server running with access to the cluster (in-cluster via `inCluster: true` or external via `kubeconfig`)

### For `job` backend (stable fallback)

1. A Kubernetes cluster running k8s 1.27+
2. Paperclip-server with cluster access — no additional controllers or CRDs required

## Installation

```bash
paperclipai plugin install @paperclipai/plugin-kubernetes
```

Or, for local development:

```bash
paperclipai plugin install --local /path/to/paperclip/packages/plugins/sandbox-providers/kubernetes
```

## Backends

The plugin supports two backend modes, selected via the `backend` config field:

| Backend | Default | Stability | Multi-command exec | Requires |
|---|---|---|---|---|
| `sandbox-cr` | Yes | Alpha | Yes | `kubernetes-sigs/agent-sandbox` controller |
| `job` | No | Stable | No | Nothing beyond k8s 1.27+ |

**`sandbox-cr` (default):** Creates a `Sandbox` CR (`agents.x-k8s.io/v1beta1`) whose controller provisions a long-lived pod running `sleep infinity`. paperclip-server execs individual commands into the running pod — this is the multi-command adapter-install pattern. When you `releaseLease`, the Sandbox CR is deleted and the controller tears down the pod. The CR also sets an absolute `shutdownTime` with `shutdownPolicy: Delete` from `podActivityDeadlineSec`, so the controller can reap it if the server cannot release it. Workspace/home/cache are ephemeral and disappear with the pod; retain important outputs through Paperclip's file sync/storage.

**`job` (stable fallback):** Creates a `batch/v1` Job. The container entrypoint runs once and exits — no multi-command exec possible. Use this when you cannot install agent-sandbox, or when you need strictly stable Kubernetes APIs. Note: paperclip-server's adapter-install pattern will not work in job mode.

### Migrating from `job` to `sandbox-cr`

1. Install the agent-sandbox controller: `kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/sandbox.yaml`
2. Update your environment config to set `backend: "sandbox-cr"` (or remove `backend` since `sandbox-cr` is the default)
3. New leases will use the Sandbox CR backend. Existing leases created with `job` mode continue to use job semantics until they are released.

## Configuration

Create a `sandbox` environment with `driver: kubernetes`. One of these auth fields is required:

- `inCluster: true` — use the in-pod ServiceAccount credentials (when paperclip-server runs inside the same cluster).
- `kubeconfig: <YAML>` — inline kubeconfig (stored as a company secret).
- `kubeconfigSecretRef: <secret-uuid>` — reference to an existing Paperclip secret.

Common optional fields:

| Field | Default | Purpose |
|---|---|---|
| `backend` | `"sandbox-cr"` | `sandbox-cr` (alpha, requires agent-sandbox controller) or `job` (stable, one-shot entrypoint). |
| `adapterType` | `"claude_local"` | One of the supported adapter types (claude_local, codex_local, gemini_local, cursor_local, opencode_local, pi_local). Determines runtime image + env keys + egress allow-list. |
| `namespacePrefix` | `"paperclip-"` | Prefix for the per-company tenant namespace. |
| `companySlug` | derived from companyId | Override the auto-derived company slug. |
| `imageRegistry` | (none) | Override the default registry for agent runtime images. |
| `imageAllowList` | `[]` | Glob patterns of allowed `target.imageOverride` values. Empty = no override permitted. |
| `imagePullSecrets` | `[]` | Names of pre-created Docker image pull secrets in the tenant namespace. |
| `egressAllowFqdns` | `[]` | Additional FQDNs (beyond adapter defaults like `api.anthropic.com`). |
| `egressAllowCidrs` | `[]` | Additional CIDRs to allow egress to. |
| `egressMode` | `"standard"` | `standard` (NetworkPolicy + CIDRs) or `cilium` (CiliumNetworkPolicy + FQDN allow-list). |
| `runtimeClassName` | (none) | e.g. `kata-fc` for Firecracker-backed microVMs. Cluster must have the RuntimeClass installed. |
| `serviceAccountAnnotations` | `{}` | Annotations applied to per-tenant ServiceAccount (e.g. IRSA `eks.amazonaws.com/role-arn`). |
| `jobTtlSecondsAfterFinished` | `900` | Seconds after a Job completes before garbage-collection. |
| `podActivityDeadlineSec` | `3600` | Hard ceiling on a single run's wall-clock time. On `sandbox-cr` this sets the Sandbox `shutdownTime`; a caller's earlier deadline (a sign-in lease) shortens it. |

Full JSON Schema in `src/manifest.ts`.

### Task-scoped egress grants

Keep provider-level egress defaults narrow, then grant only the destinations a task needs through its execution workspace settings:

```json
{
  "executionWorkspaceSettings": {
    "networkEgress": {
      "allowFqdns": ["github.com", "pypi.org"],
      "allowCidrs": []
    }
  }
}
```

The provider creates a workload-owned policy selected by the task run label, so the additional destinations do not become reachable from other concurrent agent pods. Cilium mode enforces FQDNs directly. Standard NetworkPolicy mode cannot express FQDNs, so an FQDN grant permits public IPv4 TCP 80/443 for that run while excluding private, loopback, link-local, CGNAT, and multicast ranges. Network failures that look policy-related include the grant path in stderr, and the sandbox exposes the effective policy through `PAPERCLIP_NETWORK_EGRESS_*` environment variables.

## Subscription sign-in (login PTY)

The driver advertises `supportsLoginPty`, so Paperclip's provider-generic sign-in flows can create a Claude (`claude setup-token`) or ChatGPT (`codex login --device-auth`) subscription connection in the company's own sandbox. The login runs on a terminal exec (`tty=true`) in a fresh Sandbox pod, never in the Paperclip server or plugin worker process.

- **Command:** the server sends a closed command key and a session home of the exact shape `/tmp/paperclip-adapter-login/<uuid>`, never a command string. The plugin maps the key to a fixed command and runs `["/bin/sh", "-c", "exec <command>"]`; Codex gets `CODEX_HOME=<session home>` through `env`. The session home is created with `mkdir -m 700 -p` first. The browser code reaches the command over the exec stdin channel, never a command line.
- **Lifetime:** when the server asks for a deadline (`requestedExpiresAt`, sent by the Claude flow), the Sandbox `shutdownTime` is the earlier of that deadline and `podActivityDeadlineSec`, and the lease returns it as `expiresAt`. A deadline that has already passed is refused before anything is created. The plugin also stops the command at the earliest of the open request's deadline (newer servers send one) and that expiry.
- **Backend:** `sandbox-cr` only. The `job` backend has no exec channel, attests no expiry and refuses the terminal.
- **Worker state:** the open request names only the provider lease, so the worker resolves the pod from the lease it acquired or resumed. After a worker restart an unfinished login fails closed; start it again.
- **Credential read:** Codex writes `auth.json` (mode 0600) in the session home; the server reads it back with one `node -e` exec through the normal execute path. Claude prints its token on the terminal.

### Runtime image requirements

The adapter's runtime image must provide `/bin/sh`, `mkdir`, and the CLI on the container `PATH` (the exec does not source login profiles): `claude` for `claude_local`, `codex` for `codex_local`. The Codex credential read also needs `node`. The command runs as the pod user (UID 1000) with `HOME=/home/paperclip`; `/tmp` is a writable `emptyDir`.

### Sign-in egress

The browser opens the provider's authorize page on the user's machine; the sandbox only calls the token endpoints:

| Adapter | `loginAllowFqdns` default | Also needed (already in `allowFqdns`) |
|---|---|---|
| `claude_local` | `platform.claude.com` | `api.anthropic.com` |
| `codex_local` | `auth.openai.com` | none |

In `cilium` mode these hosts are added to the run's scoped policy (below). The sandbox-provider acquire does not say whether a lease is for a login, so they apply to every lease of that adapter unless the server marks the lease `purpose: "run"`. In `standard` mode FQDNs cannot be enforced; the hosts are reachable to the same extent as the adapter's other FQDNs (the public-IPv4 fallback, or your `egressAllowCidrs`). With an adapter registry (`adapters`, replace semantics) set `loginAllowFqdns` on the entry; an entry without it allows no sign-in hosts.

Running an agent on the subscription afterwards needs the provider's runtime hosts as well (for Codex, `chatgpt.com` and `auth.openai.com` for token refresh). Add them with `egressAllowFqdns`, a task grant, or the registry entry's `allowFqdns`.

## What gets created in your cluster

For each company that runs agents (created lazily on first dispatch):

```
Namespace          paperclip-{companySlug}        (PSS: restricted enforce + audit)
ServiceAccount     paperclip-tenant-sa
Role               paperclip-tenant-role          (only get pods/log)
RoleBinding        paperclip-tenant-rb
ResourceQuota      paperclip-quota                (pods, requests/limits cpu+memory)
LimitRange         paperclip-limits               (container max/min/default/defaultRequest)
NetworkPolicy      paperclip-deny-all             (deny ingress + egress baseline)
NetworkPolicy      paperclip-egress-allow         (DNS + paperclip-server callback + user CIDRs)
                   OR CiliumNetworkPolicy paperclip-egress-fqdn if egressMode=cilium
```

For each agent run (sandbox-cr backend):

```
Sandbox CR         pc-{ulid}                       (agents.x-k8s.io/v1beta1; release or absolute shutdown deadline)
Pod                pc-{ulid}                       (managed by Sandbox controller; torn down on CR delete)
Secret             pc-{ulid}-env                   (owned by Sandbox CR; cascade-deleted)
```

For each agent run (job backend):

```
Job                pc-{ulid}                       (backoffLimit: 0, ttlSecondsAfterFinished from config)
Pod                pc-{ulid}-{podSuffix}           (owned by Job; cascade-deleted)
Secret             pc-{ulid}-env                   (owned by Job; cascade-deleted)
```

Each workload carries `paperclip.io/run-id`, `paperclip.io/company-id` and, on newer servers, `paperclip.io/create-attempt` (the server's creation intent).

### When an acquire fails

A failed acquire hands no lease to the server, so nothing would ever release its workload. Its pod would hold a `paperclip-quota` slot until the Sandbox's `shutdownTime`. Three things prevent that:

- **Deleted on failure.** Once the Sandbox (or Job) exists, any later failure in the acquire deletes it before the error is returned.
- **Bounded by the server's deadline.** Newer servers send `acquireDeadlineAt`, the time their `environmentAcquireLease` RPC gives up. The readiness wait ends 5 s before it, so the provider has time to delete the Sandbox and answer. A Sandbox is not created at all when less than 5 s is left. The wait is the earlier of this and `podStartTimeoutSec`.
- **Creation recovery.** The driver declares `creationOperationVersion: 1`. About a minute after a failed acquire, the server asks `onEnvironmentInspectLease` for the workload labelled with that attempt. The provider checks the run and company labels, returns a cleanup envelope, and the server deletes the workload through `onEnvironmentDestroyLease`. Destroy checks the labels again first. This also covers a server that exits mid-acquire. Any other inspection returns `unknown`.

### When the tenant quota is full

A Sandbox whose pod `paperclip-quota` refuses stays Pending until a slot frees, so its acquire would otherwise end in the deadline error above with the cause hidden. While the Sandbox has no pod, each readiness poll reads `paperclip-quota` and compares it with what this Sandbox's pod needs (one pod plus its container requests and limits). When `used + needed > hard` for any of them on two polls in a row, the acquire fails at once with `SandboxQuotaExceededError`, e.g. `quota paperclip-quota exhausted: pods 16/16`, and the Sandbox is deleted as for any failed acquire.

The check needs `get` on `resourcequotas/paperclip-quota` in the tenant namespace (the provisioner Role's `resourceNames` grant; `list` is not used). If the quota is missing or the read fails or is forbidden, the check turns itself off for that acquire, logs one warning, and the wait behaves as before.

## Security baseline

Every agent pod is:

- non-root (`runAsUser: 1000`, `runAsGroup: 1000`, `runAsNonRoot: true`)
- drops ALL Linux capabilities, `allowPrivilegeEscalation: false`
- `readOnlyRootFilesystem: true` with explicit `emptyDir` mounts for `/workspace`, `/home/paperclip`, `/home/paperclip/.cache`, `/tmp`
- `seccompProfile: RuntimeDefault`
- Tini as PID 1 (reaps zombies, forwards signals)
- `fsGroupChangePolicy: OnRootMismatch` (fast PVC startup; openclaw-operator lesson)
- `automountServiceAccountToken: false` (callbacks use Paperclip credentials, not Kubernetes API credentials)

Plus per-namespace `pod-security.kubernetes.io/enforce: restricted` and a deny-all NetworkPolicy baseline with explicit egress allow-list (DNS, paperclip-server, configured FQDNs/CIDRs).

The per-run Secret carrying the bootstrap token and adapter API keys has `ownerReferences` pointing at the owning Job, so a single `kubectl delete job …` cascades cleanly to the Pod and Secret.

## Optional Kata-FC microVM isolation

For stronger isolation, install [Kata Containers](https://github.com/kata-containers/kata-containers) with the Firecracker hypervisor, then set `runtimeClassName: kata-fc` in the plugin config. Each agent pod will run inside a Firecracker microVM. Requires nested-virt-capable nodes (bare-metal or specific cloud instance types).

## Roadmap

- **Phase A (done):** `sandbox-cr` backend — multi-command exec via agent-sandbox Sandbox CRD.
- **Phase B:** Warm pool support — pre-provisioned Sandbox CRs for sub-second cold starts. The `SandboxOrchestrator` interface reserves optional `pause?`/`resume?` extension slots.
- **Phase C:** Kata-FC + snapshots — `runtimeClassName: kata-fc` with VM snapshot for fast restore.
- **Phase D:** Contribute back to agent-sandbox upstream if their Beta model diverges from our needs. The `SandboxOrchestrator` interface (`src/sandbox-orchestrator.ts`) is the clean swap point — a new implementation can be added without touching `plugin.ts` business logic.

## Lessons learned (from openclaw-operator)

This plugin adopts patterns from `openclaw-rocks/openclaw-operator`:

- Tini PID 1 (issue #471 — zombie helper processes)
- Read-only rootFS with explicit writable mounts (issue #456 — ~/.config not writable)
- Strategic merge on reconcile (issue #446 — preserve third-party annotations)
- Multi-storage-class testing (issue #448 — `local-path-provisioner` differences)
- Image version compat matrix (issue #462 — runtime deps cannot resolve after upgrade)

## Development

```bash
cd packages/plugins/sandbox-providers/kubernetes
pnpm install --ignore-workspace
pnpm test           # unit tests only (fast)
pnpm typecheck
pnpm build
```

To run the kind-cluster integration test (requires `kubectl --context kind-paperclip` and a pre-loaded alpine image; see `test/integration/end-to-end-run.test.ts`):

```bash
RUN_K8S_INTEGRATION_TESTS=1 pnpm test test/integration/end-to-end-run.test.ts
```
