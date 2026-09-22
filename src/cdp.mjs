// 极简 Chrome DevTools Protocol 客户端（零依赖，只用 node 内置模块）。
// 够驱动一个无头 Chrome/Edge/Chromium 标签页：导航、等跳转、截图。
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP http 超时')));
  });
}

/** 裸 WebSocket 客户端：握手 + 帧编解码（发送一律 mask）。 */
class WsClient {
  constructor(wsUrl) {
    const u = new URL(wsUrl);
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.path = (u.pathname || '/') + (u.search || '');
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.handlers = new Map();   // id -> resolve
    this.listeners = [];         // 事件
    this.onOpen = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let headDone = false, head = Buffer.alloc(0);
      this.sock.on('data', chunk => {
        if (!headDone) {
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf('\r\n\r\n');
          if (end < 0) return;
          const statusLine = head.slice(0, head.indexOf('\r')).toString();
          if (!/ 101 /.test(statusLine)) { reject(new Error('握手失败: ' + statusLine)); return; }
          const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
          if (!head.toString('latin1').toLowerCase().includes('sec-websocket-accept: ' + expect.toLowerCase())) {
            reject(new Error('握手 accept 校验失败')); return;
          }
          headDone = true;
          this._feed(head.slice(end + 4));
          resolve();
          this.onOpen?.();
          return;
        }
        this._feed(chunk);
      });
      this.sock.on('error', reject);
      this.sock.on('close', () => {
        for (const [, h] of this.handlers) h.reject(new Error('WebSocket 已关闭'));
        this.handlers.clear();
      });
    });
  }

  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1], len0 = b1 & 0x7f;
      let off = 2, len = len0;
      if (len0 === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len0 === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      this._message(payload);
    }
  }

  _message(payload) {
    let obj;
    try { obj = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (obj.id && this.handlers.has(obj.id)) {
      const { resolve, reject, timer } = this.handlers.get(obj.id);
      this.handlers.delete(obj.id);
      clearTimeout(timer);
      if (obj.error) reject(new Error(obj.error.message || JSON.stringify(obj.error)));
      else resolve(obj.result);
    } else if (obj.method) {
      for (const fn of this.listeners) { try { fn(obj); } catch { /* 单个监听器出错不影响其它 */ } };
    }
  }

  send(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  call(method, params = {}, timeoutMs = 30000) {
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(id);
        reject(new Error(`${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.handlers.set(id, { resolve, reject, timer });
      try { this.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.handlers.delete(id); reject(e); }
    });
  }

  on(fn) { this.listeners.push(fn); }
  close() { try { this.sock?.end(); this.sock?.destroy(); } catch { /* 已断开 */ } }
}
WsClient.prototype._seq = 0;

/**
 * 打开一个无头浏览器标签页并返回句柄。
 * launch 需带 --remote-debugging-port，本函数负责等它起来并连上页面级 CDP。
 */
export async function attach(pageUrl, { port = 9333, waitMs = 12000 } = {}) {
  const deadline = Date.now() + waitMs;
  let targets = [];
  for (;;) {
    try { targets = await getJson(`http://127.0.0.1:${port}/json/list`); break; }
    catch {
      if (Date.now() > deadline) throw new Error(`等不到调试端口 ${port} 就绪（浏览器是否启动失败？）`);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  let page = targets.find(t => t.type === 'page') || targets[0];
  if (!page) throw new Error('调试端口没有可用页面');
  const ws = new WsClient(page.webSocketDebuggerUrl);
  await ws.connect();
  const cdp = {
    ws,
    async send(method, params, opts) { return ws.call(method, params, opts?.timeoutMs); },
    async navigate(url) {
      await ws.call('Page.enable');
      await ws.call('Page.navigate', { url }, 40000);
    },
    async screenshot(clip) {
      const params = { format: 'png' };
      if (clip) params.clip = { ...clip, scale: 2 };
      const r = await ws.call('Page.captureScreenshot', params, 30000);
      return 'data:image/png;base64,' + r.data;
    },
    onNavigation(fn) {
      ws.on(msg => {
        if (msg.method === 'Page.frameNavigated' && !msg.params.frame?.parentId) {
          fn(msg.params.frame.url || '');
        }
      });
    },
    /** 任何层（含 iframe）的请求与跳转都过一遍，用于抓 OAuth 回调里的 code/token */
    async onAnyRequest(fn) {
      await ws.call('Network.enable');
      ws.on(msg => {
        if (msg.method === 'Network.requestWillBeSent') fn(msg.params?.request?.url || '');
        else if (msg.method === 'Page.frameNavigated') fn(msg.params?.frame?.url || '');
      });
    },
    /** 响应体里可能就带着 token：登录页往往自己在浏览器里完成兑换，这样连 apiId 都不用知道 */
    async onResponse(fn) {
      await ws.call('Network.enable');
      ws.on(msg => {
        if (msg.method === 'Network.responseReceived') {
          const r = msg.params?.response;
          fn({ url: r?.url || '', requestId: msg.params?.requestId, mimeType: r?.mimeType || '', headers: r?.headers || {} });
        }
      });
    },
    async responseBody(requestId) {
      try {
        const r = await ws.call('Network.getResponseBody', { requestId }, 8000);
        return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      } catch { return ''; }
    },
    /** 在页面里执行 JS 取返回值（cookie / storage 里可能藏着登录态） */
    async evalJson(expression, timeoutMs = 8000) {
      try {
        const r = await ws.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
        return r?.result?.value;
      } catch { return undefined; }
    },
    /** 页面控制台与异常 —— 登录页拒绝我们时通常只写在这里 */
    async onConsole(fn) {
      await ws.call('Runtime.enable');
      try { await ws.call('Log.enable'); } catch { /* 部分版本无此域 */ }
      ws.on(msg => {
        if (msg.method === 'Runtime.consoleAPICalled') {
          const t = (msg.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
          fn(`[console.${msg.params.type}] ${t}`.slice(0, 300));
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          fn(`[exception] ${(d.exception && (d.exception.description || d.exception.message)) || d.text}`.slice(0, 300));
        } else if (msg.method === 'Log.entryAdded') {
          const e = msg.params.entry;
          if (e.level === 'error' || e.level === 'warning') fn(`[${e.source}] ${e.text}`.slice(0, 300));
        }
      });
    },
    async pageText() {
      return await ws.call('Runtime.evaluate', {
        expression: 'JSON.stringify({url:location.href,text:((document.body&&document.body.innerText)||"").replace(/\\s+/g," ").slice(0,400),title:document.title||""})',
        returnByValue: true
      }).then(r => r?.result?.value).catch(() => undefined);
    },
    close() { ws.close(); }
  };
  await cdp.navigate(pageUrl);
  return cdp;
}
