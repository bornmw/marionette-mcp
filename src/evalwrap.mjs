// Two-phase fx_eval wrappers (see server.mjs tool `fx_eval`).
//
// The user body is evaluated in-page with dual semantics:
//   1. expression first  — `eval(body)`; the completion value is the result.
//      `1 + 1`, `document.title`, `var x = 1; x`, `(async () => { … })()`,
//      `fetch(u).then(r => r.json())` all just work.
//   2. function-body fallback — a top-level `return` is a SyntaxError under
//      eval, so that is re-run via `new Function(body)()`. The classic
//      `return value` / `return (async () => { … })()` scripts keep working.
//
// A Promise result from either path feeds the pending protocol: the wrapper
// reports {__fx:'pend'} and settles into window.__fxr; the server polls it.
// The body travels as arguments[0] (never string-interpolated), so arbitrary
// quotes/backticks in the body cannot break the wrapper source.

export const EVAL_WRAP = `/*__fxeval__*/
var __r;
try {
  var __b = arguments[0];
  try {
    __r = eval(__b);
  } catch (__e1) {
    if (__e1 instanceof SyntaxError) { __r = new Function(__b)(); }
    else { throw __e1; }
  }
} catch (e) { return { __fx: "err", m: String((e && e.message) || e) }; }
if (__r && typeof __r.then === "function") { __r.then(function (v) { window.__fxr = { __fx: "ok", v: v }; }, function (e) { window.__fxr = { __fx: "err", m: String((e && e.message) || e) }; }); return { __fx: "pend" }; }
return { __fx: "ok", v: __r };`;

export const EVAL_POLL = `/*__fxpoll__*/
var __w = window.__fxr; if (__w) { delete window.__fxr; return __w; } return null;`;
