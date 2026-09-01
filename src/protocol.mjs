// protocol.mjs — Marionette wire protocol. Pure functions, no I/O (unit-testable).
//
// Wire format (per packet):  <decimal-byte-length>:<json-bytes>
//   hello:     {"applicationType":"gecko","marionetteProtocol":<int>}
//   command:   [0, <id>, "<Ns:Name>", <paramsObject>]
//   response:  [1, <id>, <errorOrNull>, <resultObject>]
//
// Frames are sent as pure ASCII (>= 0x7f characters are \uXXXX-escaped), so the
// declared byte length always equals the actual byte length.

export const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
export const MAX_FRAME = 500 * 1024 * 1024;

// JSON.stringify leaves U+E000/U+E001 (and anything >= 0x7f) unescaped; in UTF-8
// those are multi-byte, which desynchronizes <len> framing when len is computed
// from string length. Escape every such codepoint so frames stay 1 byte = 1 char.
export function asciiEscape(s) {
  return s.replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4));
}

export function encodeFrame(arr) {
  const body = asciiEscape(JSON.stringify(arr));
  return Buffer.from(body.length + ':' + body, 'ascii');
}

// Incremental frame parser.
//   parser.push(chunk: Buffer)
//   onFrame(json, rawBody)  — called for every well-formed frame
//   onDrop(reason, head)    — called when bytes are discarded (corruption guard)
export function createFrameParser({ onFrame, onDrop, maxFrame = MAX_FRAME } = {}) {
  let buf = Buffer.alloc(0);
  function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    let guard = 0;
    for (;;) {
      if (++guard > 10000) {
        if (onDrop) onDrop('stall', buf.subarray(0, 80));
        buf = Buffer.alloc(0);
        return;
      }
      const colon = buf.indexOf(':');
      if (colon < 0) return;
      const prefix = buf.subarray(0, colon).toString('ascii');
      const len = /^\d+$/.test(prefix) ? Number(prefix) : NaN;
      if (!Number.isSafeInteger(len) || len < 0 || len > maxFrame) { buf = Buffer.alloc(0); return; }
      if (buf.length < colon + 1 + len) return;
      const body = buf.subarray(colon + 1, colon + 1 + len);
      buf = buf.subarray(colon + 1 + len);
      let msg = null;
      try { msg = JSON.parse(body.toString('utf8')); } catch { if (onDrop) onDrop('unparseable', body.subarray(0, 60)); continue; }
      if (onFrame) onFrame(msg, body);
    }
  }
  return { push, pending: () => buf };
}

// FindElement responses may wrap the element ref: { "element-...-...": "uuid" }
// (or legacy "m-element"/"moz:elementId" keys). Commands take the bare uuid.
export function unwrapElementRef(v) {
  if (v == null) throw new Error('element ref is null');
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (k === 'm-element' || k === 'moz:elementId' || k === 'element' || k === 'id' || k.includes('element-')) return String(val);
    }
    throw new Error('unrecognized element ref: ' + JSON.stringify(v));
  }
  return String(v);
}

// Classify a parsed frame: 'hello' | 'response' | 'other'
export function frameKind(msg) {
  if (Array.isArray(msg) && msg[0] === 1) return 'response';
  if (msg && typeof msg === 'object' && !Array.isArray(msg) && 'marionetteProtocol' in msg) return 'hello';
  return 'other';
}
