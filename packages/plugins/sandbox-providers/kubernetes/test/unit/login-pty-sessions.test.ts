import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createLoginPtySessions,
  LOGIN_PTY_CLOSED_DURING_OPEN,
  LOGIN_PTY_EXPIRED,
  LOGIN_PTY_JOB_BACKEND,
  LOGIN_PTY_LEASE_SCOPE_MISMATCH,
  LOGIN_PTY_UNKNOWN_LEASE,
  type LoginLeaseTarget,
  type LoginPtyOpenDeps,
  type LoginPtyOpenRequest,
} from "../../src/login-pty-sessions.js";
import type { LoginPtySession } from "../../src/login-pty.js";
import { kubernetesProviderConfigSchema } from "../../src/types.js";

const HOME = "/tmp/paperclip-adapter-login/0b8f6a5e-3c1d-4f2a-9e7b-1a2b3c4d5e6f";

function target(overrides: Partial<LoginLeaseTarget> = {}): LoginLeaseTarget {
  return {
    providerLeaseId: "pc-abc",
    companyId: "company-1",
    environmentId: "env-1",
    config: kubernetesProviderConfigSchema.parse({ inCluster: true }),
    namespace: "paperclip-acme",
    podName: "pc-abc-pod",
    backend: "sandbox-cr",
    expiresAtMs: null,
    ...overrides,
  };
}

function request(overrides: Partial<LoginPtyOpenRequest> = {}): LoginPtyOpenRequest {
  return {
    hostRouteId: "route-1",
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    providerLeaseId: "pc-abc",
    loginCommandKey: "claude",
    sessionHome: HOME,
    ...overrides,
  };
}

function fakeSession() {
  let listener: ((chunk: string) => void) | null = null;
  let resolveExit!: (r: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((r) => { resolveExit = r; });
  const session = {
    onData: vi.fn((l: (chunk: string) => void) => { listener = l; }),
    write: vi.fn(),
    wait: vi.fn(() => exited),
    kill: vi.fn(),
    close: vi.fn(async () => undefined),
  } satisfies LoginPtySession;
  return {
    session,
    emit: (chunk: string) => listener?.(chunk),
    exit: (exitCode: number | null) => resolveExit({ exitCode }),
  };
}

function deps(session: LoginPtySession, overrides: Partial<LoginPtyOpenDeps> = {}) {
  return {
    openSession: vi.fn(async () => session),
    output: vi.fn(),
    exit: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("login PTY sessions", () => {
  it("fails closed for a lease this worker does not hold", async () => {
    const sessions = createLoginPtySessions();
    const fake = fakeSession();
    const d = deps(fake.session);
    await expect(sessions.open(request(), d)).rejects.toThrow(LOGIN_PTY_UNKNOWN_LEASE);
    expect(d.openSession).not.toHaveBeenCalled();
  });

  it("fails closed for another company or environment", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const d = deps(fakeSession().session);
    await expect(sessions.open(request({ companyId: "company-2" }), d)).rejects.toThrow(LOGIN_PTY_LEASE_SCOPE_MISMATCH);
    await expect(sessions.open(request({ environmentId: "env-2" }), d)).rejects.toThrow(LOGIN_PTY_LEASE_SCOPE_MISMATCH);
    expect(d.openSession).not.toHaveBeenCalled();
  });

  it("refuses the job backend", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target({ backend: "job" }));
    const d = deps(fakeSession().session);
    await expect(sessions.open(request(), d)).rejects.toThrow(LOGIN_PTY_JOB_BACKEND);
    expect(d.openSession).not.toHaveBeenCalled();
  });

  it("revalidates the descriptor before opening", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const d = deps(fakeSession().session);
    await expect(sessions.open(request({ sessionHome: "/etc" }), d)).rejects.toThrow(/DESCRIPTOR_REJECTED/);
    expect(d.openSession).not.toHaveBeenCalled();
  });

  it("streams output and the exit under the host route and worker session ids", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const fake = fakeSession();
    const d = deps(fake.session);
    const { workerSessionId } = await sessions.open(request(), d);
    expect(workerSessionId).toMatch(/^pty-/);
    expect(d.openSession).toHaveBeenCalledWith(target(), request());
    fake.emit("Paste code here");
    expect(d.output).toHaveBeenCalledWith("route-1", workerSessionId, "Paste code here");
    fake.exit(0);
    await vi.waitFor(() => expect(d.exit).toHaveBeenCalledWith("route-1", workerSessionId, 0));
    expect(sessions.size).toBe(1);
  });

  it("writes input once per input id and drops input for another company", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const fake = fakeSession();
    const { workerSessionId } = await sessions.open(request(), deps(fake.session));
    sessions.input({ workerSessionId, data: "code\r", inputId: "in-1" });
    sessions.input({ workerSessionId, data: "code\r", inputId: "in-1" });
    sessions.input({ workerSessionId, data: "x", companyId: "company-2" });
    sessions.input({ workerSessionId: "pty-unknown", data: "x" });
    expect(fake.session.write).toHaveBeenCalledTimes(1);
    expect(fake.session.write).toHaveBeenCalledWith("code\r");
  });

  it("stops the child on stop", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const fake = fakeSession();
    const { workerSessionId } = await sessions.open(request(), deps(fake.session));
    sessions.stop({ workerSessionId });
    expect(fake.session.kill).toHaveBeenCalledTimes(1);
  });

  it("acknowledges close by host route id, idempotently", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const fake = fakeSession();
    await sessions.open(request(), deps(fake.session));
    await expect(sessions.close({ hostRouteId: "route-1" })).resolves.toEqual({ hostRouteId: "route-1" });
    await expect(sessions.close({ hostRouteId: "route-1" })).resolves.toEqual({ hostRouteId: "route-1" });
    await expect(sessions.close({ hostRouteId: "never-opened" })).resolves.toEqual({ hostRouteId: "never-opened" });
    expect(fake.session.close).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  it("closes a terminal that finishes opening after the host closed its route", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const fake = fakeSession();
    let finishOpen!: () => void;
    const d = deps(fake.session, {
      openSession: vi.fn(() => new Promise<LoginPtySession>((r) => { finishOpen = () => r(fake.session); })),
    });
    const opening = sessions.open(request(), d);
    await vi.waitFor(() => expect(d.openSession).toHaveBeenCalled());
    await sessions.close({ hostRouteId: "route-1" });
    finishOpen();
    await expect(opening).rejects.toThrow(LOGIN_PTY_CLOSED_DURING_OPEN);
    expect(fake.session.close).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });

  it("closes the lease's terminals when the lease is released", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const fake = fakeSession();
    await sessions.open(request(), deps(fake.session));
    await sessions.forgetLease("pc-abc");
    expect(fake.session.close).toHaveBeenCalledTimes(1);
    expect(sessions.hasLease("pc-abc")).toBe(false);
    await expect(sessions.open(request({ hostRouteId: "route-2" }), deps(fake.session))).rejects.toThrow(
      LOGIN_PTY_UNKNOWN_LEASE,
    );
  });

  it("stops the command at the earliest of the open deadline and the lease expiry", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-01-01T00:00:00Z");
    vi.setSystemTime(now);
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target({ expiresAtMs: now + 60_000 }), now);
    const fake = fakeSession();
    await sessions.open(request({ expiresAt: new Date(now + 30_000).toISOString() }), deps(fake.session));
    vi.advanceTimersByTime(29_999);
    expect(fake.session.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fake.session.kill).toHaveBeenCalledTimes(1);
  });

  it("refuses an open whose deadline has passed", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target({ expiresAtMs: now - 1 }), now - 10);
    const d = deps(fakeSession().session, { now: () => now });
    await expect(sessions.open(request(), d)).rejects.toThrow(LOGIN_PTY_EXPIRED);
    expect(d.openSession).not.toHaveBeenCalled();
  });

  it("closes every terminal on shutdown", async () => {
    const sessions = createLoginPtySessions();
    sessions.rememberLease(target());
    const a = fakeSession();
    const b = fakeSession();
    await sessions.open(request({ hostRouteId: "route-a" }), deps(a.session));
    await sessions.open(request({ hostRouteId: "route-b" }), deps(b.session));
    await sessions.closeAll();
    expect(a.session.close).toHaveBeenCalledTimes(1);
    expect(b.session.close).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
  });
});
