#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
source ./scripts/macos-common.sh
if [ ! -f .env ] || [ ! -f bridge.local.json ]; then
  printf 'Configure .env first, then ask Codex in this project to run:\nnpm run setup:codex\nnpm run doctor\n' >&2
  pause_terminal
  exit 1
fi
if [ ! -f node_modules/@larksuiteoapi/node-sdk/package.json ]; then
  printf 'Dependencies are missing. Run 1-安装依赖.command first.\n' >&2
  pause_terminal
  exit 1
fi
printf 'Keep this Terminal window open while the bot is running.\n'
node --env-file-if-exists=.env src/main.js
pause_terminal
