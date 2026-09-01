// marionette.mjs — async Marionette TCP client (one session, one socket)
import net from 'node:net';
import { encodeFrame, createFrameParser, frameKind } from './protocol.mjs';

const noop = () => {};

export class Marionette {
  constructor({ host = '127.0.0.1', port = 2828, helloWaitMs = 1200, connectTimeoutMs = 60000, log = noop } = {}) {
    this.host = host;
    this.port = port;
    this.helloWaitMs = helloWaitMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.log = log;
    this.sock = null;
    this.parser = null;
    this.nextId = 1;
    this.pending = new Map();
    this.hello = null;
    this.sessionId = null;
  }

  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    this.pending.clear();
    this.sessionId = null;
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      s.setTimeout(this.connectTimeoutMs);
      s.on('timeout', () => s.destroy(new Error('connect timeout')));
      s.once('error', (e) => reject(new Error('connect: ' + e.message)));
      s.on('connect', () => {
        s.setTimeout(0); // cancel: no idle timeout once connected
        this.sock = s;
        this.parser = createFrameParser({
          onFrame: (msg) => this._onFrame(msg),
          onDrop: (reason, head) => this.log('frame dropped:', reason, head && head.toString().slice(0, 80)),
        });
        s.on('error', (e) => this._fail('browser connection lost: ' + e.message));
        s.on('close', () => this._fail('browser connection lost: socket closed'));
        s.on('data', (d) => this.parser.push(d));
        resolve();
      });
    });
  }

  _fail(msg) {
    if (!this.sock) return;
    this.log('socket fail:', msg);
    const pend = [...this.pending.values()];
    this.pending.clear();
    this.sessionId = null;
    this.sock = null;
    pend.forEach((p) => p.reject(new Error(msg)));
  }

  _onFrame(msg) {
    const kind = frameKind(msg);
    if (kind === 'hello') {
      this.hello = msg;
      return;
    }
    if (kind !== 'response' || !Array.isArray(msg)) return;
    const [, id, err, res] = msg;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (err) {
      let m = msg[2];
      if (m && typeof m === 'object') {
        m = m.stacktrace ? (m.message || m.error || JSON.stringify(m.error)) : (m.message || JSON.stringify(m));
      }
      p.reject(new Error(String(m).slice(0, 4000)));
    } else {
      p.resolve(res ?? {});
    }
  }

  send(name, params) {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    this.sock.write(encodeFrame([0, id, name, params ?? {}]));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // Wait for the on-connect hello, then open a session.
  async init() {
    await new Promise((r) => setTimeout(r, this.helloWaitMs));
    const r = await this.send('WebDriver:NewSession', { strictFileInteractability: true });
    this.sessionId = r.sessionId;
    this.log('session', this.sessionId, 'protocol', this.hello && this.hello.marionetteProtocol);
    return this.sessionId;
  }

  // Auto-connects and auto-opens a session on first use (and after a loss).
  cmd(name, params) {
    if (!this.sessionId) {
      const ready = this.sock && !this.sock.destroyed ? Promise.resolve() : this.connect();
      return ready.then(() => this.init()).then(() => this.send(name, params));
    }
    return this.send(name, params);
  }
}
