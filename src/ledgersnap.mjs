// 台账【当前态快照】—— 生产端。
//
// 【为什么要有这个文件】
// contextpack.ledgerForPack 早就写好了消费端：台账顶部若有「📌 当前态快照」段并以
// LEDGER_HISTORY_BELOW 与下方历史原文分隔，就【整段喂快照】、不喂下方几十上百 KB 历史。
// 可全代码库【没有任何地方产出这个结构】——scaffold 不铺，没有生成器，没有迁移器，
// 写作提示词最后还补了一句"若文件还没有快照段，按旧法维护即可"，等于明说可以不建。
// 于是消费端的快照分支【从未对任何一本书命中过】，所有书 100% 走回退路径 clip(前 8000 字符)：
//
//   重生东京   台账 325 KB → 每批只喂前 8000 字符（2.5%）：292 章的书，看着开篇的旧账在写
//   重生 94    台账 253 KB → 同上
//
// 这不是"上下文包太大"，是【喂错了】——模型看到的"当前剧情状态权威快照"是两百多章前的。
//
// 【修法：结构归代码，内容归模型，校验归代码】
// 与 deslop（排版强制矫正）、pacingGate（节奏闸）同一个教训：凡是指望模型自觉维护的东西，
// 模型就不会维护——不是它偷懒，是提示词里但凡留了退路，它必走退路。所以三层分工：
//   · 结构 ensureStructure()：纯代码、幂等、不调模型。新书 scaffold 时铺好，老书写作前自动迁移。
//   · 内容：仍由模型在写作时就地改写（这一批发生了什么，只有它清楚），但退路已从提示词里删掉。
//   · 校验 snapshotGate()：写完用代码查快照有没有真跟上。可代码校验的锚点是【进度章号】——
//     快照里必须有「进度：已写到第 NNN 章」，NNN 对不上最高章号就是没更新，当批退回自纠一轮。
//     正常情况零额外模型开销，跟 pacingGate 完全一个路子。

import fs from 'node:fs';
import path from 'node:path';

export const SNAP_MARK = 'LEDGER_HISTORY_BELOW';
export const SNAP_TITLE = '📌 当前态快照';
const MARK_LINE = `<!-- ${SNAP_MARK} ——以下是历史增量原文，只追加、不修改；写作时不会读这里 -->`;

const LEDGER = 'continuity_ledger.md';
function ledgerPath(dir) { return path.join(dir, LEDGER); }
function readOr(p, fb = '') { try { return fs.readFileSync(p, 'utf8'); } catch { return fb; } }

// 结构检测。**必须按"行"匹配，不能用 includes 做子串检测。**
//
// 实测「梦中学风水」：模型某次写作时把结构【说明】写成了台账里的一句引用——
//   > **写作前只读下面这一段「📌 当前态快照」；`<!-- LEDGER_HISTORY_BELOW -->
// 它从没真建过那个段，但两个关键词都出现在这句话里，includes 检测全中。
// 于是 splitLedger 从这句话切开，把「标题 + 这句说明」共 143 字符当成快照，
// 喂了这本 120 章的书每一批——比走"喂台账尾部"的兜底还差。
// 所以判据收紧为：标记必须是【独占一行】的 HTML 注释，快照标题必须是【独立的标题行】。
const RE_MARK_LINE = /^[^\S\n]*<!--[^\n]*LEDGER_HISTORY_BELOW[^\n]*-->[^\S\n]*$/m;
const RE_SNAP_HEAD = /^#{2,3}[^\S\n]*📌[^\S\n]*当前态快照[^\S\n]*$/m;

export function hasStructure(text) {
  const s = String(text || '');
  return RE_MARK_LINE.test(s) && RE_SNAP_HEAD.test(s);
}

// 拆成 {snapshot, history}。snapshot = 标记行及以上（就是真正会被喂进上下文的那一段）。
export function splitLedger(text) {
  const s = String(text || '');
  if (!hasStructure(s)) return { snapshot: '', history: s, ok: false };
  const m = s.match(RE_MARK_LINE);
  const mk = m.index;
  const eol = s.indexOf('\n', mk);
  return {
    snapshot: eol >= 0 ? s.slice(0, eol + 1) : s,
    history: eol >= 0 ? s.slice(eol + 1) : '',
    ok: true,
  };
}

// 快照骨架。空的——内容由模型填，代码只保证【位置和锚点在】。
// 「进度」那一行是给代码校验用的锚点，格式不能随便改（snapshotGate 靠它判断快照有没有过期）。
function skeleton({ roster = false } = {}) {
  return [
    `## ${SNAP_TITLE}`,
    '',
    '> 这一段是【写作时唯一会被读进上下文的部分】，必须永远代表最新状态。',
    '> 每批写完【就地改写本段】（改写，不是往下追加）：变了的改掉、了结的移走、新增的加进来，保持精简。',
    '> 详细增量另追加到下方历史区。快照过期 = 后面每一章都在照着旧状态写。',
    '',
    '- 进度：已写到第 000 章',
    '',
    `### 人物现状（含全部已出场姓名${roster ? '——本书配角临时起名，起了就永久沿用' : ''}，绝不改名、绝不串名）`,
    '-',
    '',
    '### 未回收伏笔 / 待查',
    '-',
    '',
    '### 欠债与承诺',
    '-',
    '',
    '### 伤势 / 状态 / 关键物件去向',
    '-',
    '',
    '### 时间线锚点',
    '-',
    '',
    MARK_LINE,
  ].join('\n');
}

// 纯代码迁移：把已有台账整体降为历史区，顶部插入快照骨架。幂等——已有结构直接返回。
// 不调模型、不丢一个字（原文全部保留在历史区）。
export function ensureStructure(dir, book = {}, { roster = false } = {}) {
  const p = ledgerPath(dir);
  const raw = readOr(p, null);
  if (raw == null) return { ok: false, reason: 'no-ledger' };
  if (hasStructure(raw)) return { ok: true, migrated: false };

  // 保留原文件的一级标题行当文件头，其余【原样】沉到历史区。
  // 注意不要 split(/\r?\n/).join('\n')——那会把整个几百 KB 的历史区 CRLF 全改成 LF，
  // 等于整份台账在 git 里变成一次全文改写，既看不出真正的改动，也谈不上"一字未动"。
  const firstNl = raw.indexOf('\n');
  const firstLine = (firstNl >= 0 ? raw.slice(0, firstNl) : raw).replace(/\r$/, '');
  const keepTitle = /^#\s/.test(firstLine);
  const title = keepTitle ? firstLine : `# 《${book.title || path.basename(dir)}》连贯性台账（${LEDGER}）`;
  const rest = (keepTitle && firstNl >= 0 ? raw.slice(firstNl + 1) : raw).replace(/^[\r\n]+/, '');

  const out = `${title}\n\n${skeleton({ roster })}\n\n## 历史增量（写作不读，供自检/追溯用）\n\n${rest}`;
  fs.writeFileSync(p, out, 'utf8');
  return { ok: true, migrated: true, bytesBefore: Buffer.byteLength(raw), bytesAfter: Buffer.byteLength(out) };
}

// 新建书直接铺带结构的台账（scaffold 用）。
export function freshLedger(book, { roster = false, body = '' } = {}) {
  const title = `# 《${book.title}》${roster ? '人物名册' : '连贯性台账'}（${LEDGER}）`;
  return `${title}\n\n${skeleton({ roster })}\n\n## 历史增量（写作不读，供自检/追溯用）\n\n${body}`;
}

// —— 校验锚点 ——
const RE_PROGRESS = /进度[：:]\s*已写到第\s*(\d{1,4})\s*章/;
export function progressOf(snapshot) {
  const m = String(snapshot || '').match(RE_PROGRESS);
  return m ? parseInt(m[1], 10) : -1;
}

// 就地改写快照里的进度锚点行。给【引擎代记台账】的写作路径用（网页版/API 直连：
// 模型只吐正文、不碰台账，进度行没人改，快照会永远显示过期）。找不到锚点行就原样返回——
// 不硬插，那种情况多半是半成品结构，交给 snapshotGate 走重新合成。
export function setProgress(snapshot, n) {
  const s = String(snapshot || '');
  if (!RE_PROGRESS.test(s)) return s;
  return s.replace(/^.*进度[：:]\s*已写到第\s*\d{1,4}\s*章.*$/m, `- 进度：已写到第 ${String(n).padStart(3, '0')} 章`);
}

// 快照除掉骨架自带的说明行/空条目后，还剩多少实质内容。用来判"建了结构但一个字没填"。
function substanceOf(snapshot) {
  return String(snapshot || '')
    .split(/\r?\n/)
    .filter(l => !/^\s*$/.test(l) && !/^\s*>/.test(l) && !/^\s*#/.test(l) && !/^\s*-\s*$/.test(l) && !/^\s*<!--/.test(l))
    .filter(l => !RE_PROGRESS.test(l))
    .join('\n').trim().length;
}

// 「快照实际是空的」的判定门槛。硬锚点是进度章号，这条只兜底"结构建了但一个字没填"，
// 所以按书的长度缩放而不是取一个固定值：刚开篇的书当前态本来就一两句话说得完，
// 写到几十上百章还只有两行，那一定是没填。
function minSubstance(maxChapter) {
  if (maxChapter >= 20) return 200;
  if (maxChapter >= 5) return 80;
  return 40;
}

// 写后快照闸：查快照有没有真的跟上这一批。返回 {ok, instruction?}——instruction 非空即未过。
// 与 pacingGate 同构：代码只量、不改，改由模型就地做（快照内容是语义的，代码写不出来）。
export function snapshotGate(dir, maxChapter, onLog = () => {}, { book = {} } = {}) {
  const raw = readOr(ledgerPath(dir), null);
  if (raw == null) return { ok: true, skipped: 'no-ledger' };
  if (!hasStructure(raw)) return { ok: false, reason: 'no-structure', instruction: seedInstruction(book, maxChapter) };

  const { snapshot } = splitLedger(raw);
  const prog = progressOf(snapshot);
  const sub = substanceOf(snapshot);
  const stale = prog >= 0 && maxChapter > 0 && prog < maxChapter;
  const empty = sub < minSubstance(maxChapter);
  const noAnchor = prog < 0;

  if (!stale && !empty && !noAnchor) {
    onLog({ level: 'info', msg: `📌 快照闸通过（进度 ${prog} 章 / 实质 ${sub} 字）` });
    return { ok: true, progress: prog, substance: sub };
  }

  const why = [
    stale ? `进度停在第 ${prog} 章、实际已写到 ${maxChapter} 章` : '',
    empty ? `快照实质内容仅 ${sub} 字（近乎空）` : '',
    noAnchor ? '缺「进度：已写到第 NNN 章」锚点行' : '',
  ].filter(Boolean).join('；');
  onLog({ level: 'warn', msg: `📌 快照闸未过：${why}` });

  return {
    ok: false, progress: prog, substance: sub, why,
    instruction: refreshInstruction(book, maxChapter, why),
  };
}

// 日常刷新指令（快照已有结构，只是没跟上）。
function refreshInstruction(book, maxChapter, why) {
  return [
    `《${book.title || ''}》的 ${LEDGER} 顶部有一段「${SNAP_TITLE}」——`,
    `它是【下一批写作唯一会被读进上下文的内容】，其余历史区不会喂给作者。`,
    `现在这段快照没跟上：${why}。`,
    ``,
    `请【只做这一件事】，不要写新章：`,
    `1. 打开 ${LEDGER}，读顶部快照段，再读 ${SNAP_MARK} 标记以下【最近的】历史增量；必要时抽读最新几章正文。`,
    `2. 【就地改写】快照段（改写，不是追加），让它准确代表【写到第 ${maxChapter} 章为止】的最新状态：`,
    `   · 「进度」那一行改成「- 进度：已写到第 ${String(maxChapter).padStart(3, '0')} 章」（格式照旧，代码要读它）；`,
    `   · 人物现状：把全部已出场角色的姓名与当前处境过一遍，改掉变了的、补上新出场的（姓名务必与正文一致，绝不改名串名）；`,
    `   · 未回收伏笔/待查：已回收的移出并在历史区标了结，新埋的加进来；`,
    `   · 欠债与承诺、伤势/状态/关键物件去向、时间线锚点：同样只保留【当前】状态。`,
    `3. 快照要【精简】——它每批都会被完整喂进上下文，写成流水账就等于没压缩。来龙去脉留在历史区。`,
    `4. 不要动 ${SNAP_MARK} 标记以下的历史区已有内容，也不要删除标记行本身。`,
    `改完回报一句：快照已更新到第几章、改了哪几项。`,
  ].join('\n');
}

// 首次合成指令（老书迁移后，快照还是空骨架，要从历史区把当前态"收"出来）。
export function seedInstruction(book, maxChapter) {
  return [
    `《${book.title || ''}》的 ${LEDGER} 刚做过结构迁移：顶部新加了一段空的「${SNAP_TITLE}」骨架，`,
    `原有的全部台账内容【一个字没删】，都在 ${SNAP_MARK} 标记以下的历史区里。`,
    ``,
    `背景（重要）：以前每批写作只喂得进台账的【前 8000 字符】，也就是这本书开篇时的旧状态——`,
    `写到第 ${maxChapter} 章还在照着开头的账写。现在改成只喂顶部这段快照，所以这段快照必须准确。`,
    ``,
    `请【只做这一件事】，不要写新章：`,
    `1. 读 ${SNAP_MARK} 以下的历史区（重点读【靠后】的部分，越近越权威），再读 chapter_index.md 与最近 10–20 章正文。`,
    `2. 把「写到第 ${maxChapter} 章为止的当前状态」合成进顶部快照段的各小节：`,
    `   · 「- 进度：已写到第 ${String(maxChapter).padStart(3, '0')} 章」（格式照旧，代码要读它）；`,
    `   · 人物现状：全部仍在场的角色姓名 + 当前处境/立场/知道什么（历史区里已死、已退场的写明状态，别漏也别复活）；`,
    `   · 未回收伏笔 / 待查：只留【还没回收】的，已回收的不要搬上来；`,
    `   · 欠债与承诺、伤势/状态/关键物件去向、时间线锚点：同上，只要当前态。`,
    `3. 【精简优先】：这段每批都会整段进上下文，目标控制在 3000 字符以内；`,
    `   有冲突时以【靠后的历史区记录和最新章正文】为准——历史区早期内容多半已经过期。`,
    `4. 不要修改历史区任何已有内容，不要删除 ${SNAP_MARK} 标记行。`,
    `完成后回报：快照写了哪几节、覆盖到第几章、发现哪些前后矛盾（若有）。`,
  ].join('\n');
}

// 这本书需不需要【从历史区重新合成】一份快照。
//
// 判据不能只看"有没有结构"——实测「梦中学风水」台账 517 KB，模型在某次自检时照着提示词里的
// 文案自己建了半个结构（标记行和标题都在），但内容一个字没填、也没有进度锚点。
// 于是消费端命中快照分支、每批只喂进 143 字符的空壳，比走"喂尾部 8000 字符"的兜底还糟。
// 所以【假结构】必须和【没结构】一样被当成要迁移的对象。
// 注意：只是"进度落后"（内容合格、章号没跟上）不算——那由写后闸 snapshotGate 增量刷新即可，
// 不必兴师动众从头合成。
export function needsSeed(dir, maxChapter = 0) {
  const ins = inspect(dir);
  if (!ins.exists) return { need: false, why: 'no-ledger' };
  if (!ins.structured) return { need: true, why: 'no-structure' };
  if (ins.progress < 0) return { need: true, why: 'no-anchor' };
  if (ins.substance < minSubstance(maxChapter)) return { need: true, why: 'empty-snapshot' };
  return { need: false, why: 'ok' };
}

// 供 CLI/迁移脚本用的体检：这本书现在是什么状态。
export function inspect(dir) {
  const raw = readOr(ledgerPath(dir), null);
  if (raw == null) return { exists: false };
  const structured = hasStructure(raw);
  const { snapshot } = splitLedger(raw);
  return {
    exists: true, structured,
    bytes: Buffer.byteLength(raw), chars: raw.length,
    snapshotChars: snapshot.length,
    progress: structured ? progressOf(snapshot) : -1,
    substance: structured ? substanceOf(snapshot) : 0,
    // 没有结构时消费端实际喂进去的比例（就是这次要修的病）
    fedRatio: structured ? 1 : Math.min(1, 8000 / Math.max(1, raw.length)),
  };
}
