@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 24 from https://nodejs.org/en/download
  pause
  exit /b 1
)
call npm.cmd ci --ignore-scripts
if errorlevel 1 (
  echo Install failed. Keep this window and check the guide.
  pause
  exit /b 1
)
echo Installation complete. Next: open 2-*.cmd to edit your config.
pause
