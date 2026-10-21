#!/usr/bin/env bash
set -euo pipefail
umask 077
# Minimal Linux database setup; intentionally does not configure AI clients.
# Pin and checksum from the official starter kit versions.json (2026-10-16).
LOOM_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOOM_LAUNCHER="$LOOM_PROJECT_DIR/.local/bin/exasol"
LOOM_LAUNCHER_SHA256=62f7dcd9da76e54848cf5c53f0de70d1d33908fe994455687d0d4ed5524ab2b9
if [[ "$(uname -s)/$(uname -m)" != Linux/x86_64 ]]; then
  echo 'This helper pins the tested Linux x86_64 launcher. Use the current Exasol starter kit for other platforms.' >&2
  exit 1
fi
for tool in podman curl sha256sum; do
  command -v "$tool" >/dev/null || { echo "$tool is required. See RUNBOOK.md." >&2; exit 1; }
done
podman info >/dev/null
mkdir -p "$LOOM_PROJECT_DIR/.local/bin"
chmod 700 "$LOOM_PROJECT_DIR/.local"
if [[ ! -f "$LOOM_LAUNCHER" ]] || [[ "$(sha256sum "$LOOM_LAUNCHER" | cut -d ' ' -f 1)" != "$LOOM_LAUNCHER_SHA256" ]]; then
  curl --fail --location --proto '=https' --connect-timeout 15 --max-time 300 \
    https://x-up.s3.eu-west-1.amazonaws.com/releases/exasol-personal/linux/x86_64/2.3.0/exasol \
    --output "$LOOM_LAUNCHER.download"
  echo "$LOOM_LAUNCHER_SHA256  $LOOM_LAUNCHER.download" | sha256sum --check --status
  chmod 755 "$LOOM_LAUNCHER.download"
  mv "$LOOM_LAUNCHER.download" "$LOOM_LAUNCHER"
fi
# Exasol uses its own Personal terms, separate from Loom's Apache-2.0 license.
# Its installer reports the terms and any local runtime host-preparation steps.
"$LOOM_LAUNCHER" install local --auto-approve --deployment-dir "$LOOM_PROJECT_DIR/.local/exasol"
