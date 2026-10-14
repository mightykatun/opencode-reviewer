#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
directory="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp/opencode}}/actionlint.XXXXXXXX")"
trap 'rm -rf "$directory"' EXIT
curl --fail --silent --show-error --location --max-time 60 --retry 3 --retry-delay 2 --retry-max-time 180 \
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
  --output "$directory/actionlint.tar.gz"
echo "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  $directory/actionlint.tar.gz" | sha256sum --check
tar -xzf "$directory/actionlint.tar.gz" -C "$directory" actionlint
# GitHub supports queue: max, but actionlint 1.7.12 does not yet recognize it.
# The helper tests independently enforce that exact release concurrency contract.
"$directory/actionlint" -shellcheck= -pyflakes= -ignore '^unexpected key "queue" for "concurrency" section\. expected one of "cancel-in-progress", "group"$' \
  "$root/.github/workflows/ci.yml" "$root/.github/workflows/release.yml"
