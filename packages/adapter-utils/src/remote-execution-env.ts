// Shell identity variables. A remote target owns its own login identity, so an
// inherited host value is dropped and an explicit override is kept. These are
// compared against the caller's `inheritedEnv` baseline.
const REMOTE_EXECUTION_ENV_IDENTITY_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "NVM_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

// Terminal and locale settings. Adapters set defaults for these (TERM,
// COLORTERM, NO_COLOR, CI) that often equal the server's own value; they carry
// no secret, so an equal value is kept.
const REMOTE_EXECUTION_ENV_PRESENTATION_KEYS = new Set([
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "LANG",
  "LANGUAGE",
  "TZ",
]);

function isPresentationKey(key: string): boolean {
  return REMOTE_EXECUTION_ENV_PRESENTATION_KEYS.has(key) || key.startsWith("LC_");
}

// Values the Paperclip runtime deliberately copies from the server's own
// environment into an agent's run env (see `buildPaperclipEnv`). They are part
// of the agent contract, so an identical server value is not a leak.
const REMOTE_EXECUTION_ENV_SERVER_PUBLISHED_KEYS = new Set([
  "PAPERCLIP_API_URL",
]);

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

export interface SanitizeRemoteExecutionEnvOptions {
  /**
   * The Paperclip server's own process environment. Defaults to `process.env`.
   * Tests pass a fixture; production callers leave it unset.
   */
  serverEnv?: NodeJS.ProcessEnv;
}

function isServerProcessEnvEntry(key: string, value: string, serverEnv: NodeJS.ProcessEnv): boolean {
  if (REMOTE_EXECUTION_ENV_SERVER_PUBLISHED_KEYS.has(key) || isPresentationKey(key)) return false;
  const serverValue = serverEnv[key];
  return typeof serverValue === "string" && serverValue === value;
}

/**
 * Names of the non-identity entries in `env` that carry the server's own
 * process environment value. Use it to report what
 * {@link sanitizeRemoteExecutionEnv} drops; it never returns values.
 */
export function serverProcessEnvKeysIn(
  env: Record<string, string | undefined>,
  serverEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(key.toUpperCase())) continue;
    if (isServerProcessEnvEntry(key, value, serverEnv)) keys.push(key);
  }
  return keys;
}

/**
 * The env a remote (SSH or sandbox) execution target may receive.
 *
 * A remote target gets only the adapter's own env. The Paperclip server's
 * process environment holds the server's secrets (database URL, auth and
 * signing secrets, provider credentials), and an adapter that builds its env as
 * `{ ...process.env, ...adapterEnv }` for local spawning would otherwise ship
 * all of it to the remote target. So this drops:
 *
 * - every entry whose value is the server's own value for that key, except the
 *   keys the runtime publishes to agents on purpose (`PAPERCLIP_API_URL`) and
 *   terminal and locale settings (TERM, LANG, LC_*, ...);
 * - shell identity keys (PATH, HOME, ...) whose value equals `inheritedEnv`,
 *   so the target keeps its own login PATH and HOME. An explicit identity
 *   override is kept; pass `{}` as `inheritedEnv` to keep every identity key.
 *
 * Every remote branch in this package passes its env through here, and the
 * server applies it again where it dispatches commands to remote environment
 * drivers, so a caller that merges `process.env` cannot leak it. A sandbox
 * provider that needs a server-held credential in the sandbox gets it through
 * its own secret channel (for example a per-run pod Secret), not through the
 * command env.
 */
export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  options: SanitizeRemoteExecutionEnvOptions = {},
): Record<string, string> {
  const serverEnv = options.serverEnv ?? process.env;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (!REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(normalizedKey)) {
      if (typeof value === "string" && isServerProcessEnvEntry(key, value, serverEnv)) continue;
      sanitized[key] = value;
      continue;
    }
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue === "string" && inheritedValue === value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
