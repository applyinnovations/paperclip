import { describe, expect, it } from "vitest";
import { shouldWakeAssigneeLeavingBlocked } from "./issue-unblock-wake.js";

const assignee = "11111111-1111-4111-8111-111111111111";
const base = { previousStatus: "blocked", statusRequested: true, actorAgentId: null, assigneeAgentId: assignee };

describe("shouldWakeAssigneeLeavingBlocked", () => {
  it.each(["todo", "in_progress", "in_review"])("wakes on blocked -> %s by another actor", (nextStatus) => {
    expect(shouldWakeAssigneeLeavingBlocked({ ...base, nextStatus })).toBe(true);
    expect(shouldWakeAssigneeLeavingBlocked({ ...base, nextStatus, actorAgentId: "other-agent" })).toBe(true);
  });

  it.each(["todo", "in_progress", "in_review"])("does not wake the assignee for its own move to %s", (nextStatus) => {
    expect(shouldWakeAssigneeLeavingBlocked({ ...base, nextStatus, actorAgentId: assignee })).toBe(false);
  });

  it.each([
    { previousStatus: "todo", nextStatus: "in_progress" },
    { previousStatus: "blocked", nextStatus: "done" },
    { previousStatus: "blocked", nextStatus: "backlog" },
  ])("ignores $previousStatus -> $nextStatus", (statuses) => {
    expect(shouldWakeAssigneeLeavingBlocked({ ...base, ...statuses })).toBe(false);
  });

  it("ignores updates without a requested status or an assignee agent", () => {
    expect(shouldWakeAssigneeLeavingBlocked({ ...base, nextStatus: "in_progress", statusRequested: false })).toBe(false);
    expect(shouldWakeAssigneeLeavingBlocked({ ...base, nextStatus: "in_progress", assigneeAgentId: null })).toBe(false);
  });
});
