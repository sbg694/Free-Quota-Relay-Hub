@echo off
chcp 65001 >nul
rem FQRH v1 gateway launcher. Same as: node src\server.mjs --config config.json
cd /d "%~dp0.."
if not exist config.json (
  echo [FQRH] config.json not found, copying config.example.json ...
  copy /y config.example.json config.json >nul
)
echo [FQRH] starting v1 gateway ...
node src\server.mjs --config config.json
echo.
echo [FQRH] gateway exited, code %ERRORLEVEL%
pause
