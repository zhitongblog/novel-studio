// 网页版写作主引擎。
//
// 与「无状态 CLI 写作」(statelessWriter.mjs) 的关键区别：
//   无状态模式下模型自己用文件工具落盘/更新索引台账；
//   网页版模式下模型【只能吐文字、不能写文件】——所以：
//     1) 复用 contextpack.buildBatchPack 组装上下文包（与无状态一致，保证喂料一致→质量一致）；
//     2) 追加一段【严格输出格式指令】，要求模型每章按固定分隔符输出；
//     3) 用 webchat 适配器把 prompt 送进网页聊天框、等生成完、抓正文；
//     4) 由本引擎【自己解析各章正文并落盘】：写 chapters/卷NN/NNN章名.txt、
//        追加 chapter_index.md、在 continuity_ledger.md 追一条批次锚点；
//     5) 推进章号，下一批带更新后的上下文继续。
//
// 落盘/命名规则对齐 books.mjs / contextpack.mjs / scaffold.mjs 里既有约定：
//   文件名 = 3 位全局章号 + 章名 + .txt；正文仅正文；卷目录 chapters/卷NN/。

import fs from 'node:fs';
import path from 'node:path';
import { UnzooClient } from './fanqie.mjs';
import { buildBatchPack } from './contextpack.mjs';
import { hasStructure, splitLedger, setProgress } from './ledgersnap.mjs';
import { bookStats, getBook, currentVolume } from './books.mjs';
import { gitSnapshot } from './scaffold.mjs';
import { chatOnce } from './webchat/adapter.mjs';
import { qwenAdapter } from './webchat/qwen.mjs';
import { chatgptAdapter } from './webchat/chatgpt.mjs';
import { claudeAdapter } from './webchat/claude.mjs';
import { doubaoAdapter } from './webchat/doubao.mjs';
import { grokAdapter } from './webchat/grok.mjs';

// 适配器注册表：adapterId → 适配器对象。
export const WEB_ADAPTERS = {
  qwen: qwenAdapter,
  chatgpt: chatgptAdapter,
  claude: claudeAdapter,
  doubao: doubaoAdapter,
  grok: grokAdapter,
};
export function getAdapter(id) {
  return WEB_ADAPTERS[id] || WEB_ADAPTERS[String(id || '').toLowerCase()] || null;
}

// 章分隔符约定（既写进 prompt，也是解析依据）。
// 每章：<<<CHAPTER 章号=N 标题=章名>>>\n正文\n<<<END>>>
const CH_OPEN_RE = /<<<\s*CHAPTER\s+章号\s*=\s*(\d{1,5})\s+标题\s*=\s*([^\n>]+?)\s*>>>/g;

// 生成【严格输出格式指令】：追加在上下文包 prompt 末尾。（导出供 apiwriter 复用）
export function buildFormatInstruction(numList) {
  const first = numList[0], last = numList[numList.length - 1];
  return [
    `## ⚠️ 输出格式（本次是网页对话，你【不能写文件】，必须把正文直接输出在回复里，由程序解析落盘）`,
    `请【严格】按下面的分隔符逐章输出第 ${numList.join('、')} 章，共 ${numList.length} 章：`,
    '',
    '```',
    `<<<CHAPTER 章号=${first} 标题=这里写本章章名>>>`,
    `（本章正文，仅正文，可含自然段换行；不要写“第X章”标题行、不要 markdown、不要作者旁白）`,
    '<<<END>>>',
    `<<<CHAPTER 章号=${Number(first) + 1 <= Number(last) ? Number(first) + 1 : last} 标题=下一章章名>>>`,
    `（下一章正文）`,
    '<<<END>>>',
    '```',
    '',
    `硬性要求：`,
    `1. 每章必须以 <<<CHAPTER 章号=N 标题=…>>> 开始、以 <<<END>>> 结束；章号用阿拉伯数字（如 ${first}）。`,
    `2. 分隔符行【单独成行】，标记之间只放该章正文，正文里【不要出现】 <<<CHAPTER 或 <<<END 字样。`,
    `3. 章名务必与全书已有章名不重复（参考上文“近期已用章名”）。`,
    `4. 从第 ${first} 章连续写到第 ${last} 章，不要跳号、不要少写。`,
    `5. 除这些带分隔符的章节块外，回复里不要有多余寒暄/解释/总结。`,
  ].join('\n');
}

// 解析模型回答，提取各章 {num, title, body}。容错：宽松匹配、缺 END 用下一 CHAPTER 或文末兜底。
export function parseChapters(text, { onLog = () => {} } = {}) {
  const out = [];
  if (!text) return out;
  const src = String(text).replace(/\r\n/g, '\n');
  // 收集所有 CHAPTER 头的位置
  const heads = [];
  CH_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = CH_OPEN_RE.exec(src)) !== null) {
    heads.push({ index: m.index, after: CH_OPEN_RE.lastIndex, num: parseInt(m[1], 10), title: cleanTitle(m[2]) });
  }
  if (!heads.length) { onLog({ level: 'warn', msg: '网页版：回答里未找到任何 <<<CHAPTER…>>> 分隔符，无法解析（选择器/格式需校准）' }); return out; }

  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const nextHeadIdx = (i + 1 < heads.length) ? heads[i + 1].index : src.length;
    const whole = src.slice(h.after, nextHeadIdx);
    // 优先切到 <<<END>>>；没有则用整段（到下一 CHAPTER 前）
    let seg = whole;
    const endM = whole.match(/<<<\s*END\s*>>>/);
    if (endM) {
      seg = whole.slice(0, endM.index);
      // 【小模型常见的摆模板行为】：把 <<<CHAPTER…>>> 和 <<<END>>> 当"框架"连着吐出来，
      // 正文写在 END 【之后】。实测本地 qwen3:14b 就是这样：
      //     <<<CHAPTER 章号=2 标题=旧人重逢>>>\n<<<END>>>\n沈砚秋站在拳馆外……
      // 死守"END 之前"会把整章判成空、报"未按格式产出"，而正文其实好好地躺在下面。
      // 所以：END 前几乎没东西、而 END 后有大段内容时，改用后面那段。
      const before = seg.replace(/\s/g, '').length;
      const after = whole.slice(endM.index + endM[0].length);
      if (before < 50 && after.replace(/\s/g, '').length >= 50) {
        onLog({ level: 'warn', msg: `  第 ${h.num} 章：模型把 <<<END>>> 提前吐了、正文写在其后，已按正文取用` });
        seg = after.replace(/<<<\s*END\s*>>>/g, '');
      }
    }
    const body = sanitizeBody(seg);
    if (!h.num || !h.title) { onLog({ level: 'warn', msg: `网页版：跳过一段（缺章号或标题）` }); continue; }
    if (!body || body.replace(/\s/g, '').length < 50) { onLog({ level: 'warn', msg: `网页版：第 ${h.num} 章正文过短(<50字)，跳过（可能被截断）` }); continue; }
    out.push({ num: h.num, title: h.title, body });
  }
  return out;
}

function cleanTitle(t) {
  return String(t || '').trim()
    .replace(/^[《【]|[》】]$/g, '')            // 去书名号
    .replace(/^第?\s*\d+\s*章[：:\s]*/, '')     // 去“第N章”前缀
    .replace(/[\\/:*?"<>|]/g, '')               // 去 Windows 非法文件名字符
    .replace(/\s+/g, '')                        // 章名内不留空白
    .slice(0, 40)
    .trim();
}

// 清洗正文：去掉可能残留的格式标记/提示语；并【去除弱模型的重复段落循环】（如 glm-4-flash 为凑字数
// 把同一段/同一组对话重复几十遍）——保留首次出现，删掉后续重复，避免把复读机文本落盘。
function sanitizeBody(s) {
  let t = String(s || '')
    .replace(/<<<\s*CHAPTER[^>]*>>>/g, '')
    .replace(/<<<\s*END\s*>>>/g, '')
    .replace(/^```[a-z]*\n?|\n?```$/g, '')
    .replace(/^\s*（?本章正文[^）]*）?\s*$/gm, '')   // 去掉示例占位提示行
    .replace(/^#+\s*第?\s*\d+\s*章.*$/gm, '')        // 去掉误加的“# 第N章…”标题行
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return dedupeParagraphs(t);
}

// 去重复段落：把正文按段切开，去掉与「已出现过的某一段」几乎相同的段（弱模型复读）。
// 规则：一段（去空白后 ≥8 字）若与前面任一保留段落的归一化文本相同，则丢弃；一旦开始连续重复，
// 说明模型进入了复读循环，直接截断到此为止（后面基本都是循环，保留也是垃圾）。
function dedupeParagraphs(text) {
  const paras = String(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  let consecutiveDup = 0;
  const norm = p => p.replace(/[\s　，。！？、：；“”‘’…—·]/g, '');
  for (const p of paras) {
    const key = norm(p);
    if (key.length >= 8 && seen.has(key)) {
      consecutiveDup++;
      // 连续 2 段以上都是重复 → 判定进入复读循环，截断
      if (consecutiveDup >= 2) break;
      continue;   // 单段偶发重复：跳过这一段，继续看后面
    }
    consecutiveDup = 0;
    if (key.length >= 8) seen.add(key);
    out.push(p);
  }
  return out.join('\n\n').trim();
}

// —— 落盘工具（本引擎自己写文件；模型不写文件）——

// 汉字计数（用于日志展示字数）。（导出供 apiwriter 复用）
export function hanziCount(s) { return (String(s).match(/[一-鿿]/g) || []).length; }

// 落盘一章：写 chapters/卷NN/NNN章名.txt（正文仅正文）；返回相对路径。重名加 _dup。（导出供 apiwriter 复用）
export function saveChapter(book, volDir, num, title, body) {
  const dir = path.join(book.dir, 'chapters', volDir);
  fs.mkdirSync(dir, { recursive: true });
  const num3 = String(num).padStart(3, '0');
  let name = `${num3}${title}.txt`;
  let fp = path.join(dir, name);
  if (fs.existsSync(fp)) { name = `${num3}${title}_dup.txt`; fp = path.join(dir, name); }
  fs.writeFileSync(fp, body.endsWith('\n') ? body : body + '\n', 'utf8');
  return path.join('chapters', volDir, name).replace(/\\/g, '/');
}

// 追加登记到 chapter_index.md（表格行：| 全局章号 | 章名 | 卷 | 路径 | 状态 |）。（导出供 apiwriter 复用）
export function appendIndex(book, rows) {
  const fp = path.join(book.dir, 'chapter_index.md');
  let cur = '';
  try { cur = fs.readFileSync(fp, 'utf8'); } catch {}
  if (!cur) {
    cur = `# 《${book.title}》章节索引（chapter_index.md）\n\n| 全局章号 | 章名 | 卷 | 路径 | 状态 |\n|---|---|---|---|---|\n`;
  }
  const add = rows.map(r => `| ${r.num} | ${r.title} | ${r.volDir} | ${r.rel} | 已写 |`).join('\n');
  const next = cur.replace(/\s*$/, '') + '\n' + add + '\n';
  fs.writeFileSync(fp, next, 'utf8');
}

// 在 continuity_ledger.md 追一条批次锚点（模型只吐文字不改台账 → 由引擎记最小锚点）。（导出供 apiwriter 复用）
export function appendLedgerAnchor(book, rows) {
  const fp = path.join(book.dir, 'continuity_ledger.md');
  let cur = '';
  try { cur = fs.readFileSync(fp, 'utf8'); } catch {}
  if (!cur) return;   // 台账应由 scaffold 建好；缺失则不硬造结构
  const first = rows[0], last = rows[rows.length - 1];
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = `- [网页版写作 ${stamp}] 新增第 ${first.num}–${last.num} 章：${rows.map(r => r.num + '《' + r.title + '》').join('、')}（网页模型不写台账，请在下次自检时据正文补全人物现状/伏笔/欠债）`;

  // 台账已有「📌 当前态快照」结构时：锚点只能进【历史区】。
  // 快照段每批都会被整段喂进上下文，往里插批次流水行会一路把它撑爆——而且下面那个
  // indexOf('## 时间线锚点') 会命中快照骨架里的「### 时间线锚点」（子串匹配），正好插错地方。
  // 顺带把快照的进度行推到最新章：这条路径上模型压根不碰台账（引擎代记是设计如此），
  // 进度行没人改的话，快照会永远被写后闸判成过期。
  if (hasStructure(cur)) {
    const { snapshot, history } = splitLedger(cur);
    fs.writeFileSync(fp, setProgress(snapshot, last.num) + history.replace(/\s*$/, '') + '\n' + line + '\n', 'utf8');
    return;
  }

  // 尚未迁移的旧结构：保持原行为
  const anchorHead = '## 时间线锚点';
  const idx = cur.indexOf(anchorHead);
  let next;
  if (idx >= 0) {
    const insertAt = idx + anchorHead.length;
    next = cur.slice(0, insertAt) + '\n' + line + cur.slice(insertAt);
  } else {
    next = cur.replace(/\s*$/, '') + '\n\n' + line + '\n';
  }
  fs.writeFileSync(fp, next, 'utf8');
}

// 写一批（count 章）：组装上下文包 → 网页对话 → 解析 → 落盘 → 更新索引/台账。
async function writeBatchWeb({ book, adapter, client, count, onLog, timeoutMs }) {
  const pack = buildBatchPack(book, { count });
  const numList = [];
  for (let i = pack.meta.nextNum; i <= pack.meta.lastNum; i++) numList.push(String(i));

  const prompt = pack.prompt + '\n\n' + buildFormatInstruction(numList);
  onLog({ level: 'act', msg: `网页版：请求第 ${pack.meta.nextNum}–${pack.meta.lastNum} 章（${count} 章）｜上下文包 ≈${(prompt.length / 1000).toFixed(1)}K 字` });

  const answer = await chatOnce(client, adapter, prompt, { onLog, timeoutMs });
  const chapters = parseChapters(answer, { onLog });
  if (!chapters.length) {
    onLog({ level: 'warn', msg: '网页版：本批未解析到任何章节（回答未按格式或被截断）' });
    return { ok: false, wrote: 0 };
  }

  // 落盘：按当前卷目录写；章号以模型给的为准，但用引擎侧起始号兜底（避免模型跳号写乱）。
  const volNum = currentVolume(book) || pack.meta.volNum || 1;
  const volDir = '卷' + String(volNum).padStart(2, '0');
  const rows = [];
  let expected = pack.meta.nextNum;
  for (const ch of chapters) {
    // 章号纠偏：若模型给的号明显偏离预期（重复/回退），用预期号
    let num = ch.num;
    if (!num || num < pack.meta.nextNum) num = expected;
    const rel = saveChapter(book, volDir, num, ch.title, ch.body);
    rows.push({ num, title: ch.title, volDir, rel, words: hanziCount(ch.body) });
    onLog({ level: 'info', msg: `  ✓ 落盘 第 ${num} 章《${ch.title}》（约 ${hanziCount(ch.body)} 字）→ ${rel}` });
    expected = num + 1;
  }
  try { appendIndex(book, rows); } catch (e) { onLog({ level: 'warn', msg: '更新 chapter_index.md 失败：' + e.message }); }
  try { appendLedgerAnchor(book, rows); } catch (e) { onLog({ level: 'warn', msg: '更新 continuity_ledger.md 失败：' + e.message }); }

  onLog({ level: 'act', msg: `网页版本批完成：落盘 ${rows.length} 章（第 ${rows[0].num}–${rows[rows.length - 1].num} 章）` });
  return { ok: true, wrote: rows.length, rows };
}

// 连续跑 batches 批的网页版写作。
// 参数：book、adapterId（qwen|chatgpt|claude）、batches、profilePath、onLog、cfg、control。
export async function runWebWrite({
  book, adapterId, batches = 1, profilePath = null, onLog = () => {}, cfg = null, control = null,
} = {}) {
  const adapter = getAdapter(adapterId);
  if (!adapter) throw new Error('未知网页适配器：' + adapterId + '（可选 qwen|doubao|chatgpt|claude|grok）');
  if (!profilePath) throw new Error('网页版写作需要 profilePath（绑定已登录该聊天站点的 Unzoo 账号）');

  const count = book?.standards?.batchSize || 3;
  const timeoutMs = cfg?.web?.batchTimeoutMs || cfg?.stateless?.batchTimeoutMs || 600000;
  // 站点感知：让 UnzooClient 按该聊天站点的 host 锁定标签页（而非默认的 fanqienovel.com）
  const client = new UnzooClient(profilePath, onLog, adapter.host || '', adapter.name);

  // 写前 git 存档（best-effort）
  try { const h = gitSnapshot(book.dir, '网页版写作前自动存档'); if (h) onLog({ level: 'info', msg: `已 git 存档：${h}（不满意可回退）` }); } catch {}

  onLog({ level: 'act', msg: `网页版写作启动：站点[${adapter.name}]、每批 ${count} 章、共 ${batches} 批` });

  const results = [];
  let totalWrote = 0;
  for (let i = 0; i < batches; i++) {
    if (control?.stopped) { onLog({ level: 'act', msg: '收到停止请求 → 在批间安全停止' }); break; }

    // 到达目标章数则停
    const b = getBook(book.slug) || book;
    const target = b.targetChapters || 0;
    if (target > 0 && bookStats(b).chapters >= target) {
      onLog({ level: 'act', msg: `已达目标章数 ${target} → 停止网页版写作` });
      break;
    }

    onLog({ level: 'info', msg: `—— 第 ${i + 1}/${batches} 批（网页版）——` });
    let r;
    try {
      r = await writeBatchWeb({ book, adapter, client, count, onLog, timeoutMs });
    } catch (e) {
      const msg = e.message || String(e);
      if (/^BLOCKED/.test(msg)) {
        onLog({ level: 'error', msg: '网页版被拦截，优雅停止：' + msg + '（请人工处理登录/额度/验证后重试）' });
        break;
      }
      onLog({ level: 'error', msg: '网页版本批异常，停止：' + msg });
      break;
    }
    results.push(r);
    if (!r.ok || r.wrote <= 0) { onLog({ level: 'warn', msg: '本批无产出 → 停止（请检查页面/选择器/额度）' }); break; }
    totalWrote += r.wrote;
  }

  onLog({ level: 'act', msg: `网页版写作结束：共 ${results.length} 批、新增 ${totalWrote} 章` });
  return { ok: true, batches: results.length, totalWrote, results };
}
