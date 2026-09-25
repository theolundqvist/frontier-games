#!/usr/bin/env bash
# Runs one discovery pass; systemd's frontier-discover.timer calls it every 12 hours.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only --quiet
mkdir -p discover/logs
exec claude -p "$(cat discover/brief.md)" --model claude-opus-5-5 --permission-mode acceptEdits \
  --allowedTools "Bash Read Edit Write WebSearch WebFetch Glob Grep" \
  > "discover/logs/$(date -u +%Y-%m-%dT%H%M).log" 2>&1
