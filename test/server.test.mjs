// server.test.mjs — integration: spawn the real MCP server (stdio) against a
// fake Marionette, exercise JSON-RPC plumbing + tools over the wire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeMarionette } from './helpers/fake_marionette.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');

let fake;
let child;
const lines = [];
const stderr = [];

const rpc = (obj) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const i = lines.findIndex((L) => { try { return JSON.parse(L).id === obj.id; } catch { return false; } });
    if (i >= 0) { resolve(JSON.parse(lines.splice(i, 1)[0])); return; }
    if (Date.now() - t0 > 15000) { resolve(null); return; }
    setTimeout(tick, 25);
  };
  tick();
  child.stdin.write(JSON.stringify(obj) + '\n');
});

const toolText = (resp, tool) => {
  assert.ok(resp, 'no response (timeout)');
  assert.ok(resp.result, 'no result');
  assert.equal(resp.result.isError, false, 'tool failed: ' + JSON.stringify(resp.result) + ' | stderr: ' + stderr.slice(-6).join('\n'));
  return resp.result.content[0].text;
};
const toolErr = (resp, re) => {
  assert.ok(resp, 'no response (timeout)');
  assert.equal(resp.result.isError, true, 'expected isError: ' + JSON.stringify(resp.result));
  assert.match(resp.result.content[0].text, re);
  return resp.result.content[0].text;
};

before(async () => {
  fake = await startFakeMarionette();
  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      FX_MARIONETTE_HOST: '127.0.0.1',
      FX_MARIONETTE_PORT: String(fake.port),
      FX_MCP_FILE_ROOTS: '/tmp/marionette-mcp-test-roots',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) { lines.push(out.slice(0, nl).trim()); out = out.slice(nl + 1); }
  });
  child.stderr.on('data', (d) => stderr.push(String(d)));
  await new Promise((r) => setTimeout(r, 300)); // let the server boot
});

after(async () => {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 300));
  if (!child.killed) child.kill('SIGKILL');
  await fake.stop();
});

test('initialize returns server identity and echoes protocol version', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.ok(r, 'no response');
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.equal(r.result.serverInfo.name, 'marionette-mcp');
  assert.ok(r.version === undefined && r.result.serverInfo.version, 'version reported');
});

test('tools/list exposes the full tool table', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = r.result.tools.map((t) => t.name);
  assert.equal(names.length, 22, names.join(','));
  for (const n of ['fx_status', 'fx_navigate', 'fx_snapshot', 'fx_click', 'fx_type', 'fx_select', 'fx_toggle', 'fx_upload', 'fx_form', 'fx_field', 'fx_answer', 'fx_scroll', 'fx_eval', 'fx_wait', 'fx_screenshot', 'fx_cookies']) {
    assert.ok(names.includes(n), 'missing tool ' + n);
  }
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});

test('fx_status reaches the browser through the fake', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fx_status', arguments: {} } });
  const t = toolText(r);
  assert.match(t, /"connected": true/);
  assert.match(t, /fake-sess-1/);
  assert.match(t, /Fake Page/);
});

test('fx_navigate + fx_page', async () => {
  const r1 = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fx_navigate', arguments: { url: 'https://example.test/' } } });
  assert.match(toolText(r1), /"ok": true/);
  const r2 = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
  const t = toolText(r2);
  assert.match(t, /https:\/\/fake\.test\//);
});

test('fx_snapshot renders numbered refs', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fx_snapshot', arguments: {} } });
  const t = toolText(r);
  assert.match(t, /#Form\n1\. \[input:text #name ph="Full name"\]/, t);
  assert.ok(t.includes('#pw'), t);
  assert.ok(t.includes('"Go"'), t);
});

test('fx_click resolves refs through FindElement (W3C ref unwrap)', async () => {
  await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fx_snapshot', arguments: {} } });
  const r = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'fx_click', arguments: { ref: 3 } } });
  assert.match(toolText(r), /"ok": true/);
  const f = fake.state.frames.find((x) => x[2] === 'WebDriver:FindElement');
  assert.equal(f[3].using, 'xpath');
});

test('fx_click with CSS selector uses W3C "css selector" using-value', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'fx_click', arguments: { selector: '#searchFilter_salaryBucketV2' } } });
  assert.match(toolText(r), /"ok": true/);
  const f = [...fake.state.frames].reverse().find((x) => x[2] === 'WebDriver:FindElement');
  assert.equal(f[3].using, 'css selector', 'gecko rejects bare "css" as a using-value');
  assert.equal(f[3].value, '#searchFilter_salaryBucketV2');
});

test('fx_type sends clear+keys and stays framing-safe with unicode', async () => {
  await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fx_snapshot', arguments: {} } });
  const text = 'Jürgen 🎯\ue000';
  const r = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'fx_type', arguments: { ref: 1, text } } });
  assert.match(toolText(r), /"ok": true/);
  assert.deepEqual(fake.state.violations, [], 'unicode typing must not desync framing: ' + JSON.stringify(fake.state.violations));
  const keys = [...fake.state.frames].reverse().find((x) => x[2] === 'WebDriver:ElementSendKeys');
  assert.equal(keys[3].text, text);
});

test('fx_upload rejects paths outside allowed roots', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'fx_upload', arguments: { ref: 1, path: '/etc/passwd' } } });
  toolErr(r, /outside allowed roots/);
});

test('fx_upload accepts a path under the allowed root', async () => {
  const dir = '/tmp/marionette-mcp-test-roots';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'upload.csv');
  fs.writeFileSync(file, 'a,b\n1,2\n');
  await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'fx_snapshot', arguments: {} } });
  const r = await rpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'fx_upload', arguments: { ref: 1, path: file } } });
  const t = toolText(r);
  assert.match(t, /"uploaded": "upload\.csv"/, t);
  fs.rmSync(file);
});

test('fx_screenshot writes a file under an allowed root', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'fx_screenshot', arguments: { path: '/tmp/marionette-mcp-test-roots/shot.png' } } });
  const t = toolText(r);
  assert.match(t, /shot\.png/);
  assert.ok(fs.existsSync('/tmp/marionette-mcp-test-roots/shot.png'));
});

test('fx_wait on visible text resolves quickly', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'fx_wait', arguments: { text: 'anything', timeout_ms: 3000 } } });
  assert.match(toolText(r), /"ok": true/);
});

test('unknown tool and unknown method produce isError results', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'fx_nope', arguments: {} } });
  toolErr(r, /unknown tool/);
  const r2 = await rpc({ jsonrpc: '2.0', id: 17, method: 'bogus/method' });
  toolErr(r2, /unsupported method/);
});

test('notifications produce no response line', async () => {
  const before = lines.length;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(lines.length, before);
});

test('stdin EOF terminates the server cleanly', () =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const onExit = (code) => {
      clearTimer();
      if (Date.now() - t0 < 10000 && code === 0) resolve();
      else reject(new Error('exit code ' + code));
    };
    const timer = setTimeout(() => reject(new Error('server did not exit on stdin EOF')), 10000);
    const clearTimer = () => clearTimeout(timer);
    child.once('exit', onExit);
    child.stdin.end();
  }));
