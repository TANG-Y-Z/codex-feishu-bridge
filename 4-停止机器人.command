#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
source ./scripts/macos-common.sh
node scripts/stop.js
pause_terminal
