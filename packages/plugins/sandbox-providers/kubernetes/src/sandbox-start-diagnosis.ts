/**
 * Why a Sandbox has not become Ready yet, read from what the cluster reports
 * while acquireLease waits (APP-114).
 *
 * - `capacity`: the pod could not be created or placed for lack of room: the
 *   tenant ResourceQuota refused it (`quota`), or no node can take it
 *   (`scheduling`). This clears on its own as other sandboxes finish.
 * - `permanent`: the pod was refused, or cannot start, for a reason that will
 *   not clear by waiting (a LimitRange rejection, an image that cannot be
 *   pulled, a broken container config). The run should fail now, with this
 *   cause in its error, instead of at the start-up deadline.
 * - `pending`: nothing wrong is reported; the pod is still being created,
 *   pulled or started.
 *
 * The agent-sandbox controller reports a refused pod create only as a Warning
 * Event on the Sandbox (`SandboxPodCreateFailed`); there is no pod and nothing
 * in the Sandbox status. Reading those events needs `list` on `events` in the
 * tenant namespace. Without it the diagnosis stays `pending` and the wait
 * behaves as before.
 */

import type { KubeClients } from "./kube-client.js";

export type SandboxStartDiagnosis =
  | { kind: "pending" }
  | { kind: "capacity"; reason: "quota" | "scheduling"; message: string }
  | { kind: "permanent"; message: string };

export interface SandboxStartPod {
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    containerStatuses?: SandboxStartContainerStatus[];
    initContainerStatuses?: SandboxStartContainerStatus[];
  };
}

interface SandboxStartContainerStatus {
  name?: string;
  state?: { waiting?: { reason?: string; message?: string } };
}

export interface SandboxStartEvent {
  type?: string;
  reason?: string;
  message?: string;
  lastTimestamp?: string | Date | null;
  eventTime?: string | Date | null;
  firstTimestamp?: string | Date | null;
  metadata?: { creationTimestamp?: string | Date | null };
}

/**
 * Container waiting reasons that no amount of waiting fixes. `ErrImagePull` is
 * left out: a registry blip shows as one, and a pull that keeps failing turns
 * into `ImagePullBackOff` within seconds.
 */
const PERMANENT_WAITING_REASONS = new Set([
  "ImagePullBackOff",
  "ErrImageNeverPull",
  "InvalidImageName",
  "CreateContainerConfigError",
]);

const MAX_MESSAGE_LENGTH = 500;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_MESSAGE_LENGTH ? `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : oneLine;
}

function eventTime(event: SandboxStartEvent): number {
  for (const value of [event.lastTimestamp, event.eventTime, event.firstTimestamp, event.metadata?.creationTimestamp]) {
    if (!value) continue;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/**
 * Classify a pending Sandbox from its pod (null when none exists yet) and the
 * events recorded against its name. The pod, when it exists, is the current
 * truth: a quota refusal from before the pod was created no longer matters.
 */
export function classifySandboxStart(input: {
  pod: SandboxStartPod | null;
  events: SandboxStartEvent[];
}): SandboxStartDiagnosis {
  const { pod, events } = input;
  if (pod) {
    const containers = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    for (const container of containers) {
      const waiting = container.state?.waiting;
      if (waiting?.reason && PERMANENT_WAITING_REASONS.has(waiting.reason)) {
        const detail = waiting.message ? `: ${waiting.message}` : "";
        return {
          kind: "permanent",
          message: clip(`container ${container.name ?? "(unnamed)"} cannot start: ${waiting.reason}${detail}`),
        };
      }
    }
    const scheduled = pod.status?.conditions?.find((condition) => condition.type === "PodScheduled");
    if (scheduled?.status === "False" && scheduled.reason === "Unschedulable") {
      return {
        kind: "capacity",
        reason: "scheduling",
        message: clip(`no node can take the pod: ${scheduled.message ?? "Unschedulable"}`),
      };
    }
    return { kind: "pending" };
  }

  // No pod yet: the latest refusal of the pod create says why.
  const refusals = events
    .filter((event) => event.type === "Warning" && typeof event.message === "string" && /\bforbidden\b/i.test(event.message))
    .sort((a, b) => eventTime(b) - eventTime(a));
  const latest = refusals[0];
  if (!latest?.message) return { kind: "pending" };
  if (/exceeded quota/i.test(latest.message)) {
    return { kind: "capacity", reason: "quota", message: clip(`tenant quota is full: ${latest.message}`) };
  }
  return { kind: "permanent", message: clip(`the pod was refused at admission: ${latest.message}`) };
}

function statusCode(error: unknown): number | undefined {
  const value = (error as { code?: unknown; statusCode?: unknown } | null)?.code
    ?? (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof value === "number" ? value : undefined;
}

/**
 * Read the Sandbox's pod and events and classify them. Read failures (for
 * example no RBAC on events) degrade to `pending`, so a diagnosis can only make
 * a wait end sooner with a reason, never fail a Sandbox that would have started.
 */
export async function diagnoseSandboxStart(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<SandboxStartDiagnosis> {
  let pod: SandboxStartPod | null = null;
  try {
    // The agent-sandbox controller names the pod after the Sandbox.
    pod = (await clients.core.readNamespacedPod({ namespace, name })) as SandboxStartPod;
  } catch (error) {
    if (statusCode(error) !== 404) return { kind: "pending" };
  }

  let events: SandboxStartEvent[] = [];
  if (!pod) {
    try {
      const list = (await clients.core.listNamespacedEvent({
        namespace,
        fieldSelector: `involvedObject.name=${name}`,
      })) as { items?: SandboxStartEvent[] };
      events = list.items ?? [];
    } catch {
      return { kind: "pending" };
    }
  }
  return classifySandboxStart({ pod, events });
}
