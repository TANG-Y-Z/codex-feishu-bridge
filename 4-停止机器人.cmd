@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. You can also stop the bot from Feishu; see the guide.
  pause
  exit /b 1
)
call npm.cmd run stop
pause
