@echo off
rem Opens Ronin Council using the build that is already in this folder (no npm needed).
rem After changing the code, run "npm run build" once so this picks up the changes.
cd /d "%~dp0"
if not exist "dist\index.html" (
  echo The app has not been built yet. Run "npm install" then "npm run build" in this folder first.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. See the "Install note" in README.md.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
