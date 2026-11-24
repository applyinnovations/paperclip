/**
 * Redaction for plugin host handler error messages (APP-335).
 *
 * `dispatchWorkerRequest` logs a failed worker-to-host call and returns the
 * error text to the worker. Handlers and the libraries they wrap can put their
 * arguments into that text: a credentialed URL from `http.fetch`, a header from
 * `new Headers()`, or bound values from drizzle's `Failed query: ... params:`.
 * Pino redaction only covers field paths, so the text is scrubbed here before it
 * reaches the logger, the JSON-RPC error, or anything that alerts on either.
 */

import { stripSecretBearingUrlParts } from "../middleware/redact-sensitive.js";
import { redactSensitiveText } from "../redaction.js";

const REDACTED = "[REDACTED]";

// An absolute URL inside prose: scheme, `://`, then everything up to
// whitespace or a quoting character.
const URL_IN_TEXT_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

// drizzle-orm `DrizzleQueryError`: "Failed query: <sql>\nparams: <values>".
// The SQL is the plugin's own statement; the params are the values it bound.
const DRIZZLE_PARAMS_RE = /^(params:)[^\n]*/gm;

export function redactPluginHostErrorMessage(message: string): string {
  const withoutUrlSecrets = message.replace(URL_IN_TEXT_RE, (url) => stripSecretBearingUrlParts(url));
  const withoutParams = withoutUrlSecrets.replace(DRIZZLE_PARAMS_RE, `$1 ${REDACTED}`);
  return redactSensitiveText(withoutParams);
}
