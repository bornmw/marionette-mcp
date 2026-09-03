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
  // accepts (using, value) or a single {using, value} ref object
  if (using && typeof using === 'object' && using.using) { value = using.value; using = using.using; }
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
    return hardenCss(a.selector);
  }
  throw new Error('need ref (from fx_snapshot) or selector');
}

const EL0 = `const s=arguments[0]; const el=(s.indexOf('xpath:')===0)?document.evaluate(s.slice(6),document,null,9,null).singleNodeValue:document.querySelector(s);`;

async function execJs(code, args) {
  const r = await M.cmd('WebDriver:ExecuteScript', { script: code, args: args || [] });
  return r.value;
}

// A CSS `#id` whose id is not a valid bare identifier (starts with a digit, e.g.
// Ashby's UUID ids) is rejected by querySelector; rewrite to the quoted attr form.
function hardenCss(sel) {
  if (typeof sel !== 'string') return sel;
  const m = sel.match(/^#([^{,\s]+)$/);
  if (m && /^-?\d/.test(m[1])) return '[id="' + m[1].replace(/"/g, '\\"') + '"]';
  return sel;
}

// Cheap in-page validation of a CSS selector before FindElement, so unsupported
// syntax (e.g. :has(), rejected by Gecko's querySelector) yields an actionable
// error instead of a raw driver exception.
async function checkCss(sel) {
  const r = await execJs(`/*__csscheck__*/
try { document.querySelector(arguments[0]); return 'ok'; } catch (e) { return 'bad:' + (e && e.message ? String(e.message) : String(e)); }`, [sel]);
  const s = String(r == null ? 'ok' : r);
  if (s.slice(0, 4) === 'bad:') {
    throw new Error('CSS selector rejected by the page: ' + s.slice(4).slice(0, 100) +
      ' — the browser does not support all CSS (e.g. :has() is not supported); use [attr="…"]/.class/xpath forms, or fx_form/fx_field/fx_answer by label');
  }
}

// Two-phase fx_eval: the wrapper runs the user body synchronously in-page and
// reports {ok|err|pend}; a pending Promise settles into window.__fxr and is
// polled, so `return (async () => { … })()` bodies can be awaited.
const EVAL_WRAP = (body) =>
  'var __r; try { __r = (function(){ ' + body + ' })(); } catch (e) { return { __fx: "err", m: String((e && e.message) || e) }; } if (__r && typeof __r.then === "function") { __r.then(function (v) { window.__fxr = { __fx: "ok", v: v }; }, function (e) { window.__fxr = { __fx: "err", m: String((e && e.message) || e) }; }); return { __fx: "pend" }; } return { __fx: "ok", v: __r }; /*__fxeval__*/';
const EVAL_POLL = `/*__fxpoll__*/
var __w = window.__fxr; if (__w) { delete window.__fxr; return __w; } return null;`;

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
    let lbl = '';
    var lEl = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    if (lEl && (lEl.textContent || '').trim()) lbl = (lEl.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
    if (!lbl && el.closest) { var wL = el.closest('label'); if (wL) { var wt = (wL.textContent || '').trim(); if (wt) lbl = wt.replace(/\\s+/g, ' ').slice(0, 90); } }
    out.push({
      i: i++, k: kind, x, t: txt, css,
      id: el.id || '',
      l: lbl,
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
    if (r.l) bits.push('lbl=' + JSON.stringify(r.l));
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

// ---------------- generic form primitives ----------------
// Page scripts are plain (non-ES-module) scripts run via WebDriver:ExecuteScript.
// They must return a JSON-serializable value and receive parameters via arguments[].
const XP_JS = `function __xp(el){ if(!el||el.nodeType!==1) return ''; const p=[]; let n=el; while(n&&n.nodeType===1){ const t=n.tagName.toLowerCase(); const s=n.parentElement?Array.prototype.filter.call(n.parentElement.children,c=>c.tagName===n.tagName):[n]; p.unshift(t+'['+(s.indexOf(n)+1)+']'); n=n.parentElement;} return '/'+p.join('/'); }`;

// Enumerate visible form fields. args: [max, onlyIndex, id, labelQuery(lowercase), rootSelector]
// Returns: array of {i,tag,type,id,name,label,ph,ctx,dis,req,val?,on?,files?,options?,m(marker)}
const FIELD_JS = XP_JS + `
return (function(){
  var max=Number(arguments[0])||80, only=Number(arguments[1])||0, id=arguments[2]||'', lq=(arguments[3]||'').toLowerCase(), rc=arguments[4]||'';
  function norm(s){ return (s==null?'':String(s)).trim().replace(/\\s+/g,' '); }
  function vis(el){ var r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && el.type!=='hidden' && (el.offsetParent!==null || el.getClientRects().length>0); }
  function labelOf(el){ if(el.id){ var l=document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if(l && norm(l.textContent)) return norm(l.textContent).slice(0,120); } var wl=el.closest?el.closest('label'):null; if(wl){ var wt=norm(wl.textContent); if(wt) return wt.slice(0,120); } var al=el.getAttribute('aria-label'); if(al && norm(al)) return norm(al).slice(0,120); return ''; }
  function ctxOf(el){ var t=el.parentElement, g=0; while(t && g<7){ var c=norm(t.textContent); if(c.length>=15 && c.length<=600) return c.slice(0,160); t=t.parentElement; g++; } return ''; }
  function markerOf(el){ if(el.id){ var m='#'+CSS.escape(el.id); try{ if(document.querySelector(m)===el) return m; }catch(e){} } return 'xpath:'+__xp(el); }
    var scope = rc ? (document.querySelector(rc) || document) : document;
  var fields=[];
  scope.querySelectorAll('input,textarea,select').forEach(function(el){
    if(!vis(el)) return;
    var f={ i: fields.length+1, tag: el.tagName.toLowerCase(), type: el.type||'', id: el.id||'', name: el.name||'', label: labelOf(el), ph: el.placeholder||'', ctx: ctxOf(el), dis: el.disabled?1:0, req: el.required?1:0, m: markerOf(el) };
    if(el.type==='file'){ f.files = Array.prototype.slice.call(el.files||[]).map(function(x){ return x.name; }); }
    else if(el.tagName==='SELECT'){ f.val = String(el.value); f.options = Array.prototype.slice.call(el.options).slice(0,20).map(function(o){ return { v: o.value, t: norm(o.textContent).slice(0,60), s: o.selected?1:0 }; }); }
    else { f.val = el.type==='password' ? '-pw-' : String(el.value==null?'':el.value).slice(0,120); }
    if(el.type==='checkbox' || el.type==='radio'){ f.on = el.checked?1:0; }
    fields.push(f);
  });
  var cap = fields.slice(0,max);
  var groups=[]; var gmap={};
  cap.forEach(function(f){
    if(f.type!=='radio' && f.type!=='checkbox') return;
    var key = f.name ? ('n:' + f.name) : ('c:' + norm(f.ctx).slice(0,40));
    if(!gmap[key]){ gmap[key]={ key: key, type: f.type, name: f.name||'', ctx: f.ctx||'', req: f.req?1:0, single: true, options: [] }; groups.push(gmap[key]); }
    var g = gmap[key];
    g.options.push({ i: f.i, label: (f.label||f.ph||('field-'+f.i)).slice(0,60), on: f.on?1:0 });
    if(f.type==='checkbox') g.single=false;
  });
  if(id){ for(var i=0;i<fields.length;i++){ if(fields[i].id===id) return [fields[i]]; } return null; }
  if(lq){ var m2=[]; for(var j=0;j<fields.length;j++){ if(norm(fields[j].label).toLowerCase().indexOf(lq)>=0) m2.push(fields[j]); } return m2.slice(0,10); }
  if(only){ var m3=[]; for(var k=0;k<fields.length;k++){ if(fields[k].i===only) m3.push(fields[k]); } return m3; }
  return { f: cap, g: groups };
})(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4]);
`;

// Locate one choice group by question text and pick an option. args: [question, choice, exact]
// Returns: {ctx, option, kind, marker, labelMarker, state, options[]} or {error, ...}
const ANSWER_FIND_JS = XP_JS + `
return (function(){
  var Q=(arguments[0]||'').toLowerCase(), C=arguments[1]||'', exact=!!arguments[2];
  function norm(s){ return (s==null?'':String(s)).trim().replace(/\\s+/g,' '); }
  function vis(el){ var r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && el.offsetParent!==null; }
  function ctxOf(el){ var t=el.parentElement, g=0; while(t && g<8){ var c=norm(t.textContent); if(c.length>=15 && c.length<=800) return c.slice(0,240); t=t.parentElement; g++; } return ''; }
  function labelOf(el){ if(el.id){ var l=document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if(l && norm(l.textContent)) return norm(l.textContent); } var wl = el.closest ? el.closest('label') : null; if(wl){ var wt = norm(wl.textContent); if(wt) return wt; } var al=el.getAttribute('aria-label'); if(al) return norm(al); if(el.tagName==='BUTTON') return norm(el.textContent); return ''; }
  function markerOf(el){ if(el.id){ var m='#'+CSS.escape(el.id); try{ if(document.querySelector(m)===el) return m; }catch(e){} } return 'xpath:'+__xp(el); }
  function selState(el){ if(el.type==='checkbox'||el.type==='radio') return el.checked?'on':'off'; var ap=el.getAttribute('aria-pressed'); if(ap!=null) return ap==='true'?'on':'off'; return 'unknown'; }
  var cands=[];
  document.querySelectorAll('input[type=radio],input[type=checkbox]').forEach(function(el){ if(!vis(el)) return; cands.push({ el: el, kind: 'input', label: labelOf(el), ctx: ctxOf(el) }); });
  document.querySelectorAll('button,[role=radio],[role=switch]').forEach(function(el){ var t=norm(el.textContent); if(!t||t.length>14) return; if(!vis(el)) return; cands.push({ el: el, kind: el.tagName==='BUTTON'?'button':'role', label: t, ctx: ctxOf(el) }); });
  if(!cands.length) return { error: 'no-choice-controls' };
  var groups = new Map();
  cands.forEach(function(c){ var key = c.ctx || '__noctx__'; if(!groups.has(key)) groups.set(key, []); groups.get(key).push(c); });
  var matched=[];
  groups.forEach(function(arr, ctx){ if(ctx.toLowerCase().indexOf(Q)>=0) matched.push([ctx, arr]); });
  if(!matched.length) return { error: 'no-question', hint: 'question text not found near any choice group' };
  if(matched.length>1) return { error: 'ambiguous-question', groups: matched.map(function(p){ return p[0].slice(0,120); }) };
  var arr=matched[0][1]; var cl=C.toLowerCase();
  var picks=arr.filter(function(c){ return norm(c.label).toLowerCase()===cl; });
  if(!picks.length && !exact) picks=arr.filter(function(c){ return norm(c.label).toLowerCase().indexOf(cl)>=0; });
  if(!picks.length) return { error: 'no-option', options: arr.map(function(c){ return c.label; }).slice(0,12), ctx: matched[0][0].slice(0,200) };
  if(picks.length>1) return { error: 'ambiguous-option', options: picks.map(function(c){ return c.label; }), ctx: matched[0][0].slice(0,200) };
  var p=picks[0];
  var labelMarker=null;
  if(p.kind==='input'){ var l2=p.el.id?document.querySelector('label[for="'+CSS.escape(p.el.id)+'"]'):null; if(l2 && vis(l2)) labelMarker=markerOf(l2); }
  var single = arr.every(function(c){ return (c.kind==='button'||c.kind==='role') || (c.el && c.el.type==='radio'); });
  var alts = arr.filter(function(c){ return c.label!==p.label; }).slice(0,2).map(function(c){ return { label: c.label, kind: c.kind, marker: markerOf(c.el), state: selState(c.el) }; });
  return { ctx: matched[0][0].slice(0,240), option: p.label, kind: p.kind, marker: markerOf(p.el), labelMarker: labelMarker || null, state: selState(p.el), single: single, alts: alts, options: arr.map(function(c){ return c.label; }).slice(0,12) };
})(arguments[0], arguments[1], arguments[2]);
`;

function markerRef(marker) {
  if (marker.startsWith('xpath:')) return { using: 'xpath', value: marker.slice(6) };
  return { using: 'css selector', value: marker };
}
function fmtField(f) {
  return { i: f.i, type: f.tag === 'select' ? 'select' : (f.type || f.tag), label: (f.label || f.ph || f.id || 'field-' + f.i).slice(0, 80) };
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
  T('fx_click', 'Click element by ref (from fx_snapshot) or CSS selector. Digit-leading ids: use [id="…"] form (a bare #1abc is not valid CSS) — or pass it as-is and the tool will rewrite it for you. Unsupported CSS (e.g. :has()) is caught in-page with an actionable error before the driver call.', { ref: { type: 'number' }, selector: { type: 'string' } }, async (a) => {
    const p = resolveElRef(a);
    if (p.using === 'css selector') { p.value = hardenCss(p.value); await checkCss(p.value); }
    const el = await findEl(p.using, p.value);
    await M.cmd('WebDriver:ElementClick', { id: el });
    return { ok: true, el, used: a.selector && p.value !== a.selector ? p.value : undefined };
  }),
  T('fx_type', 'Type text into element (clears first unless keep=true). Same selector rules as fx_click (digit-leading #ids auto-rewritten to [id="…"]; unsupported CSS caught in-page).', { ref: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, keep: { type: 'boolean', description: 'true = append instead of clearing' } }, async (a) => {
    const p = resolveElRef(a);
    if (p.using === 'css selector') { p.value = hardenCss(p.value); await checkCss(p.value); }
    const el = await findEl(p.using, p.value);
    if (!a.keep) await M.cmd('WebDriver:ElementClear', { id: el }).catch(() => {});
    await M.cmd('WebDriver:ElementSendKeys', { id: el, text: a.text });
    return { ok: true, used: a.selector && p.value !== a.selector ? p.value : undefined };
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
  T('fx_form', 'Structured dump of all visible form fields on the page: index, type, label, context, value, options, files, plus aggregated choice groups (radio/checkbox sets with their question context and per-option state) — audit every required group, not just individually labeled fields. Form workflow: run fx_form first to learn the fields/groups, then set values with fx_field (by index/id/label) and answer radio/checkbox/button questions with fx_answer. Prefer these over hand-written fx_eval form scripts. Optional CSS root scopes the dump.', { root: { type: 'string', description: 'CSS selector to scope the dump (default: whole page)' }, max: { type: 'number', description: 'max fields (default 80)' } }, async (a) => {
    const recs = await execJs(FIELD_JS, [Math.min(300, Math.max(1, Number(a.max) || 80)), 0, '', '', a.root || '']);
    let arr, groups;
    if (recs && typeof recs === 'object' && Array.isArray(recs.f)) { arr = recs.f; groups = recs.g || []; }
    else if (Array.isArray(recs)) { arr = recs; groups = []; }
    else throw new Error('form dump returned ' + typeof recs);
    return {
      count: arr.length,
      fields: arr.map((f) => {
        const o = { i: f.i, type: f.tag === 'select' ? 'select' : (f.type || f.tag) };
        o.label = (f.label || f.ph || (f.id ? f.id : 'field-' + f.i)).slice(0, 80);
        if (f.name) o.name = f.name;
        if (f.ctx) o.ctx = f.ctx;
        if (f.val !== undefined) o.value = f.val;
        if (f.on !== undefined) o.on = !!f.on;
        if (f.files) o.files = f.files.slice(0, 10);
        if (f.options) o.options = f.options;
        if (f.dis) o.disabled = true;
        if (f.req) o.required = true;
        return o;
      }),
      ...(groups.length ? { groups: groups.map((g) => ({ type: g.type, name: g.name, ctx: (g.ctx || '').slice(0, 140), required: !!g.req, single: !!g.single, options: g.options.map((o) => ({ i: o.i, label: o.label, on: !!o.on })) })) } : {}),
    };
  }),
  T('fx_field', 'Set a form field by index (from fx_form), by id, or by label substring. Text/textarea = real keystrokes (framework-safe); checkbox/radio = real click that reaches the wanted state (pass value "on"/"off", default on) with verify + label-click + event fallbacks; select = option match by value or label. Scrolls the field into view automatically. File inputs: use fx_upload.', { index: { type: 'number', description: 'field index from fx_form' }, id: { type: 'string', description: 'field id attribute' }, label: { type: 'string', description: 'field label (substring match)' }, value: { type: 'string', description: 'text to type / option value / "on"|"off" for checkbox-radio' } }, async (a) => {
    if (a.index == null && !a.id && !a.label) throw new Error('need index (from fx_form), id, or label');
    const recs = await execJs(FIELD_JS, [80, Number(a.index) || 0, a.id || '', (a.label || '').trim().toLowerCase(), '']);
    let field;
    if (a.index != null || a.id) {
      if (!Array.isArray(recs) || !recs.length) throw new Error(a.index != null ? 'field index not found (page changed?) — run fx_form again' : 'field id not found: ' + a.id);
      field = recs[0];
    } else {
      if (!Array.isArray(recs) || !recs.length) throw new Error('no visible field with label containing "' + a.label + '"');
      if (recs.length > 1) throw new Error('ambiguous label "' + a.label + '" -> ' + recs.slice(0, 5).map((f) => f.label + ' (index ' + f.i + ')').join(' | '));
      field = recs[0];
    }
    if (!field || !field.m) throw new Error('field not resolved');
    await execJs(EL0 + ` if(el) el.scrollIntoView({block:'center',behavior:'instant'}); return 'ok';`, [field.m]);
    await new Promise((r) => setTimeout(r, 150));
    const ref = markerRef(field.m);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (field.type === 'file') throw new Error('file input — use fx_upload with a path under the allowed roots');
    if (field.tag === 'select') {
      if (a.value == null) throw new Error('select field: pass value (option value or visible label)');
      const X = String(a.value);
      const r = await execJs(EL0 + ` if(!el) return 'el-gone'; const opts=Array.prototype.slice.call(el.options); const X=String(arguments[1]); let m=opts.find(o=>o.value===X); if(!m) m=opts.find(o=>o.textContent.trim()===X); if(!m){ const c=opts.filter(o=>o.textContent.trim().toLowerCase().indexOf(X.toLowerCase())>=0); if(c.length===1) m=c[0]; } if(!m) return 'no-option:'+X.slice(0,40); el.selectedIndex=m.index; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok:'+String(m.value);`, [field.m, X]);
      if (r === 'el-gone') throw new Error('field vanished before select');
      if (String(r).slice(0, 3) !== 'ok:') throw new Error('select: ' + r);
      await sleep(150);
      const conf = await execJs(EL0 + ` return el?String(el.value):null;`, [field.m]);
      return { ok: true, field: fmtField(field), wanted: X, confirmed: conf };
    }
    if (field.type === 'checkbox' || field.type === 'radio') {
      let want = true;
      if (a.value != null) {
        if (typeof a.value === 'boolean') want = a.value;
        else {
          const s = String(a.value).trim().toLowerCase();
          if (/^(off|false|no|0)$/.test(s)) want = false;
          else if (!/^(on|true|yes|1)$/.test(s)) throw new Error('checkbox/radio: value must be on or off (got "' + a.value + '")');
        }
      }
      const cur = await execJs(EL0 + ` return el?String(el.checked===true):'gone';`, [field.m]);
      if (cur === 'gone') throw new Error('field vanished before state read');
      if ((cur === 'true') === want) return { ok: true, unchanged: true, field: fmtField(field), state: want ? 'on' : 'off' };
      let via = 'none';
      try {
        const el = await findEl(ref);
        await M.cmd('WebDriver:ElementClick', { id: el });
        via = 'element';
      } catch {
        const lm = await execJs(EL0 + ` if(!el||!el.id) return null; const l=document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if(!l) return null; if(l.id){ try{ const m='#'+CSS.escape(l.id); if(document.querySelector(m)===l) return m; }catch(e){} } return 'xpath:'+__xp(l);`, [field.m]);
        if (lm && lm !== 'null') {
          try { const lel = await findEl(markerRef(lm)); await M.cmd('WebDriver:ElementClick', { id: lel }); via = 'label'; } catch { /* event fallback below */ }
        }
      }
      await sleep(250);
      let now = await execJs(EL0 + ` return el?String(el.checked===true):'gone';`, [field.m]);
      const goodNow = (want ? now === 'true' : now === 'false');
      if (!goodNow) {
        await execJs(EL0 + ` if(el){ el.checked=arguments[1]; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('click',{bubbles:true})); } return 'done';`, [field.m, want]);
        await sleep(200);
        now = await execJs(EL0 + ` return el?String(el.checked===true):'gone';`, [field.m]);
        via += ' +events-fallback';
      }
      const okNow = want ? now === 'true' : now === 'false';
      return { ok: okNow, field: fmtField(field), wanted: want ? 'on' : 'off', state: now, via };
    }
    const el = await findEl(ref).catch(() => null);
    if (!el) throw new Error('field vanished before type');
    if (a.value != null) {
      await M.cmd('WebDriver:ElementClear', { id: el }).catch(() => {});
      if (String(a.value) !== '') await M.cmd('WebDriver:ElementSendKeys', { id: el, text: String(a.value) });
    } else {
      await M.cmd('WebDriver:ElementClear', { id: el }).catch(() => {});
    }
    await sleep(150);
    const conf = await execJs(EL0 + ` return el?String(el.value):'gone';`, [field.m]);
    return { ok: conf !== 'gone' && (a.value == null || conf === String(a.value)), field: fmtField(field), confirmed: conf.slice(0, 120) };
  }),
  T('fx_answer', 'Answer a grouped choice question (Yes/No button groups, radio or checkbox option groups): locate the group by matching the question text, pick the option by its label, perform a real click, then re-read and report the resulting selection state. If the target was already selected (or is still not selected) after the click — a no-op click that frameworks often do not register — performs a toggle cycle (click another option, then the target) on exclusive groups and re-verifies. Use this instead of clicking raw button refs — option order/refs can shift on re-render, and matching by question text prevents picking the wrong option of a neighbouring question.', { question: { type: 'string', description: 'text that must appear in the question context' }, choice: { type: 'string', description: 'option label to select, e.g. "Yes" or "New York City"' }, exact: { type: 'boolean', description: 'require exact label match (default false: case-insensitive substring allowed)' } }, async (a) => {
    if (!a.question || !a.choice) throw new Error('need question + choice');
    const found0 = await execJs(ANSWER_FIND_JS, [a.question, a.choice, a.exact !== true]);
    if (!found0 || typeof found0 !== 'object' || !found0.marker) throw new Error('fx_answer: ' + JSON.stringify(found0));
    const pre = found0.state;
    await execJs(EL0 + ` if(el) el.scrollIntoView({block:'center',behavior:'instant'}); return 'ok';`, [found0.marker]);
    await new Promise((r) => setTimeout(r, 150));
    let via;
    const primary = found0.labelMarker || found0.marker;
    async function clickPrimary(fallbackNote) {
      try {
        const el = await findEl(markerRef(primary));
        await M.cmd('WebDriver:ElementClick', { id: el });
        via = fallbackNote ? 'element(' + fallbackNote + ')' : (found0.labelMarker ? 'label' : 'element');
      } catch (e) {
        if (!found0.labelMarker) throw e;
        const el = await findEl(markerRef(found0.marker));
        await M.cmd('WebDriver:ElementClick', { id: el });
        via = 'element( fallback )';
      }
    }
    await clickPrimary();
    await new Promise((r) => setTimeout(r, 300));
    let after = await execJs(ANSWER_FIND_JS, [a.question, a.choice, true]);
    let state = after && after.option === found0.option ? after.state : 'unreadable';
    // A click on an already-selected radio is a no-op in the DOM AND often
    // unregistered by the framework; a fresh change cycle (other option, then
    // target) is the only reliable way to (re)set the answer.
    if (found0.single && (pre === 'on' || state === 'off' || state === 'unreadable')) {
      let toggled = false;
      for (const alt of found0.alts || []) {
        try {
          const el = await findEl(markerRef(alt.marker));
          await M.cmd('WebDriver:ElementClick', { id: el });
          await new Promise((r) => setTimeout(r, 300));
          const mid = await execJs(ANSWER_FIND_JS, [a.question, a.choice, true]);
          if (mid && (mid.state !== pre || pre === 'unknown')) { toggled = true; break; }
        } catch { /* try next alt */ }
      }
      if (toggled) {
        await clickPrimary('toggle-cycle');
        await new Promise((r) => setTimeout(r, 300));
        after = await execJs(ANSWER_FIND_JS, [a.question, a.choice, true]);
        if (after && after.option === found0.option) state = after.state;
      }
    }
    let verified;
    if (state === 'on') verified = 'selected';
    else if (state === 'off') verified = 'NOT-SELECTED — click may have toggled it off; verify';
    else verified = 'no selection signal on this control type — verify (e.g. re-run fx_form)';
    return { ok: state !== 'off', question: found0.ctx, answer: found0.option, pre, via, state: state === 'unreadable' ? 'unknown' : state, verified };
  }),
  T('fx_scroll', 'Scroll an element (ref from fx_snapshot, or selector) into view so it is not obscured (e.g. by a fixed header/cookie bar), wait, and return its top coordinate. Use before clicking elements that failed as "not clickable because another element obscures it".', { ref: { type: 'number' }, selector: { type: 'string' }, pos: { type: 'string', description: 'start | center | end (default center)' }, wait_ms: { type: 'number', description: 'wait after scroll (default 400, max 2000)' } }, async (a) => {
    const mk = refMarker(a);
    const pos = a.pos === 'start' || a.pos === 'end' ? a.pos : 'center';
    const r = await execJs(EL0 + ` if(!el) return 'el-gone'; el.scrollIntoView({block:arguments[1],behavior:'instant'}); return 'ok:'+Math.round(el.getBoundingClientRect().top);`, [mk, pos]);
    if (r === 'el-gone') throw new Error('element not found');
    await new Promise((r2) => setTimeout(r2, Math.min(2000, Math.max(0, Number(a.wait_ms) || 400))));
    return { r };
  }),
  T('fx_eval', 'Execute JS in the page (script = function body, may return a value). Synchronous bodies behave as before ({r: value}). If the body returns a Promise — e.g. `return (async () => { … })()` after a fetch/timeout — the call awaits it (default max 30s, wait_ms to tune) and returns {r: value, awaited: true}; a rejected or long-unsettled Promise is an error.', { js: { type: 'string' }, wait_ms: { type: 'number', description: 'max wait for a Promise-returning body (default 30000, max 120000)' } }, async (a) => {
    const w = await execJs(EVAL_WRAP(String(a.js)), []);
    if (!w || typeof w !== 'object' || typeof w.__fx !== 'string') {
      throw new Error('fx_eval: body must `return` a value (for async work: `return (async () => { … })()`); bare expression statements are discarded');
    }
    if (w.__fx === 'err') throw new Error('fx_eval page error: ' + (w.m || 'unknown'));
    if (w.__fx === 'ok') return { r: w.v };
    const ms = Math.min(120000, Math.max(0, Number(a.wait_ms) || 30000));
    const t0 = Date.now();
    for (;;) {
      const p = await execJs(EVAL_POLL, []);
      if (p && typeof p === 'object' && typeof p.__fx === 'string') {
        if (p.__fx === 'err') throw new Error('fx_eval: Promise rejected: ' + (p.m || 'unknown'));
        return { r: p.v, awaited: true };
      }
      if (Date.now() - t0 > ms) throw new Error('fx_eval: Promise did not settle within ' + ms + ' ms');
      await new Promise((r) => setTimeout(r, 150));
    }
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
  T('fx_screenshot', 'Full-page PNG (Marionette captures the entire scrollable document, not just the viewport) to a file under an allowed root (or explicit allowed path)', { path: { type: 'string' } }, async (a) => {
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
