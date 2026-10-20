@echo off
REM Start the Khumbha AI local Python runtime (port 8001).
REM Uses the shared project virtualenv.
setlocal
cd /d "%~dp0"
set PYTHON="C:\project\.venv\Scripts\python.exe"
%PYTHON% -c "import uvicorn, numpy, psutil, fastapi" 2>nul || (
  echo installing ai runtime deps...
  "C:\project\.venv\Scripts\pip.exe" install -r requirements.txt
)
%PYTHON% -m uvicorn main:app --host 127.0.0.1 --port 8001 --ws wsproto
