// wusbfff: isolated-world bridge between the page (inject.js) and background.js.
// Also owns the device chooser, which the page can neither see nor script.
'use strict';

const TAG = '__wusbfff';

function matches(f, d) {
  if (f.vendorId !== undefined && f.vendorId !== d.vendorId) return false;
  if (f.productId !== undefined && f.productId !== d.productId) return false;
  if (f.serialNumber !== undefined && f.serialNumber !== d.serialNumber) return false;
  if (f.classCode === undefined) return true;
  const ok = (cls, sub, proto) =>
    cls === f.classCode &&
    (f.subclassCode === undefined || sub === f.subclassCode) &&
    (f.protocolCode === undefined || proto === f.protocolCode);
  if (ok(d.deviceClass, d.deviceSubclass, d.deviceProtocol)) return true;
  return d.configurations.some((c) =>
    c.interfaces.some((i) =>
      i.alternates.some((a) => ok(a.interfaceClass, a.interfaceSubclass, a.interfaceProtocol))));
}

const passes = (d, filters, exclusions) =>
  (filters.length === 0 || filters.some((f) => matches(f, d))) &&
  !exclusions.some((f) => matches(f, d));

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  Object.assign(el, props || {});
  el.append(...children);
  return el;
}

const hex = (n) => n.toString(16).padStart(4, '0');

const VENDORS = { 0x2833: 'Meta / Oculus', 0x2d40: 'Meta / Oculus', 0x18d1: 'Google / Android' };

// Names come from USB string descriptors, which the host cannot read while another
// program (e.g. the ADB server) holds the device, so fall back to what we do know.
function deviceLabel(d) {
  if (d.productName) return d.productName;
  const isAdb = d.configurations.some((c) => c.interfaces.some((i) => i.alternates.some(
    (a) => a.interfaceClass === 0xff && a.interfaceSubclass === 0x42 && a.interfaceProtocol === 1)));
  const vendor = VENDORS[d.vendorId];
  if (vendor) return `${vendor} device${isAdb ? ' (ADB)' : ''}`;
  return isAdb ? 'Android device (ADB)' : 'USB device';
}

const CSS = `
  :host { all: initial; }
  .back { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex;
          align-items: flex-start; justify-content: center; padding-top: 12vh;
          font: 14px system-ui, sans-serif; }
  .box { background: Canvas; color: CanvasText; border: 1px solid GrayText; border-radius: 10px;
         width: min(440px, 92vw); padding: 16px; box-shadow: 0 8px 32px rgba(0,0,0,.4);
         color-scheme: light dark; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p { margin: 0 0 12px; color: GrayText; font-size: 12px; }
  .list { max-height: 260px; overflow: auto; border: 1px solid GrayText; border-radius: 6px; }
  .row { display: block; width: 100%; text-align: left; padding: 8px 10px; border: 0;
         background: none; color: inherit; font: inherit; cursor: pointer; }
  .row:hover { background: color-mix(in srgb, CanvasText 10%, transparent); }
  .row[aria-selected=true] { background: Highlight; color: HighlightText; }
  .row small { display: block; opacity: .7; font-size: 11px; }
  .empty { padding: 14px 10px; color: GrayText; }
  .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  button.b { padding: 6px 14px; font: inherit; border-radius: 6px; border: 1px solid GrayText;
             background: ButtonFace; color: ButtonText; cursor: pointer; }
  button.b:disabled { opacity: .5; cursor: default; }
`;

function chooseDevice(devices) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    let selected = null;

    const connect = h('button', { className: 'b', textContent: 'Connect', disabled: true });
    const cancel = h('button', { className: 'b', textContent: 'Cancel' });
    const list = h('div', { className: 'list', role: 'listbox' });

    if (devices.length === 0) {
      list.append(h('div', { className: 'empty', textContent: 'No compatible devices found.' }));
    }
    for (const d of devices) {
      const row = h('button', { className: 'row', role: 'option' },
        deviceLabel(d),
        h('small', { textContent: `${hex(d.vendorId)}:${hex(d.productId)}${d.serialNumber ? ' · ' + d.serialNumber : ''}` }));
      row.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        selected = d;
        list.querySelectorAll('.row').forEach((r) => r.setAttribute('aria-selected', String(r === row)));
        connect.disabled = false;
      });
      row.addEventListener('dblclick', (e) => e.isTrusted && finish(d));
      list.append(row);
    }

    const finish = (d) => {
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      resolve(d);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && e.isTrusted) finish(null);
    };
    document.addEventListener('keydown', onKey, true);
    connect.addEventListener('click', (e) => e.isTrusted && selected && finish(selected));
    cancel.addEventListener('click', (e) => e.isTrusted && finish(null));

    root.append(
      h('style', { textContent: CSS }),
      h('div', { className: 'back' },
        h('div', { className: 'box' },
          h('h1', { textContent: 'Select a USB device' }),
          h('p', { textContent: `${location.origin} wants to connect to a USB device (wusbfff)` }),
          list,
          h('div', { className: 'btns' }, cancel, connect))));
    (document.documentElement || document).append(host);
  });
}

const bg = (msg) => browser.runtime.sendMessage(msg);

async function unwrap(p, full) {
  const r = await p;
  if (!r || !r.ok) throw r && r.error ? r.error : { name: 'NetworkError', message: 'No response from the extension' };
  return full ? r : r.result;
}

async function requestDevice({ filters, exclusionFilters }) {
  // Enforced here as well as in inject.js: the page can post to this script directly.
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    throw { name: 'SecurityError', message: 'Must be handling a user gesture to show a permission request.' };
  }
  const all = await unwrap(bg({ kind: 'chooserList' }));
  const chosen = await chooseDevice(all.filter((d) => passes(d, filters, exclusionFilters)));
  if (!chosen) throw { name: 'NotFoundError', message: 'No device selected.' };
  await unwrap(bg({ kind: 'grant', key: chosen.key }));
  return chosen;
}

async function dispatch(op, args) {
  switch (op) {
    case 'requestDevice': return requestDevice(args);
    case 'devices': return unwrap(bg({ kind: 'devices' }));
    case 'ping': return unwrap(bg({ kind: 'ping' }));
    case 'revoke': return unwrap(bg({ kind: 'revoke', key: args.key }));
    default: {
      // Binary payloads travel as ArrayBuffers (structured clone), never base64.
      const { data, ...rest } = args;
      const r = await unwrap(bg({ kind: 'op', op, args: rest, payload: data }), true);
      return r.data ? { ...(r.result || {}), data: r.data } : r.result;
    }
  }
}

window.addEventListener('message', async (e) => {
  const m = e.data;
  if (e.source !== window || !m || m[TAG] !== 'req') return;
  let reply;
  try {
    reply = { ok: true, result: await dispatch(m.op, m.args || {}) };
  } catch (err) {
    reply = { ok: false, error: { name: err.name || 'NetworkError', message: err.message || String(err) } };
  }
  const data = reply.result && reply.result.data;
  window.postMessage({ [TAG]: 'res', id: m.id, ...reply }, '*', data instanceof ArrayBuffer ? [data] : []);
});
