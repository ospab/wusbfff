'use strict';

const HOST = 'wusbfff';
const enc = new TextEncoder();
const dec = new TextDecoder();

// Control channel: native messaging, used only to start the host and get its
// loopback port + token. Data channel: binary WebSocket to that port.
let conn = null; // Promise<WebSocket> | null
let seq = 0;
const pending = new Map();
const deviceKeys = new Map(); // host device id -> stable key (vid:pid:serial)

const fail = (name, message) => ({ ok: false, error: { name, message } });

function failAll(message) {
  for (const [, resolve] of pending) resolve(fail('NetworkError', message));
  pending.clear();
}

function onFrame(buf) {
  const hl = new DataView(buf).getUint32(0, true);
  const head = JSON.parse(dec.decode(new Uint8Array(buf, 4, hl)));
  const resolve = pending.get(head.id);
  if (!resolve) return;
  pending.delete(head.id);
  resolve(head.ok ? { ok: true, result: head.result, data: buf.slice(4 + hl) } : { ok: false, error: head.error });
}

function connect() {
  if (conn) return conn;
  conn = new Promise((resolve, reject) => {
    const np = browser.runtime.connectNative(HOST);
    let ws = null;
    let settled = false;
    const teardown = (message) => {
      conn = null;
      try { if (ws) ws.close(); } catch (e) { /* already closed */ }
      try { np.disconnect(); } catch (e) { /* already gone */ }
      failAll(message);
      if (!settled) { settled = true; reject(new Error(message)); }
    };
    np.onDisconnect.addListener((p) => {
      teardown('Native host unavailable: ' + ((p && p.error && p.error.message) || 'run install.ps1'));
    });
    np.onMessage.addListener((m) => {
      if (!m.ok) return teardown('Host: ' + (m.error && m.error.message));
      ws = new WebSocket('ws://127.0.0.1:' + m.port);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(JSON.stringify({ auth: m.token }));
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          if (!settled) { settled = true; resolve(ws); }
          return;
        }
        onFrame(e.data);
      };
      ws.onclose = () => teardown('Connection to the host was closed');
      ws.onerror = () => {};
    });
    np.postMessage({ op: 'hello' });
  });
  return conn;
}

async function native(op, args, payload) {
  let ws;
  try {
    ws = await connect();
  } catch (e) {
    return fail('NetworkError', e.message);
  }
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    const head = enc.encode(JSON.stringify({ id, op, args }));
    const body = payload ? new Uint8Array(payload) : null;
    const frame = new Uint8Array(4 + head.length + (body ? body.length : 0));
    new DataView(frame.buffer).setUint32(0, head.length, true);
    frame.set(head, 4);
    if (body) frame.set(body, 4 + head.length);
    try {
      ws.send(frame);
    } catch (e) {
      pending.delete(id);
      resolve(fail('NetworkError', String(e)));
    }
  });
}

async function getGrants() {
  const { grants } = await browser.storage.local.get('grants');
  return grants || {};
}

async function listDevices() {
  const r = await native('list', {});
  if (r.ok) for (const d of r.result) deviceKeys.set(d.id, d.key);
  return r;
}

function originOf(sender) {
  try {
    return new URL(sender.url).origin;
  } catch (e) {
    return null;
  }
}

async function handle(msg, sender) {
  const origin = originOf(sender);
  if (!origin) return fail('SecurityError', 'Unknown origin');

  switch (msg.kind) {
    case 'chooserList':
      return listDevices();

    case 'ping': {
      const r = await native('ping', {});
      if (!r.ok) return r;
      return {
        ok: true,
        result: { extensionVersion: browser.runtime.getManifest().version, hostVersion: r.result.version },
      };
    }

    case 'grant': {
      const grants = await getGrants();
      const set = new Set(grants[origin] || []);
      set.add(msg.key);
      grants[origin] = [...set];
      await browser.storage.local.set({ grants });
      return { ok: true, result: null };
    }

    case 'revoke': {
      const grants = await getGrants();
      grants[origin] = (grants[origin] || []).filter((k) => k !== msg.key);
      await browser.storage.local.set({ grants });
      return { ok: true, result: null };
    }

    case 'devices': {
      const r = await listDevices();
      if (!r.ok) return r;
      const granted = new Set((await getGrants())[origin] || []);
      return { ok: true, result: r.result.filter((d) => granted.has(d.key)) };
    }

    case 'op': {
      const id = msg.args && msg.args.id;
      const key = deviceKeys.get(id);
      const granted = new Set((await getGrants())[origin] || []);
      if (!key || !granted.has(key)) return fail('SecurityError', 'This site has no access to the device');
      return native(msg.op, msg.args, msg.payload);
    }
  }
  return fail('NotSupportedError', 'Unknown message');
}

browser.runtime.onMessage.addListener((msg, sender) => handle(msg, sender));
