'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');
const qrcode = require('qrcode-terminal');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number.parseInt(process.env.PORT || '3443', 10);
const MAX_PAYLOAD = 1024;
const REGISTER_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 30;
const MAX_CONNECTIONS_PER_IP = 5;
const MAX_SCANS_PER_WINDOW = 20;
const SCAN_WINDOW_MS = 10_000;
const DEDUP_TTL_MS = 5 * 60_000;

const ASSETS = new Map([
  ['/', ['scanner.html', 'text/html; charset=utf-8']],
  ['/scanner.html', ['scanner.html', 'text/html; charset=utf-8']],
  ['/html5-qrcode.min.js', ['html5-qrcode.min.js', 'application/javascript; charset=utf-8']],
  ['/beep.mp3', ['beep.mp3', 'audio/mpeg']],
]);

function getAllLocalIPs() {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
  }
  return ips.length ? ips : ['127.0.0.1'];
}

function getStaticAsset(requestUrl) {
  let pathname;
  try {
    pathname = new URL(requestUrl || '/', 'https://localhost').pathname;
  } catch {
    return null;
  }
  return ASSETS.get(pathname) || null;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function tokenEquals(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function validBarcode(value) {
  return typeof value === 'string' && /^[\x20-\x7e]{1,128}$/.test(value);
}

function validateMessage(message) {
  if (!isObject(message) || message.v !== 2 || typeof message.type !== 'string') return null;
  if (message.type === 'register' && hasOnlyKeys(message, new Set(['v', 'type', 'role', 'token'])) &&
      (message.role === 'scanner' || message.role === 'desktop') &&
      typeof message.token === 'string' && message.token.length === 64) return message;
  if (message.type === 'scan' && hasOnlyKeys(message, new Set(['v', 'type', 'id', 'value'])) &&
      validId(message.id) && validBarcode(message.value)) return message;
  if ((message.type === 'typed' || message.type === 'failed') &&
      hasOnlyKeys(message, new Set(['v', 'type', 'id'])) && validId(message.id)) return message;
  return null;
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function makeRuntimeTokens() {
  return { scannerToken: crypto.randomBytes(32).toString('hex'), desktopToken: crypto.randomBytes(32).toString('hex') };
}

function writeSessionFile(runtimeDir, session) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runtimeDir, 0o700); } catch { /* Windows has no POSIX modes */ }
  const target = path.join(runtimeDir, 'session.json');
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(session)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch { /* Windows has no POSIX modes */ }
  fs.renameSync(temporary, target);
  return target;
}

async function getCert() {
  const certPath = path.join(__dirname, 'cert.pem');
  const keyPath = path.join(__dirname, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const existingCert = fs.readFileSync(certPath, 'utf8');
    if (certSupportsLocalClient(existingCert)) {
      try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows has no POSIX modes */ }
      return { cert: existingCert, key: fs.readFileSync(keyPath, 'utf8'), certPath };
    }
    // Older releases created certificates without a localhost SAN while the
    // desktop client now correctly verifies wss://localhost. Regenerate both
    // files as one pair rather than leaving users with an unusable launcher.
    console.log('Existing certificate lacks localhost SAN; regenerating it...');
  }
  console.log('Generating self-signed certificate...');
  const ips = getAllLocalIPs();
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map(ip => ({ type: 7, ip }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 365,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows has no POSIX modes */ }
  return { cert: pems.cert, key: pems.private, certPath };
}

function certSupportsLocalClient(certPem) {
  try {
    const san = new crypto.X509Certificate(certPem).subjectAltName || '';
    return /DNS:localhost(?:,|$)/i.test(san) && /IP Address:127\.0\.0\.1(?:,|$)/i.test(san);
  } catch {
    return false;
  }
}

function allowedOrigin(origin, port, localIPs) {
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    const allowedHosts = new Set(['localhost', '127.0.0.1', ...localIPs]);
    return url.protocol === 'https:' && allowedHosts.has(url.hostname) && Number(url.port || 443) === port;
  } catch {
    return false;
  }
}

function createServer({ cert, key, port = PORT, scannerToken, desktopToken, localIPs = getAllLocalIPs() }) {
  const desktop = { ws: null };
  const connectionCounts = new Map();
  const ipScans = new Map();
  const pending = new Map();

  function prunePending() {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [id, item] of pending) if (item.createdAt < cutoff) pending.delete(id);
    for (const [ip, hits] of ipScans) {
      const recent = hits.filter(time => time > cutoff);
      if (recent.length) ipScans.set(ip, recent);
      else ipScans.delete(ip);
    }
  }
  function rateAllowed(ip) {
    const now = Date.now();
    const hits = (ipScans.get(ip) || []).filter(time => time > now - SCAN_WINDOW_MS);
    if (hits.length >= MAX_SCANS_PER_WINDOW) return false;
    hits.push(now);
    ipScans.set(ip, hits);
    return true;
  }
  function notifyScanner(item, status) {
    if (item.scanner.readyState === WebSocket.OPEN) send(item.scanner, { v: 2, type: 'delivery', id: item.id, status });
  }

  const server = https.createServer({ cert, key }, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const asset = getStaticAsset(req.url);
    if (!asset) { res.writeHead(404); return res.end('Not found'); }
    const filePath = path.join(__dirname, 'public', asset[0]);
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': asset[1],
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': asset[0] === 'scanner.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || '';
    const count = (connectionCounts.get(ip) || 0) + 1;
    connectionCounts.set(ip, count);
    let role = null;
    let timeout = null;
    // Register cleanup BEFORE any rejection.  A rejected WebSocket still emits
    // close, and otherwise a flood of bad upgrades permanently consumed an IP's
    // connection quota.
    ws.once('close', () => {
      if (timeout !== null) clearTimeout(timeout);
      const remaining = Math.max(0, (connectionCounts.get(ip) || 1) - 1);
      if (remaining) connectionCounts.set(ip, remaining);
      else connectionCounts.delete(ip);
      if (desktop.ws === ws) {
        desktop.ws = null;
        for (const item of pending.values()) {
          if (item.status === 'received') {
            item.status = 'delivery_unknown';
            notifyScanner(item, item.status);
          }
        }
      }
    });
    const requestPath = new URL(req.url || '/', 'https://localhost').pathname;
    if (wss.clients.size > MAX_CONNECTIONS || count > MAX_CONNECTIONS_PER_IP || requestPath !== '/ws') return ws.close(1008, 'connection refused');
    timeout = setTimeout(() => ws.close(1008, 'registration required'), REGISTER_TIMEOUT_MS);

    ws.on('message', raw => {
      if (Buffer.byteLength(raw) > MAX_PAYLOAD) return ws.close(1009, 'payload too large');
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch { return send(ws, { v: 2, type: 'error', code: 'invalid_message' }); }
      const msg = validateMessage(parsed);
      if (!msg) return send(ws, { v: 2, type: 'error', code: 'invalid_message' });
      if (!role) {
        if (msg.type !== 'register') return ws.close(1008, 'registration required');
        if (msg.role === 'scanner') {
          if (!allowedOrigin(req.headers.origin, port, localIPs) || !tokenEquals(msg.token, scannerToken)) return ws.close(1008, 'unauthorized');
          role = 'scanner';
        } else {
          if (!isLoopback(ip) || !tokenEquals(msg.token, desktopToken)) return ws.close(1008, 'unauthorized');
          if (desktop.ws && desktop.ws !== ws) return ws.close(1008, 'desktop already connected');
          role = 'desktop'; desktop.ws = ws;
        }
        clearTimeout(timeout);
        timeout = null;
        return send(ws, { v: 2, type: 'registered', role });
      }
      if (role === 'scanner' && msg.type === 'scan') {
        prunePending();
        if (!rateAllowed(ip)) return send(ws, { v: 2, type: 'error', code: 'rate_limited', id: msg.id });
        const existing = pending.get(msg.id);
        if (existing) {
          // A page reload creates a new WebSocket. The previous socket may be
          // closed, so ownership of the pending delivery must follow the
          // authenticated scanner before we report its current state.
          existing.scanner = ws;
          return notifyScanner(existing, existing.status);
        }
        if (!desktop.ws || desktop.ws.readyState !== WebSocket.OPEN) return send(ws, { v: 2, type: 'delivery', id: msg.id, status: 'desktop_unavailable' });
        const item = { id: msg.id, scanner: ws, status: 'received', createdAt: Date.now() };
        pending.set(msg.id, item);
        send(desktop.ws, { v: 2, type: 'scan', id: msg.id, value: msg.value });
        return notifyScanner(item, 'received');
      }
      if (role === 'desktop' && (msg.type === 'typed' || msg.type === 'failed')) {
        const item = pending.get(msg.id);
        if (!item) return;
        item.status = msg.type === 'typed' ? 'typed' : 'failed';
        return notifyScanner(item, item.status);
      }
      return send(ws, { v: 2, type: 'error', code: 'unauthorized_message' });
    });
  });
  return { server, wss };
}

async function main() {
  const { cert, key, certPath } = await getCert();
  const tokens = makeRuntimeTokens();
  const localIPs = getAllLocalIPs();
  const runtimeDir = path.join(__dirname, 'runtime');
  const sessionFile = writeSessionFile(runtimeDir, { v: 2, port: PORT, certPath, desktopToken: tokens.desktopToken });
  const { server } = createServer({ cert, key, port: PORT, localIPs, ...tokens });
  server.listen(PORT, () => {
    const url = `https://${localIPs[0]}:${PORT}/#s=${tokens.scannerToken}`;
    console.log(`\nBarcode server running at https://${localIPs[0]}:${PORT}`);
    console.log('\nScan this QR code with your phone to open the scanner:\n');
    qrcode.generate(url, { small: true });
    console.log(`\nDesktop client reads the local session file: ${sessionFile}`);
  });
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = { certSupportsLocalClient, createServer, getStaticAsset, isLoopback, validateMessage, validBarcode };
