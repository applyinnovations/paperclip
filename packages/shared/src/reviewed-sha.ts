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
 * object id.
 *
 * One decision can cover several pull requests (an issue often has more than
 * one), so a body may carry several such lines, one per reviewed head.
 * `parseReviewedShas` returns all of them; `parseReviewedSha` keeps the older
 * single-commit reading for consumers that still expect one value.
 */

export const REVIEWED_SHA_TRAILER_KEY = "Reviewed-SHA";

const REVIEWED_SHA_LINE_RE = /^\s*reviewed-sha\s*:(.*)$/i;
const FULL_LOWERCASE_SHA_RE = /^[0-9a-f]{40}$/;

function trailerValues(body: string): string[] {
  const values: string[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    const match = REVIEWED_SHA_LINE_RE.exec(line);
    if (match) values.push(match[1]!.trim());
  }
  return values;
}

/**
 * Return the commit a decision body says was reviewed, or `null`.
 *
 * When several trailer lines are present the last one governs; if its value
 * is not a valid SHA the result is `null`. Prefer `parseReviewedShas`, which
 * keeps every reviewed commit.
 */
export function parseReviewedSha(body: string | null | undefined): string | null {
  if (!body) return null;
  const last = trailerValues(body).at(-1);
  return last !== undefined && FULL_LOWERCASE_SHA_RE.test(last) ? last : null;
}

/**
 * Return every commit a decision body says was reviewed: the valid values of
 * its trailer lines, in order of appearance, without duplicates. Lines whose
 * value is not a valid SHA name no commit and are skipped. Returns `[]` when
 * the body names no reviewed commit.
 */
export function parseReviewedShas(body: string | null | undefined): string[] {
  if (!body) return [];
  const shas: string[] = [];
  for (const value of trailerValues(body)) {
    if (FULL_LOWERCASE_SHA_RE.test(value) && !shas.includes(value)) shas.push(value);
  }
  return shas;
}
