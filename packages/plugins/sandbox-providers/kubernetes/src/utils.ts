import { createHash, randomInt } from "node:crypto";

const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

// Namespace names are capped at 63 chars (RFC 1123). The default "paperclip-"
// prefix leaves 53 for the slug, which fits a full 36-char UUID untruncated.
const MAX_SLUG_LENGTH = 53;

export function deriveCompanySlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+$/, "");
  if (slug.length === 0) return "company";
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  // Never drop entropy by plain truncation: two long inputs sharing a prefix
  // (e.g. UUIDs differing only in their tail) must not map to the same slug,
  // or the tenants would share a namespace and each other's per-run Secrets.
  // Keep a readable head and append a hash of the FULL input so every byte
  // contributes to the final name.
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 8);
  return `${slug.slice(0, MAX_SLUG_LENGTH - 9).replace(/-+$/, "")}-${digest}`;
}

export function deriveNamespaceName(prefix: string, slug: string): string {
  return `${prefix}${slug}`;
}

export function newRunUlidDns(now: () => number = Date.now): string {
  const timestamp = now();
  let out = "";
  let t = timestamp;
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET[t & 0x1f] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) {
    // crypto-strength randomness: these become Job/Sandbox CR names and the
    // providerLeaseId, so they must not be enumerable.
    out += ULID_ALPHABET[randomInt(32)];
  }
  return out;
}

export interface LabelsInput {
  runId: string;
  /** The run's agent. Absent or not a valid label value: the label is omitted. */
  agentId?: string | null;
  companyId: string;
  adapterType: string;
}

// Kubernetes label values: at most 63 chars, alphanumeric at both ends, with
// '-', '_' and '.' allowed in between.
const LABEL_VALUE_RE = /^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)$/;

export function isValidLabelValue(value: string): boolean {
  return LABEL_VALUE_RE.test(value);
}

export function paperclipLabels(input: LabelsInput): Record<string, string> {
  // A wrong agent id is worse than none: Grafana groups sandbox memory and OOM
  // kills by this label. So never substitute another id; omit the label when
  // the host did not send a usable one.
  const agentId = typeof input.agentId === "string" && isValidLabelValue(input.agentId)
    ? input.agentId
    : null;
  return {
    "paperclip.io/run-id": input.runId,
    ...(agentId ? { "paperclip.io/agent-id": agentId } : {}),
    "paperclip.io/company-id": input.companyId,
    "paperclip.io/adapter": input.adapterType,
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
  };
}
