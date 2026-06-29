// Token 用量统计：从 agent 的 TUI 屏幕解析"tokens used N"，按"书 × 写作会话"累计。
// codex 显示 "tokens used 12,250"；claude/gemini 类似 "12.3k tokens"。这些是会话内累计值，
// 我们用"增量法"汇总到每本书的总量（同一会话取最新值算增量，避免重复计数）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from './paths.mjs';
import { ensureDirs } from './config.mjs';

// —— 从 codex 的会话日志读取某书目录的真实 token 用量 ——
// codex 在 ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl 里记录：
//   首行 session_meta.payload.cwd = 工作目录；event_msg(payload.type=token_count) 里
//   info.total_token_usage.total_tokens = 该会话累计。一本书可能跨多个会话 → 求和。
const _tokCache = new Map(); // dir -> { at, val }
export function codexTokensForDir(dir) {
  if (!dir) return 0;
  const key = path.resolve(dir).toLowerCase();
  const c = _tokCache.get(key);
  if (c && Date.now() - c.at < 20000) return c.val;
  let val = 0;
  try { val = scanCodexTokens(key); } catch {}
  _tokCache.set(key, { at: Date.now(), val });
  return val;
}
function scanCodexTokens(targetLower) {
  const base = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(base)) return 0;
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000; // 只看近 90 天的会话
  const files = [];
  (function walk(d) {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= cutoff) files.push(p); } catch {} }
    }
  })(base);
  let total = 0;
  for (const f of files) {
    try {
      // 首行(session_meta)可能很长(含 base_instructions)，别 JSON.parse 整行，直接正则抠 cwd
      const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, 8192, 0); fs.closeSync(fd);
      const chunk = buf.toString('utf8', 0, n);
      if (!chunk.includes('"session_meta"')) continue;
      const m = chunk.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!m) continue;
      const cwd = m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\u002f/gi, '/');
      if (path.resolve(cwd).toLowerCase() !== targetLower) continue;
      // 匹配 → 取该会话最后一个 token_count 的累计 total_tokens
      const content = fs.readFileSync(f, 'utf8');
      let last = 0;
      for (const line of content.split('\n')) {
        if (!line.includes('token_count')) continue;
        try { const o = JSON.parse(line); if (o?.payload?.type === 'token_count') last = o.payload.info.total_token_usage.total_tokens; } catch {}
      }
      total += last;
    } catch {}
  }
  return total;
}

// —— 从 claude code 的会话日志读取某书目录的真实 token 用量 ——
// claude 存在 ~/.claude/projects/<编码cwd>/<session>.jsonl，assistant 行带 message.usage
//   {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}，且每行带 cwd。
// 目录编码规则：把 cwd 里每个非 [A-Za-z0-9] 字符替换成 '-'（盘符冒号/反斜杠/中文都成 '-'）。
// 中文书名会编码成一串 '-' → 多本可能撞进同一目录，故再按行内 cwd 精确区分。
const _claudeCache = new Map();
export function claudeTokensForDir(dir) {
  if (!dir) return 0;
  const key = path.resolve(dir).toLowerCase();
  const c = _claudeCache.get(key);
  if (c && Date.now() - c.at < 20000) return c.val;
  let val = 0;
  try { val = scanClaudeTokens(dir); } catch {}
  _claudeCache.set(key, { at: Date.now(), val });
  return val;
}
function scanClaudeTokens(dir) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(base)) return 0;
  const targetLower = path.resolve(dir).toLowerCase();
  const enc = path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
  const pd = path.join(base, enc);
  if (!fs.existsSync(pd)) return 0;
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  let total = 0, files = [];
  try { files = fs.readdirSync(pd).filter(f => f.endsWith('.jsonl')); } catch {}
  for (const f of files) {
    const fp = path.join(pd, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
    let content = '';
    try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.includes('"usage"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.cwd && path.resolve(o.cwd).toLowerCase() !== targetLower) continue;  // 撞名目录按 cwd 区分
        const u = o.message && o.message.usage;
        if (u) total += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      } catch {}
    }
  }
  return total;
}

// —— 当前“上下文占用”估算（用于“上下文快满就重开新会话省 token”）——
// 与累计用量不同：这里要的是【最近一轮请求实际带的上下文大小】≈ 该轮 prompt 的 input+cache。
// claude：~/.claude/projects/<enc>/<session>.jsonl 里 assistant 行 message.usage 的
//   input_tokens + cache_read_input_tokens + cache_creation_input_tokens（不含 output）。
//   取“最新会话文件里最后一条 usage”。
const _ctxCache = new Map(); // dir|model -> { at, val }
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

export function claudeContextSize(dir) {
  try {
    const base = path.join(os.homedir(), '.claude', 'projects');
    const pd = path.join(base, path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-'));
    if (!fs.existsSync(pd)) return 0;
    const targetLower = path.resolve(dir).toLowerCase();
    const files = fs.readdirSync(pd).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ p: path.join(pd, f), m: safeMtime(path.join(pd, f)) }))
      .sort((a, b) => b.m - a.m);
    for (const { p } of files) {
      let content = ''; try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"usage"')) continue;
        try {
          const o = JSON.parse(line);
          if (o.cwd && path.resolve(o.cwd).toLowerCase() !== targetLower) continue;
          const u = o.message && o.message.usage;
          if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        } catch {}
      }
    }
  } catch {}
  return 0;
}

// codex：rollout 里 token_count.info.last_token_usage.total_tokens ≈ 最近一轮上下文（尽力而为，拿不到返回 0）。
export function codexContextSize(dir) {
  try {
    const base = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(base)) return 0;
    const targetLower = path.resolve(dir).toLowerCase();
    let newest = null, newestM = 0;
    (function walk(d) {
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) { const m = safeMtime(p); if (m > newestM) { newestM = m; newest = p; } }
      }
    })(base);
    if (!newest) return 0;
    const content = fs.readFileSync(newest, 'utf8');
    // 确认这个最新会话属于目标目录
    const head = content.slice(0, 8192);
    const mm = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (mm) { const cwd = mm[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\u002f/gi, '/'); if (path.resolve(cwd).toLowerCase() !== targetLower) return 0; }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('token_count')) continue;
      try { const o = JSON.parse(lines[i]); if (o?.payload?.type === 'token_count') { const info = o.payload.info; return info?.last_token_usage?.total_tokens || 0; } } catch {}
    }
  } catch {}
  return 0;
}

// 统一入口：返回当前上下文占用 token 数（claude 精确；codex 尽力；其它/读不到返回 0）。短缓存避免频繁读盘。
export function currentContextSize(dir, model) {
  if (!dir) return 0;
  const key = (model || '') + '|' + path.resolve(dir).toLowerCase();
  const c = _ctxCache.get(key);
  if (c && Date.now() - c.at < 8000) return c.val;
  let val = 0;
  try { val = model === 'claude' ? claudeContextSize(dir) : model === 'codex' ? codexContextSize(dir) : 0; } catch {}
  _ctxCache.set(key, { at: Date.now(), val });
  return val;
}

const USAGE_FILE = path.join(CONFIG_DIR, 'usage.json');

// 从屏幕文本解析当前累计 token 数（取屏幕上与 "tokens" 相关的最大数字）
export function parseTokens(text) {
  if (!text) return null;
  let best = null;
  const re = /([\d][\d,\.]*)\s*([kKmM]?)\s*tokens?\b|\btokens?\s*(?:used)?\s*[:：]?\s*([\d][\d,\.]*)\s*([kKmM]?)/gi;
  let m;
  while ((m = re.exec(text))) {
    const numStr = m[1] || m[3];
    const suf = (m[2] || m[4] || '').toLowerCase();
    if (!numStr) continue;
    let n = parseFloat(numStr.replace(/,/g, ''));
    if (!isFinite(n)) continue;
    if (suf === 'k') n *= 1000; else if (suf === 'm') n *= 1000000;
    n = Math.round(n);
    if (n > 0 && (best === null || n > best)) best = n;
  }
  return best;
}

export function loadUsage() {
  ensureDirs();
  if (!fs.existsSync(USAGE_FILE)) return { books: {} };
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return { books: {} }; }
}

function saveUsage(u) {
  ensureDirs();
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2), 'utf8');
}

// 记录某本书某次写作会话的当前累计 token（增量法汇总到 book.total）。
// sessionKey 应在同一次写作会话内稳定（用 实例id@startedAt）。
export function recordUsage(slug, sessionKey, currentTokens) {
  if (!slug || !sessionKey || !(currentTokens > 0)) return;
  const u = loadUsage();
  const book = u.books[slug] || (u.books[slug] = { total: 0, sessions: {}, updatedAt: '' });
  const prev = book.sessions[sessionKey] || 0;
  if (currentTokens >= prev) {
    book.total += (currentTokens - prev);     // 增量
  } else {
    book.total += currentTokens;              // 会话重置/新值变小 → 视为新增量
  }
  book.sessions[sessionKey] = currentTokens;
  book.updatedAt = new Date().toISOString();
  saveUsage(u);
  return book.total;
}

export function bookUsage(slug) {
  const u = loadUsage();
  const b = u.books[slug];
  return b ? b.total : 0;
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
