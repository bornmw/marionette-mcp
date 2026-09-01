#!/usr/bin/env node
// server.mjs — Model Context Protocol server (stdio) that drives a user-launched
// Firefox (firefox --marionette, default port 2828) via its native wire protocol.
//
// MCP transport: newline-delimited JSON-RPC 2.0 on stdin/stdout; stderr = logs.
// Zero runtime dependencies (Node >= 20).

import fs from 'node:fs';
import path from 'node:path';
import { Marionette } from './marionette.mjs';
import { unwrapElementRef } from './protocol.mjs';

const HOST = process.env.FX_MARIONETTE_HOST || '127.0.0.1';
const PORT = Number(process.env.FX_MARIONETTE_PORT || 2828);
const FILE_ROOTS = (process.env.FX_MCP_FILE_ROOTS || '/tmp').split(',').map((s) => s.trim()).filter(Boolean);

const log = (...a) => process.stderr.write(new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || VERSION;
} catch { /* dev checkouts without package.json */ }

const M = new Marionette({ host: HOST, port: PORT, log });
let snapshotRefs = [];

// ---------------- element helpers ----------------
function resolveElRef(args) {
  const p = { ...(args || {}) };
  if (p.ref != null) {
    const ref = Number(p.ref);
    const entry = snapshotRefs[ref - 1];
    if (!entry) throw new Error('ref ' + ref + ' unknown — run fx_snapshot again');
    p.using = p.using || 'xpath';
    p.value = entry.x;
    delete p.ref;
  }
  if (!p.using || !p.value) {
    if (p.selector) { p.value = p.selector; p.using = p.using || 'css selector'; }
    else throw new Error('need ref (from fx_snapshot) or selector');
    delete p.selector;
  }
  return p;
}

async function findEl(using, value) {
  const r = await M.cmd('WebDriver:FindElement', { using, value });
  return unwrapElementRef(r.value);
}

// Marker usable inside page scripts: "#id" (css) or "xpath:..."
function refMarker(a) {
  if (a.ref != null) {
    const e = snapshotRefs[Number(a.ref) - 1];
    if (!e) throw new Error('ref ' + a.ref + ' unknown — run fx_snapshot again');
    return e.css ? e.css : 'xpath:' + e.x;
  }
  if (a.selector) {
    if (a.selector.startsWith('xpath:')) return a.selector;
    if (a.selector.startsWith('/')) return 'xpath:' + a.selector;
    return a.selector;
  }
  throw new Error('need ref (from fx_snapshot) or selector');
}

const EL0 = `const s=arguments[0]; const el=(s.indexOf('xpath:')===0)?document.evaluate(s.slice(6),document,null,9,null).singleNodeValue:document.querySelector(s);`;

async function execJs(code, args) {
  const r = await M.cmd('WebDriver:ExecuteScript', { script: code, args: args || [] });
  return r.value;
}

function allowedPath(abs) {
  return FILE_ROOTS.some((r0) => abs === r0 || abs.startsWith(r0 + path.sep));
}

const SNAPSHOT_JS = `
return (function () {
  function xp(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      const sibs = n.parentElement ? Array.prototype.filter.call(n.parentElement.children, (c) => c.tagName === n.tagName) : [n];
      parts.unshift(tag + '[' + (sibs.indexOf(n) + 1) + ']');
      n = n.parentElement;
    }
    return '/' + parts.join('/');
  }
  const out = [];
  let i = 1;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.type !== 'hidden' && getComputedStyle(el).visibility !== 'hidden';
  };
  const seen = new Set();
  document.querySelectorAll('h1,h2,h3').forEach((h) => {
    out.push({ i: i++, k: 'h', x: xp(h), t: (h.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90) });
    if (out.length >= 140) return;
  });
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=combobox],[role=switch],[role=option],[role=menuitem],[onclick],[tabindex]';
  document.querySelectorAll(sel).forEach((el) => {
    if (!vis(el) || (el.offsetParent === null && el.getClientRects().length === 0)) return;
    const x = xp(el);
    if (seen.has(x)) return;
    seen.add(x);
    const kind = el.tagName.toLowerCase() + (el.type ? ':' + el.type : '');
    let txt = el.innerText || el.getAttribute('aria-label') || el.placeholder || '';
    txt = (txt || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
    const css = el.id && document.querySelector('#' + CSS.escape(el.id)) === el ? '#' + CSS.escape(el.id) : '';
    out.push({
      i: i++, k: kind, x, t: txt, css,
      id: el.id || '',
      ph: el.placeholder || '',
      al: el.getAttribute('aria-label') || '',
      val: el.type === 'password' ? '-pw-' : String(el.value ?? '').slice(0, 30),
      sel: el.checked === true ? '*' : '',
      dis: el.disabled ? '!' : ''
    });
    if (out.length >= 140) return;
  });
  return out;
})()
`;

function fmtSnapshot(rows) {
  if (!Array.isArray(rows)) throw new Error('snapshot script returned ' + typeof rows);
  snapshotRefs = rows.filter((r) => r.k !== 'h');
  const lines = [];
  let n = 0;
  for (const r of rows) {
    if (r.k === 'h') { lines.push('#' + r.t); continue; }
    n++;
    const bits = [r.k];
    if (r.id) bits.push('#' + r.id);
    if (r.al) bits.push('aria=' + JSON.stringify(r.al));
    if (r.ph) bits.push('ph=' + JSON.stringify(r.ph));
    if (r.val) bits.push('val=' + JSON.stringify(r.val));
    if (r.sel) bits.push('checked');
    if (r.dis) bits.push('DISABLED');
    if (r.t) bits.push('"' + r.t + '"');
    lines.push(n + '. [' + bits.join(' ') + ']');
  }
  return lines.join('\n');
}

async function pageInfo() {
  const r = await M.cmd('WebDriver:ExecuteScript', {
    script: 'return JSON.stringify({webdriver: navigator.webdriver, url: location.href, title: document.title, ready: document.readyState});',
    args: [],
  });
  return JSON.parse(r.value);
}

// ---------------- MCP tools ----------------
const T = (name, desc, schema, fn) => ({ name, description: desc, inputSchema: { type: 'object', properties: schema, additionalProperties: false }, fn });

const TOOLS = [
  T('fx_status', 'Health: connection, session, current page, navigator.webdriver flag', {}, async () => {
    const pi = await pageInfo();
    return { connected: true, protocol: M.hello && M.hello.marionetteProtocol, session: M.sessionId, ...pi };
  }),
  T('fx_navigate', 'Navigate the active tab to a URL', { url: { type: 'string' } }, async (a) => {
    await M.cmd('WebDriver:Navigate', { url: a.url });
    return { ok: true };
  }),
  T('fx_page', 'Current URL and title', {}, async () => {
    const pi = await pageInfo();
    return { url: pi.url, title: pi.title };
  }),
  T('fx_snapshot', 'Interactive-element map with refs (use refs in fx_click/fx_type/...)', {}, async () => {
    return fmtSnapshot(await execJs(SNAPSHOT_JS));
  }),
  T('fx_click', 'Click element by ref (from fx_snapshot) or CSS selector', { ref: { type: 'number' }, selector: { type: 'string' } }, async (a) => {
    const p = resolveElRef(a);
    const el = await findEl(p.using, p.value);
    await M.cmd('WebDriver:ElementClick', { id: el });
    return { ok: true, el };
  }),
  T('fx_type', 'Type text into element (clears first unless keep=true)', { ref: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, keep: { type: 'boolean', description: 'true = append instead of clearing' } }, async (a) => {
    const p = resolveElRef(a);
    const el = await findEl(p.using, p.value);
    if (!a.keep) await M.cmd('WebDriver:ElementClear', { id: el }).catch(() => {});
    await M.cmd('WebDriver:ElementSendKeys', { id: el, text: a.text });
    return { ok: true };
  }),
  T('fx_select', 'Set <select> by option value or visible label', { ref: { type: 'number' }, selector: { type: 'string' }, value: { type: 'string' }, label: { type: 'string' } }, async (a) => {
    const mk = refMarker(a);
    const match = a.value != null
      ? `const m=[...el.options].find(o=>o.value===arguments[1]); if(!m) return 'no-option:'+arguments[1]; el.value=m.value; return 'ok:'+m.value;`
      : `const m=[...el.options].find(o=>o.textContent.trim()===arguments[1]); if(!m) return 'no-option:'+arguments[1]; el.value=m.value; return 'ok:'+m.textContent.trim();`;
    const r = await execJs(EL0 + ` if(!el) return 'el-gone'; if(el.tagName!=='SELECT') return 'not-a-select:'+(el.tagName||''); ${match} el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true}));`, [mk, a.value != null ? a.value : a.label]);
    return { r };
  }),
  T('fx_toggle', 'Set checkbox/radio state', { ref: { type: 'number' }, selector: { type: 'string' }, on: { type: 'boolean', description: 'default true' } }, async (a) => {
    const mk = refMarker(a);
    const want = a.on !== false;
    const r = await execJs(EL0 + ` if(!el) return 'el-gone'; if(el.type!=='checkbox'&&el.type!=='radio') return 'not-togglable:'+String(el.type); if(el.checked!==arguments[1]){el.checked=arguments[1]; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('click',{bubbles:true}));} return 'ok:'+(el.checked?'on':'off');`, [mk, want]);
    return { r };
  }),
  T('fx_upload', 'Set a file input value (raw-path sendKeys); path must be under FX_MCP_FILE_ROOTS', { ref: { type: 'number' }, selector: { type: 'string' }, path: { type: 'string' } }, async (a) => {
    const abs = path.resolve(a.path);
    if (!allowedPath(abs)) throw new Error('path outside allowed roots: ' + FILE_ROOTS.join(','));
    if (!fs.existsSync(abs)) throw new Error('file not found: ' + abs);
    const p = resolveElRef(a);
    const el = await findEl(p.using, p.value);
    await M.cmd('WebDriver:ElementSendKeys', { id: el, text: abs });
    await new Promise((r) => setTimeout(r, 700));
    const got = await execJs(EL0 + ` return el&&el.files&&el.files[0] ? el.files[0].name : 'no-file-set';`, [refMarker(a)]);
    return { uploaded: got, path: abs };
  }),
  T('fx_eval', 'Execute JS in the page (script = function body, may return a value)', { js: { type: 'string' } }, async (a) => {
    return { r: await execJs(a.js, []) };
  }),
  T('fx_wait', 'Wait until visible text (or CSS selector exists). Default 10s, max 30s', { text: { type: 'string' }, selector: { type: 'string' }, timeout_ms: { type: 'number' } }, async (a) => {
    const ms = Math.min(30000, a.timeout_ms || 10000);
    const t0 = Date.now();
    for (;;) {
      let hit = false;
      try {
        hit = a.selector
          ? await execJs(`return !!document.querySelector(arguments[0]);`, [a.selector])
          : await execJs(`return document.body.innerText.indexOf(arguments[0]) >= 0;`, [a.text || '']);
      } catch { /* keep polling */ }
      if (hit) return { ok: true, ms: Date.now() - t0 };
      if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, 500));
    }
  }),
  T('fx_screenshot', 'View PNG to a file under an allowed root (or explicit allowed path)', { path: { type: 'string' } }, async (a) => {
    const dest = a.path || '/tmp/marionette-mcp/shot_' + Date.now() + '.png';
    const abs = path.resolve(dest);
    if (!allowedPath(abs)) throw new Error('path outside allowed roots');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const r = await M.cmd('WebDriver:TakeScreenshot', {});
    fs.writeFileSync(abs, Buffer.from(String(r.value), 'base64'));
    return { path: abs };
  }),
  T('fx_windows', 'List windows (focused marked)', {}, async () => {
    const r = await M.cmd('WebDriver:GetWindowHandles');
    const cur = await M.cmd('WebDriver:GetWindowHandle');
    return { windows: (r.value || []).map((h) => ({ handle: h, focused: h === cur.value })), current: cur.value };
  }),
  T('fx_window', 'Switch active window by handle', { handle: { type: 'string' } }, async (a) => {
    await M.cmd('WebDriver:SwitchToWindow', { handle: a.handle, focus: true });
    return { ok: true };
  }),
  T('fx_alert_state', 'Text of an open native dialog', {}, async () => {
    const r = await M.cmd('WebDriver:GetAlertText');
    return { text: r.value };
  }),
  T('fx_alert_accept', 'Accept (OK) the open native dialog', {}, async () => {
    await M.cmd('WebDriver:AcceptAlert');
    return { ok: true };
  }),
  T('fx_alert_dismiss', 'Dismiss (Cancel) the open native dialog', {}, async () => {
    await M.cmd('WebDriver:DismissAlert');
    return { ok: true };
  }),
  T('fx_cookies', 'Cookies of the current origin (names/domains only)', {}, async () => {
    const r = await M.cmd('WebDriver:GetCookies', {});
    return { cookies: (r.value || []).slice(0, 50).map((c) => ({ name: c.name, domain: c.domain, path: c.path })) };
  }),
];

// ---------------- MCP stdio plumbing ----------------
let connected = false;
async function ensureConn() {
  if (connected && M.sock && !M.sock.destroyed) return;
  await M.connect();
  if (!M.sessionId) await M.init();
  connected = true;
}

function toolResult(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.text !== 'string') {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }], isError: false };
  }
  return { content: [{ type: 'text', text: String(payload ?? '') }], isError: false };
}

async function handle(obj) {
  if (!obj || obj.jsonrpc !== '2.0') return null;
  const { id, method, params } = obj;
  let result;
  let isError = false;
  try {
    if (method === 'initialize') {
      result = {
        protocolVersion: (params && params.protocolVersion) || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'marionette-mcp', version: VERSION },
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
    } else if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw new Error('unknown tool: ' + params.name);
      await ensureConn();
      const payload = await tool.fn(params.arguments || {});
      result = toolResult(payload);
    } else {
      throw new Error('unsupported method: ' + method);
    }
  } catch (e) {
    result = { content: [{ type: 'text', text: 'ERROR: ' + ((e && e.message) || e) }], isError: true };
    isError = true;
  }
  log(method, isError ? 'IS_ERR' : 'ok');
  if (id === undefined) return null; // notification
  return { jsonrpc: '2.0', id, result };
}

let stdinBuf = '';
let stdinEof = false;
let draining = false;
const queue = [];
process.stdin.setEncoding('utf8');
process.on('SIGINT', () => process.exit(130));

async function drain() {
  if (draining) return;
  draining = true;
  for (const obj of queue.splice(0)) {
    try {
      const resp = await handle(obj);
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    } catch (e) {
      log('FATAL', e.message);
    }
  }
  draining = false;
  if (stdinEof) {
    if (M.sock && !M.sock.destroyed) M.sock.destroy();
    process.exit(0);
  }
}

function enqueue(chunk) {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    queue.push(obj);
  }
  drain();
}

process.stdin.on('data', enqueue);
process.stdin.on('end', () => { stdinEof = true; drain(); });
log('marionette-mcp ready on', HOST + ':' + PORT, 'file roots:', FILE_ROOTS.join(' '));
