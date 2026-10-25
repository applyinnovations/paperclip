#!/usr/bin/env bash
# Bring the newest upstream stable release into xlab as a merge pull request.
#
#   1. Fast-forward master to upstream master (master is a pure mirror).
#   2. Find upstream's newest stable release (GitHub "latest" release).
#   3. If xlab already contains it, or a PR for it exists, stop.
#   4. Push branch upstream/<tag> at the release commit and open a PR into xlab.
#   5. Auto-merge (merge commit, after the required checks pass) only when the
#      release touches no database migration paths and merges without conflicts.
#      Otherwise label the PR for review.
#
# Needs GH_TOKEN with contents and pull_requests write on the fork, and
# workflows write because upstream commits change .github/workflows.
set -euo pipefail

fork=${FORK:-applyinnovations/paperclip}
upstream=${UPSTREAM:-paperclipai/paperclip}
base=${BASE_BRANCH:-xlab}
# Conservative: anything that can change the database schema or data counts.
# When in doubt a path belongs here; a false positive only means a human review.
migration_re='(^|/)(migrations?|schema)(/|$)|\.sql$|migrat|drizzle|^packages/db/'

: "${GH_TOKEN:?GH_TOKEN is required}"
cd "$(git rev-parse --show-toplevel)"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "https://github.com/${upstream}.git"
git fetch --quiet origin "+refs/heads/${base}:refs/remotes/origin/${base}" "+refs/heads/master:refs/remotes/origin/master"
git fetch --quiet --tags upstream "+refs/heads/master:refs/remotes/upstream/master"

if git merge-base --is-ancestor origin/master upstream/master; then
  git push --quiet origin "refs/remotes/upstream/master:refs/heads/master"
else
  echo "fork master has diverged from upstream master; not syncing" >&2
  exit 1
fi

tag=$(gh api "repos/${upstream}/releases/latest" --jq .tag_name)
[[ ${tag} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected release tag '${tag}'" >&2; exit 1; }
commit=$(git rev-parse "refs/tags/${tag}^{commit}")
if git merge-base --is-ancestor "${commit}" "origin/${base}"; then
  echo "${base} already contains ${tag}"
  exit 0
fi
branch="upstream/${tag}"
if [ "$(gh pr list --repo "${fork}" --head "${branch}" --state all --json number --jq length)" != 0 ]; then
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

git push --quiet origin "${commit}:refs/heads/${branch}"

body=$(mktemp)
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
} > "${body}"

for label in "upstream" "needs-review: db-migration" "needs-review: conflict"; do
  gh label create "${label}" --repo "${fork}" --force >/dev/null
done
labels=(--label upstream)
[ -n "${migrations}" ] && labels+=(--label "needs-review: db-migration")
[ -n "${conflicts}" ] && labels+=(--label "needs-review: conflict")

url=$(gh pr create --repo "${fork}" --base "${base}" --head "${branch}" \
  --title "Merge upstream ${tag} into ${base}" --body-file "${body}" "${labels[@]}")
echo "opened ${url}"

if [ -z "${migrations}" ] && [ -z "${conflicts}" ]; then
  # GitHub merges once the ruleset's required checks pass; nothing can skip them.
  gh pr merge "${url}" --auto --merge
  echo "auto-merge enabled"
fi
