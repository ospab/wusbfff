#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Native host for the wusbfff (WebUSB for Firefox) extension.

Control channel: Firefox native messaging (stdin/stdout, 4-byte length + JSON).
It is used only to start the host and hand the extension a loopback port and a
one-time token ({"op": "hello"} -> {"ok": true, "port": N, "token": "..."}).

Data channel: binary WebSocket on 127.0.0.1 (no base64, no 1 MB message cap).
Frame (both directions): u32le header_len | header JSON (utf-8) | raw payload
  request header:  {"id": n, "op": "...", "args": {...}}   payload = bytes to send to the device
  response header: {"id": n, "ok": true, "result": ...}    payload = bytes read from the device
                   {"id": n, "ok": false, "error": {"name", "message"}}
"""
import json
import os
import secrets
import struct
import sys
import threading

if sys.platform == "win32":
    import msvcrt

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# Keep stray prints away from the protocol channel.
OUT = sys.stdout.buffer
sys.stdout = sys.stderr

import usb.backend.libusb1  # noqa: E402
import usb.core  # noqa: E402
import usb.util  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402
from websockets.sync.server import serve  # noqa: E402

VERSION = "0.2.0"
MAX_READ = 4 * 1024 * 1024
EP_TYPES = {0: "control", 1: "isochronous", 2: "bulk", 3: "interrupt"}
REQ_TYPES = {"standard": 0, "class": 1, "vendor": 2}
RECIPIENTS = {"device": 0, "interface": 1, "endpoint": 2, "other": 3}

LIBUSB_ERRORS = {
    -3: ("SecurityError", "Access denied to the device"),
    -4: ("NotFoundError", "Device disconnected"),
    -5: ("NotFoundError", "Device not found"),
    -6: ("NetworkError", "Device is busy in another program (for Quest: run `adb kill-server`)"),
    -12: ("NotSupportedError", "No WinUSB/libusb driver is installed for this device"),
}

TOKEN = secrets.token_hex(16)

_backend = None
_devices = {}  # id -> usb.core.Device
_descriptors = {}  # id -> descriptor dict
_lock = threading.Lock()
_out_lock = threading.Lock()


class HostError(Exception):
    def __init__(self, name, message):
        super().__init__(message)
        self.name = name
        self.message = message


def backend():
    global _backend
    if _backend is None:
        try:
            import libusb_package

            _backend = usb.backend.libusb1.get_backend(find_library=libusb_package.find_library)
        except ImportError:
            pass
        if _backend is None:
            _backend = usb.backend.libusb1.get_backend()
        if _backend is None:
            raise HostError("NotSupportedError", "libusb not found: pip install libusb-package")
    return _backend


def usb_error_code(e):
    return getattr(e, "backend_error_code", None)


def to_host_error(e):
    if isinstance(e, HostError):
        return e
    if isinstance(e, usb.core.USBTimeoutError):
        return HostError("NetworkError", "Transfer timed out")
    if isinstance(e, usb.core.USBError):
        code = usb_error_code(e)
        if code in LIBUSB_ERRORS:
            return HostError(*LIBUSB_ERRORS[code])
        return HostError("NetworkError", str(e))
    if isinstance(e, NotImplementedError):
        return HostError("NotSupportedError", "No WinUSB/libusb driver is installed for this device")
    return HostError("UnknownError", "%s: %s" % (type(e).__name__, e))


def dev_id(d):
    return "%s:%s:%04x:%04x" % (d.bus, d.address, d.idVendor, d.idProduct)


def safe(fn):
    try:
        return fn()
    except Exception:
        return None


def build_descriptor(d):
    manufacturer = safe(lambda: d.manufacturer)
    product = safe(lambda: d.product)
    serial = safe(lambda: d.serial_number)
    vid, pid = d.idVendor, d.idProduct
    key = "%04x:%04x:%s" % (vid, pid, serial if serial else "@%s.%s" % (d.bus, d.address))
    configurations = []
    for cfg in d:
        interfaces = {}
        for intf in cfg:
            endpoints = [
                {
                    "endpointNumber": ep.bEndpointAddress & 0x0F,
                    "direction": "in" if ep.bEndpointAddress & 0x80 else "out",
                    "type": EP_TYPES[ep.bmAttributes & 3],
                    "packetSize": ep.wMaxPacketSize,
                }
                for ep in intf
            ]
            interfaces.setdefault(intf.bInterfaceNumber, []).append(
                {
                    "alternateSetting": intf.bAlternateSetting,
                    "interfaceClass": intf.bInterfaceClass,
                    "interfaceSubclass": intf.bInterfaceSubClass,
                    "interfaceProtocol": intf.bInterfaceProtocol,
                    "endpoints": endpoints,
                }
            )
        configurations.append(
            {
                "configurationValue": cfg.bConfigurationValue,
                "interfaces": [
                    {"interfaceNumber": n, "alternates": alts} for n, alts in sorted(interfaces.items())
                ],
            }
        )
    usb_ver, dev_ver = d.bcdUSB, d.bcdDevice
    return {
        "id": dev_id(d),
        "key": key,
        "vendorId": vid,
        "productId": pid,
        "deviceClass": d.bDeviceClass,
        "deviceSubclass": d.bDeviceSubClass,
        "deviceProtocol": d.bDeviceProtocol,
        "usbVersionMajor": usb_ver >> 8,
        "usbVersionMinor": (usb_ver >> 4) & 0xF,
        "usbVersionSubminor": usb_ver & 0xF,
        "deviceVersionMajor": dev_ver >> 8,
        "deviceVersionMinor": (dev_ver >> 4) & 0xF,
        "deviceVersionSubminor": dev_ver & 0xF,
        "manufacturerName": manufacturer,
        "productName": product,
        "serialNumber": serial,
        "configurations": configurations,
    }


# Handlers take an args dict. Ops that send bytes to the device find them in
# args["_payload"]; ops that return bytes put them in result["_data"].


def op_ping(_):
    backend()
    return {"version": VERSION}


def op_list(_):
    found = list(usb.core.find(find_all=True, backend=backend()))
    with _lock:
        fresh = {}
        for d in found:
            if d.bDeviceClass == 9:  # hubs
                continue
            i = dev_id(d)
            if i in _devices:
                fresh[i] = _devices[i]
            else:
                fresh[i] = d
                _descriptors[i] = safe(lambda: build_descriptor(d))
        for i in list(_devices):
            if i not in fresh:
                safe(lambda: usb.util.dispose_resources(_devices[i]))
                _descriptors.pop(i, None)
        _devices.clear()
        _devices.update(fresh)
        return [desc for i, desc in ((i, _descriptors.get(i)) for i in fresh) if desc]


def get_dev(args):
    with _lock:
        d = _devices.get(args.get("id"))
    if d is None:
        raise HostError("NotFoundError", "Device not found or disconnected")
    return d


def ep_addr(direction, number):
    return (0x80 if direction == "in" else 0x00) | (number & 0x0F)


def op_open(args):
    d = get_dev(args)
    d._ctx.managed_open()
    value = None
    try:
        value = d.get_active_configuration().bConfigurationValue
    except Exception:
        pass
    return {"configurationValue": value}


def op_close(args):
    usb.util.dispose_resources(get_dev(args))
    return None


def op_select_configuration(args):
    d = get_dev(args)
    value = args["configurationValue"]
    try:
        if d.get_active_configuration().bConfigurationValue == value:
            return None
    except Exception:
        pass
    d.set_configuration(value)
    return None


def op_claim_interface(args):
    d = get_dev(args)
    n = args["interfaceNumber"]
    if sys.platform != "win32":
        try:
            if d.is_kernel_driver_active(n):
                d.detach_kernel_driver(n)
        except Exception:
            pass
    usb.util.claim_interface(d, n)
    return None


def op_release_interface(args):
    usb.util.release_interface(get_dev(args), args["interfaceNumber"])
    return None


def op_select_alternate(args):
    get_dev(args).set_interface_altsetting(args["interfaceNumber"], args["alternateSetting"])
    return None


def op_clear_halt(args):
    get_dev(args).clear_halt(ep_addr(args["direction"], args["endpointNumber"]))
    return None


def op_reset(args):
    get_dev(args).reset()
    return None


def transfer_status(e):
    code = usb_error_code(e)
    if code == -9:
        return "stall"
    if code == -8:
        return "babble"
    return None


def op_transfer_in(args):
    d = get_dev(args)
    length = min(int(args["length"]), MAX_READ)
    try:
        data = d.read(ep_addr("in", args["endpointNumber"]), length, timeout=0)
    except usb.core.USBError as e:
        status = transfer_status(e)
        if status:
            return {"status": status, "_data": b""}
        raise
    return {"status": "ok", "_data": data.tobytes()}


def op_transfer_out(args):
    d = get_dev(args)
    try:
        written = d.write(ep_addr("out", args["endpointNumber"]), args.get("_payload") or b"", timeout=0)
    except usb.core.USBError as e:
        status = transfer_status(e)
        if status:
            return {"status": status, "bytesWritten": 0}
        raise
    return {"status": "ok", "bytesWritten": written}


def op_control_transfer(args):
    d = get_dev(args)
    s = args["setup"]
    direction = 0x80 if args["dir"] == "in" else 0x00
    bm = direction | (REQ_TYPES[s["requestType"]] << 5) | RECIPIENTS[s["recipient"]]
    try:
        if args["dir"] == "in":
            data = d.ctrl_transfer(bm, s["request"], s["value"], s["index"], int(args["length"]), timeout=5000)
            return {"status": "ok", "_data": data.tobytes()}
        written = d.ctrl_transfer(bm, s["request"], s["value"], s["index"], args.get("_payload") or b"", timeout=5000)
        return {"status": "ok", "bytesWritten": written}
    except usb.core.USBError as e:
        status = transfer_status(e)
        if status:
            return {"status": status, "_data": b"", "bytesWritten": 0}
        raise


HANDLERS = {
    "ping": op_ping,
    "list": op_list,
    "open": op_open,
    "close": op_close,
    "selectConfiguration": op_select_configuration,
    "claimInterface": op_claim_interface,
    "releaseInterface": op_release_interface,
    "selectAlternateInterface": op_select_alternate,
    "clearHalt": op_clear_halt,
    "reset": op_reset,
    "transferIn": op_transfer_in,
    "transferOut": op_transfer_out,
    "controlTransfer": op_control_transfer,
}


def pack(head, payload=b""):
    h = json.dumps(head, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(h)) + h + payload


def run_op(msg, payload):
    """Run one request; returns the response frame."""
    mid = msg.get("id")
    try:
        handler = HANDLERS.get(msg.get("op"))
        if handler is None:
            raise HostError("NotSupportedError", "Unknown operation: %s" % msg.get("op"))
        args = dict(msg.get("args") or {})
        if payload:
            args["_payload"] = payload
        result = handler(args)
        data = b""
        if isinstance(result, dict) and "_data" in result:
            data = result.pop("_data")
        return pack({"id": mid, "ok": True, "result": result}, data)
    except Exception as e:  # noqa: BLE001
        err = to_host_error(e)
        if not isinstance(e, HostError):
            print("host error in %s: %r" % (msg.get("op"), e), file=sys.stderr)
        return pack({"id": mid, "ok": False, "error": {"name": err.name, "message": err.message}})


def serve_frame(ws, frame):
    try:
        (hl,) = struct.unpack_from("<I", frame, 0)
        msg = json.loads(frame[4 : 4 + hl].decode("utf-8"))
        reply = run_op(msg, bytes(frame[4 + hl :]))
        with _out_lock:
            ws.send(reply)
    except ConnectionClosed:
        pass
    except Exception as e:  # noqa: BLE001
        print("frame error: %r" % e, file=sys.stderr)


def ws_handler(ws):
    origin = ws.request.headers.get("Origin", "")
    if not origin.startswith("moz-extension://"):
        ws.close(1008, "forbidden")
        return
    try:
        auth = json.loads(ws.recv(timeout=5))
        if not secrets.compare_digest(str(auth.get("auth", "")), TOKEN):
            ws.close(1008, "bad token")
            return
        ws.send("ready")
        for frame in ws:
            if isinstance(frame, bytes):
                threading.Thread(target=serve_frame, args=(ws, frame), daemon=True).start()
    except (ConnectionClosed, TimeoutError, ValueError):
        pass


def native_send(obj):
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    OUT.write(struct.pack("=I", len(data)) + data)
    OUT.flush()


def native_read():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (n,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def main():
    server = serve(ws_handler, "127.0.0.1", 0, max_size=None, compression=None)
    port = server.socket.getsockname()[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    while True:
        msg = native_read()
        if msg is None:
            break
        if msg.get("op") == "hello":
            try:
                backend()
                native_send({"ok": True, "port": port, "token": TOKEN, "version": VERSION})
            except HostError as e:
                native_send({"ok": False, "error": {"name": e.name, "message": e.message}})
    os._exit(0)  # Firefox closed the pipe: shut down, dropping any blocked USB reads


if __name__ == "__main__":
    main()
