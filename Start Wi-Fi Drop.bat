@echo off
title Wi-Fi Drop
cd /d "%~dp0"
if not exist node_modules (
  echo Installing, one time only...
  call npm install --no-audit --no-fund
)
node server.mjs
pause
