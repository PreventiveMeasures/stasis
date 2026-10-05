#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The web container ships Node 22 on PATH by default. This switches the
# session to the Node.js version pinned in .nvmrc (currently 24) via nvm,
# persists that PATH for every later shell command, and installs the dev
# dependencies so `node --run lint` and `node --run test` work right away.
set -euo pipefail

# Only run in remote (Claude Code on the web) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# SessionStart stdout becomes context Claude sees, so the setup logs go to
# stderr and only the closing summary line reaches stdout.
exec 3>&1 1>&2

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# CLAUDE_PROJECT_DIR stays at the checkout the session started in, while the
# input's cwd follows Claude into a worktree: set that worktree up instead
# when it belongs to the same repository.
if [ ! -t 0 ]; then
  HOOK_CWD="$(node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).cwd ?? "") } catch {}' || true)"
  git_common_dir() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }
  if [ -n "$HOOK_CWD" ] && WORKTREE="$(git -C "$HOOK_CWD" rev-parse --show-toplevel 2>/dev/null)" &&
    [ "$(git_common_dir "$WORKTREE")" = "$(git_common_dir "$PROJECT_DIR")" ]; then
    PROJECT_DIR="$WORKTREE"
  fi
fi
cd "$PROJECT_DIR"

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # nvm.sh is not clean under `set -u`.
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use
  # Reads .nvmrc. Idempotent: a no-op when that version is already installed.
  nvm install --no-progress
  nvm use --silent
  set -u
else
  echo "nvm not found at $NVM_DIR; trying $(node --version) from PATH" >&2
  # .nvmrc pins the engines floor, which pnpm only warns about.
  if ! node -e '
    const [have, want] = [process.version, process.argv[1]].map((v) => v.replace(/^v/, "").split(".").map(Number))
    process.exitCode = have.reduce((d, n, i) => d || n - want[i], 0) < 0 ? 1 : 0
  ' "$(cat .nvmrc)"; then
    echo "Node $(node --version) is older than $(cat .nvmrc) from .nvmrc" >&2
    exit 1
  fi
fi

NODE_BIN="$(dirname "$(command -v node)")"

# Persist the Node version for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE_BIN:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi

# pnpm: the version is pinned by "packageManager" in package.json, so let
# corepack provide it. Fall back to a global npm install of that same
# version if corepack is unavailable in this Node build.
if command -v corepack >/dev/null 2>&1; then
  corepack enable --install-directory "$NODE_BIN"
else
  npm install -g "$(node -p 'require("./package.json").packageManager.split("+")[0]')"
fi

pnpm install --frozen-lockfile

echo "Node $(node --version) from $NODE_BIN, pnpm $(pnpm --version)" >&3
