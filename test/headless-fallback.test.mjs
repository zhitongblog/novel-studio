// 「放手让他写」时，模型跑不了无头就该【自动改用有窗口的模式】，而不是白跑一批再报错。
//
// 由来（作者原话）：「那我选择放手让他写时，你应该做的是唤起有头的模式运行啊」。
// 作者点的是"把书写出来"，不是"用无状态这条路写"——模式是实现细节，不该让他替工具擦屁股。
// 背景：agy 的交互模式能自动登录，但凭据【不落盘】，非交互 -p 每次都要人贴授权码（PKCE 绑进程，
// 后台无解）。所以 agy + 无状态 = 必然零产出，修多少次参数都没用，只能换模式。
import assert from 'node:assert';
import test from 'node:test';
import { canRunHeadless, getModel } from '../src/models.mjs';

test('agy 跑不了无头——这是换模式的依据，不是 bug', () => {
  assert.equal(canRunHeadless('agy'), false, 'agy 的凭据不落盘，-p 每次都要人贴授权码');
  const m = getModel('agy');
  assert.ok(m && typeof m.seedArgs === 'function', 'agy 仍然是可以开窗口跑的 CLI —— 换的是模式，不是把它禁掉');
});

test('本地 CLI（claude/codex/gemini）照旧走无头', () => {
  for (const id of ['claude', 'codex', 'gemini']) {
    assert.equal(canRunHeadless(id), true, `${id} 应该能无头跑`);
  }
});

test('网页版 / API 模型本来就不走 spawn，也算不能无头', () => {
  for (const id of ['web-qwen', 'api-zhipu']) {
    assert.equal(canRunHeadless(id), false, `${id} 不该被当成能无头跑的本地 CLI`);
  }
  // 这两类不能"自动改用窗口模式"——窗口模式要的是能在终端里跑起来的 CLI。
  // 它们各有自己的入口（网页版引擎 / API 写作），所以服务端对它们是明确报错、指路，不是静默换路。
  for (const id of ['web-qwen', 'api-zhipu']) {
    const m = getModel(id);
    assert.ok(m && (m.kind === 'web' || m.kind === 'api'), `${id} 的 kind 要能被服务端认出来，好把话说清楚`);
    assert.ok(typeof m.seedArgs !== 'function', `${id} 没有 seedArgs，本来就开不了窗口`);
  }
});

test('未知模型不当成能无头跑（宁可报错也别瞎跑）', () => {
  assert.equal(canRunHeadless('不存在的模型'), false);
});
