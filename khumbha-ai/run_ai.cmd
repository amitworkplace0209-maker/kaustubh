@echo off
REM Start the Khumbha AI local Python runtime (port 8001).
REM Uses the shared project virtualenv.
REM
REM Optional environment (set before running):
REM   AI_CORS_ORIGINS=http://localhost:3000,https://your-vm.example
REM       Add the deployed frontend origin so the browser may call this bridge.
REM   AI_BRIDGE_TOKEN=change-me
REM       Require X-Khumbha-AI-Token on every API call (recommended when AI_HOST
REM       is not loopback).
REM   AI_HOST=0.0.0.0
REM       Expose the bridge to the LAN (for a phone). Loopback is the default
REM       and is the safe choice.
REM   AI_PORT=8001
REM       Bridge port (default 8001).
REM   AI_PROVIDER_CONFIG=C:\path\to\local-ai.json
REM       Override the device-local provider config file.
setlocal
cd /d "%~dp0"
set PYTHON="C:\project\.venv\Scripts\python.exe"
if "%AI_HOST%"=="" set AI_HOST=127.0.0.1
if "%AI_PORT%"=="" set AI_PORT=8001
%PYTHON% -c "import uvicorn, numpy, psutil, fastapi" 2>nul || (
  echo installing ai runtime deps...
  "C:\project\.venv\Scripts\pip.exe" install -r requirements.txt
)
%PYTHON% -m uvicorn main:app --host %AI_HOST% --port %AI_PORT% --ws wsproto
