const { useState } = React;
const hex = (n, w = 4) => n.toString(16).padStart(w, '0');
const bytesHex = (dv) => [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map((b) => hex(b, 2)).join(' ');

const CNXN = 0x4e584e43, AUTH = 0x48545541;
function adbPacket(cmd, a0, a1, payload) {
  const buf = new ArrayBuffer(24 + payload.length);
  const v = new DataView(buf);
  let crc = 0;
  for (const b of payload) crc += b;
  [cmd, a0, a1, payload.length, crc >>> 0, (cmd ^ 0xffffffff) >>> 0].forEach((x, i) => v.setUint32(i * 4, x, true));
  new Uint8Array(buf, 24).set(payload);
  return new Uint8Array(buf);
}

function App() {
  const [devices, setDevices] = useState([]);
  const [sel, setSel] = useState(null);
  const [log, setLog] = useState([]);
  const [, force] = useState(0);
  const supported = 'usb' in navigator;

  const say = (m, k = '') => setLog((l) => [...l, { t: new Date().toLocaleTimeString(), m, k }]);
  const run = async (name, fn) => {
    try {
      const r = await fn();
      say(name + ': ok' + (r !== undefined ? ' → ' + r : ''), 'ok');
    } catch (e) {
      say(`${name}: ${e.name}: ${e.message}`, 'err');
    }
    force((x) => x + 1);
  };

  const refresh = () => run('getDevices', async () => {
    const d = await navigator.usb.getDevices();
    setDevices(d);
    return d.length + ' device(s)';
  });
  const request = () => run('requestDevice', async () => {
    const d = await navigator.usb.requestDevice({ filters: [] });
    setSel(d);
    setDevices(await navigator.usb.getDevices());
    return `${hex(d.vendorId)}:${hex(d.productId)} ${d.productName || ''}`;
  });
  const requestAdb = () => run('requestDevice(ADB)', async () => {
    const d = await navigator.usb.requestDevice({ filters: [{ classCode: 0xff, subclassCode: 0x42, protocolCode: 1 }] });
    setSel(d);
    setDevices(await navigator.usb.getDevices());
    return `${hex(d.vendorId)}:${hex(d.productId)} ${d.productName || ''}`;
  });

  const ensureReady = async (d) => {
    if (!d.opened) await d.open();
    if (!d.configuration) await d.selectConfiguration(d.configurations[0].configurationValue);
  };

  const descriptorTest = () => run('GET_DESCRIPTOR', async () => {
    await sel.open().catch(() => {});
    const r = await sel.controlTransferIn(
      { requestType: 'standard', recipient: 'device', request: 6, value: 0x0100, index: 0 }, 18);
    return `${r.status}, ${bytesHex(r.data)}`;
  });

  const adbTest = () => run('ADB CNXN', async () => {
    await ensureReady(sel);
    let iface, alt;
    for (const i of sel.configuration.interfaces) {
      const a = i.alternates.find((x) => x.interfaceClass === 0xff && x.interfaceSubclass === 0x42 && x.interfaceProtocol === 1);
      if (a) { iface = i; alt = a; break; }
    }
    if (!iface) throw new Error('ADB interface (ff/42/01) not found');
    if (!iface.claimed) await sel.claimInterface(iface.interfaceNumber);
    const inEp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
    const outEp = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    const banner = new TextEncoder().encode('host::wusbfff\0');
    const w = await sel.transferOut(outEp.endpointNumber, adbPacket(CNXN, 0x01000001, 4096, banner));
    say(`CNXN sent (${w.bytesWritten} bytes)`);
    const r = await sel.transferIn(inEp.endpointNumber, 24);
    const v = r.data;
    const cmd = v.getUint32(0, true);
    const name = String.fromCharCode(cmd & 255, (cmd >> 8) & 255, (cmd >> 16) & 255, (cmd >> 24) & 255);
    const len = v.getUint32(12, true);
    let extra = '';
    if (len) extra = ' «' + new TextDecoder().decode((await sel.transferIn(inEp.endpointNumber, len)).data) + '»';
    return `${name}${cmd === AUTH ? ' (accept the RSA key prompt on the device, this is normal)' : ''}${extra}`;
  });

  const cfg = sel && sel.configuration;
  return (
    <>
      <h1>wusbfff tester</h1>
      <section>
        WebUSB: <span className={'badge ' + (supported ? 'yes' : 'no')}>{supported ? 'navigator.usb available' : 'navigator.usb missing'}</span>
        {!supported && <p>Open this page via <code>http://localhost:8080</code> and enable the wusbfff extension.</p>}
        <p>
          <button disabled={!supported} onClick={request}>requestDevice (all)</button>
          <button disabled={!supported} onClick={requestAdb}>requestDevice (ADB only)</button>
          <button disabled={!supported} onClick={refresh}>getDevices</button>
        </p>
        {devices.map((d, i) => (
          <div key={i} className={'dev' + (d === sel ? ' sel' : '')} onClick={() => setSel(d)}>
            {d.productName || 'USB device'} {d.opened && <span className="badge yes">open</span>}
            <small>{hex(d.vendorId)}:{hex(d.productId)} · {d.manufacturerName || '—'} · s/n {d.serialNumber || '—'} · class {d.deviceClass}</small>
          </div>
        ))}
      </section>

      {sel && (
        <section>
          <b>{sel.productName || 'Device'}</b> — configuration: {cfg ? cfg.configurationValue : 'none selected'}
          <p>
            <button onClick={() => run('open', () => sel.open())}>open</button>
            <button onClick={() => run('close', () => sel.close())}>close</button>
            <button onClick={() => run('selectConfiguration', () => sel.selectConfiguration(sel.configurations[0].configurationValue))}>selectConfiguration</button>
            <button onClick={descriptorTest}>GET_DESCRIPTOR</button>
            <button onClick={adbTest}>ADB: CNXN</button>
            <button onClick={() => run('reset', () => sel.reset())}>reset</button>
            <button onClick={() => run('forget', async () => { await sel.forget(); setDevices(await navigator.usb.getDevices()); setSel(null); })}>forget</button>
          </p>
          {cfg && cfg.interfaces.map((i) => {
            const a = i.alternate;
            return (
              <div key={i.interfaceNumber}>
                Interface {i.interfaceNumber}
                {a && <> · class {hex(a.interfaceClass, 2)}/{hex(a.interfaceSubclass, 2)}/{hex(a.interfaceProtocol, 2)} · eps: {a.endpoints.map((e) => `${e.endpointNumber}${e.direction === 'in' ? '↓' : '↑'}${e.type}`).join(', ')}</>}
                {' '}
                <button onClick={() => run('claim ' + i.interfaceNumber, () => sel.claimInterface(i.interfaceNumber))} disabled={i.claimed}>claim</button>
                <button onClick={() => run('release ' + i.interfaceNumber, () => sel.releaseInterface(i.interfaceNumber))} disabled={!i.claimed}>release</button>
              </div>
            );
          })}
        </section>
      )}

      <section>
        <button onClick={() => setLog([])}>clear log</button>
        <pre>{log.map((l, i) => <div key={i} className={l.k}>[{l.t}] {l.m}</div>)}</pre>
      </section>
    </>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<App />);

