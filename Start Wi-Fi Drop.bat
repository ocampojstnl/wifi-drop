@echo off
title Wi-Fi Drop
cd /d "%~dp0"
rem Installs on first run, and again when something new is needed (selfsigned: the https address for phones).
if not exist node_modules\selfsigned (
  echo Installing, one time only...
  call npm install --no-audit --no-fund
)
node server.mjs
pause
