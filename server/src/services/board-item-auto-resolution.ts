import {
  activityLog,
  agents,
  approvals,
  externalObjectMentions,
  externalObjects,
  issueApprovals,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWorkProducts,
  type Db,
} from "@paperclipai/db";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { isAgentStatusAssignableToWork } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { extractGitHubPullRequestReferences, type GitHubPullRequestReference } from "./github-pull-request-merge.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

/**
 * Board items are open issues assigned to a human. When the work such an item
 * waits on resolves elsewhere (its linked pull requests close, its blockers
 * finish), this service closes the item or hands it back to the agent that
 * handed it over. It runs only from events (a pull request `closed` webhook,
 * an issue becoming done/cancelled) plus an opt-in one-shot backfill; there is
 * no recurring sweep.
 */

export const BOARD_ITEM_AUTO_RESOLUTION_ACTOR_ID = "system:board-item-auto-resolution";
export const BOARD_ITEM_AUTO_RESOLVED_ACTION = "issue.board_item_auto_resolved";
export const BOARD_ITEM_AUTO_RESOLUTION_SKIPPED_ACTION = "issue.board_item_auto_resolution_skipped";

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const ACTIVITY_LOOKBACK_ROWS = 500;

export type BoardItemPullRequestState = "merged" | "closed" | "open" | "unknown";

export type BoardItemPullRequest = {
  /** `owner/repo#number`, lower-cased owner/repo, used for matching. */
  key: string;
  /** `owner/repo#number` as written by the provider, used in comments. */
  label: string;
  url: string;
  state: BoardItemPullRequestState;
  mergeCommitSha: string | null;
  headSha: string | null;
};

export type BoardItemBlocker = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
};

/** The state a `closed` webhook reported, for a PR that has no external object row. */
export type BoardItemObservedPullRequest = {
  owner: string;
  repo: string;
  number: number;
  merged: boolean;
  mergeCommitSha?: string | null;
  headSha?: string | null;
};

export type BoardItemTrigger =
  | { kind: "pull_request_closed"; pullRequest: string; merged: boolean }
  | { kind: "blocker_resolved"; blockerIssueId: string }
  | { kind: "backfill" };

export type BoardItemDecision =
  | { kind: "wait"; reason: "pending_human_input" | "no_linked_work" | "pull_request_open" | "blocker_open" }
  | { kind: "done" }
  | { kind: "return_to_agent"; reason: "pull_request_closed_unmerged" | "blockers_resolved" };

/**
 * The resolution rule, kept pure so it can be read and tested on its own.
 *
 * 1. Wait while a pending interaction or approval still needs the human, while
 *    any linked pull request is open (or its state is unknown) or while any
 *    blocker is not done/cancelled. An item with neither PRs nor blockers waits.
 * 2. Every linked PR merged (blockers, if any, resolved) -> `done`.
 * 3. Any linked PR closed without merging -> back to the agent as `todo`.
 * 4. No PRs, only resolved blockers -> back to the agent as `todo`. The human
 *    was only waiting; the next action belongs to the agent that handed over.
 */
export function decideBoardItemResolution(input: {
  pullRequests: readonly Pick<BoardItemPullRequest, "state">[];
  blockers: readonly Pick<BoardItemBlocker, "status">[];
  pendingHumanInputs: number;
}): BoardItemDecision {
  if (input.pendingHumanInputs > 0) return { kind: "wait", reason: "pending_human_input" };
  if (input.pullRequests.length === 0 && input.blockers.length === 0) return { kind: "wait", reason: "no_linked_work" };
  if (input.pullRequests.some((pr) => pr.state !== "merged" && pr.state !== "closed")) {
    return { kind: "wait", reason: "pull_request_open" };
  }
  if (input.blockers.some((blocker) => !(TERMINAL_ISSUE_STATUSES as readonly string[]).includes(blocker.status))) {
    return { kind: "wait", reason: "blocker_open" };
  }
  if (input.pullRequests.some((pr) => pr.state === "closed")) {
    return { kind: "return_to_agent", reason: "pull_request_closed_unmerged" };
  }
  if (input.pullRequests.length > 0) return { kind: "done" };
  return { kind: "return_to_agent", reason: "blockers_resolved" };
}

export type BoardItemEvaluationOutcome =
  | { outcome: "not_board_item" }
  | { outcome: "waiting"; reason: Extract<BoardItemDecision, { kind: "wait" }>["reason"] }
  | { outcome: "done"; commentId: string }
  | { outcome: "returned_to_agent"; agentId: string; commentId: string }
  | { outcome: "no_return_agent"; alreadyRecorded: boolean }
  | { outcome: "would_resolve"; decision: Exclude<BoardItemDecision, { kind: "wait" }>; agentId: string | null };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function referenceKey(reference: Pick<GitHubPullRequestReference, "owner" | "repo" | "number">) {
  return `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
}

function referenceLabel(reference: Pick<GitHubPullRequestReference, "owner" | "repo" | "number">) {
  return `${reference.owner}/${reference.repo}#${reference.number}`;
}

function referenceUrl(reference: Pick<GitHubPullRequestReference, "owner" | "repo" | "number">) {
  return `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`;
}

function externalIdReference(externalId: string): GitHubPullRequestReference | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#pull\/([1-9][0-9]*)$/.exec(externalId);
  if (!match) return null;
  return { host: "github.com", owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

function externalObjectState(object: {
  isTerminal: boolean;
  statusKey: string | null;
  data: Record<string, unknown> | null;
}): BoardItemPullRequestState {
  const data = record(object.data);
  if (object.statusKey === "merged" || data.merged === true) return "merged";
  if (object.isTerminal || object.statusKey === "closed") return "closed";
  if (object.statusKey === "open" || object.statusKey === "draft") return "open";
  return "unknown";
}

function workProductReference(product: { url: string | null; metadata: Record<string, unknown> | null }) {
  const metadata = record(product.metadata);
  const repo = stringValue(metadata.repo) ?? stringValue(metadata.repository);
  const number = typeof metadata.number === "number" && Number.isSafeInteger(metadata.number) ? metadata.number : null;
  return extractGitHubPullRequestReferences([
    product.url,
    stringValue(metadata.url),
    repo && number ? `${repo}#${number}` : null,
  ])[0] ?? null;
}

function workProductState(metadata: Record<string, unknown> | null): BoardItemPullRequestState {
  const state = stringValue(record(metadata).state);
  if (state === "merged" || state === "closed") return state;
  if (state === "open" || state === "draft") return "open";
  return "unknown";
}

/** Columns that make an issue a board item: assigned to a human and still open. */
function boardItemPredicate() {
  return and(
    isNotNull(issues.assigneeUserId),
    notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
    isNull(issues.conversationAgentId),
    isNull(issues.hiddenAt),
  );
}

function shortSha(sha: string | null) {
  return sha ? sha.slice(0, 12) : null;
}

function describePullRequest(pr: BoardItemPullRequest) {
  if (pr.state === "merged") {
    const sha = shortSha(pr.mergeCommitSha);
    return sha ? `[${pr.label}](${pr.url}) (merged as \`${sha}\`)` : `[${pr.label}](${pr.url}) (merged)`;
  }
  return `[${pr.label}](${pr.url}) (closed without merging)`;
}

function describeBlocker(blocker: BoardItemBlocker) {
  const ref = blocker.identifier ?? blocker.id;
  return `[${ref}](/issues/${ref}) ${blocker.status}`;
}

export function buildBoardItemResolutionComment(input: {
  decision: Exclude<BoardItemDecision, { kind: "wait" }>;
  pullRequests: readonly BoardItemPullRequest[];
  blockers: readonly BoardItemBlocker[];
  agentName?: string | null;
}) {
  const prs = input.pullRequests.map(describePullRequest);
  const blockers = input.blockers.map(describeBlocker);
  const evidence = [
    ...(prs.length ? [`Pull requests: ${prs.join(", ")}.`] : []),
    ...(blockers.length ? [`Blockers: ${blockers.join(", ")}.`] : []),
  ].join("\n");
  if (input.decision.kind === "done") {
    return `Closed automatically: every linked pull request is merged and nothing on this task is still waiting on a person.\n\n${evidence}`;
  }
  const agent = input.agentName ? `**${input.agentName}**` : "the agent that handed it over";
  if (input.decision.reason === "pull_request_closed_unmerged") {
    return `Returned to ${agent} automatically: a linked pull request was closed without merging, so this task has nothing left for a person to act on.\n\n${evidence}\n\nNext: decide whether the change is still needed, then reopen or replace the pull request, or close this task.`;
  }
  return `Returned to ${agent} automatically: every blocker this task was waiting on is resolved.\n\n${evidence}\n\nNext: continue the work this task was waiting to do.`;
}

export function boardItemAutoResolutionService(
  db: Db,
  options: { wakeup?: IssueAssignmentWakeupDeps["wakeup"] } = {},
) {
  async function defaultWakeup(): Promise<IssueAssignmentWakeupDeps["wakeup"]> {
    if (options.wakeup) return options.wakeup;
    const { heartbeatService } = await import("./heartbeat.js");
    return heartbeatService(db).wakeup as IssueAssignmentWakeupDeps["wakeup"];
  }

  async function candidatesForPullRequest(companyId: string, reference: Pick<GitHubPullRequestReference, "owner" | "repo" | "number">) {
    const externalId = `${reference.owner}/${reference.repo}#pull/${reference.number}`;
    const mentioned = await db.selectDistinct({ issueId: externalObjectMentions.sourceIssueId })
      .from(externalObjectMentions)
      .innerJoin(externalObjects, and(
        eq(externalObjects.id, externalObjectMentions.objectId),
        eq(externalObjects.companyId, externalObjectMentions.companyId),
      ))
      .innerJoin(issues, and(eq(issues.id, externalObjectMentions.sourceIssueId), eq(issues.companyId, companyId)))
      .where(and(
        eq(externalObjectMentions.companyId, companyId),
        eq(externalObjects.providerKey, "github"),
        eq(externalObjects.objectType, "pull_request"),
        sql`lower(${externalObjects.externalId}) = lower(${externalId})`,
        boardItemPredicate(),
      ));
    // Work products store the PR in a URL or metadata; match in memory over
    // the (small) set of PR work products on open human-assigned issues.
    const products = await db.select({
      issueId: issueWorkProducts.issueId,
      url: issueWorkProducts.url,
      metadata: issueWorkProducts.metadata,
    }).from(issueWorkProducts)
      .innerJoin(issues, and(eq(issues.id, issueWorkProducts.issueId), eq(issues.companyId, companyId)))
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        boardItemPredicate(),
      ));
    const key = referenceKey(reference);
    const linked = products.filter((product) => {
      const productReference = workProductReference(product);
      return productReference ? referenceKey(productReference) === key : false;
    });
    return [...new Set([...mentioned.map((row) => row.issueId), ...linked.map((row) => row.issueId)])];
  }

  async function candidatesForResolvedBlocker(companyId: string, blockerIssueId: string) {
    const rows = await db.select({ id: issues.id }).from(issueRelations)
      .innerJoin(issues, and(eq(issues.id, issueRelations.relatedIssueId), eq(issues.companyId, companyId)))
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.issueId, blockerIssueId),
        boardItemPredicate(),
      ));
    return rows.map((row) => row.id);
  }

  async function linkedPullRequests(tx: Db, companyId: string, issueId: string, observed?: BoardItemObservedPullRequest) {
    const byKey = new Map<string, BoardItemPullRequest>();
    const objects = await tx.select({
      externalId: externalObjects.externalId,
      statusKey: externalObjects.statusKey,
      isTerminal: externalObjects.isTerminal,
      data: externalObjects.data,
    }).from(externalObjectMentions)
      .innerJoin(externalObjects, and(
        eq(externalObjects.id, externalObjectMentions.objectId),
        eq(externalObjects.companyId, externalObjectMentions.companyId),
      ))
      .where(and(
        eq(externalObjectMentions.companyId, companyId),
        eq(externalObjectMentions.sourceIssueId, issueId),
        eq(externalObjects.providerKey, "github"),
        eq(externalObjects.objectType, "pull_request"),
      ));
    for (const object of objects) {
      const reference = externalIdReference(object.externalId);
      if (!reference) continue;
      const data = record(object.data);
      byKey.set(referenceKey(reference), {
        key: referenceKey(reference),
        label: referenceLabel(reference),
        url: referenceUrl(reference),
        state: externalObjectState(object),
        mergeCommitSha: stringValue(data.mergeCommitSha),
        headSha: stringValue(data.headSha),
      });
    }
    // A GitHub PR mention not yet resolved to an object has an unknown state;
    // it keeps the item waiting until the provider resolves it.
    const unresolved = await tx.select({ canonicalIdentity: externalObjectMentions.canonicalIdentity })
      .from(externalObjectMentions)
      .where(and(
        eq(externalObjectMentions.companyId, companyId),
        eq(externalObjectMentions.sourceIssueId, issueId),
        eq(externalObjectMentions.providerKey, "github"),
        eq(externalObjectMentions.objectType, "pull_request"),
        isNull(externalObjectMentions.objectId),
      ));
    for (const mention of unresolved) {
      const identity = record(mention.canonicalIdentity);
      const owner = stringValue(identity.owner);
      const repo = stringValue(identity.repo);
      const number = typeof identity.number === "number" ? identity.number : Number(identity.number);
      const reference = owner && repo && Number.isSafeInteger(number) && number > 0 ? { owner, repo, number } : null;
      const key = reference ? referenceKey(reference) : `unresolved:${byKey.size}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        label: reference ? referenceLabel(reference) : "unresolved GitHub pull request",
        url: reference ? referenceUrl(reference) : "",
        state: "unknown",
        mergeCommitSha: null,
        headSha: null,
      });
    }
    const products = await tx.select({ url: issueWorkProducts.url, metadata: issueWorkProducts.metadata })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issueId),
        eq(issueWorkProducts.type, "pull_request"),
      ));
    for (const product of products) {
      const reference = workProductReference(product);
      if (!reference) continue;
      const key = referenceKey(reference);
      // The external object is refreshed by webhooks; a work product's state
      // is only a cached copy, so it is used only when no object exists. The
      // webhook being handled is fresher than that copy.
      if (byKey.has(key)) continue;
      const observedHere = observed && referenceKey(observed) === key ? observed : null;
      byKey.set(key, {
        key,
        label: referenceLabel(reference),
        url: referenceUrl(reference),
        state: observedHere ? (observedHere.merged ? "merged" : "closed") : workProductState(product.metadata),
        mergeCommitSha: observedHere?.mergeCommitSha ?? stringValue(record(product.metadata).mergeCommitSha),
        headSha: observedHere?.headSha ?? stringValue(record(product.metadata).headSha),
      });
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  async function blockersOf(tx: Db, companyId: string, issueId: string): Promise<BoardItemBlocker[]> {
    return tx.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issueRelations)
      .innerJoin(issues, and(eq(issues.id, issueRelations.issueId), eq(issues.companyId, companyId)))
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, issueId),
      ))
      .orderBy(issues.identifier);
  }

  async function pendingHumanInputs(tx: Db, companyId: string, issueId: string) {
    const [interactions] = await tx.select({ count: sql<number>`count(*)::int` }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.status, "pending"),
    ));
    const [linkedApprovals] = await tx.select({ count: sql<number>`count(*)::int` }).from(issueApprovals)
      .innerJoin(approvals, and(eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, issueApprovals.companyId)))
      .where(and(
        eq(issueApprovals.companyId, companyId),
        eq(issueApprovals.issueId, issueId),
        eq(approvals.status, "pending"),
      ));
    return (interactions?.count ?? 0) + (linkedApprovals?.count ?? 0);
  }

  /**
   * The agent that handed the item to the human, in precedence order:
   * `executionState.returnAssignee` (when an agent), the most recent agent
   * assignee in the issue's activity, then `createdByAgentId`. Each candidate
   * must still be an assignable agent in the same company.
   */
  async function resolveReturnAgent(tx: Db, issue: typeof issues.$inferSelect) {
    const candidates: string[] = [];
    const returnAssignee = record(record(issue.executionState).returnAssignee);
    if (returnAssignee.type === "agent" && stringValue(returnAssignee.agentId)) {
      candidates.push(returnAssignee.agentId as string);
    }
    const activity = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
    )).orderBy(desc(activityLog.createdAt)).limit(ACTIVITY_LOOKBACK_ROWS);
    for (const row of activity) {
      const details = record(row.details);
      const changed = record(record(details.changes).assigneeAgentId);
      const agentId = stringValue(changed.to) ?? stringValue(changed.from)
        ?? stringValue(record(details._previous).assigneeAgentId)
        ?? stringValue(details.assigneeAgentId);
      if (agentId) { candidates.push(agentId); break; }
    }
    if (issue.createdByAgentId) candidates.push(issue.createdByAgentId);
    const unique = [...new Set(candidates)];
    if (unique.length === 0) return null;
    const rows = await tx.select({ id: agents.id, name: agents.name, status: agents.status }).from(agents)
      .where(and(eq(agents.companyId, issue.companyId), inArray(agents.id, unique)));
    for (const id of unique) {
      const agent = rows.find((row) => row.id === id);
      if (agent && isAgentStatusAssignableToWork(agent.status)) return agent;
    }
    return null;
  }

  function triggerDetails(trigger: BoardItemTrigger) {
    return trigger.kind === "pull_request_closed"
      ? { trigger: trigger.kind, triggerPullRequest: trigger.pullRequest, triggerMerged: trigger.merged }
      : trigger.kind === "blocker_resolved"
        ? { trigger: trigger.kind, triggerBlockerIssueId: trigger.blockerIssueId }
        : { trigger: trigger.kind };
  }

  async function evaluateIssue(
    companyId: string,
    issueId: string,
    trigger: BoardItemTrigger,
    evaluationOptions: { dryRun?: boolean; observed?: BoardItemObservedPullRequest } = {},
  ): Promise<BoardItemEvaluationOutcome> {
    const publications: ActivityPublication[] = [];
    const { executeIssuePostCommitActions, issueService } = await import("./issues.js");
    type PostCommitAction = Parameters<typeof executeIssuePostCommitActions>[1][number];
    const postCommitActions: PostCommitAction[] = [];
    let wake: { agentId: string; commentId: string; status: string } | null = null;
    let closedIssueId: string | null = null;

    const outcome = await db.transaction(async (rawTx): Promise<BoardItemEvaluationOutcome> => {
      const tx = rawTx as unknown as Db;
      // The row lock serializes duplicate and out-of-order deliveries: the
      // second evaluation sees the transition the first one committed.
      const [issue] = await tx.select().from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), boardItemPredicate()))
        .for("update");
      if (!issue) return { outcome: "not_board_item" };

      const pullRequests = await linkedPullRequests(tx, companyId, issueId, evaluationOptions.observed);
      const blockers = await blockersOf(tx, companyId, issueId);
      const pending = await pendingHumanInputs(tx, companyId, issueId);
      const decision = decideBoardItemResolution({ pullRequests, blockers, pendingHumanInputs: pending });
      if (decision.kind === "wait") return { outcome: "waiting", reason: decision.reason };

      const evidence = {
        identifier: issue.identifier,
        decision: decision.kind,
        ...(decision.kind === "return_to_agent" ? { reason: decision.reason } : {}),
        ...triggerDetails(trigger),
        pullRequests: pullRequests.map((pr) => ({
          pullRequest: pr.label, url: pr.url, state: pr.state, mergeCommitSha: pr.mergeCommitSha, headSha: pr.headSha,
        })),
        blockers: blockers.map((blocker) => ({ issueId: blocker.id, identifier: blocker.identifier, status: blocker.status })),
        previousAssigneeUserId: issue.assigneeUserId,
        previousStatus: issue.status,
      };

      const agent = decision.kind === "return_to_agent" ? await resolveReturnAgent(tx, issue) : null;
      if (evaluationOptions.dryRun) return { outcome: "would_resolve", decision, agentId: agent?.id ?? null };

      const svc = issueService(tx);
      if (decision.kind === "return_to_agent" && !agent) {
        // Record once per evidence set so a replayed event does not add rows.
        const fingerprint = JSON.stringify({ pullRequests: evidence.pullRequests, blockers: evidence.blockers });
        const [existing] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, BOARD_ITEM_AUTO_RESOLUTION_SKIPPED_ACTION),
          sql`${activityLog.details}->>'fingerprint' = ${fingerprint}`,
        )).limit(1);
        if (existing) return { outcome: "no_return_agent", alreadyRecorded: true };
        await logActivity(tx, {
          companyId,
          actorType: "system",
          actorId: BOARD_ITEM_AUTO_RESOLUTION_ACTOR_ID,
          action: BOARD_ITEM_AUTO_RESOLUTION_SKIPPED_ACTION,
          entityType: "issue",
          entityId: issueId,
          issueId,
          details: { ...evidence, skipReason: "no_return_agent", fingerprint },
        }, publications);
        return { outcome: "no_return_agent", alreadyRecorded: false };
      }

      const body = buildBoardItemResolutionComment({ decision, pullRequests, blockers, agentName: agent?.name ?? null });
      const comment = await svc.addComment(issueId, body, {}, { authorType: "system" }, tx);
      const patch = decision.kind === "done"
        ? { status: "done" as const }
        : { status: "todo" as const, assigneeAgentId: agent!.id, assigneeUserId: null };
      const updated = await svc.update(issueId, { ...patch, companyGuard: companyId }, tx, publications, postCommitActions);
      if (!updated) throw new Error("board item disappeared during auto-resolution");
      await logActivity(tx, {
        companyId,
        actorType: "system",
        actorId: BOARD_ITEM_AUTO_RESOLUTION_ACTOR_ID,
        action: BOARD_ITEM_AUTO_RESOLVED_ACTION,
        entityType: "issue",
        entityId: issueId,
        issueId,
        details: {
          ...evidence,
          commentId: comment.id,
          status: updated.status,
          ...(agent ? { assigneeAgentId: agent.id } : {}),
          changes: updated.changes ?? {},
          _previous: { status: issue.status, assigneeUserId: issue.assigneeUserId, assigneeAgentId: issue.assigneeAgentId },
        },
      }, publications);
      if (decision.kind === "done") {
        closedIssueId = issueId;
        return { outcome: "done", commentId: comment.id };
      }
      wake = { agentId: agent!.id, commentId: comment.id, status: updated.status };
      return { outcome: "returned_to_agent", agentId: agent!.id, commentId: comment.id };
    });

    for (const publication of publications) {
      try { publishActivity(publication); } catch (err) {
        logger.warn({ err, issueId }, "board item auto-resolution activity publication failed after commit");
      }
    }
    // Includes the dependent-board-item evaluation queued by the done
    // transition, so a chain of human-assigned waits resolves in order.
    await executeIssuePostCommitActions(db, postCommitActions);
    const pendingWake = wake as { agentId: string; commentId: string; status: string } | null;
    if (pendingWake) {
      try {
        const wakeup = await defaultWakeup();
        await wakeup(pendingWake.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId, mutation: "board_item_auto_resolved", wakeCommentId: pendingWake.commentId },
          idempotencyKey: `board_item_auto_resolved:${issueId}:${pendingWake.commentId}`,
          requestedByActorType: "system",
          requestedByActorId: BOARD_ITEM_AUTO_RESOLUTION_ACTOR_ID,
          contextSnapshot: {
            issueId,
            taskId: issueId,
            source: "issue.board_item_auto_resolved",
            wakeCommentId: pendingWake.commentId,
          },
        });
      } catch (err) {
        logger.warn({ err, issueId, agentId: pendingWake.agentId }, "board item auto-resolution agent wakeup failed");
      }
    }
    if (closedIssueId) await wakeAgentDependents(companyId, closedIssueId);
    return outcome;
  }

  /**
   * Routes wake agent-assigned dependents when an issue becomes done. This
   * service closes issues itself, so it does the same for the items it closes.
   */
  async function wakeAgentDependents(companyId: string, blockerIssueId: string) {
    try {
      const [{ issueService }, deps] = await Promise.all([
        import("./issues.js"),
        import("./issue-dependency-wakeups.js"),
      ]);
      const dependents = await issueService(db).listWakeableBlockedDependents(blockerIssueId);
      if (dependents.length === 0) return;
      const wakeup = await defaultWakeup();
      for (const dependent of dependents) {
        const existing = await deps.findExistingIssueBlockersResolvedWakeForReadyState(db, {
          companyId,
          dependentIssueId: dependent.id,
          blockerIssueIds: dependent.blockerIssueIds,
          blockedTransitionAt: dependent.blockedTransitionAt,
        });
        if (existing) continue;
        await wakeup(dependent.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: deps.ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
          payload: {
            issueId: dependent.id,
            resolvedBlockerIssueId: blockerIssueId,
            blockerIssueIds: dependent.blockerIssueIds,
            mutation: "blocker_done",
          },
          idempotencyKey: deps.buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: dependent.id,
            blockerIssueIds: dependent.blockerIssueIds,
            blockedTransitionAt: dependent.blockedTransitionAt,
          }),
          requestedByActorType: "system",
          requestedByActorId: BOARD_ITEM_AUTO_RESOLUTION_ACTOR_ID,
          contextSnapshot: {
            issueId: dependent.id,
            taskId: dependent.id,
            wakeReason: deps.ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            source: "issue.board_item_auto_resolved",
            resolvedBlockerIssueId: blockerIssueId,
            blockerIssueIds: dependent.blockerIssueIds,
          },
        });
      }
    } catch (err) {
      logger.warn({ err, blockerIssueId }, "board item auto-resolution dependent wakeup failed");
    }
  }

  async function evaluateAll(
    companyId: string,
    issueIds: readonly string[],
    trigger: BoardItemTrigger,
    observed?: BoardItemObservedPullRequest,
  ) {
    const results: Array<{ issueId: string } & BoardItemEvaluationOutcome> = [];
    for (const issueId of issueIds) {
      try {
        results.push({ issueId, ...await evaluateIssue(companyId, issueId, trigger, { observed }) });
      } catch (err) {
        // One item must not stop the others; the event that woke this run is
        // already durable, and the next event on the item re-evaluates it.
        logger.warn({ err, companyId, issueId, trigger: trigger.kind }, "board item auto-resolution failed");
      }
    }
    return results;
  }

  return {
    evaluateIssue,
    candidatesForPullRequest,
    candidatesForResolvedBlocker,

    /** A linked pull request received a `closed` webhook (merged or not). */
    onPullRequestClosed: async (companyId: string, pullRequest: BoardItemObservedPullRequest) => {
      const issueIds = await candidatesForPullRequest(companyId, pullRequest);
      return evaluateAll(companyId, issueIds, {
        kind: "pull_request_closed",
        pullRequest: referenceLabel(pullRequest),
        merged: pullRequest.merged,
      }, pullRequest);
    },

    /** An issue became done or cancelled; evaluate the board items it blocked. */
    onBlockerResolved: async (companyId: string, blockerIssueId: string) => {
      const issueIds = await candidatesForResolvedBlocker(companyId, blockerIssueId);
      return evaluateAll(companyId, issueIds, { kind: "blocker_resolved", blockerIssueId });
    },

    /**
     * One-shot evaluation of every current board item that links a PR or has
     * a blocker. Idempotent: resolved items stop matching the board-item
     * predicate, and unresolvable ones are recorded once.
     */
    backfill: async (backfillOptions: { companyId?: string; dryRun?: boolean } = {}) => {
      const linked = sql`(
        exists (select 1 from ${issueWorkProducts} wp where wp.issue_id = ${issues.id} and wp.company_id = ${issues.companyId} and wp.type = 'pull_request')
        or exists (select 1 from ${externalObjectMentions} m where m.source_issue_id = ${issues.id} and m.company_id = ${issues.companyId} and m.provider_key = 'github' and m.object_type = 'pull_request')
        or exists (select 1 from ${issueRelations} r where r.related_issue_id = ${issues.id} and r.company_id = ${issues.companyId} and r.type = 'blocks')
      )`;
      const rows = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
        boardItemPredicate(),
        backfillOptions.companyId ? eq(issues.companyId, backfillOptions.companyId) : undefined,
        linked,
      ));
      const results: Array<{ companyId: string; issueId: string } & BoardItemEvaluationOutcome> = [];
      for (const row of rows) {
        try {
          results.push({
            companyId: row.companyId,
            issueId: row.id,
            ...await evaluateIssue(row.companyId, row.id, { kind: "backfill" }, { dryRun: backfillOptions.dryRun }),
          });
        } catch (err) {
          logger.warn({ err, companyId: row.companyId, issueId: row.id }, "board item auto-resolution backfill item failed");
        }
      }
      return results;
    },
  };
}

export const BOARD_ITEM_AUTO_RESOLUTION_BACKFILL_ENV = "PAPERCLIP_BOARD_ITEM_AUTO_RESOLUTION_BACKFILL";

/**
 * One-shot backfill for items that were already waiting when this shipped.
 * Opt-in per deploy through `PAPERCLIP_BOARD_ITEM_AUTO_RESOLUTION_BACKFILL`:
 * `dry-run` logs what would change, `apply` changes it. Runs once at startup,
 * never on a timer; remove the variable after the run.
 */
export async function runBoardItemAutoResolutionBackfillFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const mode = env[BOARD_ITEM_AUTO_RESOLUTION_BACKFILL_ENV]?.trim();
  if (mode !== "dry-run" && mode !== "apply") return null;
  const results = await boardItemAutoResolutionService(db).backfill({ dryRun: mode === "dry-run" });
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  logger.info({
    mode,
    evaluated: results.length,
    counts,
    changed: results
      .filter((result) => result.outcome !== "waiting" && result.outcome !== "not_board_item")
      .map((result) => ({ companyId: result.companyId, issueId: result.issueId, outcome: result.outcome,
        ...(result.outcome === "would_resolve" ? { decision: result.decision, agentId: result.agentId } : {}) })),
  }, "board item auto-resolution backfill finished");
  return results;
}
