// Worker-side state for login pseudo-terminals (PTYs): which pod each provider
// lease runs in, and which terminals are open.
//
// The login PTY open request names only the provider lease; it carries no driver
// config and no lease metadata. So the worker records each Sandbox lease it
// acquires or resumes (company, environment, config, namespace, pod, expiry) and
// resolves the pod from that record. A lease this worker did not acquire or
// resume (another worker, or before a restart) fails closed: a restart
// interrupts an unfinished login, it never resumes the terminal.
//
// Terminals are registered by the host route id (the authoritative close key)
// and by the worker session id (input and stop). Close is idempotent. A close
// that arrives while the open is still in flight (the host's open timed out) is
// remembered, and the late terminal is closed as soon as it exists, so no
// terminal outlives its route.
//
// Each terminal is bounded by the earliest of the open request's deadline (when
// the host sends one) and the lease's attested expiry: at that time the worker
// stops the command. That is one timer per open terminal, cleared on close.

import { randomUUID } from "node:crypto";

import type { KubernetesProviderConfig } from "./types.js";
import { assertLoginPtyDescriptor, type LoginCommandKey, type LoginPtySession } from "./login-pty.js";

/** What the worker knows about a lease it acquired or resumed. */
export interface LoginLeaseTarget {
  providerLeaseId: string;
  companyId: string;
  environmentId: string;
  config: KubernetesProviderConfig;
  namespace: string;
  podName: string | null;
  backend: "sandbox-cr" | "job";
  /** The attested lease expiry (epoch ms), when the lease has one. */
  expiresAtMs: number | null;
}

// Request shapes. They are structural copies of the SDK protocol types so this
// module accepts both the current fields and the optional ones newer hosts send
// (`expiresAt` on open, `companyId` and `inputId` on input, stop and close).
export interface LoginPtyOpenRequest {
  hostRouteId: string;
  driverKey: string;
  companyId: string;
  environmentId: string;
  providerLeaseId: string;
  loginCommandKey: LoginCommandKey;
  sessionHome: string;
  expiresAt?: string;
}
export interface LoginPtyInputRequest { workerSessionId: string; data: string; companyId?: string; inputId?: string }
export interface LoginPtyStopRequest { workerSessionId: string; companyId?: string }
export interface LoginPtyCloseRequest { hostRouteId: string; workerSessionId?: string; companyId?: string }

export interface LoginPtyOpenDeps {
  /** Waits for the lease's pod and opens the login session in it. */
  openSession(target: LoginLeaseTarget, request: LoginPtyOpenRequest): Promise<LoginPtySession>;
  output(hostRouteId: string, workerSessionId: string, chunk: string): void;
  exit(hostRouteId: string, workerSessionId: string, exitCode: number | null): void;
  now?(): number;
}

interface Entry {
  hostRouteId: string;
  workerSessionId: string;
  providerLeaseId: string;
  companyId: string;
  session: LoginPtySession;
  deadline: ReturnType<typeof setTimeout> | null;
  // Input ids already written, so a host retry of the same write is not typed twice.
  deliveredInputIds: Set<string>;
}

// Bounds the retry-dedupe memory per terminal. A login takes a handful of writes.
const MAX_REMEMBERED_INPUT_IDS = 256;
// setTimeout's largest delay. A longer deadline is cut to it, which only stops early.
const MAX_TIMER_MS = 2 ** 31 - 1;

export const LOGIN_PTY_UNKNOWN_LEASE = "Kubernetes login PTY: this worker holds no lease with that provider lease id.";
export const LOGIN_PTY_LEASE_SCOPE_MISMATCH = "Kubernetes login PTY: the lease belongs to another company or environment.";
export const LOGIN_PTY_JOB_BACKEND = "Kubernetes login PTY needs the sandbox-cr backend; the job backend has no exec channel.";
export const LOGIN_PTY_EXPIRED = "Kubernetes login PTY: the login deadline has already passed.";
export const LOGIN_PTY_CLOSED_DURING_OPEN = "Kubernetes login PTY: the host closed the route before the terminal opened.";

export function createLoginPtySessions() {
  const leases = new Map<string, LoginLeaseTarget>();
  const byRoute = new Map<string, Entry>();
  const bySession = new Map<string, Entry>();
  // Host route id -> closed flag, for opens still in flight.
  const opening = new Map<string, { closed: boolean }>();

  function forget(entry: Entry): void {
    if (entry.deadline) clearTimeout(entry.deadline);
    entry.deadline = null;
    byRoute.delete(entry.hostRouteId);
    bySession.delete(entry.workerSessionId);
  }

  async function closeEntry(entry: Entry): Promise<void> {
    forget(entry);
    await entry.session.close().catch(() => undefined);
  }

  function rememberLease(target: LoginLeaseTarget, now = Date.now()): void {
    // A lease past its attested expiry is gone from the cluster; drop its record
    // here rather than with a sweep timer.
    for (const [id, known] of leases) {
      if (known.expiresAtMs !== null && known.expiresAtMs <= now) leases.delete(id);
    }
    leases.set(target.providerLeaseId, target);
  }

  /** Drops a released or destroyed lease and closes any terminal still open in it. */
  async function forgetLease(providerLeaseId: string): Promise<void> {
    leases.delete(providerLeaseId);
    const open = [...byRoute.values()].filter((e) => e.providerLeaseId === providerLeaseId);
    for (const entry of open) await closeEntry(entry);
  }

  async function open(request: LoginPtyOpenRequest, deps: LoginPtyOpenDeps): Promise<{ workerSessionId: string }> {
    const now = deps.now?.() ?? Date.now();
    const target = leases.get(request.providerLeaseId);
    if (!target) throw new Error(LOGIN_PTY_UNKNOWN_LEASE);
    if (target.companyId !== request.companyId || target.environmentId !== request.environmentId) {
      throw new Error(LOGIN_PTY_LEASE_SCOPE_MISMATCH);
    }
    if (target.backend !== "sandbox-cr") throw new Error(LOGIN_PTY_JOB_BACKEND);
    assertLoginPtyDescriptor({ loginCommandKey: request.loginCommandKey, sessionHome: request.sessionHome });

    const requestedMs = request.expiresAt ? Date.parse(request.expiresAt) : Number.NaN;
    const deadlines = [requestedMs, target.expiresAtMs ?? Number.NaN].filter(Number.isFinite);
    const deadlineMs = deadlines.length > 0 ? Math.min(...deadlines) : null;
    if (deadlineMs !== null && deadlineMs <= now) throw new Error(LOGIN_PTY_EXPIRED);

    const pending = { closed: false };
    opening.set(request.hostRouteId, pending);
    let session: LoginPtySession;
    try {
      session = await deps.openSession(target, request);
    } finally {
      opening.delete(request.hostRouteId);
    }
    if (pending.closed || !leases.has(request.providerLeaseId)) {
      await session.close().catch(() => undefined);
      throw new Error(LOGIN_PTY_CLOSED_DURING_OPEN);
    }

    const workerSessionId = `pty-${randomUUID()}`;
    const entry: Entry = {
      hostRouteId: request.hostRouteId,
      workerSessionId,
      providerLeaseId: request.providerLeaseId,
      companyId: request.companyId,
      session,
      deadline: null,
      deliveredInputIds: new Set(),
    };
    byRoute.set(entry.hostRouteId, entry);
    bySession.set(workerSessionId, entry);
    if (deadlineMs !== null) {
      entry.deadline = setTimeout(() => session.kill(), Math.min(deadlineMs - now, MAX_TIMER_MS));
      entry.deadline.unref?.();
    }
    // The session buffers output until a listener exists, so attaching here
    // loses nothing the command printed while the exec was starting.
    session.onData((chunk) => deps.output(entry.hostRouteId, workerSessionId, chunk));
    void session.wait().then(
      (result) => deps.exit(entry.hostRouteId, workerSessionId, result.exitCode),
      () => deps.exit(entry.hostRouteId, workerSessionId, null),
    );
    return { workerSessionId };
  }

  function input(request: LoginPtyInputRequest): void {
    const entry = bySession.get(request.workerSessionId);
    if (!entry) return;
    if (request.companyId !== undefined && request.companyId !== entry.companyId) return;
    if (request.inputId !== undefined) {
      if (entry.deliveredInputIds.has(request.inputId)) return;
      if (entry.deliveredInputIds.size >= MAX_REMEMBERED_INPUT_IDS) entry.deliveredInputIds.clear();
      entry.deliveredInputIds.add(request.inputId);
    }
    entry.session.write(request.data);
  }

  function stop(request: LoginPtyStopRequest): void {
    const entry = bySession.get(request.workerSessionId);
    if (!entry) return;
    if (request.companyId !== undefined && request.companyId !== entry.companyId) return;
    entry.session.kill();
  }

  async function close(request: LoginPtyCloseRequest): Promise<{ hostRouteId: string }> {
    const pending = opening.get(request.hostRouteId);
    if (pending) pending.closed = true;
    // The host route id is the authoritative close key, so close never filters
    // on the optional company id: a refused close would leave a terminal open.
    const entry = byRoute.get(request.hostRouteId);
    if (entry) await closeEntry(entry);
    return { hostRouteId: request.hostRouteId };
  }

  async function closeAll(): Promise<void> {
    for (const pending of opening.values()) pending.closed = true;
    const open = [...byRoute.values()];
    for (const entry of open) await closeEntry(entry);
    leases.clear();
  }

  return {
    rememberLease,
    forgetLease,
    open,
    input,
    stop,
    close,
    closeAll,
    /** Number of open terminals. */
    get size() { return byRoute.size; },
    hasLease: (providerLeaseId: string) => leases.has(providerLeaseId),
  };
}

export type LoginPtySessions = ReturnType<typeof createLoginPtySessions>;
