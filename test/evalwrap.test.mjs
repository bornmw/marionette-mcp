// evalwrap.test.mjs — semantics of the fx_eval wrapper, run in a node:vm page
// context (mirrors the Marionette driver: the script is a function body whose
// arguments[] carries the user body). No browser required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EVAL_WRAP, EVAL_POLL } from '../src/evalwrap.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

function run(body, extra = {}) {
  const sandbox = { window: {}, document: { title: 'T' }, setTimeout: (...a) => globalThis.setTimeout(...a), ...extra };
  // window.__fxr objects are created in the vm realm (different Object.prototype),
  // so compare properties, not with deepStrictEqual.
  const fxrOf = (s) => s.window.__fxr;
  const ctx = vm.createContext(sandbox);
  // The wrapper is a function body (like the Marionette driver delivers it):
  // build it with the context's Function constructor and pass the user body as
  // arguments[0]. The context global carries `window`/`document` for the body.
  const res = vm.runInContext('new Function(' + JSON.stringify(EVAL_WRAP) + ').call(null, ' + JSON.stringify(body) + ')', ctx);
  return { res, sandbox };
}

test('expression body: completion value is returned (1 + 1)', () => {
  const { res } = run('1 + 1');
  assert.equal(res.__fx, 'ok');
  assert.equal(res.v, 2);
});

test('expression body: document.title (member access)', () => {
  const { res } = run('document.title');
  assert.equal(res.v, 'T');
});

test('expression body: multi-statement completion value (var x = 21; x * 2)', () => {
  const { res, sandbox } = run('var x = 21; x * 2');
  assert.equal(res.v, 42);
  assert.equal(sandbox.x, undefined, 'eval var must not leak to global');
  assert.equal(sandbox.window.x, undefined);
});

test('expression body: IIFE', () => {
  const { res } = run('(() => 3)()');
  assert.equal(res.v, 3);
});

test('function-body fallback: top-level return', () => {
  const { res } = run('return 7;');
  assert.equal(res.v, 7);
});

test('function-body fallback: return inside multi-statement body', () => {
  const { res } = run('if (true) { return 1; } return 2;');
  assert.equal(res.v, 1);
});

test('body with backticks/quotes cannot break the wrapper source', () => {
  const { res } = run("const s = `a` + 'b' + \"c\";\ns + '!'");
  assert.equal(res.v, 'abc!');
});

test('classic async pattern: return (async () => {…})() is awaited via window.__fxr', async () => {
  const { res, sandbox } = run('return (async () => { await new Promise((r) => setTimeout(r, 5)); return 42; })();');
  assert.equal(res.__fx, 'pend');
  await new Promise((r) => setTimeout(r, 20));
  const fx = sandbox.window.__fxr;
  assert.equal(fx.__fx, 'ok');
  assert.equal(fx.v, 42);
});

test('expression Promise: new Promise(...) without return is awaited', async () => {
  const { res, sandbox } = run('new Promise(function (r) { r(5); })');
  assert.equal(res.__fx, 'pend');
  await new Promise((r) => setTimeout(r, 10));
  const fx = sandbox.window.__fxr;
  assert.equal(fx.__fx, 'ok');
  assert.equal(fx.v, 5);
});

test('rejected Promise surfaces as err with the reason', async () => {
  const { res, sandbox } = run('Promise.reject(new Error("boom"))');
  assert.equal(res.__fx, 'pend');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sandbox.window.__fxr.__fx, 'err');
  assert.match(sandbox.window.__fxr.m, /boom/);
});

test('runtime error reports the page error message', () => {
  const { res } = run('nope_undefined_var_xyz');
  assert.equal(res.__fx, 'err');
  assert.match(res.m, /nope_undefined_var_xyz/);
});

test('body that is a syntax error in both modes is reported as err', () => {
  const { res } = run('const = 5');
  assert.equal(res.__fx, 'err');
  assert.match(res.m, /SyntaxError|unexpected|invalid/i);
});

test('EVAL_POLL returns null before settle and clears after', async () => {
  const sandbox = { window: {} };
  const ctx = vm.createContext(sandbox);
  // EVAL_POLL is a function body; run `new Function(body)()` inside the context
  // so the generated function's global is the sandbox (where `window` lives).
  const poll = () => vm.runInContext('new Function(' + JSON.stringify(EVAL_POLL) + ')()', ctx);
  assert.equal(poll(), null);
  sandbox.window.__fxr = { __fx: 'ok', v: 9 };
  assert.deepEqual(poll(), { __fx: 'ok', v: 9 });
  assert.equal(poll(), null, 'poll must clear the slot');
});
