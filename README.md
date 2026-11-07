# wusbfff — WebUSB for Firefox

Firefox has no WebUSB, so `wusbfff` adds `navigator.usb` with an extension, and a small native
host built on libusb (Python + pyusb) does the actual USB work.

```
page ──postMessage──> content.js ──> background.js ──WebSocket (binary)──> host.py ──libusb──> USB
 (inject.js: navigator.usb)   (device chooser)   (per-origin permissions)
                                     └── native messaging: only to start the host and hand over port + token
```

## Install (Windows)

One line, in PowerShell (installs the native host; then open the printed `wusbfff.xpi` path in Firefox):

```powershell
irm https://raw.githubusercontent.com/ospab/wusbfff/main/get.ps1 | iex
```

Or manually:

1. Install Python 3 (with the `py` launcher) and Firefox 140 or newer.
2. Unzip the release (`wusbfff-<version>-windows.zip`) and run:
   `powershell -ExecutionPolicy Bypass -File install.ps1`
   It copies the host to `%LOCALAPPDATA%\wusbfff`, creates a venv, installs dependencies and registers
   the native host for Firefox (HKCU, no admin rights needed). The unzipped folder can be deleted afterwards.
3. Install the add-on: open `wusbfff.xpi` in Firefox (see below for signing).

Uninstall: `uninstall.ps1`, then remove the add-on in `about:addons`.

## First run

Installed from addons.mozilla.org, the extension opens a setup page and has a toolbar popup. If the native helper is
missing, they offer the one-line install command, a double-click `install-wusbfff.cmd`, or a link to this repo.
(A browser extension cannot run programs, so the user runs the installer.) The installer sets up Python through winget
if needed, installs the helper, and checks that a WinUSB driver is present (it prints the official Meta/Google driver
links if not).

## Keeping it installed permanently

Release and Beta Firefox only install **signed** add-ons, and temporary add-ons from `about:debugging`
disappear on restart. Pick one:

- **Sign it yourself (recommended, free).** Create API keys at <https://addons.mozilla.org/developers/addon/api/key/>, then:
  ```
  $env:WEB_EXT_API_KEY = "user:..."; $env:WEB_EXT_API_SECRET = "..."
  .\package.ps1 -Sign
  ```
  This submits the add-on as *unlisted* (private, not published) and produces a signed `wusbfff.xpi`
  in the bundle that installs in any Firefox and survives restarts and updates.
- **Firefox Developer Edition / Nightly / ESR with unbranded builds:** set `xpinstall.signatures.required`
  to `false` in `about:config`, then open the unsigned `.xpi`.
- **Temporary:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `extension\manifest.json`
  (gone after restart).

## Build the package

```
.\package.ps1            # dist\wusbfff-<version>.xpi + dist\wusbfff-<version>-windows.zip (unsigned)
.\package.ps1 -Sign      # same, with the xpi signed on AMO
```

## Status page

`docs/index.html` is a small page that checks the whole chain: secure context, `navigator.usb`, the extension,
the native host running outside the browser (round trip with latency), and libusb enumeration. It is meant to be
served with GitHub Pages (`https://ospab.github.io/wusbfff/`) but also works locally. The extension exposes a
non-standard `navigator.usb.wusbfff.ping()` for this.

Publishing to the Mozilla add-on store: see [RELEASE.md](RELEASE.md).

## Tester

```
cd tester
py -3 -m http.server 8080
```

Open <http://localhost:8080> (WebUSB is allowed on localhost without HTTPS). The page is a fully
self-contained React build: `tester/index.html` is a single file with React inlined, no internet needed.
It can pick a device, open/claim interfaces, run GET_DESCRIPTOR and a test ADB CNXN handshake.

Sources are in `tester/src/app.jsx`; rebuild with `node tester/build.js`.

## Quest / ADB

- The device needs a WinUSB-based driver (Google USB Driver or the Oculus/Meta ADB driver).
  For other devices WinUSB can be installed with Zadig.
- Run `adb kill-server` before use: the ADB server holds the interface and libusb would report "busy".
- Sites built on ya-webadb/Tango (ADB in the browser) should work as in Chrome.
- If Windows does not list the headset under USB at all, it is a cable/port/"Allow data access" problem,
  not a driver problem.

## What is and is not supported

- Supported: `requestDevice` (chooser, filters), `getDevices`, `forget`, open/close, configurations,
  interfaces, bulk/interrupt and control transfers, `clearHalt`, `reset`.
- Permissions are stored per origin in `storage.local` and enforced in the background script, not on the page.
- Not supported: `connect`/`disconnect` events, isochronous transfers, a Linux/macOS installer
  (`host.py` is cross-platform, only the host manifest is needed).
- Speed: native messaging is only used to start the host. Data travels as binary frames over a WebSocket
  on 127.0.0.1 (no base64, no 1 MB cap). The port is protected by a random token and an
  `Origin: moz-extension://` check. One read can return up to 4 MB.

## License

GNU Affero General Public License v3 (`AGPL-3.0-only`), see [LICENSE](LICENSE). The tester bundle includes React (MIT).
