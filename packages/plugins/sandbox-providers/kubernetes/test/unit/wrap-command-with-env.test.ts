import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shQuote, wrapCommandWithEnv } from "../../src/pod-exec.js";

const SENTINEL = "sentinel-value-must-not-reach-argv";

function decodeEnvLine(stdin: string | undefined): string {
  const line = (stdin ?? "").split("\n", 1)[0] ?? "";
  return Buffer.from(line, "base64").toString("utf-8");
}

// Runs the wrapped command the way execInPod does: stdin bounded by `head -c`
// and piped into the command under /bin/sh.
function runLikeExecInPod(command: string[], stdin: string | undefined) {
  const bytes = Buffer.from(stdin ?? "", "utf-8");
  const script = bytes.length > 0
    ? `head -c ${bytes.length} | ${command.map(shQuote).join(" ")}`
    : command.map(shQuote).join(" ");
  return spawnSync("/bin/sh", ["-c", script], {
    input: bytes,
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
}

describe("wrapCommandWithEnv", () => {
  it("returns the command and stdin unchanged when there is no env", () => {
    expect(wrapCommandWithEnv(["opencode", "run"], undefined)).toEqual({ command: ["opencode", "run"], stdin: undefined });
    expect(wrapCommandWithEnv(["opencode", "run"], {}, "prompt")).toEqual({ command: ["opencode", "run"], stdin: "prompt" });
  });

  it("keeps env values out of the exec argv", () => {
    const out = wrapCommandWithEnv(
      ["opencode", "run", "--model", "anthropic/x"],
      { XDG_CONFIG_HOME: "/tmp/cfg", ANTHROPIC_API_KEY: SENTINEL },
      "prompt",
    );
    expect(out.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(out.command.slice(-4)).toEqual(["opencode", "run", "--model", "anthropic/x"]);
    const argv = out.command.join("\u0000");
    expect(argv).not.toContain(SENTINEL);
    expect(argv).not.toContain("/tmp/cfg");
    expect(argv).not.toContain("ANTHROPIC_API_KEY");
    expect(out.stdin).not.toContain(SENTINEL);
    expect(decodeEnvLine(out.stdin)).toContain(`export ANTHROPIC_API_KEY='${SENTINEL}'`);
    expect(out.stdin?.endsWith("\nprompt")).toBe(true);
  });

  it("never propagates PATH (would break command resolution in the sandbox image)", () => {
    const out = wrapCommandWithEnv(["opencode"], { PATH: "/server/bin", XDG_CONFIG_HOME: "/c" });
    const exports = decodeEnvLine(out.stdin);
    expect(exports).not.toContain("PATH=");
    expect(exports).toContain("XDG_CONFIG_HOME=");
  });

  it("skips invalid identifiers and non-string values", () => {
    const out = wrapCommandWithEnv(["opencode"], {
      "BAD-KEY": "x",
      GOOD_KEY: "y",
      // @ts-expect-error intentional non-string to exercise the guard
      NUMERIC: 5,
    });
    const exports = decodeEnvLine(out.stdin);
    expect(exports).toContain("export GOOD_KEY='y'");
    expect(exports).not.toContain("BAD-KEY");
    expect(exports).not.toContain("NUMERIC");
  });

  it("applies the env in the shell and passes the caller's stdin through", () => {
    const value = "a'b \"c\" $HOME `x`\nsecond line";
    const out = wrapCommandWithEnv(
      ["/bin/sh", "-c", 'printf "%s|" "$V" "$W"; cat'],
      { V: value, W: SENTINEL },
      "caller stdin\nline 2",
    );
    const result = runLikeExecInPod(out.command, out.stdin);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${value}|${SENTINEL}|caller stdin\nline 2`);
  });

  it("gives the command an empty stdin when the caller sent none", () => {
    const out = wrapCommandWithEnv(["/bin/sh", "-c", 'printf "%s|" "$V"; cat; echo end'], { V: "set" });
    const result = runLikeExecInPod(out.command, out.stdin);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("set|end\n");
  });

  it("propagates the command's exit code", () => {
    const out = wrapCommandWithEnv(["/bin/sh", "-c", "exit 7"], { V: "set" });
    expect(runLikeExecInPod(out.command, out.stdin).status).toBe(7);
  });
});
