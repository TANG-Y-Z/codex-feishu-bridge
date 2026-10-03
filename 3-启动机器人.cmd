@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 24 from https://nodejs.org/en/download
  pause
  exit /b 1
)
if not exist ".env" (
  echo Missing .env. Open 2-*.cmd and fill in your own app credentials.
  pause
  exit /b 1
)
if not exist "bridge.local.json" (
  echo Missing Codex connection. Ask Codex in this project to run:
  echo npm run setup:codex
  echo npm run doctor
  pause
  exit /b 1
)
if not exist "node_modules\@larksuiteoapi\node-sdk\package.json" (
  echo Missing dependencies. Run 1-*.cmd first.
  pause
  exit /b 1
)
echo Keep this window open while the bot is running.
call npm.cmd start
pause
