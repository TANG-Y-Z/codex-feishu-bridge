#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
source ./scripts/macos-common.sh
npm ci --ignore-scripts
printf '\nInstallation complete. Next: run 2-填写配置.command.\n'
pause_terminal
