import { describe, expect, it } from "vitest";
import type { IssueExecutionStage } from "@paperclipai/shared";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  selectStageParticipant,
} from "../services/issue-execution-policy.ts";

const reviewerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reviewerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const reviewerC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const coder = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const agent = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
const key = (agentId: string) => `agent:${agentId}`;

function stage(...agentIds: string[]): IssueExecutionStage {
  return normalizeIssueExecutionPolicy({
    stages: [{ type: "review", participants: agentIds.map((agentId) => ({ type: "agent", agentId })) }],
  })!.stages[0]!;
}

describe("selectStageParticipant", () => {
  it("keeps today's first-participant behaviour without loads", () => {
    expect(selectStageParticipant(stage(reviewerA, reviewerB))).toEqual(agent(reviewerA));
  });

  it("picks the lowest load", () => {
    const loads = new Map([[key(reviewerA), 3], [key(reviewerB), 1], [key(reviewerC), 2]]);
    expect(selectStageParticipant(stage(reviewerA, reviewerB, reviewerC), { loads })).toEqual(agent(reviewerB));
  });

  it("treats missing loads as zero and breaks ties by stage order", () => {
    expect(selectStageParticipant(stage(reviewerA, reviewerB, reviewerC), {
      loads: new Map([[key(reviewerA), 1]]),
    })).toEqual(agent(reviewerB));
    expect(selectStageParticipant(stage(reviewerA, reviewerB), {
      loads: new Map([[key(reviewerA), 2], [key(reviewerB), 2]]),
    })).toEqual(agent(reviewerA));
  });

  it("respects exclude", () => {
    const loads = new Map([[key(reviewerA), 0], [key(reviewerB), 5]]);
    expect(selectStageParticipant(stage(reviewerA, reviewerB), { loads, exclude: agent(reviewerA) })).toEqual(agent(reviewerB));
  });

  it("keeps preferred winning over load", () => {
    const loads = new Map([[key(reviewerA), 9], [key(reviewerB), 0]]);
    expect(selectStageParticipant(stage(reviewerA, reviewerB), { loads, preferred: agent(reviewerA) })).toMatchObject(agent(reviewerA));
  });

  it("skips ineligible agents while an eligible one exists", () => {
    const loads = new Map([[key(reviewerA), 0], [key(reviewerB), 4]]);
    expect(selectStageParticipant(stage(reviewerA, reviewerB), {
      loads,
      ineligible: new Set([key(reviewerA)]),
    })).toEqual(agent(reviewerB));
  });

  it("falls back to the least-loaded participant when none is eligible", () => {
    expect(selectStageParticipant(stage(reviewerA, reviewerB), {
      loads: new Map([[key(reviewerA), 2]]),
      ineligible: new Set([key(reviewerA), key(reviewerB)]),
    })).toEqual(agent(reviewerB));
  });
});

describe("applyIssueExecutionPolicyTransition with participant loads", () => {
  const policy = normalizeIssueExecutionPolicy({
    stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerA }, { type: "agent", agentId: reviewerB }] }],
  })!;
  const enterReview = (extra: Record<string, unknown>) => applyIssueExecutionPolicyTransition({
    issue: { status: "in_progress", assigneeAgentId: coder, assigneeUserId: null, executionPolicy: policy, executionState: null },
    policy,
    requestedStatus: "in_review",
    requestedAssigneePatch: {},
    actor: { agentId: coder },
    commentBody: "Ready for review",
    ...extra,
  });

  it("routes a new review to the least-busy reviewer", () => {
    const result = enterReview({ participantLoads: new Map([[key(reviewerA), 2]]) });
    expect(result.patch.assigneeAgentId).toBe(reviewerB);
  });

  it("routes to the first reviewer without loads", () => {
    expect(enterReview({}).patch.assigneeAgentId).toBe(reviewerA);
  });

  it("returns to the previous reviewer after changes requested regardless of load", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coder,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "changes_requested",
          currentStageId: policy.stages[0]!.id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: agent(reviewerA),
          returnAssignee: agent(coder),
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "changes_requested",
        },
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: coder },
      commentBody: "Addressed",
      participantLoads: new Map([[key(reviewerA), 5]]),
    });
    expect(result.patch.assigneeAgentId).toBe(reviewerA);
  });
});
