// 标签页卡死后的恢复自测。
//
// 现场（2026-09-14）：《天皇》277 章那批重发在第 54 章把 Unzoo 的标签页整个卡住——
// 之后连只读的 location.href 都 45s 超时。批次当场 paused，干等了 14 小时才被发现；
// 第二天原样续发，4 分钟内又栽在同一个卡死的 tab 上（0/225）。
// 一个标签页卡死不该报废整批 → evaluate 超时且【弹窗不是原因】时，关掉重建、回到原页面、再试一次。
//
// 另一条更要紧：重建【必须验证归属】。选中账号时若新标签页落在别的 profile 下，
// 后面每一章都会发到别人的书里——宁可这批停下，也不能发错号。
import assert from 'node:assert';
import test from 'node:test';
import { UnzooClient } from '../src/fanqie.mjs';

const PROF = 'C:\\Users\\Alex\\AppData\\Local\\Unzoo\\User Data\\Profile 3';

// 把 unzooCallTool 的行为塞进一个假的 daemon：记录每次调用，按剧本决定 evaluate 是否超时。
function mkClient({ evalPlan, tabsAfterCreate, profile = PROF }) {
  const calls = [];
  const client = new UnzooClient(profile, () => {});
  client.tabId = '100';
  client.lastUrl = 'https://fanqienovel.com/main/writer/chapter-manage/1?type=1';
  client.sleep = async () => {};
  // 直接替换掉底层调用：这是唯一和真 daemon 打交道的地方
  client.__calls = calls;
  const impl = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'browser_evaluate') {
      const verdict = evalPlan.shift();
      if (verdict === 'timeout') throw new Error('调用 browser_evaluate 超时(45s，页面可能卡住/弹窗阻塞)');
      return { result: 'OK' };
    }
    if (tool === 'tab_create') return { tab_id: 777 };
    if (tool === 'tab_list') return { tabs: tabsAfterCreate };
    return {};
  };
  return { client, calls, impl };
}

test('标签页卡死 → 关掉重建 → 同一账号下继续', async () => {
  const { client, calls, impl } = mkClient({
    evalPlan: ['timeout', 'timeout', 'ok'],
    tabsAfterCreate: [{ tab_id: 777, profile_path: PROF }],
  });
  client._call = impl;               // 注入底层调用，测的是源码里那个 recoverTab
  client.getActiveTab = async () => { client.tabId = null; };   // 本账号没有别的可用标签页
  const id = await client.recoverTab(client.lastUrl);
  assert.equal(id, '777', '应换到新标签页上');
  assert.ok(calls.some(c => c.tool === 'tab_close' && String(c.args.tab_id) === '100'), '卡死的那个必须关掉');
  assert.ok(calls.some(c => c.tool === 'tab_create'), '本账号没有别的标签页时才新建');
});

test('重建到了别的账号下 → 立刻关掉并中止，绝不发错号', async () => {
  const { client, calls, impl } = mkClient({
    evalPlan: [],
    tabsAfterCreate: [{ tab_id: 777, profile_path: 'C:\\Users\\Alex\\AppData\\Local\\Unzoo\\User Data\\Profile 1' }],
  });
  client._call = impl;               // 注入底层调用，测的是源码里那个 recoverTab
  client.getActiveTab = async () => { client.tabId = null; };   // 本账号没有别的可用标签页
  await assert.rejects(() => client.recoverTab('x'), /别的账号|发错号/);
  const closes = calls.filter(c => c.tool === 'tab_close').map(c => String(c.args.tab_id));
  assert.ok(closes.includes('777'), '误建到别的 profile 的标签页要关掉，不能留着');
  assert.notEqual(client.tabId, '777', '绝不能把 tabId 指到别的账号的标签页上');
});

test('本账号还有别的活标签页 → 复用，不新建', async () => {
  const { client, calls, impl } = mkClient({ evalPlan: [], tabsAfterCreate: [] });
  client._call = impl;               // 注入底层调用，测的是源码里那个 recoverTab
  client.getActiveTab = async () => { client.tabId = '200'; };   // 本账号还有一个活的标签页
  const id = await client.recoverTab('x');
  assert.equal(id, '200');
  assert.ok(!calls.some(c => c.tool === 'tab_create'), '有得复用就不该新建标签页');
});
