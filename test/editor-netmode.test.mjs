// editor 这条路原来不会翻代理：2026-09-20 实测——
//   这台机器【直连出口在洛杉矶】，agy 跑得好好的；
//   而 cfg 里的 7897 代理【出口在新加坡】，Google 回 FAILED_PRECONDITION: User location is not supported。
// planner.runModelOnce 早就有"失败像网络问题就把代理翻过来再试一次"的协商，
// editor.runModelOnceAsync 却只认 cfg.enableProxy 挂上就完事 → 大纲重建/审稿/卷名生成
// （全走 editor）在这种网络下是零产出，而同一台机器上 planner 那条路能跑通。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNetMode } from '../src/editor.mjs';
import { looksNetworkFailure } from '../src/planner.mjs';

test('没有记录过成功模式时，跟随 cfg.enableProxy', () => {
  assert.deepEqual(planNetMode('agy', { enableProxy: true }, null), { proxyOn: true, mayFlip: true });
  assert.deepEqual(planNetMode('agy', { enableProxy: false }, null), { proxyOn: false, mayFlip: true });
  assert.deepEqual(planNetMode('agy', {}, null), { proxyOn: false, mayFlip: true });
});

test('记住的模式优先于 cfg——上次直连成功，这次就别再挂代理', () => {
  assert.equal(planNetMode('agy', { enableProxy: true }, 'direct').proxyOn, false);
  assert.equal(planNetMode('agy', { enableProxy: false }, 'proxy').proxyOn, true);
});

test('noProxyModels 里的模型强制直连，且不许翻转（显式配置不做协商）', () => {
  const p = planNetMode('agy', { enableProxy: true, noProxyModels: ['agy'] }, 'proxy');
  assert.deepEqual(p, { proxyOn: false, mayFlip: false });
});

test('没被显式配置的模型仍可翻转', () => {
  assert.equal(planNetMode('claude', { enableProxy: true, noProxyModels: ['agy'] }, null).mayFlip, true);
});

test('agy 的地区拒绝必须被认成"值得翻过来再试"的失败', () => {
  const real = 'error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.';
  assert.equal(looksNetworkFailure(real), true);
  // 正常回答不能被误判成网络失败，否则每次都要白跑一遍翻转
  assert.equal(looksNetworkFailure('1142'), false);
  assert.equal(looksNetworkFailure('1|岳飞在汤阴醒来|确立目标|钩子'), false);
});

test('各家 CLI 报网络失败的写法都不一样——claude 那句没有下划线，漏了就不会翻转重试', () => {
  // 2026-09-20 实测：claude CLI 报 `API Error: Unable to connect to API (ConnectionRefused)`，
  // 而当时正则里只有 ECONNREFUSED，于是这条没被认出来，翻转重试没触发，整批零产出。
  assert.equal(looksNetworkFailure('API Error: Unable to connect to API (ConnectionRefused)'), true);
  assert.equal(looksNetworkFailure('connect ECONNREFUSED 127.0.0.1:7897'), true);
  assert.equal(looksNetworkFailure('Connection reset by peer'), true);
  // 正常产出不许被误判——误判一次就要白跑一整轮翻转
  assert.equal(looksNetworkFailure('岳飞把炭条换到左手，右手在腿上搓了搓。'), false);
  assert.equal(looksNetworkFailure('1|穿越者李向东在汤阴醒来|确立目标|章末钩子'), false);
});
