#!/usr/bin/env python3
"""Authenticated local desktop receiver for barcode bridge protocol v2."""

from __future__ import annotations

import argparse
import json
import platform
import signal
import ssl
import sys
import threading
import time
from pathlib import Path

import pyautogui
import websocket
from pynput import keyboard as kb

from protocol import RecentIds, valid_scan

pyautogui.PAUSE = 0.02
pyautogui.FAILSAFE = False

DEFAULT_SESSION_FILE = Path(__file__).resolve().parent.parent / "server" / "runtime" / "session.json"
parser = argparse.ArgumentParser()
parser.add_argument("--session-file", type=Path, default=DEFAULT_SESSION_FILE)
parser.add_argument("--port", type=int, help="Override the local server port from the session file")
parser.add_argument("--no-enter", dest="enter", action="store_false", default=True,
                    help="Do not press Enter after typing the barcode")
args = parser.parse_args()


def load_session(session_file: Path) -> tuple[str, int, str]:
    try:
        data = json.loads(session_file.read_text(encoding="utf8"))
        token, port, cert_path = data["desktopToken"], data["port"], data["certPath"]
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Invalid or missing session file {session_file}: {exc}") from exc
    if not isinstance(token, str) or len(token) != 64 or not isinstance(port, int):
        raise SystemExit("Session file has invalid authentication data")
    cert = Path(cert_path)
    if not cert.is_file():
        raise SystemExit(f"Server certificate not found: {cert}")
    return token, args.port or port, str(cert)


DESKTOP_TOKEN, PORT, CERT_PATH = load_session(args.session_file)
URL = f"wss://localhost:{PORT}/ws"
paused = False
_pause_lock = threading.Lock()
_recent = RecentIds()


def _toggle_pause() -> None:
    global paused
    with _pause_lock:
        paused = not paused
    print("[hotkey] PAUSED — scans will be ignored" if paused else "[hotkey] ACTIVE — scans will be typed")


hotkey_combo = "<cmd>+<shift>+<f9>" if platform.system() == "Darwin" else "<ctrl>+<shift>+<f9>"
hotkey_listener = kb.GlobalHotKeys({hotkey_combo: _toggle_pause})
hotkey_listener.daemon = True
hotkey_listener.start()


def send_result(ws, result_type: str, scan_id: str) -> None:
    ws.send(json.dumps({"v": 2, "type": result_type, "id": scan_id}))


def on_message(ws, raw) -> None:
    try:
        msg = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        print("[error] invalid server message", file=sys.stderr)
        return
    if msg.get("v") == 2 and msg.get("type") == "registered":
        print("[connected] authenticated desktop receiver")
        return
    parsed = valid_scan(msg)
    if parsed is None:
        return
    scan_id, value = parsed
    if _recent.seen(scan_id):
        # A lost acknowledgement must not cause a second keyboard injection.
        send_result(ws, "typed", scan_id)
        return
    if paused:
        print(f"[scan] ignored (paused): {value}")
        send_result(ws, "failed", scan_id)
        return
    try:
        pyautogui.typewrite(value, interval=0.02)
        if args.enter:
            pyautogui.press("enter")
        send_result(ws, "typed", scan_id)
        print("[scan] typed successfully")
    except Exception as exc:  # keyboard backends vary by OS
        print(f"[error] pyautogui failed: {exc}", file=sys.stderr)
        send_result(ws, "failed", scan_id)


def on_open(ws) -> None:
    ws.send(json.dumps({"v": 2, "type": "register", "role": "desktop", "token": DESKTOP_TOKEN}))


def on_error(ws, error) -> None:
    print(f"[error] {error}", file=sys.stderr)


def on_close(ws, code, msg) -> None:
    print("[disconnected] retrying in 3s…")


def _sigint(sig, frame) -> None:
    print("\nExiting.")
    sys.exit(0)


signal.signal(signal.SIGINT, _sigint)
ssl_options = {"cert_reqs": ssl.CERT_REQUIRED, "ca_certs": CERT_PATH, "check_hostname": True}
print(f"Connecting to {URL} (waiting for authenticated scans... Ctrl+C to quit)")
print("Toggle input pause: Ctrl+Shift+F9 (Windows) / Cmd+Shift+F9 (macOS)")
while True:
    try:
        ws = websocket.WebSocketApp(URL, on_open=on_open, on_message=on_message,
                                    on_error=on_error, on_close=on_close)
        ws.run_forever(sslopt=ssl_options)
        time.sleep(3)
    except KeyboardInterrupt:
        _sigint(None, None)
    except Exception as exc:
        print(f"[fatal] {exc} — retrying in 5s", file=sys.stderr)
        time.sleep(5)
