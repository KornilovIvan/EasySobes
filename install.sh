#!/usr/bin/env bash
# EasySobes installer for macOS. Run it with:
#   curl -fsSL https://raw.githubusercontent.com/KornilovIvan/EasySobes/main/install.sh | bash
#
# What it does, all inside ~/.easysobes (no sudo, nothing system-wide):
#   1. uses your Node.js 20+ if you have it, otherwise downloads a private copy (checksum verified)
#   2. downloads EasySobes and installs Electron
#   3. adds the `sobes` command to your shell
#   4. runs `sobes setup` (API key, profile, resume) unless you already did it
# Running it again updates EasySobes and keeps your settings.
set -euo pipefail

REPO="${SOBES_REPO:-KornilovIvan/EasySobes}"
BRANCH="${SOBES_BRANCH:-main}"
SOBES_HOME="${SOBES_HOME:-$HOME/.easysobes}"
APP="$SOBES_HOME/app"
BIN="$SOBES_HOME/bin"
NODE_LINE=24

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\033[36m→\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Windows, use the PowerShell command in the README."
ARCH="$(uname -m)"
# A Terminal running under Rosetta reports x86_64 on Apple Silicon.
[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] && ARCH=arm64
case "$ARCH" in arm64) ;; x86_64) ARCH=x64 ;; *) fail "Unsupported processor: $ARCH" ;; esac

echo
bold "Installing EasySobes (macOS, $ARCH)"
mkdir -p "$SOBES_HOME"

# 1. Node.js
NODE=""
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ] 2>/dev/null && NODE="$(command -v node)"
fi
if [ -z "$NODE" ] && [ -x "$SOBES_HOME/node/bin/node" ]; then NODE="$SOBES_HOME/node/bin/node"; fi
if [ -z "$NODE" ]; then
  step "Downloading Node.js (a private copy just for EasySobes)…"
  base="https://nodejs.org/dist/latest-v$NODE_LINE.x"
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v[0-9.]*-darwin-$ARCH.tar.gz\$" | head -1)"
  [ -n "$line" ] || fail "Could not find a Node.js download. Check your internet and try again."
  sum="${line%% *}"
  file="${line##* }"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  [ "$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)" = "$sum" ] || fail "The Node.js download was corrupted. Try again."
  rm -rf "$SOBES_HOME/node" && mkdir -p "$SOBES_HOME/node"
  tar -xzf "$tmp/$file" --strip-components=1 -C "$SOBES_HOME/node"
  rm -rf "$tmp"
  NODE="$SOBES_HOME/node/bin/node"
fi
NODE_DIR="$(cd "$(dirname "$NODE")" && pwd)"
export PATH="$NODE_DIR:$PATH"
step "Using Node.js $("$NODE" -v)"

# 2. EasySobes itself. Unpacking over the old copy keeps node_modules, so updates are quick.
step "Downloading EasySobes…"
mkdir -p "$APP"
if [ -n "${SOBES_SOURCE:-}" ]; then
  # Local folder instead of GitHub, for testing this installer.
  (cd "$SOBES_SOURCE" && tar -cf - --exclude node_modules --exclude dist --exclude .git .) | tar -xf - -C "$APP"
else
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components=1 -C "$APP"
fi
step "Installing Electron (about 150 MB the first time, a minute or two)…"
(cd "$APP" && npm install --no-audit --no-fund --loglevel=error) || fail "npm install failed. Check your internet and run the installer again."
# Electron 44+ fetches its binary on first use; do it now so the first `sobes` starts right away.
(cd "$APP" && "$NODE" -e "require('electron')" >/dev/null) || fail "Could not download Electron. Check your internet and run the installer again."

# 3. The `sobes` command
mkdir -p "$BIN"
cat > "$BIN/sobes" <<EOF
#!/bin/sh
export PATH="$NODE_DIR:\$PATH"
exec "$NODE" "$APP/bin/sobes.js" "\$@"
EOF
chmod +x "$BIN/sobes"
for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  [ "$rc" = "$HOME/.zshrc" ] || [ -f "$rc" ] || continue
  if ! grep -qs "$BIN" "$rc"; then
    printf '\n# EasySobes\nexport PATH="%s:$PATH"\n' "$BIN" >> "$rc"
  fi
done
step "Added the sobes command"

# 4. Setup wizard. The installer's own stdin is the curl pipe, so read answers from the terminal.
if (exec < /dev/tty) 2>/dev/null; then
  "$BIN/sobes" setup --if-needed < /dev/tty || true
  echo
  printf 'Start EasySobes now? [Y/n] '
  read -r answer < /dev/tty || answer=n
  case "$answer" in [nN]*) ;; *) "$BIN/sobes" ;; esac
fi

echo
bold "Done! From now on, open a new Terminal window and type:  sobes"
echo "   sobes setup    change your API key, profile or resume"
echo "   sobes update   get the latest version"
