@echo off
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js LTS from https://nodejs.org/ first.
  exit /b 1
)

if not exist node_modules (
  call npm.cmd install
  if errorlevel 1 exit /b %errorlevel%
)

call npm.cmd run dev
