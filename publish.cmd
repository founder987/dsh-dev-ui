@echo off
rem dsh-develop-ui one-click publish launcher (ASCII only - cmd parses GBK on CN Windows)
rem Usage: publish.cmd [patch|minor|major|X.Y.Z] [--dry-run|--no-publish|--skip-build]
chcp 65001 >nul
setlocal
cd /d "%~dp0"
node "scripts\publish.mjs" %*
if errorlevel 1 (
  echo.
  echo Publish failed. Press any key to close this window...
  pause >nul
  exit /b 1
)
endlocal
