import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { IssueExecutionPolicy, ProjectDefaultExecutionPolicy } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

type StageInput = {
  id?: string;
  type: string;
  participants?: Array<{ id?: string; type: string; agentId?: string | null; userId?: string | null }>;
};

function withoutIds(stages: ReadonlyArray<StageInput>) {
  return stages.map((stage) => ({
    type: stage.type,
    participants: (stage.participants ?? []).map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })),
  }));
}

/**
 * Validates a project's default execution policy and returns its stored form,
 * or null when it declares no stage with a participant.
 */
export function normalizeProjectDefaultExecutionPolicy(input: unknown): ProjectDefaultExecutionPolicy | null {
  if (input == null) return null;
  const stages = (input as { stages?: unknown }).stages;
  if (!Array.isArray(stages)) throw unprocessable("Invalid default execution policy: stages must be an array");
  const policy = normalizeIssueExecutionPolicy({ stages: withoutIds(stages as StageInput[]) });
  if (!policy || policy.stages.length === 0) return null;
  return { stages: policy.stages };
}

/** Every agent a project default names must belong to the project's company. */
export async function assertProjectDefaultExecutionPolicyParticipants(
  db: Db,
  companyId: string,
  policy: ProjectDefaultExecutionPolicy | null,
) {
  const agentIds = [...new Set(
    (policy?.stages ?? []).flatMap((stage) =>
      stage.participants.flatMap((participant) => (participant.type === "agent" && participant.agentId ? [participant.agentId] : []))),
  )];
  if (agentIds.length === 0) return;
  const found = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
  const foundIds = new Set(found.map((row) => row.id));
  const missing = agentIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw unprocessable("Default execution policy names agents outside this company", { agentIds: missing });
  }
}

/**
 * Validates `defaultIssueExecutionPolicy` inside a project's execution
 * workspace policy before it is stored: stored with ids, dropped when it names
 * no participant, and every agent must belong to the company. Returns the
 * policy unchanged when it has no such key.
 */
export async function normalizeProjectPolicyIssueDefaults<T extends Record<string, unknown> | null | undefined>(
  db: Db,
  companyId: string,
  executionWorkspacePolicy: T,
): Promise<T> {
  if (!executionWorkspacePolicy || !("defaultIssueExecutionPolicy" in executionWorkspacePolicy)) return executionWorkspacePolicy;
  const { defaultIssueExecutionPolicy, ...rest } = executionWorkspacePolicy;
  const normalized = normalizeProjectDefaultExecutionPolicy(defaultIssueExecutionPolicy);
  await assertProjectDefaultExecutionPolicyParticipants(db, companyId, normalized);
  return (normalized ? { ...rest, defaultIssueExecutionPolicy: normalized } : rest) as T;
}

/**
 * The execution policy a new issue is created with: the issue's own policy,
 * plus the project's default stages when the issue declares no stages of its
 * own. Other policy fields (monitor, authorization, review preset) are kept.
 * Stage and participant ids are fresh for each issue.
 */
export function applyProjectDefaultExecutionPolicy(
  issuePolicy: unknown,
  projectDefault: ProjectDefaultExecutionPolicy | null | undefined,
): IssueExecutionPolicy | null {
  const policy = normalizeIssueExecutionPolicy(issuePolicy ?? null);
  if (!projectDefault?.stages?.length || (policy?.stages.length ?? 0) > 0) return policy;
  const defaults = normalizeIssueExecutionPolicy({ stages: withoutIds(projectDefault.stages) });
  if (!defaults || defaults.stages.length === 0) return policy;
  return {
    ...(policy ?? { mode: "normal", commentRequired: true }),
    stages: defaults.stages,
  };
}
