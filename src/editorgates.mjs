// 写作过程中的「门」处理器（大纲审稿门 / 修订验证门 / 收尾 / 完本门 / 逐批审核）。
// 抽出来共享：startWriting(writer.mjs) 和 attachAutopilot(attach.mjs) 都用同一套 —— 否则【重挂/重启后的
// autopilot 会缺这些 handler，跨卷时卡在大纲审稿门不动】（历史 bug：attachAutopilot 只建了 onBatchReview）。
import path from 'node:path';
import { reviewOutline, buildReviseInstruction, buildProceedInstruction, buildRenudgeInstruction, buildRecheckRenudgeInstruction, recheckRevision, snapshotOutline, verifyRevision, reviewEnding, buildEndingRenudgeInstruction, parseReviewItems } from './editor.mjs';
import { buildFinaleInstruction, buildAfterwordInstruction } from './planner.mjs';
import { setPending, setReviewDefault } from './pending.mjs';
import { bookStats, getBook, setBookStatus, plannedVolumes, currentVolume, plannedTotalChapters, chaptersPerVol, participationOf } from './books.mjs';
import { runFinaleClosure } from './finale.mjs';

// 构建门处理器。slug/model/cfg/onLog 必填；book 可选（缺则按 slug 现读）。
// 返回 { onOutlineReady, onRevisionDone, finaleCheck, onFinaleReady, onBatchReview }（editorOff 时前四个为 undefined）。
export function buildGateHandlers({ slug, book = null, model, cfg, onLog = () => {} }) {
  const bk = () => getBook(slug) || book;
  const editorOff = cfg.editorReview?.enabled === false;
  // 大纲审稿【确认门】是否暂停，由该书的【参与度】决定（每次现读，可热切换）：
  //   auto → 不停(自动采纳修订)；volume/chapter → 停下等用户逐条挑。
  // 仍可用 cfg.editorReview.outlineApproval=false 全局关掉。
  const renudge = new Map();

  // —— 大纲审稿门：换主编无头审稿 → 拆成分条 → 挂起等用户逐条挑（无有效分条/审稿放行时不卡死，自动走原修订流程）。每 scope 只触发一次——
  const onOutlineReady = editorOff ? undefined : async (scope) => {
    try {
      const r = await reviewOutline({ book: bk(), scope, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'editor' }) });
      const items = r.passthrough ? [] : parseReviewItems(r.critique);
      const outlineApprove = participationOf(bk()) !== 'auto' && cfg.editorReview?.outlineApproval !== false && cfg.editorReview?.requireApproval !== false;
      if (outlineApprove && items.length) {
        setPending(slug, { kind: 'outline', scope, file: r.file, critique: (r.critique || '').slice(0, 6000), items });
        onLog({ level: 'act', source: 'editor', kind: 'pending-review', scope, file: path.basename(r.file), msg: `⏸ 主编审稿：${items.length} 条意见待你逐条挑（${scope}）——采纳哪些由你定，选完才继续` });
        return '主编审稿意见已生成，请先暂停：不要改大纲、也不要写正文，等用户逐条确认要采纳哪些意见后再继续。';
      }
      // 关了确认门 / 审稿放行 / 没解析出分条 → 回退：自动按整份审稿修订（不卡死）。
      try { snapshotOutline(bk(), scope); } catch {}
      return buildReviseInstruction(bk(), scope, r.file);
    } catch (e) { onLog({ level: 'warn', msg: '大纲审稿失败：' + e.message, source: 'editor' }); return null; }
  };

  // —— 修订验证门：作者输出「【大纲已修订：xxx】」→ ①没改便宜重催；②改了则主编二次复审硬伤是否真解决，过了才放行 ——
  const maxNudge = cfg.editorReview?.maxRenudge ?? 2;
  const onRevisionDone = editorOff ? undefined : async (scope) => {
    const v = verifyRevision(bk(), scope);
    if (!v.hadSnapshot) return buildProceedInstruction(bk(), scope);
    if (!v.changed) {
      const n = (renudge.get(scope) || 0) + 1; renudge.set(scope, n);
      if (n > maxNudge) { renudge.delete(scope); onLog({ level: 'warn', msg: `大纲仍未见改动，已达重催上限 → 放行（请人工留意 ${scope}）`, source: 'editor' }); return buildProceedInstruction(bk(), scope); }
      onLog({ level: 'warn', msg: `大纲文件未见改动 → 第 ${n} 次要求作者真正修改`, source: 'editor' });
      return buildRenudgeInstruction(bk(), scope);
    }
    if (cfg.editorReview?.recheck === false) { renudge.delete(scope); onLog({ level: 'act', msg: `已核实大纲修订（改动：${v.changedFiles.join('、')}）→ 放行开写`, source: 'editor' }); return buildProceedInstruction(bk(), scope); }
    let rc;
    try { rc = await recheckRevision({ book: bk(), scope, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'editor' }) }); }
    catch (e) { renudge.delete(scope); onLog({ level: 'warn', msg: '复审失败（放行）：' + e.message, source: 'editor' }); return buildProceedInstruction(bk(), scope); }
    if (rc.pass) { renudge.delete(scope); onLog({ level: 'act', msg: `主编复审通过：硬伤已解决 → 放行开写`, source: 'editor' }); return buildProceedInstruction(bk(), scope); }
    const n = (renudge.get(scope) || 0) + 1; renudge.set(scope, n);
    try { snapshotOutline(bk(), scope); } catch {}
    if (n > maxNudge) { renudge.delete(scope); onLog({ level: 'warn', msg: `复审仍未过，已达上限 → 放行（请人工留意 ${scope}）`, source: 'editor' }); return buildProceedInstruction(bk(), scope); }
    onLog({ level: 'warn', msg: `主编复审未过：仍有硬伤未解决 → 第 ${n} 次退回作者`, source: 'editor' });
    return buildRecheckRenudgeInstruction(bk(), scope, rc.file);
  };

  // —— 完本策略：收尾入口判定 + 收束令 + 完本审稿 ——
  const finaleOn = cfg.finale?.enabled !== false;
  let finaleBatches = 0;
  const renudgeF = new Map();
  const finalePhase = () => {
    const b = bk();
    if (b?.status === '已完本') return 'done';
    if (b?.status === '收尾中') return 'finale';
    if (finaleOn && cfg.finale?.autoEnterLastVolume !== false) {
      const total = plannedTotalChapters(b);
      if (total > 0) {
        const lastVol = chaptersPerVol(b) || Math.ceil(total * 0.1);
        if (bookStats(b).chapters >= total - lastVol) return 'finale';
      }
    }
    return 'writing';
  };
  const finaleCheck = !finaleOn ? undefined : async () => {
    if (finalePhase() !== 'finale') return null;
    const b = bk();
    let first = false;
    if (b.status !== '收尾中') {
      try { setBookStatus(slug, '收尾中'); } catch {} first = true;
      const pv = plannedVolumes(b), cv = currentVolume(b), ch = bookStats(b).chapters;
      onLog({ level: 'act', msg: `已进入【收尾 / 完本冲刺】阶段（卷${cv}${pv ? '/' + pv : ''}，第${ch}章）`, source: 'finale' });
    }
    finaleBatches++;
    const cap = cfg.finale?.maxFinaleBatches || 30;
    if (finaleBatches > cap) {
      onLog({ level: 'warn', msg: `收尾已 ${finaleBatches} 批仍未完本 → 要求立即收束`, source: 'finale' });
      return `收尾批次已偏多，请【立即】把当前所有未了线索快速但合理地收束，写出大高潮与结局，务必在本批或下一批内完成并输出「【完本待审】」，不要再拖延铺陈。`;
    }
    return buildFinaleInstruction(b, { first });
  };
  const onFinaleReady = !finaleOn ? undefined : async () => {
    const b = bk();
    const done = (text) => {
      try { setBookStatus(slug, '已完本'); } catch {}
      if (cfg.finale?.autoClosure !== false) {
        const delay = cfg.finale?.closureDelayMs ?? 120000;
        const b0 = bk();
        if (b0?.publish?.profilePath && b0?.publish?.bookId) {
          onLog({ level: 'act', source: 'fanqie', msg: `已标记【已完本】。约 ${Math.round(delay / 1000)} 秒后自动完结收口（把尾声/完本感言发齐到番茄并对账）；也可在「📤发布番茄→完结收口」手动触发。` });
          setTimeout(() => { runFinaleClosure(bk() || b0, { cfg, onLog: (e) => onLog({ ...e }) }).catch(() => {}); }, Math.max(0, delay)).unref?.();
        }
      }
      return { text, stop: true };
    };
    if (cfg.finale?.reviewEnding === false) { onLog({ level: 'act', msg: '已完本（未开完本审稿）', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
    let rc;
    try { rc = await reviewEnding({ book: b, cfg, authorModel: model, onLog: (e) => onLog({ ...e, source: 'finale' }) }); }
    catch (e) { onLog({ level: 'warn', msg: '完本审稿失败 → 放行标完本：' + e.message, source: 'finale' }); return done(buildAfterwordInstruction(b)); }
    if (rc.pass) { onLog({ level: 'act', msg: '完本审稿通过 → 标记【已完本】', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
    const n = (renudgeF.get('完本') || 0) + 1; renudgeF.set('完本', n);
    if (n > (cfg.finale?.maxRenudge ?? 2)) { onLog({ level: 'warn', msg: '完本审稿仍未过，已达上限 → 标完本（请人工把关结局）', source: 'finale' }); return done(buildAfterwordInstruction(b)); }
    onLog({ level: 'warn', msg: `完本审稿未过 → 第 ${n} 次退回补写结局`, source: 'finale' });
    return { text: buildEndingRenudgeInstruction(b, rc.file), stop: false };
  };

  // —— 逐批审核（半自动写作模式）：审核模式下每写够 N 批就停下等用户裁决 ——
  const onBatchReview = async ({ n, defaultText }) => {
    const b = bk();
    const chapters = (() => { try { return bookStats(b).chapters; } catch { return 0; } })();
    setReviewDefault(slug, defaultText);
    setPending(slug, { kind: 'batch-review', scope: `已写到第 ${chapters} 章 · 第 ${n} 批`, n, chapters });
    onLog({ level: 'act', source: 'autopilot', kind: 'pending-batch', n, chapters,
      msg: `⏸ 本批已写完（已到第 ${chapters} 章），待你审核：批准继续 / 按要求继续 / 停止` });
    return '本批已写完。请【暂停】：先不要写下一批，也不要改大纲，等用户审核当前内容并下达下一步要求后再继续。';
  };

  return { onOutlineReady, onRevisionDone, finaleCheck, onFinaleReady, onBatchReview };
}
