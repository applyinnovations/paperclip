/**
 * In-process (node-tar) host-side tar for the Kubernetes file-sync transport.
 *
 * Builds the host-authored archives streamed into the pod (`createHostTarball`)
 * and validates-then-extracts the sandbox-authored archives streamed out of it
 * (`extractHostTarball`). No `tar` child process is spawned. Sandbox-authored
 * archives are untrusted: every member is read and confined (path, type,
 * linkpath) before anything is written, and unsupported entry types fail the
 * whole archive closed.
 */
import path from "node:path";
import { promises as fs, createReadStream } from "node:fs";
import * as tar from "tar";

/**
 * Compile one tar `--exclude` pattern with GNU tar's default exclusion
 * semantics, so the in-process archive keeps the exact member set the `tar` CLI
 * produced: shell wildcards (`*`, `?`, `[...]`, `\\` escapes) where wildcards
 * also match `/`, and an unanchored match, i.e. the pattern may match the whole
 * member path or any trailing run of its components. A matching directory is
 * never descended into, so its subtree is excluded too.
 */
function compileTarExclude(pattern: string): RegExp {
  let source = "";
  const glob = pattern.replace(/\/+$/, "");
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "\\" && i + 1 < glob.length) {
      i += 1;
      source += escapeRegExpChar(glob[i]);
    } else if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      source += `[${negate ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")}]`;
      i = close;
    } else {
      source += escapeRegExpChar(char);
    }
  }
  return new RegExp(`(?:^|/)${source}$`, "s");
}

function escapeRegExpChar(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

/**
 * Build a host-side tarball in-process (node-tar, no `tar` child process),
 * mirroring the runtime's own `createTarballFromDirectory`: archive the named
 * top-level entries (no "." self entry), skip `._*` AppleDouble sidecars, honor
 * `exclude`, and map `followSymlinks` onto dereferencing, so the pod-side
 * `tar -x` sees the same plain ustar/pax member layout as the base64 fallback's
 * tar. node-tar never writes xattrs or macOS metadata. An empty entry set writes
 * a valid empty tar (1024-byte zero EOF marker).
 */
export async function createHostTarball(input: {
  localDir: string;
  archivePath: string;
  exclude?: string[];
  followSymlinks?: boolean;
  entries?: string[];
}): Promise<void> {
  const excludes = ["._*", ...(input.exclude ?? [])].map(compileTarExclude);
  const entries =
    input.entries ??
    (await fs.readdir(input.localDir)).sort((left, right) => left.localeCompare(right));
  if (entries.length === 0) {
    await fs.writeFile(input.archivePath, Buffer.alloc(1024));
    return;
  }
  await tar.c(
    {
      file: input.archivePath,
      cwd: input.localDir,
      follow: input.followSymlinks === true,
      // A stat/read failure (e.g. a dangling link under `followSymlinks`) fails
      // the transfer loud, as the `tar` CLI's non-zero exit did.
      strict: true,
      filter: (memberPath) => {
        const name = memberPath.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
        return !excludes.some((exclude) => exclude.test(name));
      },
    },
    entries,
  );
}

/**
 * Parse one `tar -tvf` verbose listing line into its leading type flag and the
 * trailing name-and-link-target field (GNU/busybox or bsdtar dialect). Retained
 * as a standalone helper; the transport itself now reads archive entries
 * in-process through node-tar and no longer parses CLI listings. Returns null
 * when nothing matches so callers can fail closed.
 */
export function parseTarVerboseListingLine(line: string): { typeFlag: string; rest: string } | null {
  const gnu = line.match(/^(\S+)\s+\S+\/\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/);
  if (gnu) return { typeFlag: gnu[1][0], rest: gnu[2] };
  const bsd = line.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/);
  if (bsd) return { typeFlag: bsd[1][0], rest: bsd[2] };
  return null;
}

/**
 * Split a verbose-listing link field (`<name><delimiter><target>`) exactly
 * once; zero or multiple delimiter occurrences are ambiguous and return null so
 * callers fail closed. Retained alongside `parseTarVerboseListingLine`.
 */
export function splitLinkEntryOnce(field: string, delimiter: string): { name: string; target: string } | null {
  const first = field.indexOf(delimiter);
  if (first === -1) return null;
  if (field.indexOf(delimiter, first + delimiter.length) !== -1) return null;
  return { name: field.slice(0, first), target: field.slice(first + delimiter.length) };
}

// Entry types a sandbox-authored archive may carry: exactly the ones node-tar
// can materialize. Anything else (FIFOs, device nodes, GNU dump dirs, vendor
// types node-tar would silently skip) fails the whole archive closed, before
// any write, rather than being dropped from an otherwise "successful" sync.
const ACCEPTED_TAR_ENTRY_TYPES = new Set([
  "File",
  "OldFile",
  "ContiguousFile",
  "Directory",
  "SymbolicLink",
  "Link",
]);

// Bound on chained archive-symlink hops while resolving a link target, so a
// symlink cycle fails closed instead of recursing forever.
const MAX_ARCHIVE_LINK_HOPS = 32;

interface ArchiveMember {
  path: string;
  type: string;
  linkpath: string | null;
  mode: number | null;
}

/**
 * Split a member path as node-tar reports it into its normalized POSIX
 * components, or null when it is not a confined relative path: absolute, or
 * carrying any `..` component (node-tar itself refuses `..` members at
 * extraction, so rejecting them here keeps the whole archive unwritten), or a
 * NUL byte.
 */
function confinedMemberParts(memberPath: string): string[] | null {
  if (memberPath.includes("\0") || path.posix.isAbsolute(memberPath)) return null;
  const parts = memberPath.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return null;
  return parts;
}

/**
 * Resolve a link target the way the host filesystem later would, starting from
 * `base` (the link's directory for a symlink, the archive root for a hardlink)
 * and following any archive symlink met along the way. Returns null when the
 * target is absolute or climbs out of the extraction dir at any step, which a
 * purely lexical join misses (e.g. `b -> .` plus `a -> b/../x`).
 */
function resolveArchiveLink(
  base: string[],
  target: string,
  symlinks: Map<string, string>,
  hops = 0,
): string[] | null {
  if (hops > MAX_ARCHIVE_LINK_HOPS || target.includes("\0") || path.posix.isAbsolute(target)) return null;
  let parts = [...base];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
    const next = symlinks.get(parts.join("/"));
    if (next !== undefined) {
      const resolved = resolveArchiveLink(parts.slice(0, -1), next, symlinks, hops + 1);
      if (!resolved) return null;
      parts = resolved;
    }
  }
  return parts;
}

/**
 * Read every member of a sandbox-authored tarball in-process (node-tar parser,
 * strict) without writing anything, failing closed on a malformed header or a
 * type node-tar would otherwise silently skip.
 */
async function readTarballMembers(
  archivePath: string,
  rejectSpecialModes: boolean,
): Promise<ArchiveMember[]> {
  const members: ArchiveMember[] = [];
  let violation: Error | null = null;
  const parser = new tar.Parser({ strict: true });
  const fail = (error: Error) => {
    if (violation) return;
    violation = error;
    parser.abort(error);
  };
  parser.on("entry", (entry: tar.ReadEntry) => {
    entry.resume();
    if (violation) return;
    if (!ACCEPTED_TAR_ENTRY_TYPES.has(entry.type)) {
      fail(new Error(`Kubernetes syncOut refusing tarball member of unsupported type ${entry.type}: ${entry.path}`));
      return;
    }
    // Source preservation promises 0777 modes only. Refuse special execution
    // bits before the host extractor can apply them, retaining every source file.
    if (rejectSpecialModes && ((entry.mode ?? 0) & 0o7000) !== 0) {
      fail(new Error("Kubernetes syncOut source preservation does not support special mode bits"));
      return;
    }
    members.push({
      path: entry.path,
      type: entry.type,
      linkpath: entry.linkpath ?? null,
      mode: typeof entry.mode === "number" ? entry.mode : null,
    });
  });
  parser.on("ignoredEntry", (entry: tar.ReadEntry) => {
    fail(new Error(`Kubernetes syncOut refusing tarball with an unreadable member: ${entry.path}`));
  });
  await new Promise<void>((resolve, reject) => {
    const settle = (error?: unknown) => (violation ?? error ? reject(violation ?? error) : resolve());
    parser.on("error", settle);
    parser.on("abort", settle);
    parser.on("end", () => settle());
    const source = createReadStream(archivePath);
    source.on("error", settle);
    source.on("data", (chunk) => {
      if (!violation) parser.write(chunk as Buffer);
    });
    source.on("end", () => {
      if (!violation) parser.end();
    });
  });
  if (violation) throw violation;
  return members;
}

/**
 * Reject a sandbox-authored tarball before extraction if any member would land
 * outside the extraction dir. The archive is produced by the (untrusted)
 * sandbox, so it is read in full and every member checked against the entry
 * as node-tar reports it (path, type, linkpath) BEFORE a single byte is
 * written: no absolute path or `..` traversal, no member nested under an
 * archived symlink, and no symlink/hardlink whose target escapes the tree
 * (symlinks resolve from their own directory, hardlinks from the archive root,
 * as the extractor creates them). Legitimate in-tree relative links are
 * preserved. node-tar's own `preservePaths`/symlink guards at extraction are
 * a second layer, not the one this relies on.
 */
async function assertTarballEntriesConfined(archivePath: string, rejectSpecialModes = false): Promise<ArchiveMember[]> {
  const members = await readTarballMembers(archivePath, rejectSpecialModes);
  const symlinks = new Map<string, string>();
  const memberParts = members.map((member) => {
    const parts = confinedMemberParts(member.path);
    if (!parts) {
      throw new Error(`Kubernetes syncOut refusing tarball member that escapes the extraction dir: ${member.path}`);
    }
    if (member.type === "SymbolicLink") symlinks.set(parts.join("/"), member.linkpath ?? "");
    return parts;
  });
  members.forEach((member, index) => {
    const parts = memberParts[index];
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (symlinks.has(parts.slice(0, depth).join("/"))) {
        throw new Error(
          `Kubernetes syncOut refusing tarball member nested under an archived symlink: ${member.path}`,
        );
      }
    }
    if (member.type !== "SymbolicLink" && member.type !== "Link") return;
    const linkTarget = member.linkpath ?? "";
    const base = member.type === "SymbolicLink" ? parts.slice(0, -1) : [];
    if (linkTarget.length === 0 || !resolveArchiveLink(base, linkTarget, symlinks)) {
      throw new Error(
        `Kubernetes syncOut refusing tarball link whose target escapes the extraction dir: ${member.path} -> ${linkTarget}`,
      );
    }
  });
  return members;
}

export async function extractHostTarball(input: { archivePath: string; localDir: string; preserveSourceEntries?: boolean }): Promise<void> {
  // The archive is sandbox-authored and untrusted: validate every member (and
  // link target) is confined before the extractor writes a single byte.
  const members = await assertTarballEntriesConfined(input.archivePath, input.preserveSourceEntries);
  await fs.mkdir(input.localDir, { recursive: true });
  // In-process extraction never adopts archive owners (even when the worker
  // runs as root), xattrs, ACLs or macOS metadata, and treats `._*` members as
  // ordinary user files. Without preservation the host umask applies, as with
  // `tar -x` without `-p`.
  await tar.x({
    file: input.archivePath,
    cwd: input.localDir,
    strict: true,
    preserveOwner: false,
    preservePaths: false,
  });
  if (input.preserveSourceEntries) {
    // Preservation applies the archive's permission bits exactly, ignoring the
    // host umask (`tar -xp`). node-tar creates new entries through the umask,
    // so set each extracted file/dir mode afterwards. Every path was confined
    // above and no member sits under an archived symlink; `lstat` skips links so
    // a chmod never follows one.
    for (const member of members) {
      if (member.mode === null || member.type === "SymbolicLink") continue;
      const target = path.join(input.localDir, ...(confinedMemberParts(member.path) ?? []));
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      await fs.chmod(target, member.mode & 0o777);
    }
  }
}
