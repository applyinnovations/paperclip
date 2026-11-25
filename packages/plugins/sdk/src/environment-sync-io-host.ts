/**
 * Host engine for host-mediated sync I/O (see `environment-sync-io.ts`).
 *
 * The Paperclip server runs this engine on behalf of environment-driver plugin
 * workers, and the SDK test harness runs the same engine as its fake host, so
 * a plugin's unit tests exercise the real confinement and write semantics.
 *
 * Confinement, all fail closed:
 * - A call only gets I/O for the mappings the host put into it, addressed by
 *   index. The caller that built the mappings declares the call's host roots;
 *   each mapping's host path must sit inside one of them, lexically and by
 *   realpath. `checkRoot` lets the host refuse a root (protected paths, shared
 *   parents) on its canonical path.
 * - Sync-in reads never leave the mapping's source root. `followSymlinks` only
 *   dereferences targets inside it.
 * - Sync-out writes reject absolute names, `..`, entries below a symlink,
 *   duplicate names, hardlinks and special entries, and escaping symlinks (the
 *   shared {@link findArchiveMemberEscape} policy). The host stages the whole
 *   stream in a fresh `0700` directory inside the target, never writes through
 *   a link (`O_EXCL | O_NOFOLLOW`), creates symlinks last, and only then swaps
 *   the staged tree in. A refused stream changes nothing at the target.
 * - Memory stays bounded: files move in fixed-size chunks, and a read batch or
 *   write batch never holds more than one RPC's worth of bytes.
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { PluginSyncFileMapping, PluginSyncOperation } from "./protocol.js";
import {
  createSyncExcludeMatcher,
  findArchiveMemberEscape,
  PluginSyncIoError,
  SYNC_IO_BATCH_BYTES,
  SYNC_IO_CHUNK_BYTES,
  type EnvironmentSyncIoMethodName,
  type EnvironmentSyncIoMethods,
  type PluginSyncEntryHeader,
  type PluginSyncWireRecord,
  type PluginSyncWriteResult,
} from "./environment-sync-io.js";

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const SCRATCH_PREFIX = ".paperclip-upload-";
const DEFAULT_MAX_WRITE_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DEFERRED_ENTRIES = 1_000_000;
const MAX_STREAMS_PER_SESSION = 64;

export type SyncHostIoDirection = "in" | "out";

/** Why the host refuses a root, or null to accept it. */
export type SyncHostRootRefusal = { code: "confinement" | "protected_path"; reason: string } | null;

export interface SyncHostIoRegistryOptions {
  /**
   * Host policy for a declared root, called with its canonical (realpath) path
   * and its declared path. Return a refusal to deny every mapping under it.
   */
  checkRoot?: (realRoot: string, declaredRoot: string) => SyncHostRootRefusal | Promise<SyncHostRootRefusal>;
  /** Cap on file bytes one sync-out stream may write. Default 8 GiB. */
  maxWriteBytes?: number;
  /** Cap on directories plus symlinks one sync-out stream may defer. */
  maxDeferredEntries?: number;
  /** umask applied to non-preserved sync-out modes. Defaults to the process umask. */
  umask?: number;
}

export interface SyncHostIoSessionInput {
  pluginId: string;
  /** When set, only a worker request scoped to this company may use the handle. */
  companyId?: string | null;
  direction: SyncHostIoDirection;
  operations: readonly PluginSyncOperation[];
  /**
   * The call's host roots, declared by the host code that built the mappings:
   * the run's realized execution workspace, or a runtime or staging directory
   * the host created for the run. Absent or empty means no mapping is served.
   */
  hostRoots: readonly string[] | undefined;
}

/** Who is asking, as established by the host from the worker connection. */
export interface SyncHostIoCaller {
  pluginId: string;
  /** Company of the worker request's host-issued invocation scope. */
  companyId?: string | null;
  /** True when the worker referenced a missing or unknown invocation. */
  invalidScope?: boolean;
}

export interface SyncHostIoSession {
  readonly handle: string;
  /** Close every open stream and invalidate the handle. Idempotent. */
  end(): Promise<void>;
}

export interface SyncHostIoRegistry {
  begin(input: SyncHostIoSessionInput): SyncHostIoSession;
  dispatch<M extends EnvironmentSyncIoMethodName>(
    method: M,
    params: unknown,
    caller: SyncHostIoCaller,
  ): Promise<EnvironmentSyncIoMethods[M][1]>;
  /** Number of live handles (for tests and leak checks). */
  activeSessionCount(): number;
}

interface SourceStream {
  kind: "source";
  records: AsyncGenerator<PluginSyncWireRecord>;
  pending: PluginSyncWireRecord | null;
}

interface DeferredDir { rel: string; mode: number; mtimeMs: number }
interface DeferredLink { rel: string; linkname: string; mtimeMs: number }

interface TargetStream {
  kind: "target";
  mappingKey: string;
  mapping: PluginSyncFileMapping;
  /** Canonical target path. */
  target: string;
  /** Staging dir (directory mappings) or temp file (file mappings), inside the target's own dir. */
  scratch: string;
  /** Directories this stream created on the way to the target, outermost first. */
  createdDirs: string[];
  excluded: (rel: string) => boolean;
  preserve: boolean;
  seen: Map<string, "directory" | "file" | "symlink" | "excluded">;
  dirs: DeferredDir[];
  links: DeferredLink[];
  current: { handle: FileHandle; mode: number; mtimeMs: number } | "skip" | null;
  fileEntries: number;
  filesWritten: number;
  bytesWritten: number;
  umask: number;
}

type Stream = SourceStream | TargetStream;

interface Session {
  handle: string;
  pluginId: string;
  companyId: string | null;
  direction: SyncHostIoDirection;
  operations: readonly PluginSyncOperation[];
  hostRoots: readonly string[];
  streams: Map<string, Stream>;
  writers: Set<string>;
  /** Serializes this call's requests, so a worker cannot interleave writes. */
  queue: Promise<unknown>;
}

function fail(code: ConstructorParameters<typeof PluginSyncIoError>[0], message: string): never {
  throw new PluginSyncIoError(code, message);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params: unknown, key: string): string {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) fail("protocol", `Missing or invalid "${key}".`);
  return value;
}

function readIndex(params: unknown, key: string): number {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("protocol", `Missing or invalid "${key}".`);
  return value;
}

function ioError(error: unknown, what: string): PluginSyncIoError {
  if (error instanceof PluginSyncIoError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new PluginSyncIoError("io", `${what} failed${code ? ` (${code})` : ""}.`);
}

function deepFreezeOperations(operations: readonly PluginSyncOperation[]): readonly PluginSyncOperation[] {
  const copy = JSON.parse(JSON.stringify(operations)) as PluginSyncOperation[];
  for (const operation of copy) {
    for (const file of operation.files) {
      if (file.exclude) Object.freeze(file.exclude);
      Object.freeze(file);
    }
    Object.freeze(operation.files);
    Object.freeze(operation);
  }
  return Object.freeze(copy);
}

/** True when `value` names a path the contract treats as lexically unsafe. */
function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/).some((part) => part === "..") || value.includes("\0");
}

/**
 * Resolve a mapping's host path against the call's declared roots: the path
 * must be absolute, free of `..`, lexically inside a declared root whose
 * canonical path the host policy accepts.
 */
async function resolveHostPath(
  session: Session,
  hostPath: string,
  checkRoot: SyncHostIoRegistryOptions["checkRoot"],
): Promise<{ realRoot: string; relative: string }> {
  if (session.hostRoots.length === 0) {
    fail("unavailable", "This sync call declared no host roots, so the host serves none of its mappings.");
  }
  if (typeof hostPath !== "string" || !path.isAbsolute(hostPath) || hasTraversal(hostPath)) {
    fail("confinement", "The mapping's host path is not a confined absolute path.");
  }
  const normalized = path.resolve(hostPath);
  for (const declared of session.hostRoots) {
    if (typeof declared !== "string" || !path.isAbsolute(declared) || hasTraversal(declared)) continue;
    const declaredRoot = path.resolve(declared);
    if (!isWithin(declaredRoot, normalized)) continue;
    let realRoot: string;
    try {
      realRoot = await fs.realpath(declaredRoot);
      if (!(await fs.stat(realRoot)).isDirectory()) fail("confinement", "A declared host root is not a directory.");
    } catch (error) {
      if (error instanceof PluginSyncIoError) throw error;
      fail("confinement", "A declared host root does not exist.");
    }
    const refusal = (await checkRoot?.(realRoot, declaredRoot)) ?? null;
    if (refusal) fail(refusal.code, refusal.reason);
    return { realRoot, relative: path.relative(declaredRoot, normalized) };
  }
  fail("confinement", "The mapping's host path is outside every host root declared for this call.");
}

// ---------------------------------------------------------------------------
// Sync-in: stream a host source
// ---------------------------------------------------------------------------

async function* fileRecords(
  realPath: string,
  rel: string,
  expected: { dev: number; ino: number },
): AsyncGenerator<PluginSyncWireRecord> {
  let handle: FileHandle;
  try {
    handle = await fs.open(realPath, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    throw ioError(error, "Opening a source file");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      fail("confinement", "A source file changed while it was being opened.");
    }
    const size = stat.size;
    yield { entry: { type: "file", path: rel, mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs, size } };
    let offset = 0;
    while (offset < size) {
      const buffer = Buffer.allocUnsafe(Math.min(SYNC_IO_CHUNK_BYTES, size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) fail("io", "A source file shrank while it was being read.");
      offset += bytesRead;
      yield { data: buffer.subarray(0, bytesRead).toString("base64") };
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function* directoryRecords(input: {
  sourceRoot: string;
  dir: string;
  prefix: string;
  excluded: (rel: string) => boolean;
  followSymlinks: boolean;
  ancestors: ReadonlySet<string>;
}): AsyncGenerator<PluginSyncWireRecord> {
  let names: string[];
  try {
    names = await fs.readdir(input.dir);
  } catch (error) {
    throw ioError(error, "Reading a source directory");
  }
  names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const name of names) {
    const rel = input.prefix ? `${input.prefix}/${name}` : name;
    if (input.excluded(rel)) continue;
    const full = path.join(input.dir, name);
    let stat;
    try {
      stat = await fs.lstat(full);
    } catch (error) {
      throw ioError(error, "Inspecting a source entry");
    }
    if (stat.isSymbolicLink()) {
      if (!input.followSymlinks) {
        let linkname: string;
        try {
          linkname = await fs.readlink(full);
        } catch (error) {
          throw ioError(error, "Reading a source symlink");
        }
        yield { entry: { type: "symlink", path: rel, mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs, linkname } };
        continue;
      }
      let real: string;
      try {
        real = await fs.realpath(full);
      } catch {
        fail("confinement", `followSymlinks: "${rel}" does not resolve to an existing entry inside the source root.`);
      }
      if (!isWithin(input.sourceRoot, real)) {
        fail("confinement", `followSymlinks: "${rel}" points outside the source root.`);
      }
      stat = await fs.stat(real);
      if (stat.isDirectory()) {
        if (input.ancestors.has(real)) fail("unsupported_entry", `followSymlinks: "${rel}" forms a symlink loop.`);
        yield { entry: { type: "directory", path: rel, mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs } };
        yield* directoryRecords({ ...input, dir: real, prefix: rel, ancestors: new Set([...input.ancestors, real]) });
      } else if (stat.isFile()) {
        yield* fileRecords(real, rel, stat);
      } else {
        fail("unsupported_entry", `"${rel}" is not a regular file, directory or symlink.`);
      }
      continue;
    }
    if (stat.isDirectory()) {
      yield { entry: { type: "directory", path: rel, mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs } };
      const real = path.join(input.dir, name);
      yield* directoryRecords({ ...input, dir: real, prefix: rel, ancestors: new Set([...input.ancestors, real]) });
    } else if (stat.isFile()) {
      yield* fileRecords(full, rel, stat);
    } else if (stat.isSocket()) {
      // tar skips sockets; so does the contract.
      continue;
    } else {
      fail("unsupported_entry", `"${rel}" is not a regular file, directory or symlink.`);
    }
  }
}

async function openSourceRecords(
  mapping: PluginSyncFileMapping,
  realRoot: string,
  relative: string,
): Promise<AsyncGenerator<PluginSyncWireRecord>> {
  const lexical = path.join(realRoot, relative);
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch {
    fail("invalid_mapping", "The mapping's host source does not exist.");
  }
  if (!isWithin(realRoot, real)) fail("confinement", "The mapping's host source resolves outside its host root.");
  const stat = await fs.stat(real);
  if (mapping.kind === "file") {
    if (!stat.isFile()) fail("invalid_mapping", "A file mapping's host source is not a regular file.");
    return fileRecords(real, "", stat);
  }
  if (!stat.isDirectory()) fail("invalid_mapping", "A directory mapping's host source is not a directory.");
  return directoryRecords({
    sourceRoot: real,
    dir: real,
    prefix: "",
    excluded: createSyncExcludeMatcher(mapping, "in"),
    followSymlinks: mapping.followSymlinks === true,
    ancestors: new Set([real]),
  });
}

async function readSourceBatch(stream: SourceStream): Promise<{ records: PluginSyncWireRecord[]; done: boolean }> {
  const records: PluginSyncWireRecord[] = [];
  let bytes = 0;
  for (;;) {
    let record = stream.pending;
    stream.pending = null;
    if (!record) {
      const next = await stream.records.next();
      if (next.done) return { records, done: true };
      record = next.value;
    }
    const size = "data" in record ? record.data.length : 256;
    if (records.length > 0 && (bytes + size > SYNC_IO_BATCH_BYTES * 1.4 || records.length >= 1024)) {
      stream.pending = record;
      return { records, done: false };
    }
    records.push(record);
    bytes += size;
  }
}

// ---------------------------------------------------------------------------
// Sync-out: apply an entry stream to a host target
// ---------------------------------------------------------------------------

/**
 * Walk from the root to the target's parent, refusing any symlink or
 * non-directory component, and return the parent components that do not exist
 * yet (outermost first).
 */
async function inspectTargetChain(realRoot: string, relative: string): Promise<{ missing: string[]; targetStat: import("node:fs").Stats | null }> {
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = realRoot;
  const missing: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    if (missing.length > 0) {
      missing.push(current);
      continue;
    }
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw ioError(error, "Inspecting the target path");
      missing.push(current);
      continue;
    }
    if (i === parts.length - 1) return { missing, targetStat: stat };
    if (stat.isSymbolicLink()) fail("confinement", "The mapping's host target passes through a symlink.");
    if (!stat.isDirectory()) fail("confinement", "The mapping's host target passes through a non-directory.");
  }
  if (parts.length === 0) return { missing, targetStat: await fs.lstat(realRoot) };
  return { missing, targetStat: null };
}

async function createDirs(dirs: string[], created: string[]): Promise<void> {
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { mode: 0o700 });
      created.push(dir);
    } catch (error) {
      throw ioError(error, "Creating the target directory");
    }
  }
}

async function openTargetStream(
  mapping: PluginSyncFileMapping,
  mappingKey: string,
  realRoot: string,
  relative: string,
  umask: number,
): Promise<TargetStream> {
  const { missing, targetStat } = await inspectTargetChain(realRoot, relative);
  const target = path.join(realRoot, relative);
  const createdDirs: string[] = [];
  const base = {
    kind: "target" as const,
    mappingKey,
    mapping,
    target,
    createdDirs,
    excluded: createSyncExcludeMatcher(mapping, "out"),
    preserve: mapping.preserveSourceEntries === true,
    seen: new Map<string, "directory" | "file" | "symlink" | "excluded">(),
    dirs: [],
    links: [],
    current: null,
    fileEntries: 0,
    filesWritten: 0,
    bytesWritten: 0,
    umask,
  };
  if (mapping.kind === "file") {
    if (relative === "") fail("invalid_mapping", "A file mapping's host target cannot be its host root.");
    if (targetStat && targetStat.isDirectory()) fail("invalid_mapping", "A file mapping's host target is a directory.");
    if (targetStat && !targetStat.isFile() && !targetStat.isSymbolicLink()) {
      fail("unsupported_entry", "A file mapping's host target is a special file.");
    }
    await createDirs(missing.filter((dir) => dir !== target), createdDirs);
    return { ...base, scratch: path.join(path.dirname(target), `${SCRATCH_PREFIX}${randomUUID()}`) };
  }
  if (targetStat) {
    if (targetStat.isSymbolicLink()) fail("confinement", "A directory mapping's host target is a symlink.");
    if (!targetStat.isDirectory()) fail("invalid_mapping", "A directory mapping's host target is not a directory.");
  }
  await createDirs(missing, createdDirs);
  const scratch = path.join(target, `${SCRATCH_PREFIX}${randomUUID()}`);
  try {
    await fs.mkdir(scratch, { mode: 0o700 });
  } catch (error) {
    throw ioError(error, "Creating the staging directory");
  }
  return { ...base, scratch };
}

function finalMode(stream: TargetStream, mode: number, rel: string): number {
  if (stream.preserve) {
    if (mode & 0o7000) fail("unsafe_member", `"${rel}" carries setuid, setgid or sticky bits.`);
    return mode & 0o777;
  }
  return mode & 0o777 & ~stream.umask;
}

function validateHeader(header: unknown): PluginSyncEntryHeader {
  if (!isRecord(header)) fail("protocol", "An entry record has no header.");
  const { type, path: name, mode, mtimeMs } = header;
  if (type !== "directory" && type !== "file" && type !== "symlink") {
    fail("unsupported_entry", `Entry type "${String(type)}" is not accepted (only directory, file and symlink).`);
  }
  if (typeof name !== "string" || name.length > 4096) fail("protocol", "An entry has an invalid path.");
  if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    fail("protocol", "An entry has an invalid mode.");
  }
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) fail("protocol", "An entry has an invalid mtime.");
  if (type === "symlink" && (typeof header.linkname !== "string" || header.linkname.length === 0 || header.linkname.length > 4096 || header.linkname.includes("\0"))) {
    fail("protocol", "A symlink entry has an invalid linkname.");
  }
  return header as PluginSyncEntryHeader;
}

/** Strict member-name check on top of the shared archive-member policy. */
function assertMemberName(name: string): void {
  if (name.length === 0) fail("unsafe_member", "A directory mapping entry has an empty name.");
  if (name.includes("\0") || name.includes("\\")) fail("unsafe_member", `"${name}" contains a forbidden character.`);
  const escape = findArchiveMemberEscape({ name });
  if (escape) fail("unsafe_member", escape);
  if (name.startsWith("/") || name.endsWith("/")) fail("unsafe_member", `"${name}" is not a relative entry name.`);
  for (const part of name.split("/")) {
    if (part === "" || part === "." || part === "..") fail("unsafe_member", `"${name}" is not a normalized relative entry name.`);
  }
}

async function closeCurrent(stream: TargetStream): Promise<void> {
  const current = stream.current;
  stream.current = null;
  if (!current || current === "skip") return;
  try {
    await current.handle.chmod(current.mode);
    const time = new Date(current.mtimeMs);
    await current.handle.utimes(time, time);
  } finally {
    await current.handle.close().catch(() => undefined);
  }
}

async function applyEntry(stream: TargetStream, raw: unknown, limits: { maxDeferredEntries: number }): Promise<void> {
  await closeCurrent(stream);
  const header = validateHeader(raw);
  if (stream.mapping.kind === "file") {
    if (header.type !== "file" || header.path !== "") {
      fail("unsafe_member", "A file mapping accepts exactly one file entry with an empty path.");
    }
    if (stream.fileEntries > 0) fail("unsafe_member", "A file mapping accepts exactly one file entry.");
    stream.fileEntries += 1;
    const mode = typeof stream.mapping.mode === "number" ? stream.mapping.mode & 0o7777 : finalMode(stream, header.mode, "");
    const handle = await fs.open(stream.scratch, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600)
      .catch((error: unknown) => { throw ioError(error, "Creating the staged file"); });
    stream.current = { handle, mode, mtimeMs: header.mtimeMs };
    stream.filesWritten += 1;
    return;
  }

  const name = header.path;
  assertMemberName(name);
  if (header.type === "symlink") {
    const escape = findArchiveMemberEscape({ name, linkTarget: header.linkname });
    if (escape) fail("unsafe_member", escape);
  }
  if (stream.seen.has(name)) fail("unsafe_member", `"${name}" appears more than once in the stream.`);

  // Every parent must be a directory this stream created. An entry below a
  // symlink (or a file) is refused; an excluded parent excludes the entry.
  const parts = name.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const parent = parts.slice(0, i).join("/");
    const kind = stream.seen.get(parent);
    if (kind === "excluded") {
      stream.seen.set(name, "excluded");
      stream.current = "skip";
      return;
    }
    if (kind === "symlink") fail("unsafe_member", `"${name}" sits below the symlink "${parent}".`);
    if (kind === "file") fail("unsafe_member", `"${name}" sits below the file "${parent}".`);
  }
  if (stream.excluded(name)) {
    stream.seen.set(name, "excluded");
    stream.current = "skip";
    return;
  }
  for (let i = 1; i < parts.length; i += 1) {
    const parent = parts.slice(0, i).join("/");
    if (stream.seen.has(parent)) continue;
    // tar creates missing parents; so do we, as real directories.
    await fs.mkdir(path.join(stream.scratch, parent), { mode: 0o700 })
      .catch((error: unknown) => { throw ioError(error, "Creating a staged directory"); });
    stream.seen.set(parent, "directory");
    stream.dirs.push({ rel: parent, mode: 0o777 & ~stream.umask, mtimeMs: Date.now() });
  }
  if (stream.dirs.length + stream.links.length >= limits.maxDeferredEntries) {
    fail("limit", "The entry stream has too many directories and symlinks.");
  }

  const staged = path.join(stream.scratch, name);
  if (header.type === "directory") {
    const mode = finalMode(stream, header.mode, name);
    await fs.mkdir(staged, { mode: 0o700 }).catch((error: unknown) => { throw ioError(error, "Creating a staged directory"); });
    stream.seen.set(name, "directory");
    stream.dirs.push({ rel: name, mode, mtimeMs: header.mtimeMs });
    return;
  }
  if (header.type === "symlink") {
    stream.seen.set(name, "symlink");
    stream.links.push({ rel: name, linkname: header.linkname, mtimeMs: header.mtimeMs });
    stream.filesWritten += 1;
    return;
  }
  const mode = finalMode(stream, header.mode, name);
  const handle = await fs.open(staged, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600)
    .catch((error: unknown) => { throw ioError(error, "Creating a staged file"); });
  stream.seen.set(name, "file");
  stream.current = { handle, mode, mtimeMs: header.mtimeMs };
  stream.filesWritten += 1;
}

async function applyData(stream: TargetStream, data: unknown, maxWriteBytes: number): Promise<void> {
  const current = stream.current;
  if (current === "skip") return;
  if (!current) fail("protocol", "A data record does not follow a file entry.");
  if (typeof data !== "string" || data.length > Math.ceil(SYNC_IO_CHUNK_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    fail("protocol", "A data record is not a bounded base64 chunk.");
  }
  const bytes = Buffer.from(data, "base64");
  if (stream.bytesWritten + bytes.length > maxWriteBytes) fail("limit", "The entry stream exceeds the host write limit.");
  stream.bytesWritten += bytes.length;
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await current.handle.write(bytes, offset, bytes.length - offset);
    offset += bytesWritten;
  }
}

async function finishTarget(stream: TargetStream): Promise<PluginSyncWriteResult> {
  await closeCurrent(stream);
  if (stream.mapping.kind === "file") {
    if (stream.fileEntries !== 1) fail("unsafe_member", "A file mapping accepts exactly one file entry.");
    await fs.rename(stream.scratch, stream.target).catch((error: unknown) => { throw ioError(error, "Replacing the target file"); });
    await settleCreatedDirs(stream);
    return { filesWritten: stream.filesWritten, bytesWritten: stream.bytesWritten };
  }
  // Symlinks last, so no staged write can follow one.
  for (const link of stream.links) {
    const staged = path.join(stream.scratch, link.rel);
    await fs.symlink(link.linkname, staged).catch((error: unknown) => { throw ioError(error, "Creating a staged symlink"); });
    const time = new Date(link.mtimeMs);
    await fs.lutimes(staged, time, time).catch(() => undefined);
  }
  // Directory modes and times deepest first, once their contents are in place.
  for (const dir of [...stream.dirs].sort((left, right) => right.rel.length - left.rel.length)) {
    const staged = path.join(stream.scratch, dir.rel);
    await fs.chmod(staged, dir.mode);
    const time = new Date(dir.mtimeMs);
    await fs.utimes(staged, time, time).catch(() => undefined);
  }
  // Destroy-then-replace: drop the old contents, then move the staged tree in.
  const scratchName = path.basename(stream.scratch);
  for (const name of await fs.readdir(stream.target)) {
    if (name === scratchName) continue;
    await fs.rm(path.join(stream.target, name), { recursive: true, force: true });
  }
  for (const name of await fs.readdir(stream.scratch)) {
    await fs.rename(path.join(stream.scratch, name), path.join(stream.target, name));
  }
  await fs.rmdir(stream.scratch);
  await settleCreatedDirs(stream);
  return { filesWritten: stream.filesWritten, bytesWritten: stream.bytesWritten };
}

/** Directories created on the way to the target get the usual `mkdir -p` mode once the stream is accepted. */
async function settleCreatedDirs(stream: TargetStream): Promise<void> {
  for (const dir of stream.createdDirs) await fs.chmod(dir, 0o777 & ~stream.umask).catch(() => undefined);
}

async function abortTarget(stream: TargetStream): Promise<void> {
  const current = stream.current;
  stream.current = null;
  if (current && current !== "skip") await current.handle.close().catch(() => undefined);
  await fs.rm(stream.scratch, { recursive: true, force: true }).catch(() => undefined);
  for (const dir of [...stream.createdDirs].reverse()) {
    await fs.rmdir(dir).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function createSyncHostIoRegistry(options: SyncHostIoRegistryOptions = {}): SyncHostIoRegistry {
  const sessions = new Map<string, Session>();
  const maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  const maxDeferredEntries = options.maxDeferredEntries ?? DEFAULT_MAX_DEFERRED_ENTRIES;
  const umask = () => options.umask ?? process.umask();

  async function closeStream(session: Session, streamId: string): Promise<boolean> {
    const stream = session.streams.get(streamId);
    if (!stream) return false;
    session.streams.delete(streamId);
    if (stream.kind === "source") {
      await stream.records.return(undefined).catch(() => undefined);
    } else {
      session.writers.delete(stream.mappingKey);
      await abortTarget(stream);
    }
    return true;
  }

  function lookup(params: unknown, caller: SyncHostIoCaller): Session {
    const handle = readString(params, "handle");
    const session = sessions.get(handle);
    // One answer for unknown, expired, foreign-plugin and foreign-call handles.
    const refuse = () => fail("invalid_handle", "The sync I/O handle is unknown, expired, or not issued to this call.");
    if (!session || caller.invalidScope || session.pluginId !== caller.pluginId) refuse();
    if (session!.companyId && session!.companyId !== (caller.companyId ?? null)) refuse();
    return session!;
  }

  function mappingFor(session: Session, params: unknown): { mapping: PluginSyncFileMapping; key: string } {
    const operationIndex = readIndex(params, "operationIndex");
    const fileIndex = readIndex(params, "fileIndex");
    const mapping = session.operations[operationIndex]?.files[fileIndex];
    if (!mapping) fail("invalid_mapping", `No mapping ${operationIndex}/${fileIndex} in this call.`);
    return { mapping, key: `${operationIndex}/${fileIndex}` };
  }

  function streamFor<K extends Stream["kind"]>(session: Session, params: unknown, kind: K): Extract<Stream, { kind: K }> {
    const streamId = readString(params, "streamId");
    const stream = session.streams.get(streamId);
    if (!stream || stream.kind !== kind) fail("protocol", "Unknown stream for this handle.");
    return stream as Extract<Stream, { kind: K }>;
  }

  function reserveStreamSlot(session: Session): string {
    if (session.streams.size >= MAX_STREAMS_PER_SESSION) fail("limit", "Too many open sync I/O streams for this call.");
    return randomUUID();
  }

  const handlers: { [M in EnvironmentSyncIoMethodName]: (session: Session, params: unknown) => Promise<EnvironmentSyncIoMethods[M][1]> } = {
    async "environmentSync.openSource"(session, params) {
      if (session.direction !== "in") fail("wrong_direction", "Sources can only be read during environmentSyncIn.");
      const { mapping } = mappingFor(session, params);
      const streamId = reserveStreamSlot(session);
      const { realRoot, relative } = await resolveHostPath(session, mapping.sourcePath, options.checkRoot);
      const records = await openSourceRecords(mapping, realRoot, relative);
      session.streams.set(streamId, { kind: "source", records, pending: null });
      return { streamId };
    },
    async "environmentSync.readSource"(session, params) {
      const streamId = readString(params, "streamId");
      const stream = streamFor(session, params, "source");
      try {
        const batch = await readSourceBatch(stream);
        if (batch.done) session.streams.delete(streamId);
        return batch;
      } catch (error) {
        await closeStream(session, streamId);
        throw ioError(error, "Reading the source");
      }
    },
    async "environmentSync.openTarget"(session, params) {
      if (session.direction !== "out") fail("wrong_direction", "Targets can only be written during environmentSyncOut.");
      const { mapping, key } = mappingFor(session, params);
      if (session.writers.has(key)) fail("protocol", "This mapping's target is already open for writing.");
      const streamId = reserveStreamSlot(session);
      const { realRoot, relative } = await resolveHostPath(session, mapping.targetPath, options.checkRoot);
      const stream = await openTargetStream(mapping, key, realRoot, relative, umask());
      session.writers.add(key);
      session.streams.set(streamId, stream);
      return { streamId };
    },
    async "environmentSync.writeTarget"(session, params) {
      const streamId = readString(params, "streamId");
      const stream = streamFor(session, params, "target");
      const records = isRecord(params) ? params.records : undefined;
      if (!Array.isArray(records) || records.length > 4096) fail("protocol", "Missing or oversized record batch.");
      try {
        for (const record of records) {
          if (isRecord(record) && "entry" in record) await applyEntry(stream, record.entry, { maxDeferredEntries });
          else if (isRecord(record) && "data" in record) await applyData(stream, record.data, maxWriteBytes);
          else fail("protocol", "A record is neither an entry nor data.");
        }
      } catch (error) {
        // A refused stream is dead: drop everything it staged.
        await closeStream(session, streamId);
        throw ioError(error, "Writing the target");
      }
      return { accepted: records.length };
    },
    async "environmentSync.finishTarget"(session, params) {
      const streamId = readString(params, "streamId");
      const stream = streamFor(session, params, "target");
      try {
        const result = await finishTarget(stream);
        session.streams.delete(streamId);
        session.writers.delete(stream.mappingKey);
        return result;
      } catch (error) {
        await closeStream(session, streamId);
        throw ioError(error, "Applying the target");
      }
    },
    async "environmentSync.closeStream"(session, params) {
      return { closed: await closeStream(session, readString(params, "streamId")) };
    },
  };

  return {
    begin(input) {
      const handle = randomUUID();
      const session: Session = {
        handle,
        pluginId: input.pluginId,
        companyId: input.companyId ?? null,
        direction: input.direction,
        operations: deepFreezeOperations(input.operations),
        hostRoots: Object.freeze([...(input.hostRoots ?? [])]),
        streams: new Map(),
        writers: new Set(),
        queue: Promise.resolve(),
      };
      sessions.set(handle, session);
      let ended: Promise<void> | null = null;
      return {
        handle,
        end() {
          if (!ended) {
            // Refuse new requests now; let a request already running finish
            // before its streams are torn down.
            sessions.delete(handle);
            ended = session.queue.then(async () => {
              for (const streamId of [...session.streams.keys()]) await closeStream(session, streamId);
            });
          }
          return ended;
        },
      };
    },
    async dispatch(method, params, caller) {
      const handler = handlers[method] as ((session: Session, params: unknown) => Promise<unknown>) | undefined;
      if (!handler) fail("protocol", `Unknown sync I/O method "${String(method)}".`);
      const session = lookup(params, caller);
      const run = session.queue.then(() => {
        // The call may have returned while this request waited.
        if (!sessions.has(session.handle)) fail("invalid_handle", "The sync I/O handle is unknown, expired, or not issued to this call.");
        return handler(session, params);
      });
      session.queue = run.catch(() => undefined);
      return (await run) as never;
    },
    activeSessionCount() {
      return sessions.size;
    },
  };
}
