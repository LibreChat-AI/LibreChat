#!/usr/bin/env bash
#
# Installs Playwright's optional font packages for the `chrome` channel, or for
# the browser named as the first argument.
#
# The GitHub runner ships Chrome as an apt package, so every library Playwright
# lists is already satisfied by apt itself. The only packages `install-deps` adds
# are decorative CJK/Thai/Cyrillic fonts (~21MB) that no CI assertion depends on:
# the one spec that takes screenshots gates the comparison behind
# `E2E_VISUAL_SNAPSHOTS`, which CI never sets.
#
# Lighthouse passes `chromium`: its lockfile-pinned build links the same
# libraries the runner's Chrome already brought in, so on the runner the same
# fonts are all that is missing, and a launch that did lack a library fails in
# the workflow's own browser check rather than here.
#
# Ubuntu's mirrors stall often enough that a hard failure here has repeatedly
# taken down whole e2e runs, so each attempt is capped and a final failure is
# only a warning. The workflow keeps `continue-on-error: true` as a backstop for
# the case where the step itself is killed by its timeout.

set -uo pipefail

readonly BROWSER="${1:-chrome}"
readonly ATTEMPT_TIMEOUT_SECONDS=70
readonly MAX_ATTEMPTS=3

for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
  if timeout "${ATTEMPT_TIMEOUT_SECONDS}" npx playwright install-deps "${BROWSER}"; then
    exit 0
  fi
  echo "::warning::playwright install-deps attempt ${attempt}/${MAX_ATTEMPTS} failed or timed out"
  sleep 5
done

echo "::warning::Optional Playwright font packages were not installed; continuing without them."
exit 0
