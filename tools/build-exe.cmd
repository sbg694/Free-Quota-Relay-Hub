@echo off
chcp 65001 >nul
rem Rebuild FQRH-hub.exe from tools\FQRH-hub.cs (uses .NET Framework csc, no npm needed)
cd /d "%~dp0.."
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [FQRH] csc.exe not found. Install .NET Framework 4.x or just use scripts\start-gateway.cmd
  pause
  exit /b 1
)
"%CSC%" /nologo /target:exe /codepage:65001 /out:FQRH-hub.exe tools\FQRH-hub.cs
if errorlevel 1 (
  echo [FQRH] build failed
) else (
  echo [FQRH] built FQRH-hub.exe
)
pause
