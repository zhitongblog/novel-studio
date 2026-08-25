// 番茄「编辑替换模式」自测：钉住三个把编辑模式打死的坑。
//
// ① 混批：publishBook 一次只能跑一条路径（editLoop / publishLoop）。原来混批时"以第一个章节的
//    mode 为准"，于是 edit 打头的批会把后面的新章也拿去 editLoop 里"找番茄上已存在的章"，
//    而新章在番茄根本不存在 → 连续 notFound → 整批卡死、新章一章没发。
// ② 只在第1卷找：番茄章节管理页一次只显示一个卷。原来永远开 &1、也不切卷，
//    多卷书里第2卷及以后的章"永远找不到" → 连续3次 notFound → 编辑模式直接停。
// ③ 翻页：原来靠可见页码取 max 当总页数（arco 出省略号会算漏），且翻页后固定 sleep 就读
//    （番茄 SPA 异步渲染，没渲染完就读 → 假 notFound）。
import assert from 'node:assert';
import { publishBook, FanqiePublisher } from '../src/fanqie.mjs';

// —— 假页面：模拟番茄章节管理页（多卷 + 分页 + 异步渲染延迟）——
// pages: { 卷序号: [[本页章号…], [下一页章号…]] }
class FakeClient {
  constructor({ pages, renderTicks = 0 }) {
    this.pages = pages;
    this.renderDelay = renderTicks;   // 每次导航/翻页后要多少次探测才渲染出数据行
    this.pending = 0;
    this.curVol = 1;
    this.curPage = 1;
    this.navigations = [];
  }
  get curPages() { return this.pages[this.curVol] || []; }
  async sleep() { /* 测试里不真等 */ }
  async navigate(url) {
    this.navigations.push(url);
    const m = String(url).match(/&(\d+)\s*$/);
    this.curVol = m ? parseInt(m[1], 10) : 1;
    this.curPage = 1;
    this.pending = this.renderDelay;
  }
  async evaluate(script) {
    const s = String(script);
    // waitChapterRows 的探针
    if (s.includes('快去创作')) {
      if (this.pending > 0) { this.pending--; return { hasRows: false, empty: false, currentPage: this.curPage, login: false, err: false }; }
      const rows = (this.curPages[this.curPage - 1] || []).length > 0;
      return { hasRows: rows, empty: !rows, currentPage: this.curPage, login: false, err: false };
    }
    // searchChapterInCurrentVolume 的 checkPage
    if (s.includes('hasNext')) {
      const target = parseInt((s.match(/var targetNum = (\d+);/) || [])[1], 10);
      const onPage = this.pending > 0 ? [] : (this.curPages[this.curPage - 1] || []);
      if (onPage.includes(target)) return { found: true };
      return { found: false, currentPage: this.curPage, hasNext: this.curPage < this.curPages.length };
    }
    return null;
  }
  async clickByLocator(body) {
    const b = String(body);
    if (b.includes('arco-pagination-item-next')) {
      if (this.curPage >= this.curPages.length) return false;
      this.curPage++; this.pending = this.renderDelay; return true;
    }
    if (b.includes("=== '1'")) { this.curPage = 1; this.pending = this.renderDelay; return true; }
    return false;
  }
}

function makePublisher(client, { fanqieVolumes = [], volumeIndex = 1 } = {}) {
  const p = new FanqiePublisher(client);
  p.config = { bookId: 'B1', fanqieVolumes, volumeIndex };
  p.currentVolPage = volumeIndex;
  p.onLog = () => {};
  return p;
}

// ① 混批必须被挡下，而不是"以第一个为准"把新章拖进 editLoop
{
  const r = await publishBook({
    bookId: 'B1',
    chapters: [
      { num: 5, title: '旧章', content: '甲', mode: 'edit' },
      { num: 9, title: '新章', content: '乙', mode: 'new' },
    ],
    onLog: () => {},
  });
  assert.strictEqual(r.ok, false, 'edit+new 混批必须直接失败');
  assert.match(r.error || '', /混了 edit 与 new/, '要说清是混批，让调用方拆成两次');
  assert.strictEqual(r.published, 0, '混批一章都不许发');
  console.log('✓ edit/new 混批被挡下（不再把新章拖进 editLoop 卡死）');
}

// 注：单一模式的批不在这里跑——那条路径会真的去驱动浏览器发布，不该出现在单测里。
// mode 闸只在 modes.size > 1 时触发，上面一条已经把回归钉住。

// ② 多卷：第2卷的章要能按 volumeText 切过去找到
{
  const client = new FakeClient({ pages: { 1: [[1, 2, 3]], 2: [[4, 5, 6]] } });
  const pub = makePublisher(client, { fanqieVolumes: ['第一卷：甲', '第二卷：乙'] });
  const r = await pub.searchForChapter(5, '第二卷：乙');
  assert.strictEqual(r.success, true, '第2卷的第5章必须找得到');
  assert.ok(client.navigations.some(u => u.endsWith('&2')), '要导航到第2卷的章节管理页');
  assert.strictEqual(client.curVol, 2);
  console.log('✓ 多卷书按章所属卷切卷后找得到（原来永远只在第1卷找）');
}

// ②b 卷名对不上时兜底扫全部卷
{
  const client = new FakeClient({ pages: { 1: [[1, 2]], 2: [[3, 4]], 3: [[5, 6]] } });
  const pub = makePublisher(client, { fanqieVolumes: ['甲', '乙', '丙'] });
  const r = await pub.searchForChapter(6, '不存在的卷名');
  assert.strictEqual(r.success, true, '卷名对不上也要靠全卷扫描找到');
  assert.strictEqual(client.curVol, 3);
  console.log('✓ 卷名对不上 → 全卷扫描兜底');
}

// ②c 真的没有这一章 → 报"全部N卷都没有"，而不是悄悄成功
{
  const client = new FakeClient({ pages: { 1: [[1, 2]], 2: [[3, 4]] } });
  const pub = makePublisher(client, { fanqieVolumes: ['甲', '乙'] });
  const r = await pub.searchForChapter(99, '甲');
  assert.strictEqual(r.success, false);
  assert.match(r.message || '', /全部 2 卷都没有/);
  console.log('✓ 全卷都没有 → 如实报错');
}

// ③ 分页：目标在第 7 页（arco 省略号场景下旧代码只会算到可见的最大页码而漏掉）
{
  const pages = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14]];
  const client = new FakeClient({ pages: { 1: pages } });
  const pub = makePublisher(client, { fanqieVolumes: [] });
  const r = await pub.searchForChapter(14);
  assert.strictEqual(r.success, true, '第7页的章必须翻得到（靠"下一页可用"翻，不靠 totalPages）');
  assert.strictEqual(client.curPage, 7);
  console.log('✓ 逐页翻到最后一页（不再被省略号算漏总页数）');
}

// ③b 异步渲染：翻页后要等真数据行渲染出来再判断，不能把"还没渲染"当"没有这一章"
{
  const client = new FakeClient({ pages: { 1: [[1, 2], [3, 4]] }, renderTicks: 3 });
  const pub = makePublisher(client, { fanqieVolumes: [] });
  const r = await pub.searchForChapter(4);
  assert.strictEqual(r.success, true, '渲染慢 3 拍也必须等到再判断，不能报假 notFound');
  console.log('✓ 异步渲染延迟不再导致假 notFound');
}

// ③c 登录失效/错误页是硬失败，要单独报，不能当成"这章不存在"去傻重试
{
  const client = new FakeClient({ pages: { 1: [[1]] } });
  client.evaluate = async (s) => (String(s).includes('快去创作')
    ? { hasRows: false, empty: false, currentPage: 1, login: true, err: false }
    : null);
  const pub = makePublisher(client, { fanqieVolumes: [] });
  const r = await pub.searchForChapter(1);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.fatal, true, '登录失效必须标 fatal，交给上层要人介入');
  console.log('✓ 登录失效/错误页 → fatal，不当成 notFound 空转');
}

console.log('\n全部通过 ✅  编辑模式：不混批、按卷切卷、翻页等渲染');
