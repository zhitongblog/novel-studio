// Phase 2：自动发布到番茄。
// 触发：autopilot 写到「目标章节数」时调用 maybeAutoPublish。
// 闸门：先跑【节奏+逻辑】自检(codex 无头)，过了才发；不过则暂缓并记日志，绝不带病发布。
import fs from 'node:fs';
import path from 'node:path';
import { runCliPrompt, stripCtrl } from './imagegen.mjs';
import { loadConfig } from './config.mjs';
import { loadPublishChapters, publishToFanqie } from './publish.mjs';

function readTrunc(p, max) {
  try { const t = fs.readFileSync(p, 'utf8'); return t.length > max ? t.slice(0, max) + '…' : t; } catch { return ''; }
}

// 节奏+逻辑质检门：读 设定圣经 + 最近几章正文，让 codex 无头判 PASS/FAIL。
// 返回 { pass:bool, reason, raw }。任何异常都按 pass:false（保守：宁可不发）。
export async function runQcCheck(book, { cfg, onLog = () => {} } = {}) {
  try {
    const dir = book.dir;
    const bible = readTrunc(path.join(dir, 'novel_bible.md'), 3000);
    const all = loadPublishChapters(book);
    const recent = all.slice(-4);   // 最近 4 章
    if (!recent.length) return { pass: false, reason: '没有可检查的章节' };
    const chapText = recent.map(c => `【${c.title}】\n` + (c.content || '').slice(0, 1800)).join('\n\n');
    const prompt =
`你是资深网文主编，做发布前终检。下面是《${book.title}》的设定与最近 ${recent.length} 章正文。
只判两件事：
1) 节奏：是否拖沓、爽点缺失、该快不快（会劝退读者）。
2) 逻辑：是否有前后矛盾、设定崩坏、硬伤。
判断标准从严但只挡"硬伤级"问题，文笔小瑕疵不算。
【只输出一行】：通过就输出 PASS；不通过就输出 FAIL: 原因(20字内)。不要任何其它内容。

=== 设定圣经(节选) ===
${bible}

=== 最近章节正文(节选) ===
${chapText}`;
    const model = book.model || cfg?.defaultModel || 'codex';
    onLog({ level: 'act', source: 'fanqie', msg: `自动发布前质检中（节奏+逻辑，${model} 无头）…` });
    const raw = stripCtrl(runCliPrompt(model, prompt, cfg, 150000) || '');
    // 找 PASS / FAIL（取最后一个明确判定，避免回显里的指令文字干扰）
    const matches = [...raw.matchAll(/\b(PASS|FAIL)\b\s*[:：]?\s*([^\n]*)/gi)];
    const last = matches.length ? matches[matches.length - 1] : null;
    if (!last) return { pass: false, reason: '质检无明确结论（保守暂缓）', raw: raw.slice(-200) };
    const pass = /pass/i.test(last[1]);
    const reason = (last[2] || '').trim().slice(0, 40);
    return { pass, reason: reason || (pass ? '通过' : '未过'), raw: raw.slice(-200) };
  } catch (e) {
    return { pass: false, reason: '质检异常：' + (e.message || e) };
  }
}

// 到达目标章数时调用：开了自动发布且配好账号 → 质检 → 过则发。
// 全程不抛错（autopilot 停机路径里调用，不能因发布失败影响写作收尾）。
export async function maybeAutoPublish(book, { cfg, onLog = () => {} } = {}) {
  try {
    const pc = book.publish || {};
    if (!pc.autoPublish) return { skipped: '未开启自动发布' };
    if (!pc.profilePath || !pc.bookId) {
      onLog({ level: 'error', source: 'fanqie', msg: '⚠️ 已开自动发布，但未配置番茄账号/书籍，已跳过。请在「📤发布番茄」里配置。' });
      return { skipped: '未配置账号/书籍' };
    }
    onLog({ level: 'info', source: 'fanqie', msg: `📦 《${book.title}》写满目标章数，开始自动发布流程…` });
    const qc = await runQcCheck(book, { cfg, onLog });
    if (!qc.pass) {
      onLog({ level: 'error', source: 'fanqie', msg: `⛔ 自动发布已暂缓：节奏/逻辑质检未过（${qc.reason}）。请人工核对修订后，用「📤发布番茄」手动发布。` });
      return { skipped: '质检未过', qc };
    }
    onLog({ level: 'info', source: 'fanqie', msg: `✅ 质检通过（${qc.reason}），开始发布到番茄…` });
    const r = await publishToFanqie(book, { onLog });
    return { published: true, qc, result: r };
  } catch (e) {
    onLog({ level: 'error', source: 'fanqie', msg: '自动发布异常：' + (e.message || e) });
    return { error: String(e.message || e) };
  }
}
