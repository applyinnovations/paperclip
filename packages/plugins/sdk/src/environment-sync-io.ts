/**
 * Host-mediated sync I/O for environment-driver plugins.
 *
 * An `environmentSyncIn` / `environmentSyncOut` call hands a plugin host paths
 * in its {@link PluginSyncFileMapping}s. A sandboxed worker cannot open those
 * paths, and no static grant can be confined to per-run workspaces. Instead the
 * host does the host-side half of every mapping: during the call the plugin
 * streams a mapping's host source out of the host (sync-in), or streams entries
 * into a mapping's host target (sync-out). The plugin names a mapping by its
 * index within the current call, never by path. The host mints a handle per call,
 * binds it to the plugin, the company and the call, and drops it when the call
 * returns.
 *
 * This module holds the parts both sides share: the entry and wire types, the
 * structured error, the archive-member confinement check (also used by the
 * Kubernetes provider), exclude matching, and the worker-side client. The host
 * engine that touches the filesystem lives in `environment-sync-io-host.ts`.
 *
 * @see doc/plugins/SANDBOX_FILE_SYNC_HOOKS.md — "Host-mediated sync I/O"
 */

import path from "node:path";
import type { PluginSyncFileMapping } from "./protocol.js";

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

/**
 * Which mapping of the current call to read or write. `operationIndex` indexes
 * `params.operations`, `fileIndex` indexes that operation's `files`.
 */
export interface PluginSyncMappingRef {
  operationIndex: number;
  fileIndex: number;
}

/** Entry kinds the host streams and accepts. Hardlinks, devices, FIFOs and sockets are not entries. */
export type PluginSyncEntryType = "directory" | "file" | "symlink";

/**
 * One entry of a mapping's tree.
 *
 * `path` is POSIX and relative to the mapping root. A `kind: "file"` mapping
 * carries exactly one `file` entry whose `path` is `""` (the mapping itself). A
 * `kind: "directory"` mapping never carries an entry for its own root.
 */
export type PluginSyncEntry =
  | { type: "directory"; path: string; mode: number; mtimeMs: number }
  | { type: "file"; path: string; mode: number; mtimeMs: number; size: number }
  | { type: "symlink"; path: string; mode: number; mtimeMs: number; linkname: string };

/** Entry header as sent to the host; a file's size is implied by its content. */
export type PluginSyncEntryHeader =
  | { type: "directory"; path: string; mode: number; mtimeMs: number }
  | { type: "file"; path: string; mode: number; mtimeMs: number; size?: number }
  | { type: "symlink"; path: string; mode: number; mtimeMs: number; linkname: string };

/**
 * A source entry streamed out of the host. For a `file` entry, read `content`
 * before advancing the iterator; unread bytes are skipped when you advance.
 */
export type PluginSyncSourceEntry =
  | Extract<PluginSyncEntry, { type: "directory" | "symlink" }>
  | (Extract<PluginSyncEntry, { type: "file" }> & { content: AsyncIterable<Uint8Array> });

/** File content accepted by {@link PluginEnvironmentSyncHostIo.writeTarget}. */
export type PluginSyncContent = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** An entry to write into a mapping's host target. */
export type PluginSyncTargetEntry =
  | Extract<PluginSyncEntryHeader, { type: "directory" | "symlink" }>
  | (Extract<PluginSyncEntryHeader, { type: "file" }> & { content: PluginSyncContent });

export interface PluginSyncWriteResult {
  /** Non-directory entries written (files and symlinks). */
  filesWritten: number;
  /** File content bytes written. */
  bytesWritten: number;
}

/**
 * The host I/O API passed as the second argument to `onEnvironmentSyncIn` and
 * `onEnvironmentSyncOut`. It is valid only while that call runs.
 */
export interface PluginEnvironmentSyncHostIo {
  /**
   * False when the host minted no handle for this call (an older host, or a
   * caller that declared no host roots). Every method then fails with
   * `PluginSyncIoError` code `"unavailable"`.
   */
  readonly available: boolean;
  /**
   * Sync-in only. Stream the entries of the mapping's host source, honouring
   * its `exclude` and `followSymlinks` exactly as the contract describes.
   * Directories come before their children; siblings are sorted by name.
   */
  readSource(ref: PluginSyncMappingRef): AsyncIterable<PluginSyncSourceEntry>;
  /**
   * Sync-out only. Apply an entry stream to the mapping's host target with the
   * contract semantics: a `kind: "file"` mapping takes exactly one `file` entry
   * (path `""`) and is replaced atomically; a `kind: "directory"` mapping is
   * destroy-then-replace. Nothing at the target changes unless the whole stream
   * is accepted.
   */
  writeTarget(
    ref: PluginSyncMappingRef,
    entries: Iterable<PluginSyncTargetEntry> | AsyncIterable<PluginSyncTargetEntry>,
  ): Promise<PluginSyncWriteResult>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Structured refusal codes. Every refusal is final: nothing retries the transfer
 * through an unsandboxed path.
 *
 * - `unavailable`: no host I/O for this call.
 * - `invalid_handle`: unknown, expired, or another plugin's or call's handle.
 * - `invalid_mapping`: no such mapping index, or the host path is not of the mapping's kind.
 * - `wrong_direction`: reading a sync-out mapping or writing a sync-in mapping.
 * - `confinement`: a host path, root or followed symlink leaves its allowed root.
 * - `protected_path`: a host root is, contains, or sits inside a protected path.
 * - `unsafe_member`: a written entry has an unsafe name, link target or position.
 * - `unsupported_entry`: a hardlink, device, FIFO or other special entry.
 * - `limit`: a size or count bound was exceeded.
 * - `protocol`: a malformed request or record.
 * - `io`: a filesystem error on the host.
 */
export type PluginSyncIoErrorCode =
  | "unavailable"
  | "invalid_handle"
  | "invalid_mapping"
  | "wrong_direction"
  | "confinement"
  | "protected_path"
  | "unsafe_member"
  | "unsupported_entry"
  | "limit"
  | "protocol"
  | "io";

const SYNC_IO_ERROR_CODES: ReadonlySet<string> = new Set<PluginSyncIoErrorCode>([
  "unavailable", "invalid_handle", "invalid_mapping", "wrong_direction", "confinement",
  "protected_path", "unsafe_member", "unsupported_entry", "limit", "protocol", "io",
]);

export class PluginSyncIoError extends Error {
  override readonly name = "PluginSyncIoError";
  readonly syncIoCode: PluginSyncIoErrorCode;

  constructor(code: PluginSyncIoErrorCode, message: string) {
    super(message);
    this.syncIoCode = code;
  }

  /** Structured JSON-RPC error data; the host attaches it to the error response. */
  get rpcErrorData(): { syncIoError: { code: PluginSyncIoErrorCode } } {
    return { syncIoError: { code: this.syncIoCode } };
  }
}

/** Rebuild a `PluginSyncIoError` from a JSON-RPC error carrying sync I/O data. */
export function toPluginSyncIoError(error: unknown): unknown {
  if (error instanceof PluginSyncIoError) return error;
  const data = (error as { data?: unknown } | null)?.data;
  const code = (data as { syncIoError?: { code?: unknown } } | null)?.syncIoError?.code;
  if (typeof code === "string" && SYNC_IO_ERROR_CODES.has(code)) {
    return new PluginSyncIoError(code as PluginSyncIoErrorCode, error instanceof Error ? error.message : String(error));
  }
  return error;
}

// ---------------------------------------------------------------------------
// Archive-member confinement (shared with the Kubernetes provider)
// ---------------------------------------------------------------------------

/**
 * True when `relative` (a POSIX path) escapes its anchoring directory once
 * normalized: an absolute path, `..`, or a `..`-leading traversal all break out.
 */
export function posixPathEscapes(relative: string): boolean {
  const normalized = path.posix.normalize(relative);
  return normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized);
}

/**
 * Return why an archive member would land outside its extraction root, or null
 * when it is confined. The member `name` must not be absolute or traverse out
 * with `..`; a link member's target, resolved against the member's directory,
 * must not be absolute or escape the root. Legitimate in-tree relative links
 * pass. This is the single policy the Kubernetes provider applies to
 * sandbox-authored tarballs and the host applies to sync-out entry streams.
 */
export function findArchiveMemberEscape(member: { name: string; linkTarget?: string | null }): string | null {
  const cleanName = member.name.replace(/\/+$/, "");
  if (cleanName.length > 0 && posixPathEscapes(cleanName)) {
    return `member escapes the extraction dir: ${member.name}`;
  }
  const linkTarget = member.linkTarget;
  if (linkTarget !== null && linkTarget !== undefined) {
    const resolved = path.posix.join(path.posix.dirname(cleanName), linkTarget);
    if (path.posix.isAbsolute(linkTarget) || posixPathEscapes(resolved)) {
      return `link target escapes the extraction dir: ${member.name} -> ${linkTarget}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exclude matching
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") source += "[\\s\\S]*";
    else if (char === "?") source += "[\\s\\S]";
    else if (char === "\\" && i + 1 < pattern.length) source += escapeRegExp(pattern[++i]);
    else if (char === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) { source += "\\["; continue; }
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      source += `[${negate ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/]/g, "\\]")}]`;
      i = close;
    } else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Build the exclude predicate for a mapping, over root-relative POSIX paths.
 *
 * - Default: tar's `--exclude` semantics, as the contract's tar path applies
 *   them. Each pattern is a wildcard (`*` also matches `/`) that may start
 *   after any `/` and end at any `/` of the path, so `node_modules` excludes
 *   `a/node_modules/x`. `._*` (AppleDouble sidecars) is always excluded.
 * - `preserveSourceEntries` (sync-out only): `exclude` holds literal
 *   root-relative paths; a path is excluded when it equals one or sits inside
 *   one. `._*` names are kept.
 *
 * An excluded directory excludes its whole subtree.
 */
export function createSyncExcludeMatcher(
  mapping: Pick<PluginSyncFileMapping, "exclude" | "preserveSourceEntries">,
  direction: "in" | "out",
): (relativePath: string) => boolean {
  const preserve = direction === "out" && mapping.preserveSourceEntries === true;
  if (preserve) {
    const literals = new Set(
      (mapping.exclude ?? [])
        .map((entry) => entry.replace(/^(?:\.\/)+/, "").replace(/\/+$/, ""))
        .filter((entry) => entry.length > 0),
    );
    return (relativePath) => {
      for (let current = relativePath; current.length > 0; current = path.posix.dirname(current)) {
        if (literals.has(current)) return true;
        if (!current.includes("/")) break;
      }
      return false;
    };
  }
  const patterns = ["._*", ...(mapping.exclude ?? [])].map(globToRegExp);
  return (relativePath) => {
    // Unanchored (any start after a `/`) and leading-dir (any end at a `/`),
    // like GNU tar's default `--exclude` matching.
    const bounds = [0];
    for (let i = relativePath.indexOf("/"); i !== -1; i = relativePath.indexOf("/", i + 1)) bounds.push(i);
    const starts = bounds.map((bound, index) => (index === 0 ? 0 : bound + 1));
    const ends = [...bounds.slice(1), relativePath.length];
    for (const start of starts) {
      for (const end of ends) {
        if (end <= start) continue;
        const candidate = relativePath.slice(start, end);
        if (patterns.some((pattern) => pattern.test(candidate))) return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/**
 * One record of an entry stream on the wire. An `entry` record starts an entry;
 * the `data` records that follow a `file` entry carry its bytes (base64) until
 * the next `entry` record or the end of the stream.
 */
export type PluginSyncWireRecord =
  | { entry: PluginSyncEntryHeader }
  | { data: string };

/** Worker→host method names of the sync I/O API. */
export const ENVIRONMENT_SYNC_IO_METHODS = [
  "environmentSync.openSource",
  "environmentSync.readSource",
  "environmentSync.openTarget",
  "environmentSync.writeTarget",
  "environmentSync.finishTarget",
  "environmentSync.closeStream",
] as const;

export type EnvironmentSyncIoMethodName = (typeof ENVIRONMENT_SYNC_IO_METHODS)[number];

export interface EnvironmentSyncIoMethods {
  "environmentSync.openSource": [
    params: { handle: string } & PluginSyncMappingRef,
    result: { streamId: string },
  ];
  "environmentSync.readSource": [
    params: { handle: string; streamId: string },
    result: { records: PluginSyncWireRecord[]; done: boolean },
  ];
  "environmentSync.openTarget": [
    params: { handle: string } & PluginSyncMappingRef,
    result: { streamId: string },
  ];
  "environmentSync.writeTarget": [
    params: { handle: string; streamId: string; records: PluginSyncWireRecord[] },
    result: { accepted: number },
  ];
  "environmentSync.finishTarget": [
    params: { handle: string; streamId: string },
    result: PluginSyncWriteResult,
  ];
  "environmentSync.closeStream": [
    params: { handle: string; streamId: string },
    result: { closed: boolean },
  ];
}

/** Raw bytes per `data` record. */
export const SYNC_IO_CHUNK_BYTES = 256 * 1024;
/** Raw bytes per worker→host batch (one RPC). */
export const SYNC_IO_BATCH_BYTES = 1024 * 1024;

export type EnvironmentSyncIoTransport = <M extends EnvironmentSyncIoMethodName>(
  method: M,
  params: EnvironmentSyncIoMethods[M][0],
) => Promise<EnvironmentSyncIoMethods[M][1]>;

// ---------------------------------------------------------------------------
// Worker-side client
// ---------------------------------------------------------------------------

function unavailable(): PluginSyncIoError {
  return new PluginSyncIoError(
    "unavailable",
    "Host-mediated sync I/O is not available for this call (no host handle was issued).",
  );
}

async function* contentChunks(content: PluginSyncContent): AsyncGenerator<Uint8Array> {
  if (content instanceof Uint8Array) {
    yield content;
    return;
  }
  for await (const chunk of content as AsyncIterable<Uint8Array>) {
    if (!(chunk instanceof Uint8Array)) {
      throw new PluginSyncIoError("protocol", "File content chunks must be Uint8Array values.");
    }
    yield chunk;
  }
}

/**
 * Build the sync host I/O API for one call. `handle` is the host-issued handle
 * for the call (absent when the host issued none); `transport` sends one
 * worker→host request.
 */
export function createEnvironmentSyncHostIo(
  handle: string | undefined,
  transport: EnvironmentSyncIoTransport,
): PluginEnvironmentSyncHostIo {
  const call: EnvironmentSyncIoTransport = async (method, params) => {
    try {
      return await transport(method, params);
    } catch (error) {
      throw toPluginSyncIoError(error);
    }
  };

  async function* readSource(ref: PluginSyncMappingRef): AsyncGenerator<PluginSyncSourceEntry> {
    if (!handle) throw unavailable();
    const { streamId } = await call("environmentSync.openSource", { handle, ...ref });
    let records: PluginSyncWireRecord[] = [];
    let index = 0;
    let done = false;
    let finished = false;
    const peek = async (): Promise<PluginSyncWireRecord | null> => {
      while (index >= records.length) {
        if (done) return null;
        const batch = await call("environmentSync.readSource", { handle, streamId });
        records = batch.records;
        index = 0;
        done = batch.done;
      }
      return records[index];
    };
    try {
      let generation = 0;
      for (;;) {
        // Skip bytes the consumer left unread.
        let record = await peek();
        while (record && "data" in record) {
          index += 1;
          record = await peek();
        }
        if (!record) break;
        index += 1;
        const header = record.entry;
        generation += 1;
        if (header.type !== "file") {
          yield header as PluginSyncSourceEntry;
          continue;
        }
        const own = generation;
        const content = (async function* () {
          for (;;) {
            if (own !== generation) {
              throw new PluginSyncIoError("protocol", "Read file content before advancing to the next entry.");
            }
            const next = await peek();
            if (!next || !("data" in next)) return;
            index += 1;
            yield Buffer.from(next.data, "base64");
          }
        })();
        yield { ...header, size: header.size ?? 0, content };
      }
      finished = true;
    } finally {
      if (!finished || !done) {
        await call("environmentSync.closeStream", { handle, streamId }).catch(() => undefined);
      }
    }
  }

  async function writeTarget(
    ref: PluginSyncMappingRef,
    entries: Iterable<PluginSyncTargetEntry> | AsyncIterable<PluginSyncTargetEntry>,
  ): Promise<PluginSyncWriteResult> {
    if (!handle) throw unavailable();
    const { streamId } = await call("environmentSync.openTarget", { handle, ...ref });
    let batch: PluginSyncWireRecord[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const records = batch;
      batch = [];
      batchBytes = 0;
      await call("environmentSync.writeTarget", { handle, streamId, records });
    };
    try {
      for await (const entry of entries as AsyncIterable<PluginSyncTargetEntry>) {
        if (entry.type === "file") {
          const { content, ...header } = entry;
          batch.push({ entry: header });
          for await (const chunk of contentChunks(content)) {
            for (let offset = 0; offset < chunk.byteLength; offset += SYNC_IO_CHUNK_BYTES) {
              const piece = chunk.subarray(offset, Math.min(chunk.byteLength, offset + SYNC_IO_CHUNK_BYTES));
              batch.push({ data: Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).toString("base64") });
              batchBytes += piece.byteLength;
              if (batchBytes >= SYNC_IO_BATCH_BYTES) await flush();
            }
          }
        } else {
          batch.push({ entry: { ...entry } });
        }
        if (batch.length >= 1024) await flush();
      }
      await flush();
      return await call("environmentSync.finishTarget", { handle, streamId });
    } catch (error) {
      await call("environmentSync.closeStream", { handle, streamId }).catch(() => undefined);
      throw error;
    }
  }

  return { available: Boolean(handle), readSource, writeTarget };
}
