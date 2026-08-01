@echo off
cd /d "%~dp0"
del /q server\runtime\session.json 2>nul

set NODE=%~dp0node\node.exe
set PYTHON=%~dp0python\python.exe

echo Starting Barcode Server...
start "Barcode Server" "%NODE%" server\server.js

for /L %%i in (1,1,25) do (
  if exist server\runtime\session.json goto session_ready
  timeout /t 1 /nobreak >nul
)
echo Server session file was not created.
exit /b 1

:session_ready
echo Starting Desktop Client...
"%PYTHON%" client\client.py --session-file "%CD%\server\runtime\session.json" %*
