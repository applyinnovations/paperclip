import {
  sanitizeRemoteExecutionEnv,
  serverProcessEnvKeysIn,
} from "@paperclipai/adapter-utils/remote-execution-env";

interface RemoteCommandInput {
  env?: Record<string, string>;
  environment: { id: string };
  lease: { id: string };
}

interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The environment runtime passes every command for a remote environment driver
 * (SSH, sandbox, plugin) through here before dispatch. A remote target gets
 * only the caller's own env: entries that carry the server's own process
 * environment (database URL, auth and signing secrets, provider credentials)
 * are dropped, whichever adapter or helper built the env. Only key names are
 * logged, never values. Local commands are left alone.
 */
export function withoutServerProcessEnv<T extends RemoteCommandInput>(
  driverKey: string,
  input: T,
  log: WarnLogger,
  serverEnv: NodeJS.ProcessEnv = process.env,
): T {
  if (driverKey === "local" || !input.env) return input;
  const dropped = serverProcessEnvKeysIn(input.env, serverEnv);
  if (dropped.length === 0) return input;
  log.warn(
    { driver: driverKey, environmentId: input.environment.id, leaseId: input.lease.id, droppedKeys: dropped },
    "Dropped server environment variables from a remote environment command",
  );
  return { ...input, env: sanitizeRemoteExecutionEnv(input.env, {}, { serverEnv }) };
}
