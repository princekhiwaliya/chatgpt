@echo off
setlocal
title PCG Photo Extractor
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js install nahi hai.
  echo.
  echo   https://nodejs.org kholiye, bada LTS button dabaiye,
  echo   install kijiye, phir is file par dobara double-click kijiye.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting... browser apne aap khulega.
echo.
node server.js %*

echo.
echo   Server band ho gaya.
pause
