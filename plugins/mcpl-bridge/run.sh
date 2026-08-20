#!/bin/sh
# Locate bun without relying on the caller's PATH (CC sessions from GUI
# terminals or launchd may not have ~/.bun/bin on PATH).
BUN="$(command -v bun 2>/dev/null)"
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
[ -z "$BUN" ] && { echo "mcpl-bridge: bun not found (install bun or put it on PATH)" >&2; exit 1; }
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$BUN" run --cwd "$DIR" --shell=bun --silent start
