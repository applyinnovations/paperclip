import { describe, expect, it } from "vitest";
import {
  decideTerminalBlockerAutoWake,
  TERMINAL_BLOCKER_AUTO_WAKE,
  terminalBlockerAutoWakeHoldsCard,
  terminalBlockerAutoWakeWhyNow,
  terminalBlockerRequiresAttention,
  type TerminalBlockerAutoWakeFacts,
} from "./attention-source-eligibility.js";

const NOW = Date.parse("2026-11-28T03:00:00.000Z");
const MINUTE = 60_000;
const agentId = "11111111-1111-4111-8111-111111111111";

function facts(overrides: Partial<Omit<TerminalBlockerAutoWakeFacts, "issue">> & { issue?: Partial<TerminalBlockerAutoWakeFacts["issue"]> } = {}): TerminalBlockerAutoWakeFacts {
  const { issue, ...rest } = overrides;
  return {
    issue: { status: "in_review", statusVersion: 3, assigneeAgentId: agentId, assigneeUserId: null, reviewPolicy: null,
      executionState: null, hiddenAt: null, ...issue },
    agent: { id: agentId, name: "Code Reviewer", status: "idle", wakeOnDemand: true },
    blocksOpenWork: true,
    active: false,
    lastActivityAt: NOW - 10 * MINUTE,
    attempts: 0,
    ...rest,
  };
}

const stranded = { state: "stalled", blockingTreeLive: false };

describe("terminal blocker auto-wake gate", () => {
  it("holds the card while the first wake is not yet due, and wakes once it is", () => {
    const quiet = decideTerminalBlockerAutoWake(facts({ lastActivityAt: NOW - 2 * MINUTE }), NOW);
    expect(quiet).toMatchObject({ kind: "pending", attempt: 1, dueAt: NOW + 3 * MINUTE, overdue: false });
    expect(terminalBlockerRequiresAttention(stranded, quiet)).toBe(false);

    const due = decideTerminalBlockerAutoWake(facts({ lastActivityAt: NOW - 6 * MINUTE }), NOW);
    expect(due).toMatchObject({ kind: "pending", attempt: 1, fingerprint: `in_review.3.${agentId}` });
    expect(due.kind === "pending" && due.dueAt <= NOW).toBe(true);
    expect(terminalBlockerAutoWakeHoldsCard(due)).toBe(true);
  });

  it("backs off before the second attempt and surfaces once attempts are used up", () => {
    const second = decideTerminalBlockerAutoWake(facts({ attempts: 1, lastActivityAt: NOW - 5 * MINUTE }), NOW);
    expect(second).toMatchObject({ kind: "pending", attempt: 2, dueAt: NOW + 10 * MINUTE });

    const exhausted = decideTerminalBlockerAutoWake(facts({ attempts: TERMINAL_BLOCKER_AUTO_WAKE.maxAttempts }), NOW);
    expect(exhausted).toMatchObject({ kind: "exhausted", attempts: 2, agentName: "Code Reviewer" });
    expect(terminalBlockerRequiresAttention(stranded, exhausted)).toBe(true);
    expect(terminalBlockerAutoWakeWhyNow(exhausted)).toBe("Auto-woke Code Reviewer 2×, no progress.");
  });

  it("holds the card while a run or wake is in flight", () => {
    const active = decideTerminalBlockerAutoWake(facts({ active: true, attempts: 1 }), NOW);
    expect(active).toEqual({ kind: "active" });
    expect(terminalBlockerRequiresAttention(stranded, active)).toBe(false);
  });

  it("stops holding the card when a due wake was never sent", () => {
    const overdue = decideTerminalBlockerAutoWake(facts({ lastActivityAt: NOW - 30 * MINUTE }), NOW);
    expect(overdue).toMatchObject({ kind: "pending", overdue: true });
    expect(terminalBlockerRequiresAttention(stranded, overdue)).toBe(true);
    expect(terminalBlockerAutoWakeWhyNow(overdue)).toBe("Auto-wake of Code Reviewer is overdue.");
  });

  it.each([
    ["user-owned", facts({ issue: { assigneeAgentId: null, assigneeUserId: "user-1" } }), "user_owned"],
    ["unassigned", facts({ issue: { assigneeAgentId: null } }), "unassigned"],
    ["paused agent", facts({ agent: { id: agentId, name: "R", status: "paused", wakeOnDemand: true } }), "agent_unavailable"],
    ["errored agent", facts({ agent: { id: agentId, name: "R", status: "error", wakeOnDemand: true } }), "agent_unavailable"],
    ["terminated agent", facts({ agent: { id: agentId, name: "R", status: "terminated", wakeOnDemand: true } }), "agent_unavailable"],
    ["pending approval", facts({ agent: { id: agentId, name: "R", status: "pending_approval", wakeOnDemand: true } }), "agent_unavailable"],
    ["wake-on-demand off", facts({ agent: { id: agentId, name: "R", status: "idle", wakeOnDemand: false } }), "agent_takes_no_wakes"],
    ["cancelled blocker", facts({ issue: { status: "cancelled" } }), "not_agent_recoverable"],
    ["backlog blocker", facts({ issue: { status: "backlog" } }), "not_agent_recoverable"],
    ["human-only review", facts({ issue: { reviewPolicy: "human_only" } }), "human_review"],
    ["blocks nothing open", facts({ blocksOpenWork: false }), "not_blocking"],
  ])("needs a human right away for a %s blocker", (_label, input, reason) => {
    const state = decideTerminalBlockerAutoWake(input, NOW);
    expect(state).toEqual({ kind: "human", reason });
    expect(terminalBlockerRequiresAttention({ state: "needs_attention", blockingTreeLive: false }, state)).toBe(true);
  });

  it("wakes a todo blocker too", () => {
    expect(decideTerminalBlockerAutoWake(facts({ issue: { status: "todo" } }), NOW)).toMatchObject({ kind: "pending", attempt: 1 });
  });

  it("never surfaces a card for a live blocking tree", () => {
    expect(terminalBlockerRequiresAttention({ state: "stalled", blockingTreeLive: true }, { kind: "human", reason: "unassigned" })).toBe(false);
  });
});
