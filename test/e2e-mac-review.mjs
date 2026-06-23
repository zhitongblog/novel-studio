// 真·端到端（macOS + claude）：开 Unterm 窗口 → 启动 claude → 逐批审核模式暂停 → 恢复。
// 直接驱动引擎(startWriting)，不经 HTTP；轮询 pending/continueCount 观察行为。带超时与清理。
import { loadConfig } from '../src/config.mjs';
import { createBook, deleteBook, setBookWriteMode, bookStats } from '../src/books.mjs';
import { startWriting } from '../src/writer.mjs';
import { stopBook } from '../src/attach.mjs';
import { hasPending, getPending, setResume, clearPending, getReviewDefault } from '../src/pending.mjs';

const cfg = loadConfig();
cfg.finale = { ...(cfg.finale || {}), enabled: false };   // 隔离测试：关收尾，专测「连载中」逐批审核门
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

let book;
function cleanup() {
  try { if (book) stopBook(book.slug); } catch {}
  try { if (book) deleteBook(book.slug, { deleteFiles: true }); } catch {}
}
process.on('SIGINT', () => { cleanup(); process.exit(1); });

try {
  // 1) 建一本极小的书（纯模板，无 AI），batch=1 章，开启逐批审核
  const title = '审核模式联调-' + Math.floor(performance.now());
  book = createBook({ title, genre: '测试·都市', model: 'claude', totalWords: '50万',
    volumes: '5', chaptersPerVolume: '20', batchSize: 1 }, cfg);
  setBookWriteMode(book.slug, 'review', 1);
  log('已建书', book.slug, 'dir=', book.dir);

  // 2) 给 claude 一个极小、能快速收尾的指令（写一章 ~80 字就停，避免长时间占用配额）
  const instruction = '这是连调测试。只做一件事：在 chapters/卷01/ 下新建文件 001试笔.txt，写约80字的都市开头正文（仅正文），写完即停，不要再问也不要继续写下一章。';
  const sess = await startWriting({
    book, model: 'claude', instruction, cfg,
    onLog: (e) => log('  ·', e.source || '-', e.msg || JSON.stringify(e)),
  });
  log('窗口已开 instance=', sess.instance.id, 'pane=', sess.paneId);

  // 3) 轮询：等 autopilot 命中“逐批审核”暂停（最多 240s）
  const deadline = performance.now() + 240000;
  let paused = false, dumps = 0;
  while (performance.now() < deadline) {
    if (hasPending(book.slug) && getPending(book.slug)?.kind === 'batch-review') { paused = true; break; }
    // 每 ~24s 抓一次屏幕尾部，便于诊断 claude 是否在写
    if (dumps++ % 12 === 0) {
      try {
        const scr = (await sess.mcp.screenText(sess.paneId)) || '';
        const tail = scr.split(/\r?\n/).filter(l => l.trim()).slice(-4).join(' ⏎ ');
        log('  [屏幕]', tail.slice(0, 200));
      } catch {}
    }
    await sleep(2000);
  }
  if (!paused) throw new Error('超时：未在 240s 内进入逐批审核暂停（看上面日志判断 claude 是否在写）');
  const ch = bookStats(book).chapters;
  log(`✅ 已进入逐批审核暂停：已写 ${ch} 章，pending=`, JSON.stringify(getPending(book.slug)));

  // 4) 模拟“批准并继续” → 验证 autopilot 恢复（注入续写、推进批次）
  const before = sess.autopilot.continueCount;
  setResume(book.slug, getReviewDefault(book.slug) || '继续');
  clearPending(book.slug);
  log('已发“批准并继续”，等 autopilot 恢复…');
  const d2 = performance.now() + 30000;
  let resumed = false;
  while (performance.now() < d2) {
    if (sess.autopilot.continueCount > before) { resumed = true; break; }
    await sleep(1500);
  }
  log(resumed ? `✅ 恢复成功：continueCount ${before} → ${sess.autopilot.continueCount}` : '⚠ 30s 内未观测到批次推进（可能 claude 仍在响应上一条）');

  log('\n结论：macOS 上 Unterm 窗口开启 + claude 启动 + 逐批审核暂停' + (resumed ? ' + 恢复 全部通过 ✅' : '（暂停已通过；恢复未在窗口内确认）'));
} catch (e) {
  log('❌ 失败：' + e.message);
} finally {
  log('清理：停窗口 + 删测试书…');
  cleanup();
  await sleep(1500);
  process.exit(0);
}
