// 发布页切卷自测：钉住《重生东京》2026-09-13 那次"假缺卷"。
//
// 当时的现场：第311章发完 → 重新导航到发布页 → 卷名元素还没挂载 → readCurrentVolume 读到 ''
// → 点它等于没点、分卷模态没开 → 列表读到 0 项 → 判成「番茄该书没有卷第七卷：王座无冕」
// → needsIntervention 当场暂停，剩下 8 章一章没发。而同一分钟接口明明列着第七卷 31 章。
// 和"章节表没渲染完就判没这一章"是同一个病：拿【没渲染】当【不存在】。
//
// 现在的判据分三档：列表没渲染 = notReady(软重试)；接口有界面没有 = notReady；
// 列表真渲染了且接口也没有 = volume_missing(才允许暂停)。
import assert from 'node:assert';
import test from 'node:test';
import { FanqiePublisher } from '../src/fanqie.mjs';

class FakeClient {
  // headerTicks: 卷名元素要多少次探测才挂载出来；listTicks: 模态列表要多少次探测才渲染
  constructor({ current = '', volumes = [], headerTicks = 0, listTicks = 0, headerMissing = false } = {}) {
    this.current = current;
    this.volumes = volumes;
    this.headerTicks = headerTicks;
    this.listTicks = listTicks;
    this.headerMissing = headerMissing;
    this.modalOpen = false;
    this.opens = 0;
    this.confirmed = false;
  }
  async sleep() {}
  async evaluate(script) {
    const s = String(script);
    if (s.includes('publish-header-volume-name') && s.includes('has:')) {
      if (this.headerMissing) return { has: false, t: '' };
      if (this.headerTicks > 0) { this.headerTicks--; return { has: false, t: '' }; }
      return { has: true, t: this.current };
    }
    if (s.includes('editor-volume-list-item-normal')) {
      if (!this.modalOpen) return JSON.stringify([]);
      if (this.listTicks > 0) { this.listTicks--; return JSON.stringify([]); }
      return JSON.stringify(this.volumes);
    }
    return null;
  }
  async clickByLocator(body) {
    const b = String(body);
    if (b.includes('publish-header-volume-name')) { this.modalOpen = true; this.opens++; return true; }
    if (b.includes('targetText')) {
      const m = b.match(/const targetText = "([^"]*)"/);
      const want = m ? m[1] : '';
      return this.volumes.includes(want) ? true : null;
    }
    if (b.includes('确定')) { this.confirmed = true; this.current = this._picked || this.current; return true; }
    if (b.includes('取消')) { this.modalOpen = false; return true; }
    return null;
  }
}

function mk(client, fanqieVolumes = []) {
  const p = new FanqiePublisher(client);
  // 等待上限压到毫秒级：测的是判据，不是真的去等 15 秒
  p.config = { fanqieVolumes, volumeWaitMs: 60, volumeListWaitMs: 40 };
  p.onLog = () => {};
  return p;
}

test('已在目标卷：不开模态，直接通过', async () => {
  const c = new FakeClient({ current: '第七卷：王座无冕', volumes: ['第七卷：王座无冕'] });
  const r = await mk(c).switchToVolume('第七卷：王座无冕');
  assert.equal(r.ok, true);
  assert.equal(r.alreadyThere, true);
  assert.equal(c.opens, 0, '已经在目标卷就不该去点分卷');
});

test('卷名元素慢挂载：等出来以后照样识别为已在目标卷，不报缺卷', async () => {
  // 这就是东京那次的现场：导航后元素要几百毫秒才挂。旧代码在这一刻读到 '' 就去开模态了。
  const c = new FakeClient({ current: '第七卷：王座无冕', volumes: ['第七卷：王座无冕'], headerTicks: 5 });
  const r = await mk(c).switchToVolume('第七卷：王座无冕');
  assert.equal(r.ok, true, '慢渲染不该判失败');
  assert.equal(r.alreadyThere, true);
  assert.notEqual(r.found, false, '绝不能报成"番茄没有这个卷"');
});

test('卷名元素始终不出现：算页面没好(notReady)，不算缺卷', async () => {
  const c = new FakeClient({ headerMissing: true, volumes: ['第七卷：王座无冕'] });
  const r = await mk(c).switchToVolume('第七卷：王座无冕');
  assert.equal(r.ok, false);
  assert.equal(r.notReady, true);
  assert.notEqual(r.found, false, 'found===false 才会让上层暂停，这里不该是 false');
});

test('模态列表慢渲染：等出来就能切过去', async () => {
  const c = new FakeClient({ current: '第六卷：银幕无界', volumes: ['第七卷：王座无冕', '第六卷：银幕无界'], listTicks: 4 });
  const p = mk(c);
  c._picked = '第七卷：王座无冕';
  const r = await p.switchToVolume('第七卷：王座无冕');
  assert.equal(c.modalOpen, true);
  assert.equal(r.found, true);
});

test('接口有、界面列表里没有 → notReady（界面没刷新），不准报缺卷', async () => {
  const c = new FakeClient({ current: '第六卷：银幕无界', volumes: ['第六卷：银幕无界'] });
  const r = await mk(c, ['第七卷：王座无冕', '第六卷：银幕无界']).switchToVolume('第七卷：王座无冕');
  assert.equal(r.ok, false);
  assert.equal(r.notReady, true, '接口说有，就不能说番茄没有这个卷');
  assert.notEqual(r.found, false);
});

test('界面和接口都没有这个卷 → 才是真 volume_missing', async () => {
  const c = new FakeClient({ current: '第六卷：银幕无界', volumes: ['第六卷：银幕无界'] });
  const r = await mk(c, ['第六卷：银幕无界']).switchToVolume('第八卷：还没建');
  assert.equal(r.ok, false);
  assert.equal(r.found, false, '真缺卷必须 found:false，上层才暂停提示人工建卷');
  assert.ok(!r.notReady);
});

test('publishChapter：notReady 走软重试，不得 needsIntervention', async () => {
  const c = new FakeClient({ headerMissing: true, volumes: ['第七卷：王座无冕'] });
  const p = mk(c, ['第七卷：王座无冕']);
  p.config.matchVolumes = true;
  const r = await p.publishChapter({ title: '第312章 把分数亮出来的人', volumeText: '第七卷：王座无冕' });
  assert.equal(r.success, false);
  assert.ok(!r.needsIntervention, '页面没就绪不该直接暂停整批');
  assert.match(String(r.message), /还没就绪/);
});
