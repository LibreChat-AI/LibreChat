#!/usr/bin/env bash
#
# Verifies that Playwright's ffmpeg download produced a usable binary.
#
# `playwright install` is not trustworthy on its own here: under the Node 24.16.0
# yauzl/extract-zip regression (Playwright < 1.60.0) it would hang mid-extraction
# and leave a truncated `ffmpeg-linux` behind with no INSTALLATION_COMPLETE marker,
# so the exit code said nothing about whether ffmpeg actually worked.
#
# CI caches the download, so this runs before the cache is saved: checking both the
# marker and that the binary actually executes is what keeps a partial extraction
# from being promoted into a cache that every later job would restore. The install
# directory is read back from Playwright so this stays correct across version bumps
# and never lets a stale revision vouch for the one actually required.

set -uo pipefail

install_dir=$(npx playwright install --dry-run ffmpeg 2>/dev/null |
  sed -n 's/^[[:space:]]*Install location:[[:space:]]*//p' | head -1)

if [ -z "${install_dir}" ]; then
  echo "::warning::Could not determine Playwright's ffmpeg install location; skipping cache save."
  exit 1
fi

if [ ! -f "${install_dir}/INSTALLATION_COMPLETE" ]; then
  echo "::warning::${install_dir} has no INSTALLATION_COMPLETE marker; the download did not finish."
  exit 1
fi

binary="${install_dir}/ffmpeg-linux"

if [ ! -x "${binary}" ]; then
  echo "::warning::${binary} is missing or not executable."
  exit 1
fi

if ! "${binary}" -version >/dev/null 2>&1; then
  echo "::warning::${binary} is present but does not execute; treating it as a partial extraction."
  exit 1
fi

echo "Verified Playwright ffmpeg at ${binary}"
