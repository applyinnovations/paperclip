import { describe, it, expect } from "vitest";
import {
  buildSandboxCrManifest as buildRawSandboxCrManifest,
  resolveSandboxShutdownMs,
  type BuildSandboxCrManifestInput,
} from "../../src/sandbox-cr-builder.js";
import type { SandboxCrManifestView } from "./manifest-views.js";

const buildSandboxCrManifest = (input: BuildSandboxCrManifestInput) =>
  buildRawSandboxCrManifest(input) as unknown as SandboxCrManifestView;

const baseInput = {
  namespace: "paperclip-acme",
  sandboxName: "pc-01h00000000000000000000000",
  adapterType: "claude_local",
  image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  envSecretName: "pc-01h00000000000000000000000-env",
  serviceAccountName: "paperclip-tenant-sa",
  labels: { "paperclip.io/run-id": "r1" },
  resources: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "2", memory: "4Gi" },
  },
  runtimeClassName: undefined,
};

describe("buildSandboxCrManifest", () => {
  it("returns a Sandbox CR with the correct apiVersion and kind", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.apiVersion).toBe("agents.x-k8s.io/v1beta1");
    expect(cr.kind).toBe("Sandbox");
  });

  it("sets metadata name and namespace correctly", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.name).toBe(baseInput.sandboxName);
    expect(cr.metadata.namespace).toBe(baseInput.namespace);
  });

  it("does NOT set ownerReferences (out-of-cluster server, explicit release path)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.ownerReferences).toBeUndefined();
  });

  it("sets restartPolicy=Always on the pod template (required for long-lived Sandbox pod)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.restartPolicy).toBe("Always");
  });

  it("uses sleep-infinity entrypoint via Tini for multi-command exec", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const container = cr.spec.podTemplate.spec.containers[0];
    expect(container.command).toEqual([
      "/usr/bin/tini",
      "--",
      "/bin/sh",
      "-c",
      "sleep infinity",
    ]);
  });

  it("applies the same security baseline as Job backend (non-root, drop ALL, RO rootFS, seccomp)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const podSec = cr.spec.podTemplate.spec.securityContext;
    expect(podSec.runAsNonRoot).toBe(true);
    expect(podSec.runAsUser).toBe(1000);
    expect(podSec.fsGroupChangePolicy).toBe("OnRootMismatch");
    expect(podSec.seccompProfile.type).toBe("RuntimeDefault");

    const container = cr.spec.podTemplate.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("disables automountServiceAccountToken", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.automountServiceAccountToken).toBe(false);
  });

  it("declares emptyDir volume mounts for standard agent paths", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const mounts = cr.spec.podTemplate.spec.containers[0].volumeMounts;
    const mountPaths = mounts
      .map((m: { mountPath: string }) => m.mountPath)
      .sort();
    expect(mountPaths).toEqual([
      "/home/paperclip",
      "/home/paperclip/.cache",
      "/tmp",
      "/workspace",
    ]);

    const volumes = cr.spec.podTemplate.spec.volumes;
    expect(
      volumes.every((v: { emptyDir?: unknown }) => v.emptyDir !== undefined),
    ).toBe(true);
    // HOME and XDG dirs live under /tmp in a run; 2Gi evicted agents (APP-128).
    expect(
      volumes.find((v: { name: string }) => v.name === "tmp").emptyDir.sizeLimit,
    ).toBe("8Gi");
  });

  it("envFrom references the per-run secret", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const envFrom = cr.spec.podTemplate.spec.containers[0].envFrom;
    expect(envFrom[0].secretRef.name).toBe(baseInput.envSecretName);
  });

  it("applies runtimeClassName when set", () => {
    const cr = buildSandboxCrManifest({
      ...baseInput,
      runtimeClassName: "kata-fc",
    });
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBe("kata-fc");
  });

  it("does not set runtimeClassName when unset", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBeUndefined();
  });

  it("applies provided labels to CR metadata and pod template labels (with role=agent added)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.labels["paperclip.io/run-id"]).toBe("r1");
    expect(
      cr.spec.podTemplate.metadata.labels["paperclip.io/run-id"],
    ).toBe("r1");
    expect(cr.spec.podTemplate.metadata.labels["paperclip.io/role"]).toBe(
      "agent",
    );
  });

  it("applies imagePullSecrets when provided", () => {
    const cr = buildSandboxCrManifest({
      ...baseInput,
      imagePullSecrets: ["my-pull-secret"],
    });
    expect(cr.spec.podTemplate.spec.imagePullSecrets).toEqual([
      { name: "my-pull-secret" },
    ]);
  });

  it("does not set imagePullSecrets when not provided", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.imagePullSecrets).toBeUndefined();
  });
});

describe("Sandbox shutdown time", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

  it("uses an explicit shutdownTime over the activeDeadlineSec default", () => {
    const cr = buildRawSandboxCrManifest({
      ...baseInput,
      activeDeadlineSec: 3600,
      shutdownTime: "2026-01-01T00:10:00.000Z",
    }) as { spec: { shutdownTime: string } };
    expect(cr.spec.shutdownTime).toBe("2026-01-01T00:10:00.000Z");
  });

  it("is the configured lifetime when no deadline is requested", () => {
    expect(resolveSandboxShutdownMs({ nowMs, podActivityDeadlineSec: 3600 })).toEqual({
      shutdownMs: nowMs + 3_600_000,
      requested: false,
    });
  });

  it("is the earlier of the configured lifetime and the requested deadline, rounded down to a second", () => {
    expect(
      resolveSandboxShutdownMs({ nowMs, podActivityDeadlineSec: 3600, requestedExpiresAt: "2026-01-01T00:10:00.900Z" }),
    ).toEqual({ shutdownMs: Date.parse("2026-01-01T00:10:00.000Z"), requested: true });
    expect(
      resolveSandboxShutdownMs({ nowMs, podActivityDeadlineSec: 60, requestedExpiresAt: "2026-01-01T00:10:00.000Z" }),
    ).toEqual({ shutdownMs: nowMs + 60_000, requested: true });
  });

  it("rejects a requested deadline that has passed", () => {
    expect(() =>
      resolveSandboxShutdownMs({ nowMs, podActivityDeadlineSec: 3600, requestedExpiresAt: "2025-12-31T23:59:59.000Z" }),
    ).toThrow(/already passed/);
  });

  it("ignores an unparseable requested deadline", () => {
    expect(resolveSandboxShutdownMs({ nowMs, podActivityDeadlineSec: 3600, requestedExpiresAt: "soon" }).requested).toBe(false);
  });
});
