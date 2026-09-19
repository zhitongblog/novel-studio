// 大纲重建的执行器：分批跑逐章摘要 → 按卷生成分章大纲。
// 可断点续、可增量、漏章会重试。绝不碰正文。
//
// 为什么要分批而不是一次喂全书：见 outlinerebuild.mjs 顶部——
// 《大乾女帝》523 章 145 万字，"通读全书"是做不到的事，
// 而现有指令第一步就是这么写的，所以它只能读个开头往下编。

import { runModelOnceAsync } from './editor.mjs';
import {
  listChapters, listVolumes, loadDigests, missingDigests, recordDigests,
  buildDigestPrompt, parseDigestLines, digestProgress,
  buildVolumeOutlinePrompt, volumeDigestText, saveVolumeOutline,
} from './outlinerebuild.mjs';

// 一批多少章：章数越多越省调用次数，但 prompt 越长越容易把 CLI 撑坏
//（gemini 就是这么废的）。12 章 × 每章截 4000 字 ≈ 5 万字，claude 扛得住。
const BATCH = 12;

export async function buildAllDigests(book, { model, cfg, onLog = () => {}, control = {}, batch = BATCH } = {}) {
  const todo = missingDigests(book);
  if (!todo.length) { onLog({ level: 'act', msg: `逐章梗概已齐（${listChapters(book).length} 章），跳过` }); return { done: 0, already: true }; }
  onLog({ level: 'act', msg: `开始做逐章梗概：还差 ${todo.length} 章，每批 ${batch} 章，约 ${Math.ceil(todo.length / batch)} 次调用（可随时停，已完成的会留下）` });
  let done = 0, failed = 0;
  for (let i = 0; i < todo.length; i += batch) {
    if (control.stopped) { onLog({ level: 'warn', msg: `已停止，本次完成 ${done} 章（下次从这里接着跑）` }); break; }
    const group = todo.slice(i, i + batch);
    const nums = group.map(c => c.num);
    const prompt = buildDigestPrompt(group);
    let got = {}, missing = nums;
    for (let attempt = 1; attempt <= 2 && missing.length; attempt++) {
      // 第二次只补漏掉的那几章——别把整批重跑一遍
      const g = attempt === 1 ? group : group.filter(c => missing.includes(c.num));
      const p = attempt === 1 ? prompt : buildDigestPrompt(g);
      try {
        const out = await runModelOnceAsync(model, p, cfg, cfg?.editorReview?.timeoutMs || 420000);
        const r = parseDigestLines(out, g.map(c => c.num));
        got = { ...got, ...r.got };
        missing = r.missing;
        if (missing.length && attempt === 1) onLog({ level: 'warn', msg: `第 ${nums[0]}–${nums[nums.length - 1]} 章：漏了 ${missing.join('、')} → 补跑` });
      } catch (e) {
        onLog({ level: 'warn', msg: `第 ${nums[0]}–${nums[nums.length - 1]} 章梗概失败：${e.message}` });
        break;
      }
    }
    // 【每批落盘】跑到一半断电，已完成的必须留下——523 章重来一遍代价太大
    const n = Object.keys(got).length;
    if (n) { recordDigests(book, got); done += n; }
    failed += missing.length;
    const p = digestProgress(book);
    onLog({ level: 'info', msg: `梗概进度 ${p.done}/${p.total}${missing.length ? `（本批漏 ${missing.length} 章，已记下，可再跑一次补上）` : ''}` });
  }
  return { done, failed, progress: digestProgress(book) };
}

export async function rebuildVolumeOutlines(book, { model, cfg, onLog = () => {}, only = null, control = {} } = {}) {
  const d = loadDigests(book);
  if (!Object.keys(d).length) throw new Error('还没有逐章梗概，先跑「逐章梗概」这一步');
  const vols = (only ? [only] : listVolumes(book));
  const files = [];
  for (const vol of vols) {
    if (control.stopped) break;
    const text = volumeDigestText(book, vol);
    const lines = text.split('\n').length;
    // 一卷太大就提醒——523 章全在卷01 这种情况（大乾女帝实况），
    // 生成出来会是 523 行的大纲，能用但说明这本书根本没分卷。
    if (lines > 120) onLog({ level: 'warn', msg: `${vol} 有 ${lines} 章——这一卷太大了（正常一卷 40–80 章），生成的大纲会很长；建议之后按剧情切分成几卷` });
    onLog({ level: 'act', msg: `据梗概生成 ${vol} 的分章大纲（${lines} 章）…` });
    try {
      const out = await runModelOnceAsync(model, buildVolumeOutlinePrompt(book, vol, text), cfg, cfg?.editorReview?.timeoutMs || 420000);
      const clean = String(out || '').trim();
      if (clean.length < 200) { onLog({ level: 'warn', msg: `${vol} 大纲返回过短，跳过（不覆盖已有文件）` }); continue; }
      const f = saveVolumeOutline(book, vol, clean);
      files.push(f);
      onLog({ level: 'act', msg: `${vol} 分章大纲已写入 ${f.split(/[\\/]/).pop()}` });
    } catch (e) { onLog({ level: 'warn', msg: `${vol} 大纲生成失败：${e.message}` }); }
  }
  return { files };
}
