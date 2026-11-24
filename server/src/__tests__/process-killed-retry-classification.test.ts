import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "../services/recovery/service.ts";
import { readHeartbeatRunErrorFamily, readTransientRecoveryContractFromRun } from "../services/heartbeat/retries.ts";

// APP-225: a run whose agent process was SIGKILLed (exit 137, usually the
// sandbox OOM killer) is recorded as `process_killed`. It must not be retried
// as a transient upstream failure into the same command.
const killedRun = {
  id: "run-1",
  agentId: "agent-1",
  status: "failed" as const,
  error: "Claude was killed by SIGKILL (exit code 137) before it finished.",
  errorCode: "process_killed",
  resultJson: { stdout: "...", stderr: "" },
  contextSnapshot: {},
  livenessState: null,
  startedAt: new Date("2026-11-24T00:00:00.000Z"),
  createdAt: new Date("2026-11-24T00:00:00.000Z"),
};

describe("process_killed retry classification (APP-225)", () => {
  it("has no transient error family, so no bounded transient retry is scheduled", () => {
    expect(readHeartbeatRunErrorFamily(killedRun)).toBeNull();
    expect(readTransientRecoveryContractFromRun(killedRun)).toBeNull();
  });

  it("gets a single informed continuation, not the three-attempt transient lane", () => {
    expect(classifyContinuationFailure(killedRun)).toEqual({
      kind: "default",
      maxAttempts: 1,
      baseBackoffMs: 0,
      errorCode: "process_killed",
    });
  });
});
