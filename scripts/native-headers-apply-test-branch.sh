#!/usr/bin/env bash
# Replays a fork test branch on top of the native headers release tree.
# Usage: native-headers-apply-test-branch.sh <upstream tag> <test branch>
# Run from the release checkout with HEAD at the tag plus the feature and fixes.
# Prints the applied commits' short shas (comma-separated) on stdout; git output
# goes to stderr. Exits non-zero on any failure, with no cherry-pick left in progress.
set -euo pipefail
tag="$1"
branch="$2"

test_ref="refs/remotes/fork/$branch"
git fetch --no-tags origin "refs/heads/$branch:$test_ref" >&2
if ! git merge-base --is-ancestor "refs/tags/$tag" "$test_ref"; then
  echo "::error::Test branch $branch is not based on upstream $tag. Rebase it onto $tag, push it, then re-run. No release was published." >&2
  exit 1
fi
# A merge can carry conflict resolutions that cherry-picking its parents would drop.
merges="$(git rev-list --merges "refs/tags/$tag..$test_ref" | cut -c1-9 | paste -sd' ' -)"
if [[ -n "$merges" ]]; then
  echo "::error::Test branch $branch has merge commits on top of $tag: $merges. Rebase it onto $tag so its history is linear, push it, then re-run. No release was published." >&2
  exit 1
fi

applied=""
for sha in $(git rev-list --reverse "refs/tags/$tag..$test_ref"); do
  if git cherry-pick -x "$sha" >&2; then
    applied="${applied:+$applied, }${sha:0:9}"
  elif [[ -z "$(git diff --name-only --diff-filter=U)" ]]; then
    git cherry-pick --skip >&2
    echo "Test commit $sha is already applied; skipped." >&2
  else
    conflicts="$(git diff --name-only --diff-filter=U | paste -sd' ' -)"
    git cherry-pick --abort >&2 || true
    echo "::error::Cherry-picking test commit $sha from $branch conflicted in: ${conflicts:-unknown}. Rebase $branch so it applies on top of $tag plus the feature and EXTRA_FIXES, push it, then re-run. No release was published." >&2
    exit 1
  fi
done
if [[ -z "$applied" ]]; then
  echo "::error::Test branch $branch has no commits left to apply on top of $tag, the feature, and EXTRA_FIXES. No release was published." >&2
  exit 1
fi
echo "$applied"
