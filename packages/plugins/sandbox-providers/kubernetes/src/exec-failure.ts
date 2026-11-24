/**
 * Turn a failed pod exec into a message that names the real cause.
 *
 * The Kubernetes client rejects an exec that cannot start with whatever its
 * WebSocket layer produced: a `ws` ErrorEvent, a V1Status, or an ApiException.
 * Most of these are not `Error` instances, so `String(err)` gave
 * "[object Object]" and the run failed with no usable reason. These helpers
 * read the useful fields instead, and ask the API server what happened to the
 * pod (gone, terminating, OOMKilled) so the run error says why.
 */

import {
  Observable,
  type ConfigurationOptions,
  type ObservableMiddleware,
  type RequestContext,
  type ResponseContext,
} from "@kubernetes/client-node";

import type { KubeClients } from "./kube-client.js";
import { isKubeNotFoundError } from "./lease-lifecycle.js";

const MAX_DETAIL_CHARS = 500;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Describe any thrown value as readable text, never "[object Object]".
 * Handles `Error`, `ws` ErrorEvent (`message` plus a nested `error`), V1Status
 * (`reason`, `message`) and ApiException (`code`, `body`).
 */
export function describeExecError(err: unknown, depth = 0): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err === "string") return clip(err) || "unknown error";
  if (typeof err !== "object") return clip(String(err));

  const record = err as Record<string, unknown>;
  const parts: string[] = [];
  const code = typeof record.code === "number" ? record.code
    : typeof record.statusCode === "number" ? record.statusCode
      : null;
  if (code !== null) parts.push(`HTTP ${code}`);

  const reason = nonEmptyString(record.reason);
  if (reason) parts.push(reason);

  const message = nonEmptyString(record.message);
  const body = parseJsonObject(record.body);
  const bodyMessage = body ? nonEmptyString(body.message) : null;
  const bodyReason = body ? nonEmptyString(body.reason) : null;
  if (bodyReason && bodyReason !== reason) parts.push(bodyReason);
  if (bodyMessage) parts.push(bodyMessage);
  else if (message) parts.push(message);

  // A `ws` ErrorEvent wraps the underlying Error; its own message may be empty.
  if (depth < 2 && record.error && record.error !== err) {
    const inner = describeExecError(record.error, depth + 1);
    if (inner !== "unknown error" && !parts.some((part) => part.includes(inner))) parts.push(inner);
  }

  if (parts.length > 0) return clip(parts.join(": "));
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return clip(json);
  } catch {
    // Circular or otherwise unserialisable: fall through.
  }
  const name = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name !== "Object" ? `${name} (no message)` : "unknown error";
}

/** Wrap any thrown value in an `Error` whose message is readable. */
export function toExecError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(describeExecError(err));
  if (err.message.trim().length > 0) return err;
  const cause = (err as { cause?: unknown }).cause;
  return new Error(cause === undefined ? `${err.name} (no message)` : `${err.name}: ${describeExecError(cause)}`);
}

type ContainerTermination = { reason?: string; exitCode?: number; message?: string };
type ContainerStatusLike = {
  name?: string;
  restartCount?: number;
  state?: { terminated?: ContainerTermination; waiting?: { reason?: string; message?: string } };
  lastState?: { terminated?: ContainerTermination };
};
type PodLike = {
  metadata?: { deletionTimestamp?: unknown };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    containerStatuses?: ContainerStatusLike[];
  };
};

function describeTermination(containerName: string, terminated: ContainerTermination, previous: boolean): string {
  const reason = nonEmptyString(terminated.reason) ?? "Terminated";
  const exit = typeof terminated.exitCode === "number" ? ` (exit ${terminated.exitCode})` : "";
  const message = nonEmptyString(terminated.message);
  const when = previous ? " and was restarted" : "";
  return `container ${containerName} was ${reason}${exit}${when}${message ? `: ${clip(message)}` : ""}`;
}

/**
 * Explain the state of a pod after an exec failed. Returns `null` when the pod
 * looks healthy or the API server could not be asked; the caller then reports
 * the exec error alone.
 */
export function describePodState(pod: PodLike, podName: string, containerName: string): string | null {
  const facts: string[] = [];
  if (pod.metadata?.deletionTimestamp) facts.push(`pod ${podName} is terminating`);
  const container = (pod.status?.containerStatuses ?? []).find((status) => status.name === containerName);
  if (container?.state?.terminated) {
    facts.push(describeTermination(containerName, container.state.terminated, false));
  } else if (container?.lastState?.terminated) {
    facts.push(describeTermination(containerName, container.lastState.terminated, true));
  } else if (container?.state?.waiting?.reason) {
    facts.push(`container ${containerName} is waiting (${container.state.waiting.reason})`);
  }
  const phase = pod.status?.phase;
  if (phase && phase !== "Running") {
    const podReason = nonEmptyString(pod.status?.reason);
    facts.push(`pod ${podName} is ${phase}${podReason ? ` (${podReason})` : ""}`);
  }
  return facts.length > 0 ? facts.join("; ") : null;
}

/**
 * How long the pod lookup after a failed exec may take. The lookup only adds
 * detail to an error the caller already has, and the exec watchdog may have
 * spent the whole execute budget, so it must not hold the run up.
 */
export const POD_DIAGNOSTIC_TIMEOUT_MS = 3_000;

/** Request options that attach an abort signal to a generated-client call. */
function abortableRequestOptions(signal: AbortSignal): ConfigurationOptions<ObservableMiddleware> {
  return {
    middleware: [{
      pre: (request: RequestContext) => {
        request.setSignal(signal);
        return new Observable(Promise.resolve(request));
      },
      post: (response: ResponseContext) => new Observable(Promise.resolve(response)),
    }],
    middlewareMergeStrategy: "append",
  };
}

/**
 * Ask the API server what happened to the pod behind a failed exec. Gives up
 * after `timeoutMs`, aborting the request, and returns `null` so the caller
 * reports the exec error alone.
 */
export async function diagnosePodAfterExecFailure(
  clients: Pick<KubeClients, "core">,
  namespace: string,
  podName: string,
  containerName: string,
  timeoutMs: number = POD_DIAGNOSTIC_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`pod diagnostic timed out after ${timeoutMs}ms`));
      resolve(null);
    }, timeoutMs);
  });
  const lookup = (async (): Promise<string | null> => {
    try {
      const pod = (await clients.core.readNamespacedPod(
        { namespace, name: podName },
        abortableRequestOptions(controller.signal),
      )) as PodLike;
      return describePodState(pod, podName, containerName);
    } catch (err) {
      if (controller.signal.aborted) return null;
      if (isKubeNotFoundError(err)) return `pod ${podName} no longer exists (deleted or evicted)`;
      return null;
    }
  })();
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
