# Releasing wusbfff to addons.mozilla.org (AMO)

Everything needed to publish the extension, in order. Status markers reflect the state of the repo
when this document was written: `[x]` done and verified, `[ ]` still to do.

## 1. Pre-flight checklist

Code and package
- [x] `npx web-ext lint --source-dir extension` — 0 errors, 1 warning (Firefox for Android minimum version; harmless, see 4.5)
- [x] Plain, unminified JS only (`background.js`, `content.js`, `inject.js`): no build step, no source-code upload needed
- [x] No remote code, no external network requests from the extension (only `ws://127.0.0.1` to its own host)
- [x] `data_collection_permissions: none` declared; `strict_min_version` 140 (needed for that key and for `world: "MAIN"`)
- [x] Content scripts run in the top-level frame only (`all_frames: false`)
- [x] `requestDevice` requires a user gesture and a trusted click in the chooser; per-origin permissions are enforced in the background script
- [x] The host's WebSocket accepts only `Origin: moz-extension://` plus a per-run random token, on 127.0.0.1
- [x] `.\package.ps1` produces `dist\wusbfff-<version>.xpi` and `dist\wusbfff-<version>-windows.zip`
- [ ] Manual test in Firefox with the packaged xpi: status page (`docs/index.html`) all green
- [ ] Manual test with real hardware (Quest + a WebUSB/ADB site)

Decisions (the add-on ID can never change after the first upload)
- [x] **Add-on ID:** `wusbfff@wusbfff.ospab.org` (set in `extension/manifest.json` and in `install.ps1` → `allowed_extensions`; keep both in sync)
- [x] **License:** GNU AGPL v3 (`LICENSE`, SPDX `AGPL-3.0-only` headers in the sources). In the AMO listing pick the AGPL v3 entry; if the
      preset list does not offer it, choose *Custom License* and link to `https://github.com/ospab/wusbfff/blob/main/LICENSE`.
- [x] **Support URL:** GitHub Issues (`https://github.com/ospab/wusbfff/issues`)
- [x] **First-run UX:** the toolbar popup (also opened in a tab right after installing from AMO) checks the native helper and, if it is
      missing, offers: copy the one-line install command, download `install-wusbfff.cmd`, open GitHub. The extension never runs
      anything itself (browsers cannot execute programs); the user runs the installer.
- [x] **Installer** (`get.ps1` → `install.ps1`): installs Python via winget on request (per user, no admin), the host, and checks for a WinUSB driver.
      It does **not** download or install a USB driver: Meta's ADB driver is not redistributable from a stable direct URL; it prints the official links instead.

Known issues to be aware of (disclose in the listing, they are real)
- Quest headsets (open issue, fix not yet implemented): libusb on Windows opens *every* interface of a composite device. If another program holds one
  (Meta's `OVRService`, a running ADB server) the open fails with `SecurityError: Access denied`. Planned fix: talk to the
  single needed interface directly through WinUSB. Until then, stop `OVRService` / run `adb kill-server`.
- No `connect` / `disconnect` events, no isochronous transfers.
- Windows installer only (the host itself is cross-platform).

## 2. One-time AMO setup

1. Create or sign in to a Mozilla account at <https://addons.mozilla.org/developers/>.
2. Enable two-factor authentication (required for developers).
3. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>. You get a *JWT issuer* (key) and *JWT secret*.
   Keep them out of the repo; use environment variables only:
   ```powershell
   $env:WEB_EXT_API_KEY = "user:12345:67"
   $env:WEB_EXT_API_SECRET = "<secret>"
   ```

## 3. Build

```powershell
npx web-ext lint --source-dir extension        # must show 0 errors
.\package.ps1                                  # dist\wusbfff-<version>.xpi (unsigned, upload this one to AMO)
```

Bump `version` in `extension/manifest.json` for every submission; AMO rejects a version that already exists.

## 4. Submit the listing

Go to <https://addons.mozilla.org/developers/addon/submit/distribution>.

1. **Distribution:** choose *On this site* (public listing). Choose *On your own* instead for a private signed build
   (`.\package.ps1 -Sign`, no listing needed).
2. **Upload** `dist\wusbfff-<version>.xpi`. Wait for the automatic validation to pass.
3. **Source code:** answer *No* to "Do you need to submit source code?" (the extension is not minified, bundled or transpiled).
4. **Listing details** — copy from section 5.
5. **Platforms:** untick *Firefox for Android* (native messaging is not available there). This also silences the lint warning.
6. **Notes for reviewers:** paste section 6.
7. Submit. Initial human review usually takes from hours to a few days. Fix anything reviewers raise and upload a new version.

## 5. Listing content (copy-paste)

**Name** (max 50 chars): `wusbfff - WebUSB for Firefox`

**Summary** (max 250 chars):
> Adds WebUSB (navigator.usb) to Firefox through a small local helper app, so web tools for Android/ADB and Meta Quest devices can talk to USB devices you choose. Requires the free native host (Windows).

**Description:**
```
Firefox does not implement WebUSB. wusbfff adds the standard navigator.usb API to Firefox so web apps that
rely on it (ADB in the browser, Meta Quest tools, firmware flashers, ...) work the same way they do in Chrome.

How it works
- The extension provides navigator.usb to web pages.
- A small open-source native helper (Python + libusb) runs on your computer and performs the actual USB transfers.
  Firefox extensions cannot access USB hardware directly, so this helper is required.
- Data goes between the extension and the helper over a binary WebSocket bound to 127.0.0.1 and protected by a random
  per-session token. Nothing leaves your computer.

Privacy and safety
- Sites can only reach devices you explicitly pick in the extension's own chooser dialog, which a page cannot script.
- Permissions are remembered per website and can be revoked with device.forget().
- No analytics, no telemetry, no remote code, no data collection.

Setup (Windows)
1. Install this extension. A setup page opens; if the helper is missing it shows the one-line install command
   (PowerShell: irm https://raw.githubusercontent.com/ospab/wusbfff/main/get.ps1 | iex) or a .cmd file to double-click.
   The installer needs no administrator rights and offers to install Python 3 through winget if it is missing.
2. Click "Check again" in the extension popup, or open the status page to verify the whole chain: https://ospab.github.io/wusbfff/

The extension is licensed under the GNU AGPL v3.

Supported: requestDevice with filters, getDevices, forget, open/close, configurations, interfaces, bulk/interrupt/control
transfers, clearHalt, reset. Not supported: connect/disconnect events, isochronous transfers.

Source code and issue tracker: https://github.com/ospab/wusbfff
```

**Categories:** Web Development (secondary: Other)
**Tags:** webusb, usb, adb, quest, developer
**Support site:** `https://github.com/ospab/wusbfff/issues`
**Homepage:** `https://github.com/ospab/wusbfff`
**License:** GNU Affero General Public License v3 (see section 1)
**Privacy policy** (paste into the listing's privacy policy field):
```
wusbfff does not collect, store, transmit or share any personal data or usage data. The extension only stores, locally in
your browser, which websites you have allowed to access which USB devices (browser.storage.local). USB data is exchanged
exclusively between the web page you are using, the extension, and a helper program on your own computer over the
loopback interface (127.0.0.1). No data is sent to the developer or to any third party.
```

**Screenshots** (AMO requires at least one; 1280x800 or larger works well). Take these:
1. The device chooser dialog on a real site (e.g. an ADB/Quest tool).
2. The status page (`docs/index.html`) with all checks green.
3. The tester page connected to a device.

**Icon:** `extension/icon.svg` is used automatically from the manifest.

## 6. Notes for reviewers (paste into the submission)

```
This extension implements WebUSB (navigator.usb) for Firefox. It needs a local native messaging host because Firefox
extensions cannot access USB devices.

Architecture
- inject.js (MAIN world, document_start) defines navigator.usb and forwards calls via window.postMessage.
- content.js (isolated world) relays to background.js and renders the device chooser inside a closed shadow root.
  The chooser only accepts trusted (isTrusted) clicks and requires transient user activation.
- background.js enforces per-origin device permissions (storage.local) on every operation, then talks to the host:
  browser.runtime.connectNative("wusbfff") is used only to start the host and receive a loopback port + random token,
  then a binary WebSocket to ws://127.0.0.1:<port> carries the data. The host rejects any WebSocket whose Origin is not
  moz-extension:// or whose first message lacks the token.
- The host (host/host.py, Python + pyusb + libusb, source in the repo) is NOT downloaded or executed by the extension.
  The user installs it manually.
- popup.html/popup.js: browser-action popup (also opened in a tab on first install). It pings the host through background.js.
  If the host is missing it shows setup instructions: a button copying the one-line PowerShell command to the clipboard, and a link
  to a .cmd file generated locally from a Blob (data: nothing is fetched) that the user may download and double-click.
  The extension itself never downloads, writes or executes any file or code.

Permissions
- nativeMessaging: start/communicate with the user-installed host.
- storage: remember which sites may access which devices.
- Content scripts on https://*/*, http://localhost/*, http://127.0.0.1/*: navigator.usb must exist on any secure page,
  exactly like in Chromium. It is only exposed in secure contexts and top-level frames.

No source code upload is required: all JavaScript is hand-written and unminified, and there is no build step.

How to test without USB hardware
1. Install the host: unzip the release zip from https://github.com/ospab/wusbfff/releases and run install.ps1 (Windows, Python 3).
2. Install the extension and open https://ospab.github.io/wusbfff/ . All checks except real devices should be green
   (extension detected, native host reachable, libusb enumeration).
3. Open the tester page (tester/index.html served from http://localhost) and click "requestDevice (all)" to see the chooser.
```

## 7. After approval

1. Tag and publish the GitHub release containing the host + installer (the listing links to it):
   ```powershell
   git tag v<version>
   git push origin v<version>
   .\package.ps1
   gh release create v<version> dist\wusbfff-<version>-windows.zip --title "v<version>" --notes "See RELEASE.md"
   ```
   If you also self-sign, attach the signed xpi from `dist\signed\`.
2. Enable GitHub Pages (Settings → Pages → Source: `main`, folder `/docs`) so the status page is live at
   `https://ospab.github.io/wusbfff/`.
3. Install from the AMO page in a clean Firefox profile and run through the status page again.

## 8. Shipping updates

1. Change code, bump `version` in `extension/manifest.json` (and `VERSION` in `host/host.py` if the host changed).
2. `npx web-ext lint --source-dir extension`, `.\package.ps1`.
3. AMO Developer Hub → your add-on → *Upload New Version* → the new xpi. Firefox users get it automatically after approval.
4. If the host protocol changed, release a new `...-windows.zip` on GitHub and say so in the release notes and the version's
   *Release notes* field. Keep the extension compatible with the previous host for at least one version where possible.

## 9. Reference

- AMO developer docs: <https://extensionworkshop.com/>
- Add-on policies: <https://extensionworkshop.com/documentation/publish/add-on-policies/>
- `web-ext`: <https://extensionworkshop.com/documentation/develop/web-ext-command-reference/>
- Native messaging: <https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>
