#!/bin/bash
# macOS/Linux launcher
cd "$(dirname "$0")"
DIR="$(pwd)"
rm -f "$DIR/server/runtime/session.json"

# Check dependencies
if ! command -v node &>/dev/null; then echo "Error: Node.js not installed."; exit 1; fi
if ! command -v python3 &>/dev/null; then echo "Error: Python 3 not installed."; exit 1; fi
python3 -c "import websocket, pyautogui" 2>/dev/null || {
    echo "Installing Python dependencies..."
    pip3 install -r client/requirements.txt
}

# Install server Node dependencies if missing
if [ ! -d "server/node_modules" ]; then
    echo "Installing server dependencies..."
    (cd server && npm install)
fi

if [[ "$(uname)" == "Darwin" ]]; then
    # Open server and client in separate Terminal windows, offset and foregrounded
    osascript <<EOF
tell application "Terminal"
    activate
    do script "cd '$DIR' && node server/server.js"
    set bounds of front window to {100, 100, 800, 500}
    do script "cd '$DIR' && for i in {1..50}; do [ -f '$DIR/server/runtime/session.json' ] && break; sleep 0.1; done; test -f '$DIR/server/runtime/session.json' || { echo 'Server session file was not created.'; exit 1; }; python3 client/client.py --session-file '$DIR/server/runtime/session.json' $*"
    set bounds of front window to {150, 150, 850, 550}
end tell
EOF
else
    # Start server in background
    node server/server.js &
    SERVER_PID=$!
    trap "kill $SERVER_PID 2>/dev/null" EXIT
    for _ in $(seq 1 50); do
        [ -f "server/runtime/session.json" ] && break
        sleep 0.1
    done
    [ -f "server/runtime/session.json" ] || { echo "Server session file was not created."; exit 1; }

    # Start desktop client (foreground — Ctrl+C stops both)
    python3 client/client.py --session-file "$DIR/server/runtime/session.json" "$@"
fi
