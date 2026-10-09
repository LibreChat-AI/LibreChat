#!/usr/bin/env bash
# Retarget pull requests opened against the release branch onto the development branch.
# Used by .github/workflows/pr-retarget-dev.yml for both the on-open hook and the manual sweep.
set -euo pipefail

REPO="${REPO:?REPO is required (owner/name)}"
RELEASE_BASE="${RELEASE_BASE:-main}"
TARGET_BASE="${TARGET_BASE:-dev}"
DRY_RUN="${DRY_RUN:-false}"
EXPLAIN_MISSING="${EXPLAIN_MISSING:-false}"
KEEP_LABEL="${KEEP_LABEL:-target: main}"
THROTTLE_SECONDS="${THROTTLE_SECONDS:-0}"
MARKER="<!-- librechat:auto-retarget -->"

if [ "$#" -eq 0 ]; then
  echo "usage: REPO=owner/name $0 <pr-number> [pr-number...]" >&2
  exit 64
fi

# Branches on the upstream repository that legitimately merge into the release branch.
# Backport branches are deliberately absent: `main` is kept as a fast-forward of `dev`, so a
# backport merged straight to `main` would break that invariant. Use the label to exempt one.
keeps_release_base() {
  local head_repo="$1" head_ref="$2"
  [ "$head_repo" = "$REPO" ] || return 1
  case "$head_ref" in
    "$TARGET_BASE" | release/* | hotfix/*) return 0 ;;
    *) return 1 ;;
  esac
}

# 0 = already explained, 1 = not explained, 2 = the lookup itself failed. The third status
# matters: treating a failed read as "not explained" would post a duplicate. Bodies are collected
# before grepping because piping into `grep -q` lets SIGPIPE fail the pipeline under `pipefail`.
already_explained() {
  local bodies
  bodies="$(gh api "repos/$REPO/issues/$1/comments" --paginate --jq '.[].body')" || return 2
  grep -qF "$MARKER" <<<"$bodies"
}

comment_body() {
  cat <<BODY
$MARKER
👋 Thanks for the contribution! LibreChat merges all changes into \`$TARGET_BASE\` first — \`$RELEASE_BASE\` only moves at release time — so this pull request's base branch was switched from \`$RELEASE_BASE\` to \`$TARGET_BASE\` automatically.

Nothing is needed from you; your commits, reviews and discussion are unchanged. If the diff now shows files you did not touch, rebase onto \`$TARGET_BASE\`:

\`\`\`bash
git remote add upstream https://github.com/$REPO.git
git fetch upstream $TARGET_BASE
git rebase upstream/$TARGET_BASE
git push --force-with-lease
\`\`\`

Maintainers: apply the \`$KEEP_LABEL\` label and restore the base branch if this one genuinely belongs on \`$RELEASE_BASE\`.
BODY
}

matched=0
skipped=0
failed=0
unexplained=0

# Posts the explanation unless one is already there. A failure is recorded rather than
# swallowed: the base edit has already succeeded, so a later run would skip the pull
# request and the contributor would never receive it.
post_explanation() {
  local number="$1" lookup=0
  already_explained "$number" || lookup=$?
  if [ "$lookup" -eq 0 ]; then
    echo "#$number: explanation already posted"
    return 0
  fi
  if [ "$lookup" -eq 2 ]; then
    echo "#$number: FAILED to read existing comments — not posting, to avoid a duplicate"
    unexplained=$((unexplained + 1))
    return 0
  fi
  if comment_body | gh pr comment "$number" --repo "$REPO" --body-file -; then
    return 0
  fi
  echo "#$number: FAILED to post the explanation — re-run with EXPLAIN_MISSING=true $number"
  unexplained=$((unexplained + 1))
}

for number in "$@"; do
  if ! pr="$(gh api "repos/$REPO/pulls/$number")"; then
    echo "#$number: FAILED to read pull request"
    failed=$((failed + 1))
    continue
  fi
  state="$(jq -r '.state' <<<"$pr")"
  base_ref="$(jq -r '.base.ref' <<<"$pr")"
  head_ref="$(jq -r '.head.ref' <<<"$pr")"
  head_repo="$(jq -r '.head.repo.full_name // ""' <<<"$pr")"

  if [ "$state" != "open" ]; then
    echo "#$number: skipped — pull request is $state"
    skipped=$((skipped + 1))
    continue
  fi

  # Canary is an intentional integration target. Keep it untouched even if a caller passes
  # its number to the sweep or overrides RELEASE_BASE, TARGET_BASE or EXPLAIN_MISSING.
  if [ "$base_ref" = "canary" ]; then
    echo "#$number: skipped — canary is an explicit target"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$base_ref" = "$TARGET_BASE" ] && [ "$EXPLAIN_MISSING" = "true" ] && [ "$DRY_RUN" != "true" ]; then
    echo "#$number: already on $TARGET_BASE — posting any missing explanation"
    post_explanation "$number"
    continue
  fi

  if [ "$base_ref" != "$RELEASE_BASE" ]; then
    echo "#$number: skipped — already based on $base_ref"
    skipped=$((skipped + 1))
    continue
  fi

  if jq -e --arg keep "$KEEP_LABEL" 'any(.labels[]; .name == $keep)' <<<"$pr" >/dev/null; then
    echo "#$number: skipped — labelled '$KEEP_LABEL'"
    skipped=$((skipped + 1))
    continue
  fi

  if keeps_release_base "$head_repo" "$head_ref"; then
    echo "#$number: skipped — $head_repo:$head_ref is a release-bound branch"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "#$number: would retarget $RELEASE_BASE -> $TARGET_BASE ($head_repo:$head_ref)"
    matched=$((matched + 1))
    continue
  fi

  echo "#$number: retargeting $RELEASE_BASE -> $TARGET_BASE ($head_repo:$head_ref)"
  if ! gh pr edit "$number" --repo "$REPO" --base "$TARGET_BASE"; then
    echo "#$number: FAILED to change base branch"
    failed=$((failed + 1))
    continue
  fi
  post_explanation "$number"
  matched=$((matched + 1))
  [ "$THROTTLE_SECONDS" = "0" ] || sleep "$THROTTLE_SECONDS"
done

if [ "$DRY_RUN" = "true" ]; then
  echo "DRY RUN — no pull request was modified. would_retarget=$matched skipped=$skipped failed=$failed"
  summary="**Dry run — nothing was modified.** Would retarget **$matched**, skip **$skipped**, failed to read **$failed**."
else
  echo "retargeted=$matched skipped=$skipped failed=$failed unexplained=$unexplained"
  summary="Retargeted **$matched** pull request(s) onto \`$TARGET_BASE\`, skipped **$skipped**, failed **$failed**, missing an explanation **$unexplained**."
fi

echo "$summary"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$summary" >> "$GITHUB_STEP_SUMMARY"

[ "$failed" -eq 0 ] && [ "$unexplained" -eq 0 ]
