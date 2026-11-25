import { describe, expect, it } from "vitest";
import {
  EnvironmentCapacityUnavailableError,
  findEnvironmentCapacityUnavailableError,
  readEnvironmentCapacityReason,
} from "./environment-capacity-unavailable-error.js";

const envelope = (capacityUnavailable: unknown) => Object.assign(new Error("RPC failed"), {
  data: { schema: "paperclip/environment-acquire-error/v1", capacityUnavailable },
});

describe("readEnvironmentCapacityReason", () => {
  it.each(["quota", "scheduling"])("reads %s from the plugin acquire envelope", (reason) => {
    expect(readEnvironmentCapacityReason(envelope(reason))).toBe(reason);
  });

  it("reads an in-process provider's capacityUnavailable field and walks causes", () => {
    const inner = Object.assign(new Error("full"), { capacityUnavailable: "scheduling" });
    expect(readEnvironmentCapacityReason(new Error("wrapped", { cause: new Error("again", { cause: inner }) })))
      .toBe("scheduling");
  });

  it("never classifies from message text, unknown reasons or other envelopes", () => {
    expect(readEnvironmentCapacityReason(new Error("exceeded quota: paperclip-quota"))).toBeNull();
    expect(readEnvironmentCapacityReason(new Error('RPC call "environmentAcquireLease" timed out after 30000ms'))).toBeNull();
    expect(readEnvironmentCapacityReason(envelope("forever"))).toBeNull();
    expect(readEnvironmentCapacityReason(Object.assign(new Error("x"), {
      data: { schema: "other/v1", capacityUnavailable: "quota" } }))).toBeNull();
  });
});

describe("EnvironmentCapacityUnavailableError", () => {
  it("names the cause and is found through wrappers", () => {
    const error = new EnvironmentCapacityUnavailableError({ environmentId: "env-1", environmentName: "Kubernetes Sandbox", reason: "quota" });
    expect(error).toMatchObject({ code: "environment_capacity_wait", environmentId: "env-1", reason: "quota" });
    expect(error.message).toContain("tenant quota is full");
    expect(findEnvironmentCapacityUnavailableError(new Error("lease", { cause: error }))).toBe(error);
    expect(findEnvironmentCapacityUnavailableError(new Error("other"))).toBeNull();
  });

  it("explains a run queued behind older waiters", () => {
    const error = new EnvironmentCapacityUnavailableError({ environmentId: "env-1", environmentName: "Kubernetes Sandbox", reason: "queued" });
    expect(error.message).toContain("waits behind them");
  });
});
