// SPDX-License-Identifier: AGPL-3.0-only
// wusbfff: runs in the page's own JS world and provides navigator.usb.
// All real work is delegated to content.js via window.postMessage.
(() => {
  'use strict';
  if (!window.isSecureContext || 'usb' in navigator) return;

  const TAG = '__wusbfff';
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m[TAG] !== 'res') return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new DOMException(m.error.message, m.error.name || 'NetworkError'));
  });

  function call(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      window.postMessage({ [TAG]: 'req', id, op, args }, '*');
    });
  }

  // Copy any buffer or view into an exactly-sized ArrayBuffer (structured-cloned as is, no base64).
  function toBuf(data) {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    return bytes.slice().buffer;
  }

  class USBEndpoint {
    constructor(e) {
      this.endpointNumber = e.endpointNumber;
      this.direction = e.direction;
      this.type = e.type;
      this.packetSize = e.packetSize;
    }
  }

  class USBAlternateInterface {
    constructor(a) {
      this.alternateSetting = a.alternateSetting;
      this.interfaceClass = a.interfaceClass;
      this.interfaceSubclass = a.interfaceSubclass;
      this.interfaceProtocol = a.interfaceProtocol;
      this.interfaceName = null;
      this.endpoints = a.endpoints.map((e) => new USBEndpoint(e));
    }
  }

  class USBInterface {
    constructor(i) {
      this.interfaceNumber = i.interfaceNumber;
      this.alternates = i.alternates.map((a) => new USBAlternateInterface(a));
      this.alternate = this.alternates.find((a) => a.alternateSetting === 0) || this.alternates[0] || null;
      this.claimed = false;
    }
  }

  class USBConfiguration {
    constructor(c) {
      this.configurationValue = c.configurationValue;
      this.configurationName = null;
      this.interfaces = c.interfaces.map((i) => new USBInterface(i));
    }
  }

  class USBInTransferResult {
    constructor(status, data) {
      this.status = status;
      this.data = data === undefined ? null : data;
    }
  }

  class USBOutTransferResult {
    constructor(status, bytesWritten) {
      this.status = status;
      this.bytesWritten = bytesWritten || 0;
    }
  }

  class USBConnectionEvent extends Event {
    constructor(type, init) {
      super(type, init);
      this.device = init && init.device;
    }
  }

  const ID = Symbol('id');
  const KEY = Symbol('key');

  const notOpen = () => new DOMException('The device must be opened first.', 'InvalidStateError');

  class USBDevice {
    constructor(d) {
      Object.defineProperty(this, ID, { value: d.id });
      Object.defineProperty(this, KEY, { value: d.key });
      for (const f of [
        'usbVersionMajor', 'usbVersionMinor', 'usbVersionSubminor',
        'deviceClass', 'deviceSubclass', 'deviceProtocol',
        'vendorId', 'productId',
        'deviceVersionMajor', 'deviceVersionMinor', 'deviceVersionSubminor',
        'manufacturerName', 'productName', 'serialNumber',
      ]) {
        this[f] = d[f] === undefined ? null : d[f];
      }
      this.configurations = d.configurations.map((c) => new USBConfiguration(c));
      this.configuration = null;
      this.opened = false;
    }

    _assertOpen() {
      if (!this.opened) throw notOpen();
    }

    _assertConfig() {
      if (!this.configuration) throw new DOMException('No configuration selected.', 'InvalidStateError');
    }

    _iface(n) {
      this._assertConfig();
      const i = this.configuration.interfaces.find((x) => x.interfaceNumber === n);
      if (!i) throw new DOMException('Interface not found.', 'NotFoundError');
      return i;
    }

    async open() {
      if (this.opened) return;
      const r = await call('open', { id: this[ID] });
      this.opened = true;
      this.configuration =
        this.configurations.find((c) => c.configurationValue === (r && r.configurationValue)) || null;
    }

    async close() {
      if (!this.opened) return;
      await call('close', { id: this[ID] });
      this.opened = false;
      if (this.configuration) this.configuration.interfaces.forEach((i) => (i.claimed = false));
    }

    async forget() {
      await call('revoke', { key: this[KEY] });
    }

    async selectConfiguration(value) {
      this._assertOpen();
      const cfg = this.configurations.find((c) => c.configurationValue === value);
      if (!cfg) throw new DOMException('Configuration not found.', 'NotFoundError');
      await call('selectConfiguration', { id: this[ID], configurationValue: value });
      this.configuration = cfg;
    }

    async claimInterface(n) {
      this._assertOpen();
      const i = this._iface(n);
      await call('claimInterface', { id: this[ID], interfaceNumber: n });
      i.claimed = true;
    }

    async releaseInterface(n) {
      this._assertOpen();
      const i = this._iface(n);
      await call('releaseInterface', { id: this[ID], interfaceNumber: n });
      i.claimed = false;
    }

    async selectAlternateInterface(n, alt) {
      this._assertOpen();
      const i = this._iface(n);
      const a = i.alternates.find((x) => x.alternateSetting === alt);
      if (!a) throw new DOMException('Alternate setting not found.', 'NotFoundError');
      await call('selectAlternateInterface', { id: this[ID], interfaceNumber: n, alternateSetting: alt });
      i.alternate = a;
    }

    async controlTransferIn(setup, length) {
      this._assertOpen();
      const r = await call('controlTransfer', { id: this[ID], dir: 'in', setup, length });
      return new USBInTransferResult(r.status, new DataView(r.data));
    }

    async controlTransferOut(setup, data) {
      this._assertOpen();
      const r = await call('controlTransfer', {
        id: this[ID], dir: 'out', setup, data: data ? toBuf(data) : undefined,
      });
      return new USBOutTransferResult(r.status, r.bytesWritten);
    }

    async clearHalt(direction, endpointNumber) {
      this._assertOpen();
      await call('clearHalt', { id: this[ID], direction, endpointNumber });
    }

    async transferIn(endpointNumber, length) {
      this._assertOpen();
      const r = await call('transferIn', { id: this[ID], endpointNumber, length });
      return new USBInTransferResult(r.status, new DataView(r.data));
    }

    async transferOut(endpointNumber, data) {
      this._assertOpen();
      const r = await call('transferOut', { id: this[ID], endpointNumber, data: toBuf(data) });
      return new USBOutTransferResult(r.status, r.bytesWritten);
    }

    async isochronousTransferIn() {
      throw new DOMException('Isochronous transfers are not supported.', 'NotSupportedError');
    }

    async isochronousTransferOut() {
      throw new DOMException('Isochronous transfers are not supported.', 'NotSupportedError');
    }

    async reset() {
      this._assertOpen();
      await call('reset', { id: this[ID] });
    }
  }

  const known = new Map(); // host id -> USBDevice (stable identity across calls)
  function wrap(d) {
    let dev = known.get(d.id);
    if (!dev) {
      dev = new USBDevice(d);
      known.set(d.id, dev);
    }
    return dev;
  }

  class USB extends EventTarget {
    async getDevices() {
      return (await call('devices', {})).map(wrap);
    }

    async requestDevice(options) {
      if (!options || !Array.isArray(options.filters)) {
        throw new TypeError("Failed to execute 'requestDevice' on 'USB': required member filters is undefined.");
      }
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        throw new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
      }
      return wrap(await call('requestDevice', {
        filters: options.filters,
        exclusionFilters: options.exclusionFilters || [],
      }));
    }
  }

  const usb = new USB();
  // Non-standard diagnostics: round-trips page -> extension -> native host and back.
  Object.defineProperty(usb, 'wusbfff', {
    value: Object.freeze({
      async ping() {
        const t0 = performance.now();
        const r = await call('ping', {});
        return { ...r, ms: Math.round((performance.now() - t0) * 10) / 10 };
      },
    }),
  });
  Object.defineProperty(Navigator.prototype, 'usb', {
    get() { return usb; },
    configurable: true,
    enumerable: true,
  });

  for (const [name, cls] of Object.entries({
    USB, USBDevice, USBConfiguration, USBInterface, USBAlternateInterface, USBEndpoint,
    USBInTransferResult, USBOutTransferResult, USBConnectionEvent,
  })) {
    Object.defineProperty(window, name, { value: cls, configurable: true, writable: true });
  }
})();
