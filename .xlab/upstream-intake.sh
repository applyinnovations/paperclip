#!/usr/bin/env bash
# Plan bringing the newest upstream stable release into xlab as a merge pull
# request. Holds no credentials and writes nothing to GitHub: it writes a plan
# to OUT_DIR, and .tekton/upstream-intake.yaml's publish task, which holds the
# token and runs no repository code, carries it out.
#
#   1. Check fork master can fast-forward to upstream master (the publisher
#      re-checks and pushes it).
#   2. Find upstream's newest stable release (GitHub "latest" release).
#   3. If xlab already contains it, or a PR for it exists, plan nothing more.
#   4. Otherwise plan branch upstream/<tag> at the release commit and a PR into
#      xlab, auto-merged (merge commit, after the required checks pass) only
#      when the release touches no database migration paths and merges without
#      conflicts. Otherwise the PR is labelled for review.
#
#   nix develop ./.xlab --command .xlab/upstream-intake.sh OUT_DIR
#
# Plan files: tag (absent when there is nothing to open), body.md, labels
# (one per line) and automerge (true or false).
set -euo pipefail

out=${1:?usage: upstream-intake.sh OUT_DIR}
fork=${FORK:-applyinnovations/paperclip}
upstream=${UPSTREAM:-paperclipai/paperclip}
base=${BASE_BRANCH:-xlab}
# Conservative: anything that can change the database schema or data counts.
# When in doubt a path belongs here; a false positive only means a human review.
migration_re='(^|/)(migrations?|schema)(/|$)|\.sql$|migrat|drizzle|^packages/db/'

mkdir -p "${out}"
out=$(cd "${out}" && pwd)
rm -f "${out}/tag" "${out}/body.md" "${out}/labels" "${out}/automerge"
cd "$(git rev-parse --show-toplevel)"

# Both repositories are public; the two API reads need no token.
github_api() {
  curl -fsS --retry 3 -H "Accept: application/vnd.github+json" "https://api.github.com/$1"
}

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "https://github.com/${upstream}.git"
git fetch --quiet origin "+refs/heads/${base}:refs/remotes/origin/${base}" "+refs/heads/master:refs/remotes/origin/master"
git fetch --quiet --tags upstream "+refs/heads/master:refs/remotes/upstream/master"

if ! git merge-base --is-ancestor origin/master upstream/master; then
  echo "fork master has diverged from upstream master; not syncing" >&2
  exit 1
fi

tag=$(github_api "repos/${upstream}/releases/latest" | jq -r .tag_name)
[[ ${tag} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected release tag '${tag}'" >&2; exit 1; }
commit=$(git rev-parse "refs/tags/${tag}^{commit}")
if git merge-base --is-ancestor "${commit}" "origin/${base}"; then
  echo "${base} already contains ${tag}"
  exit 0
fi
branch="upstream/${tag}"
if [ "$(github_api "repos/${fork}/pulls?head=${fork%%/*}:${branch}&state=all" | jq length)" != 0 ]; then
  echo "a pull request for ${tag} already exists"
  exit 0
fi

merge_base=$(git merge-base "origin/${base}" "${commit}")
migrations=$(git diff --name-only "${merge_base}" "${commit}" | grep -E "${migration_re}" || true)

scratch=$(mktemp -d)
trap 'git worktree remove --force "${scratch}" >/dev/null 2>&1 || true' EXIT
git worktree add --quiet --detach "${scratch}" "origin/${base}"
conflicts=""
if ! git -C "${scratch}" -c user.name=intake -c user.email=intake@xlab.invalid \
    merge --no-commit --no-ff --quiet "${commit}" >/dev/null 2>&1; then
  conflicts=$(git -C "${scratch}" diff --name-only --diff-filter=U)
fi

{
  echo "Merges upstream stable release [${tag}](https://github.com/${upstream}/releases/tag/${tag}) into \`${base}\`."
  echo
  if [ -n "${migrations}" ]; then
    echo "**Database migrations: yes.** Review before merging; this PR is not auto-merged."
    echo
    echo '```'
    echo "${migrations}" | head -100
    echo '```'
  else
    echo "Database migrations: none detected (rule: \`${migration_re}\`)."
  fi
  echo
  if [ -n "${conflicts}" ]; then
    echo "**Merge conflicts with ${base}:** resolve on this branch, keeping the xlab patches."
    echo
    echo '```'
    echo "${conflicts}"
    echo '```'
  fi
  echo
  echo "Opened by the nightly upstream-intake pipeline."
} > "${out}/body.md"

{
  echo upstream
  [ -z "${migrations}" ] || echo "needs-review: db-migration"
  [ -z "${conflicts}" ] || echo "needs-review: conflict"
} > "${out}/labels"
if [ -z "${migrations}" ] && [ -z "${conflicts}" ]; then
  echo true > "${out}/automerge"
else
  echo false > "${out}/automerge"
fi
echo "${tag}" > "${out}/tag"
echo "planned ${branch} -> ${base} (automerge: $(cat "${out}/automerge"))"
