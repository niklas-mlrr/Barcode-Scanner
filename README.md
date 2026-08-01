# Barcode Scanner

Scan barcodes on your phone, get them typed on your computer. A lightweight WebSocket bridge between a browser-based scanner and a desktop keyboard simulator.

## How it Works

1. **Server** (Node.js) – HTTPS + authenticated WebSocket bridge with a self-signed certificate
2. **Phone** – Browser-based scanner using the camera (`html5-qrcode`)
3. **Desktop** – local Python client that receives authenticated barcodes and types them as keyboard input

```
┌─────────────┐        ┌──────────────┐        ┌─────────────┐
│    Phone    │───────>│  Node Server │───────>│   Desktop   │
│   Camera    │  WS/WSS │   (HTTPS)    │  WS/WSS │ (simulates  │
│  Scanner UI │        │              │        │   typing)   │
└─────────────┘        └──────────────┘        └─────────────┘
```

## Setup

### Requirements
- Node.js (for server)
- Python 3 + pip (for desktop client)
- Phone with camera

### Install

```bash
cd server
npm install

cd ../client
pip install -r requirements.txt
```

## Usage

### Quick Start (macOS/Linux)

```bash
./start.sh
```

On first run, the server generates a self-signed certificate and prints a QR code. The QR contains a fresh scanner credential for this server run; scan it with your phone to open the scanner. The launcher passes a separate local-only credential to the desktop client automatically.

### Manual Start

**Terminal 1 – Server:**
```bash
cd server
npm start
```

**Terminal 2 – Desktop Client:**
```bash
cd client
python3 client.py --session-file ../server/runtime/session.json
```

**Phone:**
- Scan the QR code shown in the server terminal (required; it carries the current scanner credential), or
- Open the complete QR URL including its `#s=...` fragment on the phone
- Accept the self-signed certificate warning
- Grant camera permission

## Sound

The scanner UI has an optional beep sound on each scan, using the Web Audio API.

- **Android:** Works as long as media/ring volume is not at zero. No mute switch equivalent.
- **iOS:** The Web Audio API follows the hardware mute/silent switch. If the switch is muted, no sound plays. This is an iOS restriction and cannot be overridden from a web app.

## Pausing Input

Press **Ctrl+Shift+F9** (Windows) or **Cmd+Shift+F9** (macOS) to toggle input pause. While paused, scans are received but not typed — useful when you need to type something manually without triggering barcode input. The current state is printed in the terminal.

## Configuration

### Desktop Client Options

```bash
python3 client.py --port 3001    # Custom port
python3 client.py --no-enter     # Don't press Enter after typing
```

## Security

- Every start generates separate, random scanner and desktop credentials. Old QR codes stop working after restart.
- The scanner credential stays in the QR URL fragment and is never sent in an HTTP request.
- Only a desktop client on `localhost` with the separate desktop credential can receive scans; WLAN clients cannot register as a desktop or inject scan frames.
- The Python client verifies the self-signed server certificate from the local session file. It does not disable TLS verification.
- The server only serves an explicit list of scanner assets; certificates, keys, and runtime credentials are never static files.
- The private key and the launcher-created `server/runtime/session.json` are local, ignored files. Do not copy or commit either one.
- The phone reports whether a scan was accepted and typed. If a desktop disconnect makes delivery uncertain, verify manually before scanning again; keyboard automation cannot offer true exactly-once delivery across a crash.

## Project Structure

```
├── server/
│   ├── server.js       # HTTPS + WebSocket server
│   ├── package.json
│   └── public/
│       └── scanner.html  # Camera scanner UI
├── client/
│   ├── client.py       # Desktop keyboard simulator
│   └── requirements.txt
├── start.sh            # macOS/Linux launcher
└── start.bat           # Windows launcher
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Camera not working" | Use Chrome/Safari, not in-app browsers. Ensure HTTPS |
| "Can't connect" | Firewall: allow port 3443. Check IP hasn't changed |
| macOS: "permission denied" | Grant Accessibility permission to Terminal in System Settings |
| Certificate warning | Expected with self-signed certs; click "Advanced" → "Proceed" |

## License

MIT
