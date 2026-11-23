import { describe, expect, it } from "vitest";
import { parseReviewedSha } from "./reviewed-sha.js";

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

describe("parseReviewedSha", () => {
  it("returns null for empty or missing bodies", () => {
    expect(parseReviewedSha(undefined)).toBeNull();
    expect(parseReviewedSha(null)).toBeNull();
    expect(parseReviewedSha("")).toBeNull();
    expect(parseReviewedSha("Looks good to me.")).toBeNull();
  });

  it("reads a trailer line anywhere in the body", () => {
    expect(parseReviewedSha(`Reviewed-SHA: ${SHA_A}`)).toBe(SHA_A);
    expect(parseReviewedSha(`Approved.\n\nReviewed-SHA: ${SHA_A}\n`)).toBe(SHA_A);
    expect(parseReviewedSha(`Approved.\r\nReviewed-SHA: ${SHA_A}\r\nThanks`)).toBe(SHA_A);
  });

  it("matches the key case-insensitively and trims whitespace", () => {
    expect(parseReviewedSha(`reviewed-sha:${SHA_A}`)).toBe(SHA_A);
    expect(parseReviewedSha(`  REVIEWED-SHA  :   ${SHA_A}  \t`)).toBe(SHA_A);
  });

  it("requires exactly 40 lowercase hex characters", () => {
    expect(parseReviewedSha(`Reviewed-SHA: ${SHA_A.slice(0, 39)}`)).toBeNull();
    expect(parseReviewedSha(`Reviewed-SHA: ${SHA_A}0`)).toBeNull();
    expect(parseReviewedSha(`Reviewed-SHA: ${SHA_A.toUpperCase()}`)).toBeNull();
    expect(parseReviewedSha(`Reviewed-SHA: ${SHA_A.slice(0, 39)}g`)).toBeNull();
    expect(parseReviewedSha(`Reviewed-SHA: ${SHA_A} extra`)).toBeNull();
    expect(parseReviewedSha("Reviewed-SHA:")).toBeNull();
  });

  it("ignores the key when it is not at the start of the line", () => {
    expect(parseReviewedSha(`Note Reviewed-SHA: ${SHA_A}`)).toBeNull();
    expect(parseReviewedSha(`> Reviewed-SHA: ${SHA_A}`)).toBeNull();
  });

  it("uses the last trailer line when several are present", () => {
    expect(parseReviewedSha(`Reviewed-SHA: ${SHA_A}\nReviewed-SHA: ${SHA_B}`)).toBe(SHA_B);
    expect(parseReviewedSha(`Reviewed-SHA: ${SHA_A}\nReviewed-SHA: not-a-sha`)).toBeNull();
  });
});
