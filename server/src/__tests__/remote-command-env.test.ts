import { describe, expect, it, vi } from "vitest";
import { withoutServerProcessEnv } from "../services/remote-command-env.js";

const SENTINEL = "server-only-sentinel-dispatch";
const serverEnv = {
  DATABASE_URL: `postgres://paperclip:${SENTINEL}@db/paperclip`,
  BETTER_AUTH_SECRET: SENTINEL,
  PATH: "/server/bin",
  PAPERCLIP_API_URL: "http://paperclip:3100",
};

function command(env: Record<string, string> | undefined) {
  return {
    environment: { id: "env-1" },
    lease: { id: "lease-1" },
    command: "claude",
    args: ["--print", "-"],
    env,
  };
}

describe("withoutServerProcessEnv", () => {
  it("drops server-valued entries from a remote command and logs only key names", () => {
    const log = { warn: vi.fn() };
    const out = withoutServerProcessEnv("sandbox", command({ ...serverEnv, AGENT_SETTING: "kept" }), log, serverEnv);
    expect(out.env).toEqual({ PATH: "/server/bin", PAPERCLIP_API_URL: "http://paperclip:3100", AGENT_SETTING: "kept" });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(SENTINEL);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ droppedKeys: ["DATABASE_URL", "BETTER_AUTH_SECRET"] });
  });

  it.each(["ssh", "plugin", "sandbox"])("applies to the %s driver", (driver) => {
    const out = withoutServerProcessEnv(driver, command({ ...serverEnv }), { warn: vi.fn() }, serverEnv);
    expect(JSON.stringify(out.env)).not.toContain(SENTINEL);
  });

  it("leaves local commands and clean remote commands untouched", () => {
    const log = { warn: vi.fn() };
    const local = command({ ...serverEnv });
    expect(withoutServerProcessEnv("local", local, log, serverEnv)).toBe(local);
    const clean = command({ AGENT_SETTING: "kept" });
    expect(withoutServerProcessEnv("sandbox", clean, log, serverEnv)).toBe(clean);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("strips the real process env by default", () => {
    vi.stubEnv("PAPERCLIP_TEST_SERVER_ONLY_SECRET", SENTINEL);
    try {
      const out = withoutServerProcessEnv("sandbox", command({ ...process.env } as Record<string, string>), { warn: vi.fn() });
      expect(JSON.stringify(out.env)).not.toContain(SENTINEL);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
