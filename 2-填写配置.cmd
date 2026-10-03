@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 24 from https://nodejs.org/en/download
  pause
  exit /b 1
)
node scripts/init-env.js
if errorlevel 1 (
  pause
  exit /b 1
)
notepad.exe ".env"
