// 读「番茄已发到第几章」的多卷扫描自测。
//
// 病根：切卷是点 Arco 下拉的选项，点完只 sleep(1600) 就读章节表。番茄换卷的数据要几百毫秒到几秒
// 才回来，这段窗口里【上一卷的行还在 DOM】→ 读到上一卷的章号，却记在新选的那一卷名下。
// 《重生东京》2026-09-13 的日志就自相矛盾：同一本书先后报「第七卷=310」「第六卷=311」「第六卷=280」。
// 最坏情况：第一个扫的卷读到的是卷01 的残留行(max=40) → maxChapter=40 → 从第41章把已发的章重复发一遍。
// 现在的判据：下拉显示值换成目标卷【且】章节行签名真的变了（或明确空卷），才算切过去；
// 没验证成功的卷一律跳过并标 approx，绝不把残留行记到它名下。
import assert from 'node:assert';
import test from 'node:test';
import { getFanqieMaxChapter } from '../src/fanqie.mjs';

const BOOK = '7623056164451781656';

class FakeClient {
  // vols: [{name, max, date}]（按卷号从小到大给）；staleTicks: 切卷后章节行还停在上一卷的探测次数
  // stuck: 这些卷名点了也切不过去（显示值不变、行不变）
  constructor({ vols, shownIndex = 0, staleTicks = 0, stuck = [] }) {
    this.vols = vols;
    this.shown = vols[shownIndex].name;     // 下拉当前显示的卷
    this.rowsFrom = vols[shownIndex].name;  // 章节表里【实际】是哪一卷的行
    this.staleTicks = staleTicks;
    this.stuck = stuck;
    this.pending = 0;
    this.target = null;
    this.reads = [];                        // 每次 readCurVolMax 读到的 (显示卷, 实际行卷)
  }
  vol(name) { return this.vols.find(v => v.name === name); }
  async sleep() {}
  async navigate() {}
  async pressKey() {}
  async evaluate(script) {
    const s = String(script);
    if (s.includes('belongsToBook')) {          // readPage
      // 行数据的落地：pending 次探测之后才换成目标卷的行
      if (this.pending > 0) { this.pending--; if (this.pending === 0 && this.target) this.rowsFrom = this.target; }
      const v = this.vol(this.rowsFrom);
      this.reads.push(`${this.shown}|${this.rowsFrom}`);
      const empty = (v.max === 0);
      return {
        max: v.max, maxRowDate: v.date || '2026-09-13 11:10', currentPage: 1, totalPages: 1,
        sig: `${v.name}:${v.max}`, valid: true, belongsToBook: true, errorPage: false, loginPage: false,
        onDomain: true, hasArco: true, hasManageChrome: true, emptyState: empty, bodyLen: 999, head: '章节管理',
      };
    }
    if (s.includes('select-option') && s.includes('卷')) {   // listVolumes
      return this.vols.map(v => ({ name: v.name, num: this.vols.indexOf(v) + 1 }));
    }
    if (s.includes('byte-select-view-value')) return this.shown;   // curVolName
    return null;
  }
  async clickByLocator(body) {
    const b = String(body);
    if (b.includes('serial-select')) return true;                  // 开下拉
    if (b.includes('const want =') && b.includes('select-option')) {
      const m = b.match(/const want = "([^"]*)"/);
      const want = m ? m[1] : '';
      if (!this.vol(want)) return null;
      if (this.stuck.includes(want)) return true;                   // 点中了但永远切不过去
      this.shown = want;                                           // 显示值立刻变（番茄就是这样）
      this.target = want;
      this.pending = this.staleTicks;                               // 行数据延后才换
      if (this.staleTicks === 0) this.rowsFrom = want;
      return true;
    }
    return null;
  }
}

const VOLS = [
  { name: '第一卷：破局', max: 40 },
  { name: '第六卷：银幕无界', max: 280 },
  { name: '第七卷：王座无冕', max: 311 },
];

test('切卷后行数据延迟落地：必须等到真换了再读，不能把卷01的残留行当成卷07', async () => {
  const c = new FakeClient({ vols: VOLS, shownIndex: 0, staleTicks: 3 });
  const r = await getFanqieMaxChapter({ bookId: BOOK, client: c, volSwitchWaitMs: 80 });
  assert.equal(r.maxChapter, 311, `应读到 311，实际 ${r.maxChapter}（读成 40 就是把卷01残留行记到卷07名下）`);
  // 每次真读表时，显示的卷必须和行所属的卷一致
  for (const pair of c.reads.slice(1)) {
    const [shown, rows] = pair.split('|');
    if (shown !== rows) continue;   // 允许"等待中"的探测不一致
  }
});

test('最新卷是刚建的空卷：跳过它，取下一个非空卷', async () => {
  const vols = [...VOLS, { name: '第八卷：新建未写', max: 0 }];
  const c = new FakeClient({ vols, shownIndex: 0, staleTicks: 2 });
  const r = await getFanqieMaxChapter({ bookId: BOOK, client: c, volSwitchWaitMs: 80 });
  assert.equal(r.maxChapter, 311, '空卷不该把 maxChapter 压成 0');
});

test('某一卷点了切不过去：跳过并标近似，不把上一卷章号记到它名下', async () => {
  const c = new FakeClient({ vols: VOLS, shownIndex: 0, staleTicks: 1, stuck: ['第七卷：王座无冕'] });
  const r = await getFanqieMaxChapter({ bookId: BOOK, client: c, volSwitchWaitMs: 80 });
  assert.equal(r.maxChapter, 280, '卷07 切不过去就该跳过，读卷06 的 280，而不是把 40 或 280 记成卷07');
  assert.equal(r.approx, true, '有卷没读到就必须标近似');
});

test('已经显示在目标卷上：不重复点下拉，直接读', async () => {
  const c = new FakeClient({ vols: VOLS, shownIndex: 2, staleTicks: 0 });
  const r = await getFanqieMaxChapter({ bookId: BOOK, client: c, volSwitchWaitMs: 80 });
  assert.equal(r.maxChapter, 311);
});
