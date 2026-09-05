// 番茄读者评论抓取（P0）。
//
// 为什么要有这一层：整条链一直是【单向】的——写 → 复检 → 发布，读者的真实反馈一点回不来。
// 复检里那些判断（"反复踏同一格""103 章没人赢过陆舟""感情线几乎为零"）全是 AI 站在读者视角猜的；
// 评论区里是真读者在说话。这个模块把评论落盘，后续（P1/P2）按章聚合再喂回复检的「重点要求」。
//
// 【实地勘察结论，2026-09-05，lxd220 账号《岳飞：这一世，我不做忠臣》3440 条】
//   入口：https://fanqienovel.com/main/writer/comment-manage?type=0
//         （comment-manage/<bookId> 是 404——书只能在页内切，不能走 URL）
//   四个页签：章末讨论 / 段评 / 书圈 / 书评
//   容器：.comment-list → .comment-list-total（"章评数量 · N"）+ 若干 .comment-item
//   章节范围下拉（arco-select）：全部章节 / 最新3章 / 最新5章 / 最新10章
//   一条的原文长这样：
//     「李沧的修罗天尊」「打赏第十四名」评论了第290章 完本感言：写给岳飞，也写给你们 01-19
//     感谢作者写出了我的心声，我的意难平
//     0  0条回复  禁言 举报删除
//   整站是 Arco Design，和 publish.mjs 已经在驱动的是同一套组件库。
//
// 【最重要的一条纪律】默认筛选是「最新10章」。那本《岳飞》是完本，最新 10 章里只有 1 条评论——
// 也就是说对完本/老书，不切「全部章节」就等于什么都看不到，而页面不会报错、只会安静地给你一个近乎空的列表。
// 所以本模块：① 必切全部章节；② 页面自报总数 > 0 却一条都没解析出来时【必须抛错】，
// 绝不返回空数组让调用方以为"这本书没人评论"。今晚一整晚的教训都是同一个：静默失效比报错难查十倍。
import fs from 'node:fs';
import path from 'node:path';
import { UnzooClient } from './fanqie.mjs';

export const COMMENT_TABS = ['章末讨论', '段评', '书圈', '书评'];

// 把一条 .comment-item 的 innerText 拆成结构化字段。
// 单独拎出来是为了能【离线测】——抓取那半边要真浏览器，解析这半边不该也跟着不可测。
export function parseCommentItem(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  if (!text.trim()) return null;
  const flat = text.replace(/\s+/g, ' ').trim();

  // 「…评论了第N章 <章名> MM-DD」——章号是唯一能把评论挂回正文的锚点，抓不到就只能算书评/书圈
  const chap = flat.match(/评论了第\s*(\d+)\s*章\s*(.*?)\s+(\d{1,2}-\d{1,2}|\d{4}-\d{2}-\d{2}|\d+分钟前|\d+小时前|昨天|今天)/);
  const num = chap ? Number(chap[1]) : null;
  const chapterTitle = chap ? chap[2].trim() : '';
  const at = chap ? chap[3] : (flat.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}|\d+分钟前|\d+小时前|昨天|今天)/) || [])[1] || '';

  // 用户名 = 「评论了第N章」之前的那一段，里面还混着粉丝/打赏标签（"打赏第十四名""真爱粉"…）
  // 书评/书圈那几个页签没有「评论了第N章」这个锚点，头部就是第一行（含标签），得单独取。
  const TAG_RE = /打赏第[一二三四五六七八九十百千\d]+名|殿堂粉|真爱粉|铁杆粉|追更读者|作者赞过/g;
  const head = chap ? flat.slice(0, flat.indexOf('评论了第'))
    : (text.split('\n').map(l => l.trim()).filter(Boolean)[0] || '');
  const tags = head.match(TAG_RE) || [];
  let user = head;
  for (const t of tags) user = user.replace(t, '');
  user = user.trim();
  // 首行可能只是操作区（点赞数 / N条回复 / 禁言…），那不是用户名——清掉，好让下面的"啥都没有"判空生效
  if (/^\d+$/.test(user) || /^(禁言|举报删除|举报|删除|回复|\d+条回复)$/.test(user)) user = '';

  // 正文 = 去掉表头那行、再削掉行尾的操作区（点赞数 / N条回复 / 禁言 / 举报删除）
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const bodyLines = [];
  for (const l of lines) {
    if (/评论了第\s*\d+\s*章/.test(l)) continue;
    if (l === head) continue;                                            // 无章号时的头部行（用户名+标签）
    if (/^(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}|\d+分钟前|\d+小时前|昨天|今天)$/.test(l)) continue;  // 单独一行的日期
    if (/^\d+$/.test(l)) continue;                       // 单独一行的点赞数
    if (/^\d+条回复$/.test(l)) continue;
    if (/^(禁言|举报删除|举报|删除|回复)$/.test(l)) continue;
    bodyLines.push(l);
  }
  // 书评/书圈这类条目没有「评论了第N章」当锚点，头部信息拆不出来，用户名会原样留在第一行。
  // 启发式：首行短（≤20 字）、后面还有内容 → 那一行是用户名，不是正文。宁可保守，认不准就都留在正文里。
  if (!user && bodyLines.length >= 2 && bodyLines[0].length <= 20) {
    user = bodyLines.shift().trim();
  }
  let body = bodyLines.join('\n').trim();
  if (user && body.startsWith(user)) body = body.slice(user.length).trim();
  body = body.replace(/\s*\d+\s*\d+条回复\s*(禁言)?\s*(举报删除)?\s*$/, '').trim();

  const likes = Number((flat.match(/(\d+)\s+\d+条回复/) || [])[1] || 0);
  const replies = Number((flat.match(/(\d+)条回复/) || [])[1] || 0);
  if (!body && !user) return null;
  return { user, tags, num, chapterTitle, at, body, likes, replies, id: commentId({ user, num, at, body }) };
}

// 去重用的稳定 id：番茄没给评论 ID，只能拿「谁 + 哪章 + 什么时候 + 说了什么」做指纹。
// 同一个人在同一章同一天说两句不同的话 → 两条；刷新页面重复抓 → 同一条。
export function commentId({ user, num, at, body }) {
  const s = [user || '', num ?? '', at || '', (body || '').slice(0, 80)].join('');
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return 'c' + (h >>> 0).toString(36);
}

// 页面里那段 JS：把当前页签下的所有 .comment-item 连同自报总数一起取回来。
const HARVEST = `(function(){
  var list = document.querySelector('.comment-list');
  var totalTxt = (function(){ var e = document.querySelector('.comment-list-total'); return e ? (e.innerText||'').replace(/\\s+/g,' ').trim() : ''; })();
  var m = totalTxt.match(/·\\s*(\\d+)/);
  var items = Array.prototype.slice.call(document.querySelectorAll('.comment-item'))
    .filter(function(e){ return !/comment-item-header/.test(String(e.className)); })
    .map(function(e){ return e.innerText || ''; })
    .filter(function(t){ return t.trim(); });
  var pag = document.querySelector('[class*="arco-pagination"]');
  return JSON.stringify({
    hasList: !!list,
    total: m ? Number(m[1]) : null,
    totalTxt: totalTxt,
    items: items,
    book: (function(){
      var el = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(e){ return !e.children.length && /共收到评论数/.test(e.innerText||''); })[0];
      return el && el.parentElement ? (el.parentElement.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 80) : '';
    })(),
    pagination: pag ? (pag.innerText||'').replace(/\\s+/g,' ').slice(0,60) : null
  });
})()`;

async function evalJson(client, expr) {
  const r = await client.evaluate(expr);
  try { return JSON.parse(typeof r === 'string' ? r : JSON.stringify(r)); } catch { return null; }
}

// 切页签（章末讨论/段评/书圈/书评）。找不到就返回 false，由上层决定是报警还是跳过。
async function switchTab(client, tab) {
  const r = await client.evaluate(`(function(){
    var t = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(e){
      return !e.children.length && (e.innerText||'').trim() === ${JSON.stringify(tab)};
    })[0];
    if (!t) return 'no';
    (t.closest('[class*="tab"]') || t).click();
    return 'ok';
  })()`);
  return String(r).includes('ok');
}

// 把章节范围切成「全部章节」。默认是「最新10章」——完本书在那个默认下几乎看不到任何评论。
async function selectAllChapters(client, onLog) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.evaluate(`(function(){
      var t = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(e){
        return !e.children.length && /^(最新\\d+章|全部章节)$/.test((e.innerText||'').trim());
      })[0];
      if (t) (t.closest('[class*="arco-select"]') || t.parentElement || t).click();
      return 1;
    })()`);
    await client.sleep(1200);
    // 选项渲染在 portal 里，类名带 option/arco-select-option 都试
    const picked = await client.evaluate(`(function(){
      var o = Array.prototype.slice.call(document.querySelectorAll('[class*="option"],li,div')).filter(function(e){
        return !e.children.length && (e.innerText||'').trim() === '全部章节';
      })[0];
      if (!o) return 'no';
      (o.closest('[class*="option"]') || o).click();
      return 'ok';
    })()`);
    if (String(picked).includes('ok')) {
      await client.sleep(2500);
      // 【点了不等于切了】首版栽在这：click() 返回 ok，筛选器其实还停在「最新10章」，
      // 于是 3440 条的书只抓到 4 条，还一路报"完成"。
      // 第二版又栽了一次：回读时"任意一个文字是 全部章节 的元素"会命中【还展开着的下拉选项】本身，
      // 于是验证恒真。必须锁定 Arco 的【显示值】元素 .arco-select-view-value，并先把下拉收起来。
      await client.evaluate(`(function(){ document.body && document.body.click(); return 1; })()`);
      await client.sleep(600);
      const now = await client.evaluate(`(function(){
        var v = document.querySelector('.arco-select-view-value');
        if (v) return (v.innerText||'').trim();
        var t = Array.prototype.slice.call(document.querySelectorAll('[class*="select-view"]'))
          .map(function(e){ return (e.innerText||'').trim(); })
          .filter(function(x){ return /^(最新\\d+章|全部章节)$/.test(x); })[0];
        return t || 'unknown';
      })()`);
      if (String(now).includes('全部章节')) return true;
      onLog && onLog({ level: 'warn', msg: `点了「全部章节」但筛选器仍显示「${String(now).slice(0, 12)}」，重试…` });
    }
    await client.sleep(800);
  }
  onLog && onLog({ level: 'warn', msg: '⚠️ 没能把章节范围切到「全部章节」——默认是「最新10章」，完本/老书在这个默认下几乎抓不到评论，本次结果可能严重偏少' });
  return false;
}

// 抓一个页签下的全部评论。分页用 Arco 的分页器（和 publish.mjs 里同一套）；没有分页器就当单页。
async function harvestTab(client, tab, { maxPages = 60, onLog } = {}) {
  const seen = new Map();
  let selfTotal = null, book = '', pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const d = await evalJson(client, HARVEST);
    if (!d) { onLog && onLog({ level: 'warn', msg: `【${tab}】读页面失败（第 ${page} 页）` }); break; }
    if (!d.hasList) { onLog && onLog({ level: 'warn', msg: `⚠️【${tab}】页面上找不到 .comment-list —— 番茄很可能改版了，不是"没有评论"` }); break; }
    if (selfTotal == null) { selfTotal = d.total; book = d.book || ''; }
    for (const t of d.items || []) {
      const c = parseCommentItem(t);
      if (c) seen.set(c.id, { ...c, tab });
    }
    pages = page;
    // 下一页
    const next = await client.evaluate(`(function(){
      var n = document.querySelector('[class*="arco-pagination-item-next"]');
      if (!n) return 'nopag';
      if (/disabled/.test(String(n.className))) return 'end';
      n.click(); return 'ok';
    })()`);
    const s = String(next);
    if (s.includes('nopag') || s.includes('end')) break;
    await client.sleep(2000);
  }
  return { tab, book, selfTotal, pages, comments: [...seen.values()] };
}

// 抓一本书的评论并落盘。
// expectBook：期望的书名（片段）。页面上选中的不是这本就【直接报错】——
// 「切换作品」这一下在实测里并不总是点得动，抓错书写进另一本的 comments/ 是最难查的那类错。
export async function fetchBookComments({
  profilePath, slug, bookDir, expectBook = '', tabs = COMMENT_TABS, onLog = () => {},
} = {}) {
  if (!bookDir) throw new Error('缺少 bookDir');
  const client = new UnzooClient(profilePath || null, onLog);
  await client.navigate('https://fanqienovel.com/main/writer/comment-manage?type=0');
  await client.sleep(4000);

  const first = await evalJson(client, HARVEST);
  if (!first) throw new Error('评论页读不出来（Unzoo 没连上或页面没加载完）');
  if (expectBook && first.book && !first.book.includes(expectBook)) {
    throw new Error(`评论页当前选中的是「${first.book}」，不是「${expectBook}」——`
      + '请先在页面上切到这本书再抓（自动切换作品实测并不总是生效，宁可停下也不能把别人的评论写进这本书）');
  }
  onLog({ level: 'info', msg: `评论页：${first.book || '(读不到书名)'}` });

  await selectAllChapters(client, onLog);

  const all = [];
  const perTab = {};
  for (const tab of tabs) {
    if (!(await switchTab(client, tab))) { onLog({ level: 'warn', msg: `找不到页签「${tab}」，跳过` }); continue; }
    await client.sleep(2500);
    await selectAllChapters(client, onLog);
    const r = await harvestTab(client, tab, { onLog });
    perTab[tab] = { selfTotal: r.selfTotal, got: r.comments.length, pages: r.pages };
    all.push(...r.comments);
    onLog({ level: 'info', msg: `【${tab}】页面自报 ${r.selfTotal ?? '?'} 条，抓到 ${r.comments.length} 条（${r.pages} 页）` });
    // 【硬闸】页面自己说有、我们一条都没解析出来 → 一定是选择器失配，绝不能当"没有评论"咽下去
    if (r.selfTotal > 0 && r.comments.length === 0) {
      throw new Error(`【${tab}】页面自报 ${r.selfTotal} 条评论，却一条都没解析出来 —— 番茄的评论区结构变了，`
        + '解析器需要重新校准。这不是"没有评论"，别把空结果写进磁盘。');
    }
  }

  // 【两个数不是一回事，别拿来互相校验】实测《岳飞》：页头写"共收到评论数：3440条"，
  // 而筛选器已经是「全部章节」、页签也确实在切，列表就只有「章评数量 · 1」。
  // 结论：3440 是【书级历史累计】，"章评数量 · N" 才是这个后台视图当前能列出的条数。
  // 我一度拿 3440 去卡抓取结果（少于 10% 就抛错），那是误报——把正确结果也拦下了。
  // 真正该卡的是【每个页签自报 N 条、却一条都没解析出来】，那条闸在 harvestTab 之后已经有了。
  const claimed = Number((String(first.book || '').match(/共收到评论数[：:]\s*(\d+)/) || [])[1] || 0);
  const tabTotal = Object.values(perTab).reduce((s, t) => s + (t.selfTotal || 0), 0);
  if (claimed > 0) {
    onLog({ level: 'info', msg: `书级累计 ${claimed} 条（历史总数）；本视图各页签自报合计 ${tabTotal} 条，抓到 ${all.length} 条` });
  }
  // 页签自报合计明显多于抓到的 → 多半是分页没走完，值得提醒，但不至于把结果丢掉。
  if (tabTotal > 0 && all.length < tabTotal * 0.8) {
    onLog({ level: 'warn', msg: `⚠️ 页签自报合计 ${tabTotal} 条，只抓到 ${all.length} 条 —— 分页可能没走完，本次结果偏少` });
  }

  const dir = path.join(bookDir, 'comments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'comments.json');
  // 增量合并：老的留着（番茄列表会滚走），新的按 id 覆盖
  let old = [];
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')).comments || []; } catch {}
  const merged = new Map(old.map(c => [c.id, c]));
  let added = 0;
  for (const c of all) { if (!merged.has(c.id)) added++; merged.set(c.id, c); }
  const out = {
    slug, book: first.book || '', fetchedAt: new Date().toISOString(),
    perTab, total: merged.size, comments: [...merged.values()].sort((a, b) => (b.num || 0) - (a.num || 0)),
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  onLog({ level: 'act', msg: `评论已落盘：${path.relative(bookDir, file)}（本次新增 ${added} 条，累计 ${merged.size} 条）` });
  return { file, added, total: merged.size, perTab, book: out.book };
}
