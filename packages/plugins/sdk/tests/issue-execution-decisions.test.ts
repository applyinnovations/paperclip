import { describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1, PluginIssueExecutionDecision } from "../src/types.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA_2 = "fedcba9876543210fedcba9876543210fedcba98";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-execution-decisions",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Execution Decisions",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./worker.js" },
  };
}

function issue(id: string, companyId: string): Issue {
  return { id, companyId, title: id, identifier: id.toUpperCase(), status: "in_review" } as Issue;
}

function decision(
  input: Partial<PluginIssueExecutionDecision> & Pick<PluginIssueExecutionDecision, "decisionId" | "createdAt" | "body">,
): Omit<PluginIssueExecutionDecision, "reviewedSha" | "reviewedShas"> & { reviewedSha?: string | null; reviewedShas?: string[] } {
  const { reviewedSha: _omitted, reviewedShas: _omittedList, ...rest } = {
    issueId: "issue-1",
    issueIdentifier: "ISSUE-1",
    stageId: "stage-1",
    stageType: "review" as const,
    outcome: "approved" as const,
    actorAgentId: "reviewer-1",
    actorUserId: null,
    ...input,
  };
  return {
    ...rest,
    ...("reviewedSha" in input ? { reviewedSha: input.reviewedSha } : {}),
    ...("reviewedShas" in input ? { reviewedShas: input.reviewedShas } : {}),
  };
}

describe("ctx.issues.listExecutionDecisions in the test harness", () => {
  it("returns seeded decisions oldest first and derives reviewedSha from the body", async () => {
    const harness = createTestHarness({ manifest: manifest(["issues.read"]) });
    harness.seed({
      issues: [issue("issue-1", "company-1")],
      issueExecutionDecisions: [
        decision({ decisionId: "d2", createdAt: "2026-11-02T00:00:00.000Z", body: `LGTM\nReviewed-SHA: ${SHA}` }),
        decision({
          decisionId: "d1",
          createdAt: "2026-11-01T00:00:00.000Z",
          outcome: "changes_requested",
          body: "Needs tests",
        }),
      ],
    });

    const decisions = await harness.ctx.issues.listExecutionDecisions("issue-1", "company-1");
    expect(decisions.map((row) => [row.decisionId, row.outcome, row.reviewedShas, row.reviewedSha])).toEqual([
      ["d1", "changes_requested", [], null],
      ["d2", "approved", [SHA], SHA],
    ]);
  });

  it("derives every reviewed SHA when one decision names several heads", async () => {
    const harness = createTestHarness({ manifest: manifest(["issues.read"]) });
    harness.seed({
      issues: [issue("issue-1", "company-1")],
      issueExecutionDecisions: [
        decision({
          decisionId: "d1",
          createdAt: "2026-11-01T00:00:00.000Z",
          body: `Both PRs approved.\nReviewed-SHA: ${SHA}\nReviewed-SHA: ${SHA_2}`,
        }),
      ],
    });
    const [row] = await harness.ctx.issues.listExecutionDecisions("issue-1", "company-1");
    expect(row?.reviewedShas).toEqual([SHA, SHA_2]);
    expect(row?.reviewedSha).toBe(SHA_2);
  });

  it("keeps explicitly seeded reviewedSha and reviewedShas", async () => {
    const harness = createTestHarness({ manifest: manifest(["issues.read"]) });
    harness.seed({
      issues: [issue("issue-1", "company-1")],
      issueExecutionDecisions: [
        decision({
          decisionId: "d1",
          createdAt: "2026-11-01T00:00:00.000Z",
          body: "no trailer",
          reviewedSha: SHA,
          reviewedShas: [SHA, SHA_2],
        }),
      ],
    });
    const [row] = await harness.ctx.issues.listExecutionDecisions("issue-1", "company-1");
    expect(row?.reviewedSha).toBe(SHA);
    expect(row?.reviewedShas).toEqual([SHA, SHA_2]);
  });

  it("returns nothing for another company's issue", async () => {
    const harness = createTestHarness({ manifest: manifest(["issues.read"]) });
    harness.seed({
      issues: [issue("issue-1", "company-1")],
      issueExecutionDecisions: [decision({ decisionId: "d1", createdAt: "2026-11-01T00:00:00.000Z", body: "ok" })],
    });
    await expect(harness.ctx.issues.listExecutionDecisions("issue-1", "company-2")).resolves.toEqual([]);
  });

  it("requires the issues.read capability", async () => {
    const harness = createTestHarness({ manifest: manifest([]) });
    await expect(harness.ctx.issues.listExecutionDecisions("issue-1", "company-1")).rejects.toThrow(/issues\.read/);
  });
});

describe("issues.listExecutionDecisions host handler", () => {
  it("is gated on issues.read and the invocation company", async () => {
    const listExecutionDecisions = vi.fn(async () => []);
    const services = { issues: { listExecutionDecisions } } as unknown as HostServices;

    const denied = createHostClientHandlers({ pluginId: "paperclip.test", capabilities: [], services });
    await expect(
      denied["issues.listExecutionDecisions"]({ issueId: "issue-1", companyId: "company-1" }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);

    const handlers = createHostClientHandlers({ pluginId: "paperclip.test", capabilities: ["issues.read"], services });
    await expect(
      handlers["issues.listExecutionDecisions"](
        { issueId: "issue-1", companyId: "company-2" },
        { invocationScope: { companyId: "company-1" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(listExecutionDecisions).not.toHaveBeenCalled();

    await expect(
      handlers["issues.listExecutionDecisions"](
        { issueId: "issue-1", companyId: "company-1" },
        { invocationScope: { companyId: "company-1" } },
      ),
    ).resolves.toEqual([]);
    expect(listExecutionDecisions).toHaveBeenCalledWith({ issueId: "issue-1", companyId: "company-1" });
  });
});
