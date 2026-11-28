import { describe, expect, it } from "vitest";
import {
  assignmentGrantsRemovedActivity,
  hasAssignmentGrant,
  summarizeAssignmentGrants,
} from "../lib/assignment-grant-audit.js";

const actor = { companyId: "company-1", actorType: "user" as const, actorId: "board-user" };
const agent = { id: "agent-1", status: "idle" };

describe("summarizeAssignmentGrants", () => {
  it("keeps only sorted permission keys and assignment scope ids", () => {
    const summary = summarizeAssignmentGrants([
      { permissionKey: "tasks:assign_scope", scope: {
        projectIds: ["p2", "p1", "p2"],
        assigneeAgentId: "a1",
        userIds: ["u1"],
        allow: ["subtree:root-1", "agent:a2", "other:x"],
        token: "must-not-appear",
      } },
      { permissionKey: "agents:read", scope: { token: "must-not-appear" } },
      { permissionKey: "tasks:assign", scope: null },
    ]);

    expect(summary).toEqual({
      permissionKeys: ["agents:read", "tasks:assign", "tasks:assign_scope"],
      assignScope: {
        "tasks:assign": null,
        "tasks:assign_scope": {
          projectIds: ["p1", "p2"],
          agentIds: ["a1", "a2"],
          userIds: ["u1"],
          subtreeRootAgentIds: ["root-1"],
        },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("must-not-appear");
  });

  it("has no assignment scope without an assignment grant", () => {
    const summary = summarizeAssignmentGrants([{ permissionKey: "agents:read", scope: null }]);
    expect(summary).toEqual({ permissionKeys: ["agents:read"], assignScope: null });
    expect(hasAssignmentGrant(summary)).toBe(false);
    expect(hasAssignmentGrant(summarizeAssignmentGrants([{ permissionKey: "tasks:assign_scope" }]))).toBe(true);
  });
});

describe("assignmentGrantsRemovedActivity", () => {
  const withGrant = summarizeAssignmentGrants([{ permissionKey: "tasks:assign" }]);
  const without = summarizeAssignmentGrants([]);

  it("fires only on the transition to no assignment grant", () => {
    expect(assignmentGrantsRemovedActivity({ actor, agent, before: withGrant, after: without, sourceAction: "x" }))
      .toEqual({
        companyId: "company-1",
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        runId: null,
        agentApiKeyId: null,
        action: "agent.assignment_grants_removed",
        entityType: "agent",
        entityId: "agent-1",
        details: { before: withGrant, after: without, sourceAction: "x" },
      });
    expect(assignmentGrantsRemovedActivity({ actor, agent, before: without, after: without, sourceAction: "x" })).toBeNull();
    expect(assignmentGrantsRemovedActivity({ actor, agent, before: withGrant, after: withGrant, sourceAction: "x" })).toBeNull();
    expect(assignmentGrantsRemovedActivity({ actor, agent, before: without, after: withGrant, sourceAction: "x" })).toBeNull();
  });

  it.each(["pending_approval", "terminated"])("ignores a %s agent", (status) => {
    expect(assignmentGrantsRemovedActivity({
      actor, agent: { ...agent, status }, before: withGrant, after: without, sourceAction: "x",
    })).toBeNull();
  });

  it.each(["active", "idle", "running", "paused", "error"])("fires for a %s agent", (status) => {
    expect(assignmentGrantsRemovedActivity({
      actor, agent: { ...agent, status }, before: withGrant, after: without, sourceAction: "x",
    })).not.toBeNull();
  });

  it("ignores a missing agent", () => {
    expect(assignmentGrantsRemovedActivity({ actor, agent: null, before: withGrant, after: without, sourceAction: "x" })).toBeNull();
  });
});
