/**
 * Reviewed-commit trailer for execution-policy decisions.
 *
 * A reviewer names the exact commit they reviewed by putting a line such as
 *
 *     Reviewed-SHA: 0123456789abcdef0123456789abcdef01234567
 *
 * in the body of their review-stage decision. The key is matched
 * case-insensitively; surrounding whitespace on the line and around the value
 * is ignored. The value must be a full 40-character lowercase hexadecimal Git
 * object id. When several such lines are present, the last one governs, so a
 * reviewer can correct an earlier line; if that last line's value is not a
 * valid SHA the decision names no reviewed commit.
 */

export const REVIEWED_SHA_TRAILER_KEY = "Reviewed-SHA";

const REVIEWED_SHA_LINE_RE = /^\s*reviewed-sha\s*:(.*)$/i;
const FULL_LOWERCASE_SHA_RE = /^[0-9a-f]{40}$/;

/** Return the commit a decision body says was reviewed, or `null`. */
export function parseReviewedSha(body: string | null | undefined): string | null {
  if (!body) return null;
  let last: string | null = null;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const match = REVIEWED_SHA_LINE_RE.exec(line);
    if (match) last = match[1]!.trim();
  }
  return last !== null && FULL_LOWERCASE_SHA_RE.test(last) ? last : null;
}
