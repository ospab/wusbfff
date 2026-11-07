// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const REPO = 'https://github.com/ospab/wusbfff';
const STATUS_PAGE = 'https://ospab.github.io/wusbfff/';
const INSTALL_SCRIPT = 'https://raw.githubusercontent.com/ospab/wusbfff/main/get.ps1';
const ONE_LINER = `irm ${INSTALL_SCRIPT} | iex`;

// A double-clickable wrapper around the same one-liner. The extension only offers this file for download;
// it never runs anything itself.
const CMD_FILE = [
  '@echo off',
  'echo Installing the wusbfff native helper...',
  `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ONE_LINER}"`,
  'echo.',
  'pause',
  '',
].join('\r\n');

const $ = (id) => document.getElementById(id);

function show(view) {
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== view;
}

async function openTab(url) {
  await browser.tabs.create({ url });
  if (new URLSearchParams(location.search).has('welcome')) return;
  window.close();
}

async function check() {
  show('checking');
  let r;
  try {
    r = await browser.runtime.sendMessage({ kind: 'ping' });
  } catch (e) {
    r = { ok: false, error: { message: String(e) } };
  }
  if (r && r.ok) {
    $('ver').textContent = `Extension ${r.result.extensionVersion} · helper ${r.result.hostVersion}`;
    show('ok');
  } else {
    $('why').textContent = (r && r.error && r.error.message) || 'Unknown error';
    show('missing');
  }
}

$('dl').href = URL.createObjectURL(new Blob([CMD_FILE], { type: 'application/octet-stream' }));
$('copy').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText(ONE_LINER);
    e.target.textContent = 'Copied!';
  } catch (err) {
    e.target.textContent = 'Copy failed - see GitHub';
  }
});
$('recheck').addEventListener('click', check);
$('open-gh').addEventListener('click', () => openTab(REPO + '#install-windows'));
$('open-gh-ok').addEventListener('click', () => openTab(REPO));
$('open-status').addEventListener('click', () => openTab(STATUS_PAGE));
check();
