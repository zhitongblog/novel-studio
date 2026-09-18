// 「已完本」到底该由什么说了算。
//
// 病根：原来它只是【一次状态翻转】。writer.mjs 的 onFinaleReady 里，done() 先
// setBookStatus('已完本')，再把收尾指令扔出去并 stop:true——指令写没写、写成什么样，
// 无人检查。而那条收尾指令自己还写着「①【可选】写一章简短的《完本感言》…或写一段简短尾声」，
// 模型完全可以什么都不做。
//
// 更要命的是四条路里三条是"放行"：
//   · 完本审稿关掉      → 直接标完本
//   · 完本审稿抛异常    → "完本审稿失败 → 放行标完本"
//   · 退回 2 次仍不过   → "已达上限 → 标完本（请人工把关结局）"
// 只有 rc.pass 是真通过。于是"标完本"的门槛，实际上比"写完"低得多。
//
// 2026-09-18 的活证据《大乾女帝贴身神探》：9/4 标成已完本（当时 480 章），
// 之后又写了 45 章到 525；没有尾声、没有完本感言，第 525 章结尾是
// 「他已经带着魏忠原的尸身进了先帝陵」——纯悬念，正在开新线。
// 书挂着"已完本"的牌子，内容却在往下铺坑。
//
// 改法：完本不再是"模型说完了就完了"，而是【一组落盘可查的产物齐了才算完】。
// 产物没齐 → 继续要求补写，绝不标完本；补不出来 → 停在「收尾中」并把缺什么说清楚。
// 【宁可让书停在收尾中，也不能给没写完的书盖完本的章】——错标成完本的代价是
// 作者以为完事了，而番茄那边会按完本走签约/推荐流程。

import fs from 'node:fs';
import path from 'node:path';

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// 尾声/完本感言那一章，文件名或正文里会出现的词。
// 用词放宽是故意的：不同模型起名习惯不同（尾声/终章/大结局/完本感言/作者的话/后记都见过），
// 卡太死会把真写了的判成没写，反过来逼作者去手动标完本——那就等于没这道闸。
const AFTERWORD_WORDS = ['完本感言', '作者的话', '尾声', '后记', '全书完', '大结局', '终章'];

const chapNumOf = (f) => parseInt((path.basename(f).match(/^(\d{1,4})/) || [])[1] || '0', 10);

// 扫 chapters/ 下所有 .txt，找收尾章。返回 {ok, file, by}。
//
// 【必须带位置约束】只按词匹配会误判：实测《重生之我在岛国当天皇》全书 316 章，
// 第 074 章叫「春祭终章」——那是卷内的终章，不是全书尾声，却被判成"完本产物齐了"。
// 真正的收尾章一定在【全书最后几章】里。差得远的一律不算。
function findAfterword(dir, maxChapter = 0) {
  const root = path.join(dir, 'chapters');
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.txt')) continue;
      const byName = AFTERWORD_WORDS.find(w => e.name.includes(w));
      if (byName) { hits.push({ file: p, by: '章名含「' + byName + '」' }); continue; }
      // 章名没写，但正文开头/结尾点明了也算（模型常把"全书完"放在正文末尾）
      const txt = readSafe(p);
      if (!txt) continue;
      const head = txt.slice(0, 120), tail = txt.slice(-200);
      const byText = AFTERWORD_WORDS.find(w => head.includes(w) || tail.includes(w));
      if (byText) hits.push({ file: p, by: '正文含「' + byText + '」' });
    }
  };
  walk(root);
  if (!hits.length) return { ok: false };
  hits.sort((a, b) => chapNumOf(a.file) - chapNumOf(b.file));
  const last = hits[hits.length - 1];
  // 位置约束：命中的必须是【最后 3 章之内】。宽 3 章是为了容忍"结局→尾声→感言"这种连着写的收尾，
  // 但挡得住 316 章的书拿第 74 章的「春祭终章」来冒充全书尾声。
  if (maxChapter > 0) {
    const n = chapNumOf(last.file);
    if (n > 0 && maxChapter - n > 3) {
      return { ok: false, tooEarly: { file: last.file, n, maxChapter, by: last.by } };
    }
  }
  return { ok: true, file: last.file, by: last.by };
}

// 全书最高章号（按文件名前缀数字）——位置约束要用
function maxChapterOf(dir) {
  let max = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.toLowerCase().endsWith('.txt')) max = Math.max(max, chapNumOf(p));
    }
  };
  walk(path.join(dir, 'chapters'));
  return max;
}

// 这本书【真的写完了吗】——只看落盘的事实，不问模型。
// 返回 { ok, items:[{key,label,ok,detail}], missing:[label] }
export function finaleArtifacts(book) {
  const dir = book?.dir || '';
  const items = [];

  const maxCh = maxChapterOf(dir);
  const aw = findAfterword(dir, maxCh);
  items.push({
    key: 'afterword',
    label: '尾声 / 完本感言',
    ok: aw.ok,
    detail: aw.ok ? `${path.basename(aw.file)}（${aw.by}）`
      : aw.tooEarly
        ? `只找到第 ${aw.tooEarly.n} 章「${path.basename(aw.tooEarly.file)}」，而全书已到第 ${aw.tooEarly.maxChapter} 章——那是卷内终章，不是全书尾声`
        : '一章都没有',
  });

  const idx = readSafe(path.join(dir, 'chapter_index.md'));
  const idxOk = /全书完|全书完结|已完结/.test(idx);
  items.push({
    key: 'index',
    label: 'chapter_index.md 标注「全书完」',
    ok: idxOk,
    detail: idxOk ? '已标注' : (idx ? '没找到「全书完」' : '读不到 chapter_index.md'),
  });

  const bible = readSafe(path.join(dir, 'novel_bible.md'));
  const bibleOk = /【已完结】|已完结|全书完/.test(bible.slice(0, 1200));
  items.push({
    key: 'bible',
    label: 'novel_bible.md 顶部标注【已完结】',
    ok: bibleOk,
    detail: bibleOk ? '已标注' : (bible ? '顶部没找到【已完结】' : '读不到 novel_bible.md'),
  });

  const missing = items.filter(i => !i.ok).map(i => i.label);
  return { ok: missing.length === 0, items, missing };
}

// 缺什么，就只要求补什么——别把已经做好的再喊一遍（喊了模型可能重写，反而把好的搞坏）。
// 必须是【单行】：多行 prompt 会被 agent 当成多行草稿等人工回车。
export function buildFinaleFixInstruction(book, missing) {
  const todo = [];
  if (missing.includes('尾声 / 完本感言')) {
    todo.push('①【必写，不是可选】写完最后的大高潮与结局之后，再写一章《完本感言》或《尾声》（200–400字，真诚、不套路，谢读者、谈创作初衷与遗憾），按正常章节命名规则落进 chapters/ 对应卷目录');
  }
  if (missing.includes('chapter_index.md 标注「全书完」')) {
    todo.push('②在 chapter_index.md 末尾另起一行标注「全书完」，并写上总章数与约总字数');
  }
  if (missing.includes('novel_bible.md 顶部标注【已完结】')) {
    todo.push('③在 novel_bible.md 顶部标注【已完结】');
  }
  return (`《${book.title}》的完本收尾还差几样【实际产物】，现在补齐：` + todo.join('；') +
    `。⚠️这些是【落盘可查的硬要求】，不写就不算完本——不要只回复"已完成"，也不要只在台账里写"已收尾"而文件里没有。` +
    `全部做完后再输出一行「【完本待审】」。`).replace(/[\r\n]+/g, ' ');
}

// 给人看的一句话：这本书离真完本还差什么。
export function finaleSummary(book) {
  const r = finaleArtifacts(book);
  if (r.ok) return '完本产物齐了（尾声/完本感言、chapter_index 全书完、bible 已完结）';
  return '还差：' + r.missing.join('、');
}
