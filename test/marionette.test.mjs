// marionette.test.mjs — Marionette client against the fake wire-protocol server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marionette } from '../src/marionette.mjs';
import { startFakeMarionette } from './helpers/fake_marionette.mjs';

async function withClient(fn) {
  const fake = await startFakeMarionette();
  const m = new Marionette({ port: fake.port, helloWaitMs: 50, log: () => {} });
  try {
    await fn(m, fake);
  } finally {
    if (m.sock && !m.sock.destroyed) m.sock.destroy();
    await fake.stop();
  }
}

test('connect + hello + NewSession (strict capability accepted)', async () => {
  await withClient(async (m, fake) => {
    await m.connect();
    await m.init();
    assert.equal(m.sessionId, 'fake-sess-1');
    assert.equal(m.hello.marionetteProtocol, 3);
    const sess = fake.state.frames.find((f) => f[2] === 'WebDriver:NewSession');
    assert.deepEqual(sess[3], { strictFileInteractability: true });
  });
});

test('cmd round-trip: GetTitle', async () => {
  await withClient(async (m) => {
    await m.connect();
    const title = await m.cmd('WebDriver:GetTitle');
    assert.equal(title.value, 'Fake Page');
  });
});

test('cmd auto-opens session on first use', async () => {
  await withClient(async (m) => {
    const title = await m.cmd('WebDriver:GetTitle'); // no explicit connect/init
    assert.equal(title.value, 'Fake Page');
    assert.ok(m.sessionId);
  });
});

test('non-ascii command text stays framing-safe (regression: length desync)', async () => {
  await withClient(async (m, fake) => {
    await m.connect();
    const text = 'café \ue000BASE64\ue001Ω';
    await m.cmd('WebDriver:ElementSendKeys', { id: 'el-x', text });
    assert.deepEqual(fake.state.violations, [], 'fake server must see no framing violations');
    const f = fake.state.frames.find((x) => x[2] === 'WebDriver:ElementSendKeys');
    assert.equal(f[3].text, text, 'payload must round-trip exactly after ascii-escape/JSON');
  });
});

test('protocol error rejects with message', async () => {
  await withClient(async (m) => {
    await m.connect();
    await m.init();
    await assert.rejects(m.cmd('WebDriver:BoomError'), /something failed/);
  });
});

test('socket loss rejects in-flight command', async () => {
  const fake = await startFakeMarionette();
  const m = new Marionette({ port: fake.port, helloWaitMs: 50, log: () => {} });
  try {
    await m.connect();
    await m.init();
    const inflight = m.cmd('WebDriver:GetTitle');
    fake.closeAll(); // destroy sockets synchronously before any response can be delivered
    await assert.rejects(inflight, /connection lost/);
  } finally {
    if (m.sock && !m.sock.destroyed) m.sock.destroy();
    await fake.stop();
  }
});

test('send() without a socket rejects cleanly', async () => {
  const m = new Marionette({ port: 1, log: () => {} });
  await assert.rejects(m.send('WebDriver:GetTitle'), /not connected/);
});
