#!/bin/sh
# Publish half of the nightly upstream intake (.tekton/upstream-intake.yaml):
# fast-forward fork master to upstream master and, when the plan names a
# release, push upstream/<tag> at upstream's release commit. Only the tag comes
# from the plan; every commit comes from upstream, and GitHub refuses a
# non-fast-forward master push.
#
#   intake-push.sh PLAN_DIR KEY_FILE WORK_DIR
#
# PLAN_DIR is upstream-intake.sh's output, KEY_FILE the fork's write deploy
# key (read where it is, never copied), WORK_DIR scratch this script empties
# on exit. When it pushes a release branch it leaves only WORK_DIR/pushed-tag,
# for intake_pr.py. FORK_URL and UPSTREAM_URL override the remotes (tests).
#
# POSIX sh: the publish step runs it in the alpine/git image, from a separate
# checkout of the trusted revision, never from the plan task's workspace.
set -eu

plan=${1:?usage: intake-push.sh PLAN_DIR KEY_FILE WORK_DIR}
key=${2:?usage: intake-push.sh PLAN_DIR KEY_FILE WORK_DIR}
work=${3:?usage: intake-push.sh PLAN_DIR KEY_FILE WORK_DIR}
fork_url=${FORK_URL:-git@github.com:applyinnovations/paperclip.git}
upstream_url=${UPSTREAM_URL:-https://github.com/paperclipai/paperclip.git}
base=xlab

wipe_work() { find "${work}" -mindepth 1 -delete 2>/dev/null || true; }
trap wipe_work EXIT

export HOME="${work}/home" GIT_CONFIG_NOSYSTEM=1
mkdir -p "${HOME}"
# GitHub's host keys, pinned (api.github.com/meta).
cat > "${HOME}/known_hosts" <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
EOF
export GIT_SSH_COMMAND="ssh -i ${key} -o IdentitiesOnly=yes -o UserKnownHostsFile=${HOME}/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes"

git init --quiet --bare "${work}/repo"
cd "${work}/repo"
git remote add origin "${fork_url}"
git remote add upstream "${upstream_url}"
git fetch --quiet --no-tags --filter=blob:none origin \
  "+refs/heads/${base}:refs/remotes/origin/${base}" \
  +refs/heads/master:refs/remotes/origin/master
git fetch --quiet --no-tags upstream +refs/heads/master:refs/remotes/upstream/master
if ! git merge-base --is-ancestor origin/master upstream/master; then
  echo "fork master has diverged from upstream master; not syncing" >&2
  exit 1
fi
git push --quiet origin refs/remotes/upstream/master:refs/heads/master
echo "master at $(git rev-parse upstream/master)"

if [ ! -f "${plan}/tag" ]; then
  echo "no release to take in"
  exit 0
fi
tag=$(cat "${plan}/tag")
if ! printf '%s\n' "${tag}" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+'; then
  echo "unexpected release tag in plan" >&2
  exit 1
fi
git fetch --quiet --no-tags upstream "+refs/tags/${tag}:refs/tags/${tag}"
commit=$(git rev-parse "refs/tags/${tag}^{commit}")
if git merge-base --is-ancestor "${commit}" "origin/${base}"; then
  echo "${base} already contains ${tag}"
  exit 0
fi
git push --quiet origin "${commit}:refs/heads/upstream/${tag}"
echo "pushed upstream/${tag} at ${commit}"

# Hand only the tag to intake_pr.py.
wipe_work
printf '%s\n' "${tag}" > "${work}/pushed-tag"
trap - EXIT
