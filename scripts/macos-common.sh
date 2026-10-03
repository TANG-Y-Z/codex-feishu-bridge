#!/bin/bash
# Sourced by the four launchers after entering their project directory.
set -e
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

pause_terminal() {
  if [ -t 0 ]; then
    printf '\nPress Return to close this window...'
    read -r _bridge_answer || true
  fi
}

on_error() {
  local result=$?
  trap - ERR
  printf '\nOperation failed. Read the error above and the setup guide.\n' >&2
  pause_terminal
  exit "$result"
}
trap on_error ERR

if [ "$(uname -s)" != 'Darwin' ]; then
  printf 'These launchers are for macOS. On Windows, use the .cmd files.\n' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Install Node.js 24 from https://nodejs.org/en/download, then reopen Terminal.\n' >&2
  pause_terminal
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<9)){ console.error("Node.js 22.9+ is required; Node.js 24 is recommended."); process.exit(1); }'
