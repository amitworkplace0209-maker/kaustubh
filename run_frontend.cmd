@echo off
cd /d C:\project
set PORT=3000
call npm start >> C:\project\frontend_stdout.log 2>>&1
