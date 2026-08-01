@echo off
cd /d "%~dp0"
del /q server\runtime\session.json 2>nul

where node >nul 2>&1 || (echo Error: Node.js not installed. && pause && exit /b 1)
where python >nul 2>&1 || (echo Error: Python not installed. && pause && exit /b 1)

python -c "import websocket, pyautogui" 2>nul || (
    echo Installing Python dependencies...
    pip install -r client\requirements.txt
)

start "Barcode Server" node server\server.js
for /L %%i in (1,1,25) do (
  if exist server\runtime\session.json goto session_ready
  timeout /t 1 /nobreak >nul
)
echo Server session file was not created.
exit /b 1
:session_ready
python client\client.py --session-file "%CD%\server\runtime\session.json" %*
