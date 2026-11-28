/**
 * Audit summaries for grant changes that affect task assignment.
 *
 * Routes that change a principal's grants read the grants before and after the
 * write and record `summarizeAssignmentGrants` of each in the activity entry's
 * `details.before` / `details.after`. When an active agent loses its last
 * assignment grant, they also record `agent.assignment_grants_removed` from
 * `assignmentGrantsRemovedActivity`.
 *
 * Summaries carry only permission keys and scope ids. Nothing else from the
 * grant row (granter, timestamps, unknown scope metadata) is copied.
 */

export const ASSIGNMENT_PERMISSION_KEYS = ["tasks:assign", "tasks:assign_scope"] as const;
export type AssignmentPermissionKey = (typeof ASSIGNMENT_PERMISSION_KEYS)[number];

export const ASSIGNMENT_GRANTS_REMOVED_ACTION = "agent.assignment_grants_removed";

export type AssignmentScopeIds = {
  projectIds: string[];
  agentIds: string[];
  userIds: string[];
  subtreeRootAgentIds: string[];
};

export type AssignmentGrantSummary = {
  /** Every permission key the principal holds, sorted and de-duplicated. */
  permissionKeys: string[];
  /**
   * Scope ids of each assignment grant the principal holds, keyed by
   * permission key; `null` for a grant without scope. The whole field is
   * `null` when the principal holds no assignment grant.
   */
  assignScope: Partial<Record<AssignmentPermissionKey, AssignmentScopeIds | null>> | null;
};

type GrantLike = {
  permissionKey: string;
  scope?: Record<string, unknown> | null;
};

// The id-bearing scope keys the authorization service recognizes for
// assignment (see scopeAllows in services/authorization.ts).
const SCOPE_ID_KEYS: Record<keyof AssignmentScopeIds, { keys: string[]; allowPrefix: string | null }> = {
  projectIds: { keys: ["projectId", "projectIds"], allowPrefix: "project:" },
  agentIds: {
    keys: ["agentId", "agentIds", "assigneeAgentId", "assigneeAgentIds", "targetAgentId", "targetAgentIds"],
    allowPrefix: "agent:",
  },
  userIds: { keys: ["userId", "userIds"], allowPrefix: null },
  subtreeRootAgentIds: {
    keys: [
      "managerAgentId",
      "managerAgentIds",
      "managedSubtreeAgentId",
      "managedSubtreeAgentIds",
      "subtreeAgentId",
      "subtreeAgentIds",
      "subtreeRootAgentId",
      "subtreeRootAgentIds",
    ],
    allowPrefix: "subtree:",
  },
};

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function sortedUnique(values: Iterable<string>) {
  return [...new Set(values)].sort();
}

function isAssignmentKey(key: string): key is AssignmentPermissionKey {
  return (ASSIGNMENT_PERMISSION_KEYS as readonly string[]).includes(key);
}

function summarizeScopeIds(scopes: Array<Record<string, unknown> | null | undefined>): AssignmentScopeIds | null {
  const present = scopes.filter((scope): scope is Record<string, unknown> => Boolean(scope));
  if (present.length === 0) return null;
  const allowRules = present.flatMap((scope) => stringList(scope.allow));
  const ids = {} as AssignmentScopeIds;
  for (const [field, { keys, allowPrefix }] of Object.entries(SCOPE_ID_KEYS) as Array<
    [keyof AssignmentScopeIds, (typeof SCOPE_ID_KEYS)[keyof AssignmentScopeIds]]
  >) {
    const fromKeys = present.flatMap((scope) => keys.flatMap((key) => stringList(scope[key])));
    const fromAllow = allowPrefix
      ? allowRules
        .filter((rule) => rule.startsWith(allowPrefix))
        .map((rule) => rule.slice(allowPrefix.length))
        .filter((value) => value.length > 0)
      : [];
    ids[field] = sortedUnique([...fromKeys, ...fromAllow]);
  }
  return ids;
}

export function summarizeAssignmentGrants(grants: readonly GrantLike[]): AssignmentGrantSummary {
  const permissionKeys = sortedUnique(grants.map((grant) => grant.permissionKey));
  let assignScope: AssignmentGrantSummary["assignScope"] = null;
  for (const key of ASSIGNMENT_PERMISSION_KEYS) {
    const matching = grants.filter((grant) => grant.permissionKey === key);
    if (matching.length === 0) continue;
    assignScope ??= {};
    assignScope[key] = summarizeScopeIds(matching.map((grant) => grant.scope));
  }
  return { permissionKeys, assignScope };
}

/** True when the summary holds `tasks:assign` or `tasks:assign_scope`. */
export function hasAssignmentGrant(summary: AssignmentGrantSummary) {
  return summary.permissionKeys.some(isAssignmentKey);
}

/**
 * An agent that can still be woken to work. Pending-approval and terminated
 * agents cannot act, so losing their assignment grant is not a detection
 * signal. This matches the assignable-status rule in authorization.
 */
export function isActiveAgentStatus(status: string | null | undefined) {
  return status !== "pending_approval" && status !== "terminated";
}

type ActorFields = {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

/**
 * The `agent.assignment_grants_removed` activity entry for a grant change, or
 * `null` when the change is not an active agent's transition from holding an
 * assignment grant to holding none. Pass the main entry's actor fields so both
 * entries name the same actor.
 */
export function assignmentGrantsRemovedActivity(input: {
  actor: ActorFields;
  agent: { id: string; status: string | null | undefined } | null;
  before: AssignmentGrantSummary;
  after: AssignmentGrantSummary;
  sourceAction: string;
}) {
  const { actor, agent, before, after, sourceAction } = input;
  if (!agent || !isActiveAgentStatus(agent.status)) return null;
  if (!hasAssignmentGrant(before) || hasAssignmentGrant(after)) return null;
  return {
    companyId: actor.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId ?? null,
    runId: actor.runId ?? null,
    agentApiKeyId: actor.agentApiKeyId ?? null,
    action: ASSIGNMENT_GRANTS_REMOVED_ACTION,
    entityType: "agent",
    entityId: agent.id,
    details: { before, after, sourceAction },
  };
}
