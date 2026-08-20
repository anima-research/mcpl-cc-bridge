#!/bin/sh
BUN="$(command -v bun 2>/dev/null)"
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
[ -z "$BUN" ] && exit 0 # fail-open: no bun, no bridge, session proceeds
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$BUN" "$DIR/relay.ts"
