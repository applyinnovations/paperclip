import { describe, expect, it } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import {
  applyProjectDefaultExecutionPolicy,
  normalizeProjectDefaultExecutionPolicy,
} from "../services/project-default-execution-policy.js";

const reviewerId = "11111111-1111-4111-8111-111111111111";
const approverId = "22222222-2222-4222-8222-222222222222";

const projectDefault = normalizeProjectDefaultExecutionPolicy({
  stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
})!;

describe("normalizeProjectDefaultExecutionPolicy", () => {
  it("stores stages with ids and drops stages without participants", () => {
    const normalized = normalizeProjectDefaultExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: reviewerId }, { type: "agent", agentId: reviewerId }] },
        { type: "approval", participants: [] },
      ],
    });
    expect(normalized).toEqual({
      stages: [{
        id: expect.any(String),
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: expect.any(String), type: "agent", agentId: reviewerId, userId: null }],
      }],
    });
  });

  it("returns null for no default", () => {
    expect(normalizeProjectDefaultExecutionPolicy(null)).toBeNull();
    expect(normalizeProjectDefaultExecutionPolicy({ stages: [] })).toBeNull();
  });

  it("rejects malformed participants", () => {
    expect(() => normalizeProjectDefaultExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent" }] }] }))
      .toThrow(/Invalid execution policy/);
  });

  it("preserves optional issueExecutionPolicy fields when provided and rejects invalid ones", () => {
    const normalized = normalizeProjectDefaultExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      maxReviewRounds: 4,
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    });
    expect(normalized).toMatchObject({
      mode: "normal",
      commentRequired: true,
      maxReviewRounds: 4,
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    });
    expect(() => normalizeProjectDefaultExecutionPolicy({
      maxReviewRounds: -1,
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    })).toThrow(/Invalid execution policy/);
    expect(() => normalizeProjectDefaultExecutionPolicy("not-an-object"))
      .toThrow(/Invalid default execution policy/);
  });
});

describe("applyProjectDefaultExecutionPolicy", () => {
  it("carries requireReviewedSha from the project default to the issue's review stage", () => {
    const flaggedDefault = normalizeProjectDefaultExecutionPolicy({
      stages: [{ type: "review", requireReviewedSha: true, participants: [{ type: "agent", agentId: reviewerId }] }],
    })!;
    expect(flaggedDefault.stages[0]).toMatchObject({ requireReviewedSha: true });
    expect(applyProjectDefaultExecutionPolicy(null, flaggedDefault)?.stages[0]).toMatchObject({
      type: "review",
      requireReviewedSha: true,
    });
    expect(applyProjectDefaultExecutionPolicy(null, projectDefault)?.stages[0]).not.toHaveProperty("requireReviewedSha");
  });

  it("gives an issue without a policy the project's stages, with fresh ids", () => {
    const applied = applyProjectDefaultExecutionPolicy(null, projectDefault);
    expect(applied).toMatchObject({
      mode: "normal",
      commentRequired: true,
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    });
    expect(applied!.stages[0]!.id).not.toBe(projectDefault.stages[0]!.id);
    expect(applied!.stages[0]!.participants[0]!.id).not.toBe(projectDefault.stages[0]!.participants[0]!.id);
  });

  it("keeps an issue's own stages", () => {
    const own = { stages: [{ type: "approval", participants: [{ type: "agent", agentId: approverId }] }] };
    expect(applyProjectDefaultExecutionPolicy(own, projectDefault)).toMatchObject({
      stages: [{ type: "approval", participants: [{ agentId: approverId }] }],
    });
  });

  it("adds the stages to an issue policy that has none, keeping its other fields", () => {
    const own = { monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" }, maxReviewRounds: 5 };
    expect(applyProjectDefaultExecutionPolicy(own, projectDefault)).toMatchObject({
      maxReviewRounds: 5,
      monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" },
      stages: [{ type: "review", participants: [{ agentId: reviewerId }] }],
    });
  });

  it("leaves the issue policy as it is without a project default", () => {
    const own = normalizeIssueExecutionPolicy({ maxReviewRounds: 2 });
    expect(applyProjectDefaultExecutionPolicy(own, null)).toEqual(own);
    expect(applyProjectDefaultExecutionPolicy(undefined, null)).toBeNull();
  });
});
