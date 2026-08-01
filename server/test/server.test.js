'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const selfsigned = require('selfsigned');
const { WebSocket } = require('ws');
const { certSupportsLocalClient, createServer, getStaticAsset, isLoopback, validateMessage, validBarcode } = require('../server');

test('static serving is an allowlist, not a filesystem path resolver', () => {
  assert.deepEqual(getStaticAsset('/'), ['scanner.html', 'text/html; charset=utf-8']);
  assert.equal(getStaticAsset('/%2e%2e/key.pem'), null);
  assert.equal(getStaticAsset('/../key.pem'), null);
  assert.deepEqual(getStaticAsset('/scanner.html?x=1'), ['scanner.html', 'text/html; charset=utf-8']);
  assert.equal(getStaticAsset('/key.pem'), null);
});

test('protocol rejects extra fields and malformed scans', () => {
  const scan = { v: 2, type: 'scan', id: 'abcdefgh', value: '978-123' };
  assert.deepEqual(validateMessage(scan), scan);
  assert.equal(validateMessage({ ...scan, admin: true }), null);
  assert.equal(validateMessage({ ...scan, value: 'x'.repeat(129) }), null);
  assert.equal(validateMessage({ ...scan, value: 'bad\nbarcode' }), null);
  assert.equal(validBarcode(''), false);
});

test('only loopback can be a desktop peer', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.4'), false);
});

test('certificate migration only reuses certificates valid for localhost', async () => {
  const compatible = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
  });
  const incompatible = await selfsigned.generate([{ name: 'commonName', value: 'old-host' }], {
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '192.168.1.5' }] }],
  });
  assert.equal(certSupportsLocalClient(compatible.cert), true);
  assert.equal(certSupportsLocalClient(incompatible.cert), false);
});

test('only authenticated scanner frames reach the one local desktop and receive an ACK', async t => {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }]);
  const scannerToken = 'a'.repeat(64);
  const desktopToken = 'b'.repeat(64);
  const { server, wss } = createServer({ cert: pems.cert, key: pems.private, port: 0, scannerToken, desktopToken, localIPs: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // The production server knows its configured port; pass the chosen test port
  // to an origin-compatible instance by using an origin with the actual port.
  // Recreate is unnecessary because port=0 cannot be an allowed browser origin.
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve));

  const live = createServer({ cert: pems.cert, key: pems.private, port, scannerToken, desktopToken, localIPs: ['127.0.0.1'] });
  await new Promise(resolve => live.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { live.wss.clients.forEach(ws => ws.close()); await new Promise(resolve => live.wss.close(resolve)); await new Promise(resolve => live.server.close(resolve)); });
  const url = `wss://127.0.0.1:${port}/ws`;
  const desktop = new WebSocket(url, { rejectUnauthorized: false });
  await once(desktop, 'open');
  desktop.send(JSON.stringify({ v: 2, type: 'register', role: 'desktop', token: desktopToken }));
  assert.equal(JSON.parse((await once(desktop, 'message'))[0]).type, 'registered');
  const scanner = new WebSocket(url, { rejectUnauthorized: false, origin: `https://127.0.0.1:${port}` });
  await once(scanner, 'open');
  scanner.send(JSON.stringify({ v: 2, type: 'register', role: 'scanner', token: scannerToken }));
  assert.equal(JSON.parse((await once(scanner, 'message'))[0]).type, 'registered');
  scanner.send(JSON.stringify({ v: 2, type: 'scan', id: 'abcdefgh', value: '978-123' }));
  assert.equal(JSON.parse((await once(desktop, 'message'))[0]).value, '978-123');
  assert.equal(JSON.parse((await once(scanner, 'message'))[0]).status, 'received');
  desktop.send(JSON.stringify({ v: 2, type: 'typed', id: 'abcdefgh' }));
  assert.equal(JSON.parse((await once(scanner, 'message'))[0]).status, 'typed');
  scanner.close(); desktop.close();
});

test('scanner reconnect rebinds a pending scan acknowledgement to the new socket', async t => {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }]);
  const scannerToken = 'c'.repeat(64);
  const desktopToken = 'd'.repeat(64);
  const probe = createServer({ cert: pems.cert, key: pems.private, port: 0, scannerToken, desktopToken, localIPs: ['127.0.0.1'] });
  await new Promise(resolve => probe.server.listen(0, '127.0.0.1', resolve));
  const port = probe.server.address().port;
  await new Promise(resolve => probe.wss.close(resolve));
  await new Promise(resolve => probe.server.close(resolve));
  const live = createServer({ cert: pems.cert, key: pems.private, port, scannerToken, desktopToken, localIPs: ['127.0.0.1'] });
  await new Promise(resolve => live.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { live.wss.clients.forEach(ws => ws.close()); await new Promise(resolve => live.wss.close(resolve)); await new Promise(resolve => live.server.close(resolve)); });
  const url = `wss://127.0.0.1:${port}/ws`;
  const desktop = new WebSocket(url, { rejectUnauthorized: false });
  await once(desktop, 'open');
  desktop.send(JSON.stringify({ v: 2, type: 'register', role: 'desktop', token: desktopToken }));
  await once(desktop, 'message');
  const origin = `https://127.0.0.1:${port}`;
  const scanner1 = new WebSocket(url, { rejectUnauthorized: false, origin });
  await once(scanner1, 'open');
  scanner1.send(JSON.stringify({ v: 2, type: 'register', role: 'scanner', token: scannerToken }));
  await once(scanner1, 'message');
  scanner1.send(JSON.stringify({ v: 2, type: 'scan', id: 'reconnect1', value: 'ABC-1' }));
  await once(desktop, 'message');
  await once(scanner1, 'message');
  // The desktop can disappear after receiving a scan but before it confirms
  // keyboard injection. This must be persisted, not just sent to scanner1.
  desktop.close();
  await once(desktop, 'close');
  assert.equal(JSON.parse((await once(scanner1, 'message'))[0]).status, 'delivery_unknown');
  scanner1.close();
  await once(scanner1, 'close');
  const scanner2 = new WebSocket(url, { rejectUnauthorized: false, origin });
  await once(scanner2, 'open');
  scanner2.send(JSON.stringify({ v: 2, type: 'register', role: 'scanner', token: scannerToken }));
  await once(scanner2, 'message');
  scanner2.send(JSON.stringify({ v: 2, type: 'scan', id: 'reconnect1', value: 'ABC-1' }));
  const delivery = JSON.parse((await once(scanner2, 'message'))[0]);
  assert.deepEqual({ type: delivery.type, id: delivery.id, status: delivery.status }, { type: 'delivery', id: 'reconnect1', status: 'delivery_unknown' });
  scanner2.close();
});

test('rejected WebSocket upgrades release their per-IP connection quota', async t => {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }]);
  const scannerToken = 'e'.repeat(64);
  const desktopToken = 'f'.repeat(64);
  const probe = createServer({ cert: pems.cert, key: pems.private, port: 0, scannerToken, desktopToken, localIPs: ['127.0.0.1'] });
  await new Promise(resolve => probe.server.listen(0, '127.0.0.1', resolve));
  const port = probe.server.address().port;
  await new Promise(resolve => probe.wss.close(resolve));
  await new Promise(resolve => probe.server.close(resolve));
  const live = createServer({ cert: pems.cert, key: pems.private, port, scannerToken, desktopToken, localIPs: ['127.0.0.1'] });
  await new Promise(resolve => live.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { live.wss.clients.forEach(ws => ws.close()); await new Promise(resolve => live.wss.close(resolve)); await new Promise(resolve => live.server.close(resolve)); });
  const badUrl = `wss://127.0.0.1:${port}/not-ws`;
  for (let i = 0; i < 5; i += 1) {
    const bad = new WebSocket(badUrl, { rejectUnauthorized: false });
    await once(bad, 'open');
    await once(bad, 'close');
  }
  const desktop = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
  await once(desktop, 'open');
  desktop.send(JSON.stringify({ v: 2, type: 'register', role: 'desktop', token: desktopToken }));
  assert.equal(JSON.parse((await once(desktop, 'message'))[0]).type, 'registered');
  desktop.close();
});
