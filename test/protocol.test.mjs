// protocol.test.mjs — wire codec, frame parser, element ref handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame, createFrameParser, asciiEscape,
  unwrapElementRef, frameKind, W3C_ELEMENT_KEY,
} from '../src/protocol.mjs';

test('encodeFrame: ascii round-trip, prefix == body bytes', () => {
  const arr = [0, 1, 'WebDriver:GetTitle', null];
  const frame = encodeFrame(arr);
  const s = frame.toString('ascii');
  const colon = s.indexOf(':');
  const declared = Number(s.slice(0, colon));
  assert.equal(declared, frame.length - colon - 1, 'declared length must equal actual body bytes');
  assert.deepEqual(JSON.parse(s.slice(colon + 1)), arr);
});

test('encodeFrame: non-ascii payload stays ascii and keeps length exact (W3C file-char regression)', () => {
  const arr = [0, 8, 'WebDriver:ElementSendKeys', { id: 'el', text: '\ue000QUJD\ue001' }];
  const frame = encodeFrame(arr);
  const s = frame.toString('latin1');
  const colon = s.indexOf(':');
  const declared = Number(s.slice(0, colon));
  assert.equal(declared, frame.length - colon - 1, 'byte length must not desync from declared length');
  for (const b of frame) assert.ok(b < 0x80, 'frame must be pure ASCII');
  assert.ok(!s.includes('\ue000'), 'U+E000 must be escaped, not raw');
  // decoded body must round-trip the original value
  const body = JSON.parse(Buffer.from(frame.subarray(colon + 1)).toString('utf8'));
  assert.equal(body[3].text, arr[3].text);
});

test('asciiEscape: escapes 0x7f..0xffff, leaves ascii alone', () => {
  assert.equal(asciiEscape('abc'), 'abc');
  assert.equal(asciiEscape('café'), 'caf\\u00e9');
  assert.equal(asciiEscape('\u007f'), '\\u007f');
});

test('parser: reassembles a frame split across packets', () => {
  const frames = [];
  const p = createFrameParser({ onFrame: (m) => frames.push(m) });
  const full = encodeFrame([1, 1, null, { value: 'x' }]);
  p.push(full.subarray(0, 3));
  p.push(full.subarray(3, 9));
  p.push(full.subarray(9));
  assert.deepEqual(frames, [[1, 1, null, { value: 'x' }]]);
});

test('parser: two frames in one chunk', () => {
  const frames = [];
  const p = createFrameParser({ onFrame: (m) => frames.push(m) });
  const a = encodeFrame([1, 1, null, { a: 1 }]);
  const b = encodeFrame([1, 2, null, { b: 2 }]);
  p.push(Buffer.concat([a, b]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1], [1, 2, null, { b: 2 }]);
});

test('parser: junk prefix discarded, then recovers', () => {
  const frames = [];
  const drops = [];
  const p = createFrameParser({ onFrame: (m) => frames.push(m), onDrop: (r) => drops.push(r) });
  p.push(Buffer.from('zzz:12:'));
  p.push(encodeFrame([1, 1, null, { v: 1 }]));
  assert.equal(frames.length, 1, 'next frame must still parse after junk prefix');
  assert.equal(frames[0][3].v, 1);
});

test('parser: zero-length frame dropped, rest of stream survives', () => {
  const frames = [];
  const drops = [];
  const p = createFrameParser({ onFrame: (m) => frames.push(m), onDrop: (r) => drops.push(r) });
  const good = encodeFrame([1, 1, null, { v: 2 }]);
  p.push(Buffer.concat([Buffer.from('0:'), good]));
  assert.deepEqual(drops, ['unparseable'], 'empty body reported');
  assert.equal(frames.length, 1, 'following frame must still parse');
  assert.deepEqual(frames[0], [1, 1, null, { v: 2 }]);
});

test('parser: non-JSON body dropped via onDrop, parser survives', () => {
  const frames = [];
  const drops = [];
  const p = createFrameParser({ onFrame: (m) => frames.push(m), onDrop: (r) => drops.push(r) });
  const bad = Buffer.from('5:notjs');
  p.push(Buffer.concat([bad, encodeFrame([1, 7, null, { ok: true }])]));
  assert.ok(drops.includes('unparseable'), 'malformed body reported');
  assert.equal(frames.length, 1);
});

test('frameKind classifies hello / response / other', () => {
  assert.equal(frameKind({ applicationType: 'gecko', marionetteProtocol: 3 }), 'hello');
  assert.equal(frameKind([1, 1, null, {}]), 'response');
  assert.equal(frameKind([0, 1, 'X', {}]), 'other');
  assert.equal(frameKind('nope'), 'other');
});

test('unwrapElementRef: W3C-wrapped', () => {
  assert.equal(unwrapElementRef({ [W3C_ELEMENT_KEY]: 'uuid-1' }), 'uuid-1');
});
test('unwrapElementRef: legacy keys', () => {
  assert.equal(unwrapElementRef({ 'm-element': 'uuid-2' }), 'uuid-2');
  assert.equal(unwrapElementRef({ 'moz:elementId': 'uuid-3' }), 'uuid-3');
});
test('unwrapElementRef: plain string pass-through', () => {
  assert.equal(unwrapElementRef('uuid-4'), 'uuid-4');
});
test('unwrapElementRef: rejects null and unknown objects', () => {
  assert.throws(() => unwrapElementRef(null), /null/);
  assert.throws(() => unwrapElementRef({ weird: 1 }), /unrecognized/);
});
