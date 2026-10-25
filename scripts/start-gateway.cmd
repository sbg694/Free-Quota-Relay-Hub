@echo off
chcp 65001 >nul
rem FQRH gateway launcher (v3). Same as: node src\server.mjs --config config.json
cd /d "%~dp0.."
if not exist config.json (
  echo [FQRH] config.json not found, copying config.example.json ...
  copy /y config.example.json config.json >nul
)
echo [FQRH] starting gateway ...
node src\server.mjs --config config.json
echo.
echo [FQRH] gateway exited, code %ERRORLEVEL%
pause
