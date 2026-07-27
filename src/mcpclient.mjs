// 直连某个 Unterm 实例的 MCP 端口（TCP 行分隔 JSON-RPC）。
// 握手：connect -> auth.login {token} -> 之后用点号方法名调用（session.list / screen.text / session.input ...）
import net from 'node:net';

export class UntermMcp {
  constructor(port, token, host = '127.0.0.1', opts = {}) {
    this.port = port; this.token = token; this.host = host;
    this.sock = null; this.buf = ''; this.id = 0;
    this.pending = new Map();
    this.authed = false;
    // 未受信 agent 的写操作（session.input 等）会被【挂起等用户确认】→ 调用超时 → autopilot 点不动。
    // 新版 Unterm(v0.51)：agent.identify 只做审计分组，【不授信】；必须再调 agent.trust 把本名加入受信列表，
    // 写操作才会跳过确认。默认名 'claude-code'。
    this.identifyAs = opts.identifyAs || 'claude-code';
    this.identified = false;
    this.trusted = false;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      this.sock = sock;
      // 永久兜底 error 处理：socket 任何阶段的 error（写到已关闭的 pane→write EOF/EPIPE/ECONNRESET）都不能让整个引擎进程崩。
      // （原来只在 connect 成功后才挂 error 处理 → 半开/写失败时无监听 → Unhandled 'error' 直接 crash 引擎，图书预览/写作全挂。）
      sock.on('error', () => {});
      const to = setTimeout(() => { sock.destroy(); reject(new Error('MCP 连接超时')); }, timeoutMs);
      sock.once('connect', async () => {
        clearTimeout(to);
        sock.on('data', (d) => this._onData(d));
        sock.on('error', () => {});
        try {
          const r = await this.call('auth.login', { token: this.token });
          this.authed = (r?.status === 'ok' || r === null || r === undefined);
          // ① 自报身份（审计分组）
          try { const ir = await this.call('agent.identify', { name: this.identifyAs }, 8000); this.identified = ir?.status === 'ok'; }
          catch { this.identified = false; }
          // ② 把本名加入受信列表 → 解锁写操作（session.input 跳过确认）。这是 v0.51 必须做的一步。
          // 旧版没有 agent.trust 方法会报 -32601，吞掉即可（旧版本就靠 identify/默认信任）。
          try { const tr = await this.call('agent.trust', { name: this.identifyAs }, 8000); this.trusted = !!(tr?.ok || tr?.added); }
          catch { this.trusted = false; }
          resolve(this);
        } catch (e) { reject(e); }
      });
      sock.once('error', (e) => { clearTimeout(to); reject(e); });
    });
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.id != null && this.pending.has(o.id)) {
        const { resolve, reject } = this.pending.get(o.id);
        this.pending.delete(o.id);
        if (o.error) reject(Object.assign(new Error(o.error.message || 'rpc error'), { code: o.error.code, data: o.error }));
        else resolve(o.result);
      }
    }
  }

  call(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('MCP 未连接'));
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      const to = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, timeoutMs);
      const wrap = (fn) => (v) => { clearTimeout(to); fn(v); };
      const p = this.pending.get(id);
      this.pending.set(id, { resolve: wrap(resolve), reject: wrap(reject) });
      this.sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  // 实例(0.22)对多数按 pane 操作的方法要求 id / session_id（reference 文档写的 pane_id 是别名，
  // 但部分方法只认 session_id/id）。这里同时带上三种键，最大化兼容。
  _target(paneId) { return { pane_id: paneId, session_id: paneId, id: paneId }; }

  // —— 便捷方法 ——
  async sessionList() { const r = await this.call('session.list'); return r?.sessions || []; }
  async status(paneId) { return this.call('session.status', this._target(paneId)); }
  async screenText(paneId) {
    const r = await this.call('screen.text', this._target(paneId));
    if (typeof r === 'string') return r;
    if (Array.isArray(r?.lines)) return r.lines.join('\n');
    if (typeof r?.text === 'string') return r.text;
    return JSON.stringify(r);
  }
  // 0.22 实例要求键名为 input；reference 文档写的是 text。两者都带上。
  async input(paneId, text) { return this.call('session.input', { ...this._target(paneId), input: text, text }); }
  // 提交一段文字：先把文字打进输入框，停顿后再单独按回车。
  // 关键：文字和回车一次性注入时，agent 会把回车当作粘贴内容的一部分（只填不发）；分两次才会真正提交。
  async submitText(paneId, text) {
    await this.input(paneId, text);
    await new Promise(r => setTimeout(r, 350));
    await this.input(paneId, '\r');
  }
  async enter(paneId) { return this.input(paneId, '\r'); }
  async proxySwitch(node) { return this.call('proxy.switch', { node, node_name: node }); }
  async proxyStatus() { return this.call('proxy.status'); }

  close() { try { this.sock?.end(); } catch {} }
}

export async function connectInstance(instance, opts = {}) {
  const c = new UntermMcp(instance.mcp_port, instance.auth_token, '127.0.0.1', opts);
  await c.connect();
  return c;
}
