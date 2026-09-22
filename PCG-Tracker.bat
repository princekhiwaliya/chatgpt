@echo off
setlocal
title PCG Grading photo extractor
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo.
  echo   Install it once from https://nodejs.org  ^(pick the LTS button^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

node pcg.js %*

if errorlevel 1 (
  echo.
  echo   Nothing was saved. See the checklist above.
)
pause
