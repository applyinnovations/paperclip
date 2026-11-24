import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import {
  findListeningProcessPid,
  findMissingHotRestartSnapshotRunIds,
  isObservedHotRestartTargetAlive,
  parseHotRestartIntent,
  readHotRestartIntent,
  readProcessStartedAt,
  removeHotRestartIntent,
  resolveHotRestartIntentPath,
  resolveLegacyHotRestartIntentPath,
  writeHotRestartIntent,
} from "./hot-restart.js";

const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
});

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-paths-"));
  try {
    return await fn(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

describe("hot-restart path compatibility", () => {
  it("reads version-1 native recovery fields without making them mandatory", () => {
    expect(
      parseHotRestartIntent({
        version: 1,
        requestedAt: "2026-09-04T10:00:00.000Z",
        recoveryRequestId: "restart-request-1",
        previousServerPid: 123,
        drainRequired: false,
        requestedByRunId: null,
        preflightActiveRunIds: ["run-1"],
        shutdownSnapshot: {
          capturedAt: "2026-09-04T10:00:01.000Z",
          signal: "SIGTERM",
          activeRuns: [
            {
              runId: "run-1",
              companyId: "company-1",
              agentId: "agent-1",
              adapterType: "paperclip_runner",
              status: "running",
              processPid: 456,
              processGroupId: 456,
              issueId: "issue-1",
              runtimeMode: "native",
              nativeSessionId: "session-1",
              runnerInstanceId: "runner-1",
              processStartedAt: "2026-09-04T09:59:00.000Z",
            },
          ],
        },
      }),
    ).toMatchObject({
      version: 1,
      recoveryRequestId: "restart-request-1",
      shutdownSnapshot: {
        activeRuns: [
          {
            runtimeMode: "native",
            nativeSessionId: "session-1",
            runnerInstanceId: "runner-1",
            processStartedAt: "2026-09-04T09:59:00.000Z",
          },
        ],
      },
    });

    expect(
      parseHotRestartIntent({
        version: 1,
        requestedAt: "2026-09-04T10:00:00.000Z",
        previousServerPid: 123,
        drainRequired: false,
        requestedByRunId: null,
        preflightActiveRunIds: [],
      }),
    ).not.toBeNull();
  });

  it("reads Linux process birth from kernel ticks rather than proc directory metadata", async () => {
    await expect(
      readProcessStartedAt(123, {
        platform: "linux",
        linuxProcessStart: {
          clockTicksPerSecond: 100,
          readFile: (target) => target === "/proc/stat"
            ? `btime ${Date.parse("2026-08-01T01:00:00.000Z") / 1000}\n`
            : target === "/proc/123/stat"
              ? `123 (runner) S ${Array(18).fill("0").join(" ")} 123\n`
              : (() => { throw new Error("Unexpected proc read"); })(),
        },
      }),
    ).resolves.toBe("2026-08-01T01:00:01.230Z");
  });

  it("reads macOS process start time through ps", async () => {
    await expect(
      readProcessStartedAt(456, {
        platform: "darwin",
        runCommand: async (command, args) => {
          expect([command, ...args]).toEqual([
            "ps",
            "-o",
            "lstart=",
            "-p",
            "456",
          ]);
          return "Fri Aug  1 01:02:03 2026\n";
        },
      }),
    ).resolves.toBe(new Date("Fri Aug  1 01:02:03 2026").toISOString());
  });

  it("reads Windows process start time through PowerShell", async () => {
    await expect(
      readProcessStartedAt(789, {
        platform: "win32",
        runCommand: async (command, args) => {
          expect(command).toBe("powershell.exe");
          expect(args.at(-1)).toContain("Get-Process -Id 789");
          return "2026-08-01T01:02:03.456Z\r\n";
        },
      }),
    ).resolves.toBe("2026-08-01T01:02:03.456Z");
  });

  it("falls back from Windows PowerShell to pwsh", async () => {
    const commands: string[] = [];
    await expect(
      readProcessStartedAt(790, {
        platform: "win32",
        runCommand: async (command) => {
          commands.push(command);
          if (command === "powershell.exe") throw new Error("not installed");
          return "2026-08-01T01:02:04.000Z\n";
        },
      }),
    ).resolves.toBe("2026-08-01T01:02:04.000Z");
    expect(commands).toEqual(["powershell.exe", "pwsh.exe"]);
  });

  it("surfaces supported-platform process identity probe failures", async () => {
    await expect(readProcessStartedAt(791, {
      platform: "darwin",
      runCommand: async () => {
        throw new Error("ps unavailable");
      },
    })).rejects.toThrow("ps unavailable");
  });

  it("distinguishes recycled PIDs and rejects unknown live claim classification", () => {
    const intent = {
      version: 1 as const,
      requestedAt: "2026-08-01T01:05:00.000Z",
      previousServerPid: 123,
      previousServerIdentity: "server-boot-a",
      previousServerStartedAt: "2026-08-01T01:00:00.000Z",
      previousServerVersion: "old-version",
      drainRequired: false,
      requestedByRunId: null,
      preflightActiveRunIds: [],
    };

    expect(isObservedHotRestartTargetAlive(intent, {
      alive: true,
      startedAt: "2026-08-01T01:00:00.000Z",
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "server-boot-a",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(intent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "server-boot-b",
      },
    })).toBe(false);

    const legacyIntent = {
      ...intent,
      previousServerIdentity: null,
      previousServerStartedAt: null,
    };
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: "2026-08-01T01:06:00.000Z",
    })).toBe(false);
    expect(() => isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
    })).toThrow("Cannot establish process identity");
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "2026-08-01T01:04:00.000Z",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: "2026-08-01T01:06:00.000Z",
      },
    })).toBe(false);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: null,
        previousServerStartedAt: "2026-08-01T01:04:00.000Z",
      },
    })).toBe(true);
    expect(isObservedHotRestartTargetAlive(legacyIntent, {
      alive: true,
      startedAt: null,
      replacement: {
        previousServerPid: 123,
        previousServerIdentity: null,
        previousServerStartedAt: "2026-08-01T01:06:00.000Z",
      },
    })).toBe(false);
  });

  it("refuses to create an unidentifiable process claim", async () => {
    await withTempHome(async (homeDir) => {
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: null,
      })).rejects.toThrow("process start time are unavailable");

      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(resolveLegacyHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reclaims a live recycled PID when server boot identities differ", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        previousServerIdentity: "server-boot-a",
        requestedByRunId: "blue-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        previousServerIdentity: "server-boot-b",
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({
        previousServerIdentity: "server-boot-b",
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("writes both paths but does not merge a legacy snapshot from another request", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "blue";

    await withTempHome(async (homeDir) => {
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 101,
        previousServerStartedAt: "2026-08-01T01:00:00.000Z",
        requestedAt: new Date("2026-08-01T02:00:00.000Z"),
        requestedByRunId: "blue-deploy",
        preflightActiveRunIds: ["blue-run"],
      });
      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).resolves.toBeDefined();
      await expect(fs.stat(resolveLegacyHotRestartIntentPath(homeDir))).resolves.toBeDefined();

      const unrelatedLegacyIntent = {
        version: 1,
        requestedAt: "2026-08-01T02:00:01.000Z",
        previousServerPid: 202,
        previousServerVersion: "other-instance",
        drainRequired: false,
        requestedByRunId: "other-deploy",
        shutdownSnapshot: {
          capturedAt: "2026-08-01T02:00:02.000Z",
          signal: "SIGTERM",
          activeRuns: [],
        },
      };
      await fs.writeFile(
        resolveLegacyHotRestartIntentPath(homeDir),
        `${JSON.stringify(unrelatedLegacyIntent, null, 2)}\n`,
        "utf8",
      );

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: 101,
        requestedByRunId: "blue-deploy",
        preflightActiveRunIds: ["blue-run"],
      });
      expect((await readHotRestartIntent(homeDir))?.shutdownSnapshot).toBeUndefined();
    });
  });

  it("does not let a non-default instance consume an uncorrelated legacy-only marker", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "green";

    await withTempHome(async (homeDir) => {
      await fs.writeFile(
        resolveLegacyHotRestartIntentPath(homeDir),
        `${JSON.stringify({
          version: 1,
          requestedAt: "2026-08-01T03:00:00.000Z",
          previousServerPid: 303,
          previousServerVersion: "legacy",
          drainRequired: false,
          requestedByRunId: null,
        })}\n`,
        "utf8",
      );

      await expect(readHotRestartIntent(homeDir)).resolves.toBeNull();
    });
  });

  it("ignores a malformed legacy marker when the instance marker is valid", async () => {
    process.env.PAPERCLIP_INSTANCE_ID = "blue";

    await withTempHome(async (homeDir) => {
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 304,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:30:00.000Z"),
        preflightActiveRunIds: ["blue-run"],
      });
      await fs.writeFile(resolveLegacyHotRestartIntentPath(homeDir), "not-json", "utf8");

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: 304,
        preflightActiveRunIds: ["blue-run"],
      });
    });
  });

  it("does not overwrite another instance's active legacy handoff", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2026-08-01T03:40:00.000Z"),
        requestedByRunId: "blue-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: 502,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:40:01.000Z"),
        requestedByRunId: "green-deploy",
      })).rejects.toMatchObject({ code: "EEXIST" });

      const legacyIntent = JSON.parse(
        await fs.readFile(resolveLegacyHotRestartIntentPath(homeDir), "utf8"),
      ) as Record<string, unknown>;
      expect(legacyIntent).toMatchObject({
        previousServerPid: process.pid,
        requestedByRunId: "blue-deploy",
      });
      await expect(fs.stat(resolveHotRestartIntentPath(homeDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reclaims an abandoned legacy handoff after its target process exits", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:50:00.000Z"),
        requestedByRunId: "abandoned-deploy",
      });

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2026-08-01T03:51:00.000Z"),
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({ requestedByRunId: "green-deploy" });

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        previousServerPid: process.pid,
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("reclaims an abandoned handoff when its PID belongs to a newer process", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date("2020-01-01T00:00:00.000Z"),
        requestedByRunId: "expired-deploy",
      });
      const legacyPath = resolveLegacyHotRestartIntentPath(homeDir);
      const legacyIntent = JSON.parse(
        await fs.readFile(legacyPath, "utf8"),
      ) as Record<string, unknown>;
      delete legacyIntent.previousServerStartedAt;
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify(legacyIntent, null, 2)}\n`,
        "utf8",
      );

      process.env.PAPERCLIP_INSTANCE_ID = "green";
      await expect(writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedByRunId: "green-deploy",
      })).resolves.toMatchObject({ requestedByRunId: "green-deploy" });

      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        requestedByRunId: "green-deploy",
      });
    });
  });

  it("keeps an old handoff while its original target process is alive", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      await writeHotRestartIntent({
        homeDir,
        previousServerPid: process.pid,
        requestedAt: new Date(),
        requestedByRunId: "blue-deploy",
      });

      vi.useFakeTimers({ now: Date.now() + 10 * 60_000 });
      try {
        process.env.PAPERCLIP_INSTANCE_ID = "green";
        await expect(writeHotRestartIntent({
          homeDir,
          previousServerPid: process.pid,
          requestedByRunId: "green-deploy",
        })).rejects.toMatchObject({ code: "EEXIST" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not let matching cleanup delete replacement intent markers", async () => {
    await withTempHome(async (homeDir) => {
      process.env.PAPERCLIP_INSTANCE_ID = "blue";
      const abandonedIntent = await writeHotRestartIntent({
        homeDir,
        previousServerPid: 2_147_483_647,
        previousServerStartedAt: "2026-08-01T03:00:00.000Z",
        requestedAt: new Date("2026-08-01T03:55:00.000Z"),
        requestedByRunId: "abandoned-deploy",
      });

      await Promise.all([
        removeHotRestartIntent(homeDir, abandonedIntent),
        writeHotRestartIntent({
          homeDir,
          previousServerPid: process.pid,
          requestedAt: new Date("2026-08-01T03:56:00.000Z"),
          requestedByRunId: "replacement-deploy",
        }),
      ]);

      const legacyIntent = JSON.parse(
        await fs.readFile(resolveLegacyHotRestartIntentPath(homeDir), "utf8"),
      ) as Record<string, unknown>;
      expect(legacyIntent).toMatchObject({ requestedByRunId: "replacement-deploy" });
      await expect(readHotRestartIntent(homeDir)).resolves.toMatchObject({
        requestedByRunId: "replacement-deploy",
      });
    });
  });

  it("treats every preflight run omitted from the shutdown snapshot as missing", () => {
    expect(findMissingHotRestartSnapshotRunIds({
      version: 1,
      requestedAt: "2026-08-01T04:00:00.000Z",
      previousServerPid: 404,
      previousServerVersion: "old-version",
      drainRequired: false,
      requestedByRunId: null,
      preflightActiveRunIds: ["captured-run", "missing-run"],
      shutdownSnapshot: {
        capturedAt: "2026-08-01T04:00:01.000Z",
        signal: "SIGTERM",
        activeRuns: [{
          runId: "captured-run",
          companyId: "company",
          agentId: "agent",
          adapterType: "codex_local",
          status: "running",
          processPid: 405,
          processGroupId: null,
          issueId: "issue",
        }],
      },
    })).toEqual(["missing-run"]);
  });
});

describe("findListeningProcessPid", () => {
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  // 0x0C1C = 3100. State 0A is LISTEN, 01 is ESTABLISHED.
  const listen3100 = "   0: 00000000:0C1C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0 100 0 0 10 0\n";
  const client3100 = "   1: 0100007F:0C1C 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 5151 1 0 20 4 30 10 -1\n";

  async function withProcFixture<T>(
    layout: { tcp?: string; tcp6?: string; fds: Record<string, string[]> },
    fn: (procRoot: string) => Promise<T>,
  ) {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-proc-fixture-"));
    try {
      await fs.mkdir(path.join(procRoot, "net"));
      if (layout.tcp !== undefined) await fs.writeFile(path.join(procRoot, "net", "tcp"), header + layout.tcp);
      if (layout.tcp6 !== undefined) await fs.writeFile(path.join(procRoot, "net", "tcp6"), header + layout.tcp6);
      await fs.mkdir(path.join(procRoot, "self"));
      for (const [pid, targets] of Object.entries(layout.fds)) {
        const fdDir = path.join(procRoot, pid, "fd");
        await fs.mkdir(fdDir, { recursive: true });
        for (const [index, target] of targets.entries()) {
          await fs.symlink(target, path.join(fdDir, String(index)));
        }
      }
      return await fn(procRoot);
    } finally {
      await fs.rm(procRoot, { recursive: true, force: true });
    }
  }

  it("returns the process holding the listening socket, not a client of the port", async () => {
    await withProcFixture({
      tcp: listen3100 + client3100,
      tcp6: "",
      fds: {
        "1": ["/dev/null"],
        "7": ["/dev/null", "socket:[4242]"],
        "12": ["socket:[5151]"],
      },
    }, async (procRoot) => {
      await expect(findListeningProcessPid(3100, { procRoot, platform: "linux" })).resolves.toBe(7);
    });
  });

  it("finds an IPv6 listener", async () => {
    await withProcFixture({
      tcp: "",
      tcp6: "   0: 00000000000000000000000000000000:0C1C 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9001 1 0 100 0 0 10 0\n",
      fds: { "8": ["socket:[9001]"] },
    }, async (procRoot) => {
      await expect(findListeningProcessPid(3100, { procRoot, platform: "linux" })).resolves.toBe(8);
    });
  });

  it("fails when nothing listens, when the owner is not visible, or when several processes listen", async () => {
    await withProcFixture({ tcp: client3100, fds: { "12": ["socket:[5151]"] } }, async (procRoot) => {
      await expect(findListeningProcessPid(3100, { procRoot, platform: "linux" }))
        .rejects.toThrow("No process is listening on TCP port 3100");
    });
    await withProcFixture({ tcp: listen3100, fds: { "1": ["/dev/null"] } }, async (procRoot) => {
      await expect(findListeningProcessPid(3100, { procRoot, platform: "linux" }))
        .rejects.toThrow("no process visible to this user holds it");
    });
    await withProcFixture({ tcp: listen3100, fds: { "7": ["socket:[4242]"], "9": ["socket:[4242]"] } }, async (procRoot) => {
      await expect(findListeningProcessPid(3100, { procRoot, platform: "linux" }))
        .rejects.toThrow("More than one process listens on TCP port 3100 (7, 9)");
    });
  });

  it("refuses to guess off Linux", async () => {
    await expect(findListeningProcessPid(3100, { platform: "darwin" })).rejects.toThrow("needs Linux /proc");
  });

  it.runIf(process.platform === "linux")("resolves this process from a real listener", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      await expect(findListeningProcessPid(port)).resolves.toBe(process.pid);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
