@echo off
chcp 65001 >nul
rem FQRH demo: mock upstream (8899) + gateway (8790) with config.demo.json (no real keys)
cd /d "%~dp0.."
start "FQRH mock upstream" cmd /k node src\mock-upstream.mjs --port 8899
timeout /t 1 >nul
start "FQRH gateway" cmd /k node src\server.mjs --config config.demo.json
echo.
echo gateway   : http://127.0.0.1:8790/v1
echo client key: sk-fqrh-demo
echo mock logs print the incoming user-agent, so header rewriting is visible.
