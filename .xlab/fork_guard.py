#!/usr/bin/env python3
"""Keep the fork's carried patches generic: the fork-guard pull request check.

    fork_guard.py check BASE [HEAD]   fail a pull request that breaks a rule
    fork_guard.py report [REV]        list the deny-list matches in the tree at
                                      REV (default HEAD) that upstream's release
                                      does not have; never fails

`check` compares HEAD with its merge base with BASE (the target branch) and
fails when the pull request:

  1. migrations: adds, edits or deletes anything under MIGRATIONS (SQL,
     journal, snapshots) unless the path then matches, byte for byte, the
     newest upstream stable release HEAD contains. The fork never authors a
     migration; an upstream intake brings upstream's unchanged.
  2. deployment names: adds a line (or a file path) outside .xlab/ and
     .tekton/ that contains a term from .xlab/fork-guard-denylist.txt, unless
     upstream's release has that same line in that file.
  3. patch record: changes anything outside .xlab/, .tekton/ and OWNERS
     without changing .xlab/PATCHES.md. Not applied to an upstream intake,
     which merges a release BASE does not contain yet.

Upstream's release tags are fetched from FORK_GUARD_UPSTREAM_URL (default
upstream on GitHub) into refs/fork-guard/upstream-tags/ unless
FORK_GUARD_NO_FETCH=1. The deny-list is read from BASE (falling back to HEAD
when BASE predates it). Stdlib only. Exit status: 0 pass, 1 violations,
2 usage or git errors.
"""

import codecs
import os
import re
import subprocess
import sys

UPSTREAM_URL = "https://github.com/paperclipai/paperclip.git"
TAGS_NS = "refs/fork-guard/upstream-tags/"
RELEASE_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
MIGRATIONS = "packages/db/src/migrations/"
FORK_DIRS = (".xlab/", ".tekton/")
FORK_FILES = ("OWNERS",)
PATCHES = ".xlab/PATCHES.md"
DENYLIST = ".xlab/fork-guard-denylist.txt"


class GitError(Exception):
    pass


def git(*args, check=True):
    result = subprocess.run(["git", *args], capture_output=True)
    if check and result.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {result.stderr.decode(errors='replace').strip()}")
    return result


def out(*args):
    return git(*args).stdout.decode(errors="replace").strip()


def is_ancestor(a, b):
    return git("merge-base", "--is-ancestor", a, b, check=False).returncode == 0


def is_fork_path(path):
    return path.startswith(FORK_DIRS) or path in FORK_FILES


# --- deny-list -------------------------------------------------------------

def parse_denylist(text):
    terms = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            terms.append(line)
    return terms


def compile_terms(terms):
    patterns = []
    for term in terms:
        body = r"[\s._-]+".join(re.escape(word) for word in term.split())
        patterns.append((term, re.compile(body, re.IGNORECASE)))
    return patterns


def _boundary(before, first, last, after):
    # Before the term: start, a non-alphanumeric, or a camelCase hump
    # (lowercase or digit, then the term starting uppercase).
    ok_before = (not before or not before.isalnum()
                 or ((before.islower() or before.isdigit()) and first.isupper()))
    # After the term: end, a non-alphanumeric, or a camelCase hump (the
    # term ending lowercase, then uppercase).
    ok_after = not after or not after.isalnum() or (last.islower() and after.isupper())
    return ok_before and ok_after


def find_terms(patterns, text):
    """Deny-list terms that occur in text as whole words."""
    hits = []
    for term, pattern in patterns:
        for m in pattern.finditer(text):
            s, e = m.start(), m.end()
            before = text[s - 1] if s else ""
            after = text[e] if e < len(text) else ""
            if _boundary(before, text[s], text[e - 1], after):
                hits.append(term)
                break
    return hits


def load_denylist(*refs):
    for ref in refs:
        result = git("show", f"{ref}:{DENYLIST}", check=False)
        if result.returncode == 0:
            return parse_denylist(result.stdout.decode(errors="replace"))
    # Not committed anywhere yet: the copy beside this script.
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.path.basename(DENYLIST))
    if os.path.exists(local):
        with open(local, encoding="utf-8") as f:
            return parse_denylist(f.read())
    raise GitError(f"{DENYLIST} not found in {' or '.join(refs)}")


# --- upstream releases -----------------------------------------------------

def fetch_upstream_tags():
    if os.environ.get("FORK_GUARD_NO_FETCH") == "1":
        return
    url = os.environ.get("FORK_GUARD_UPSTREAM_URL", UPSTREAM_URL)
    # Trees only: the blobs compared below belong to a release HEAD contains,
    # so the checkout already has them.
    git("fetch", "--quiet", "--no-tags", "--filter=blob:none", url, f"+refs/tags/v*:{TAGS_NS}v*")


def releases():
    names = out("for-each-ref", "--format=%(refname)", TAGS_NS).splitlines()
    tags = []
    for ref in names:
        m = RELEASE_RE.match(ref[len(TAGS_NS):])
        if m:
            tags.append((tuple(int(x) for x in m.groups()), ref))
    return [ref for _, ref in sorted(tags, reverse=True)]


def newest_release_in(rev):
    for ref in releases():
        if is_ancestor(ref, rev):
            return ref
    return None


def tree_entries(rev, prefix):
    """{path: (mode, oid)} for files under prefix at rev."""
    entries = {}
    raw = git("ls-tree", "-r", "-z", rev, "--", prefix).stdout.decode(errors="surrogateescape")
    for record in raw.split("\0"):
        if record:
            meta, path = record.split("\t", 1)
            mode, _, oid = meta.split()
            entries[path] = (mode, oid)
    return entries


def file_lines(rev, path):
    result = git("show", f"{rev}:{path}", check=False)
    if result.returncode != 0:
        return set()
    return set(result.stdout.decode(errors="replace").splitlines())


# --- diff ------------------------------------------------------------------

def changed_paths(base, head):
    raw = git("diff", "--name-only", "--no-renames", "-z", base, head).stdout
    return [p for p in raw.decode(errors="surrogateescape").split("\0") if p]


def added_paths(base, head):
    raw = git("diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, head).stdout
    return [p for p in raw.decode(errors="surrogateescape").split("\0") if p]


def added_lines(base, head):
    """Yield (path, line number, text) for lines HEAD adds outside fork dirs."""
    excludes = [f":(exclude){d}" for d in FORK_DIRS] + [f":(exclude){f}" for f in FORK_FILES]
    proc = subprocess.Popen(
        ["git", "-c", "core.quotePath=false", "diff", "--no-renames", "--no-color", "--no-ext-diff",
         "-U0", "--src-prefix=a/", "--dst-prefix=b/", base, head, "--", ".", *excludes],
        stdout=subprocess.PIPE)
    path, lineno, header = None, 0, False
    for raw in proc.stdout:
        line = raw.decode(errors="replace").rstrip("\n")
        if line.startswith("diff --git "):
            path, header = None, True
        elif header and line.startswith("+++ "):
            target = line[4:]
            path = None if target == "/dev/null" else unquote(target)[2:]
        elif line.startswith("@@"):
            header = False
            m = re.match(r"@@ -\S+ \+(\d+)", line)
            lineno = int(m.group(1)) if m else 0
        elif not header and line.startswith("+") and path is not None:
            yield path, lineno, line[1:]
            lineno += 1
    if proc.wait() != 0:
        raise GitError(f"git diff {base} {head} failed")


def unquote(path):
    """A path as git quotes it ("b/caf\\303\\251"), unquoted."""
    if not (path.startswith('"') and path.endswith('"')):
        return path
    return codecs.escape_decode(path[1:-1].encode())[0].decode(errors="replace")


# --- rules -----------------------------------------------------------------

def check_migrations(head, release, changed):
    touched = [p for p in changed if p.startswith(MIGRATIONS)]
    if not touched:
        return []
    ours = tree_entries(head, MIGRATIONS)
    theirs = tree_entries(release, MIGRATIONS) if release else {}
    where = release[len(TAGS_NS):] if release else "no upstream release (HEAD contains none)"
    problems = []
    for path in touched:
        if ours.get(path) != theirs.get(path):
            state = "deletes" if path not in ours else "adds or edits"
            problems.append(f"{path}: {state} a migration that differs from upstream {where}")
    return problems


def check_names(merge_base, head, release, patterns):
    problems = []
    upstream_lines = {}

    def upstream_has(path, text):
        if not release:
            return False
        if path not in upstream_lines:
            upstream_lines[path] = file_lines(release, path)
        return text in upstream_lines[path]

    for path, lineno, text in added_lines(merge_base, head):
        hits = find_terms(patterns, text)
        if hits and not upstream_has(path, text):
            problems.append(f"{path}:{lineno}: adds {', '.join(hits)}: {text.strip()[:160]}")
    for path in added_paths(merge_base, head):
        hits = [] if is_fork_path(path) else find_terms(patterns, path)
        if hits and not (release and git("cat-file", "-e", f"{release}:{path}", check=False).returncode == 0):
            problems.append(f"{path}: file name contains {', '.join(hits)}")
    return problems


def check_patches(changed):
    patched = [p for p in changed if not is_fork_path(p)]
    if not patched or PATCHES in changed:
        return []
    listed = ", ".join(patched[:5]) + (f" and {len(patched) - 5} more" if len(patched) > 5 else "")
    return [f"changes {listed} without updating {PATCHES}: add or update the change's row"]


def cmd_check(base, head):
    fetch_upstream_tags()
    merge_base = out("merge-base", base, head)
    release = newest_release_in(head)
    intake = release is not None and not is_ancestor(release, base)
    changed = changed_paths(merge_base, head)
    patterns = compile_terms(load_denylist(base, head))

    name = release[len(TAGS_NS):] if release else None
    if intake:
        print(f"fork-guard: upstream intake of {name}; the patch-record rule does not apply")
    print(f"fork-guard: {len(changed)} paths changed since {merge_base[:12]}; upstream reference {name}")

    failed = False
    rules = [
        ("migrations", check_migrations(head, release, changed)),
        ("deployment names", check_names(merge_base, head, release, patterns)),
        ("patch record", [] if intake else check_patches(changed)),
    ]
    for rule, problems in rules:
        if problems:
            failed = True
            print(f"FAIL {rule}:")
            for problem in problems:
                print(f"  {problem}")
        else:
            print(f"ok   {rule}")
    return 1 if failed else 0


def cmd_report(rev):
    fetch_upstream_tags()
    release = newest_release_in(rev)
    terms = load_denylist(rev)
    patterns = compile_terms(terms)
    excludes = [f":(exclude){d}" for d in FORK_DIRS] + [f":(exclude){f}" for f in FORK_FILES]
    upstream_lines = {}
    args = ["-c", "core.quotePath=false", "grep", "-I", "-n", "-i", "-E", "--null"]
    for term in terms:
        words = [re.sub(r"([.^$*+?()\[\]{}|\\])", r"\\\1", w) for w in term.split()]
        args += ["-e", "[[:space:]._-]+".join(words)]
    result = git(*args, rev, "--", ".", *excludes, check=False)
    if result.returncode not in (0, 1):
        raise GitError(f"git grep: {result.stderr.decode(errors='replace').strip()}")
    count, files = 0, set()
    for raw in result.stdout.decode(errors="replace").splitlines():
        # <rev>:<path>\0<line>\0<text>
        location, lineno, text = (raw.split("\0", 2) + ["", ""])[:3]
        path = location[len(rev) + 1:]
        hits = find_terms(patterns, text)
        if hits and release:
            # Upstream's own words ("a playable video") are not ours to clean.
            if path not in upstream_lines:
                upstream_lines[path] = file_lines(release, path)
            if text in upstream_lines[path]:
                hits = []
        if hits:
            count += 1
            files.add(path)
            print(f"{path}:{lineno}: {', '.join(hits)}: {text.strip()[:160]}")
    name = release[len(TAGS_NS):] if release else "none"
    print(f"fork-guard report: {count} lines in {len(files)} files at {rev} outside .xlab/, .tekton/ and OWNERS,"
          f" not counting lines upstream {name} has (not blocking)")
    return 0


def main(argv):
    try:
        if len(argv) in (2, 3) and argv[0] == "check":
            return cmd_check(argv[1], argv[2] if len(argv) == 3 else "HEAD")
        if len(argv) in (1, 2) and argv[0] == "report":
            return cmd_report(argv[1] if len(argv) == 2 else "HEAD")
    except GitError as err:
        print(f"fork-guard: {err}", file=sys.stderr)
        return 2
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
