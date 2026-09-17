// 「代理该不该开」不能写死在代码里，只能记住"上次什么配置真的成功过"。
//
// 血泪：09-13 实测 agy【直连通、挂代理被 Google 按地区拒】，我就把"agy 不用代理"写进代码；
// 09-15 同一台机器正好反过来（直连 Eligibility check failed…userinfo: EOF、挂代理正常），
// 《穿成王莽后》那个窗口每一轮都失败，autopilot 又只会催"继续"，几个小时一个字没写。
// 代理是节点轮换的，"哪种配置能用"本来就会变——写死必然过期，所以要：
//   ① 按模型记住上次成功的模式；② 失败像网络问题就把代理翻过来再试一次。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksNetworkFailure, getNetMode, rememberNetMode } from '../src/planner.mjs';

test('两天里那两句真实报错，都要认成"网络/地区"这一类', () => {
  const geo = 'error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.';
  const eof = 'Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF';
  const auth403 = 'Failed to authenticate. API Error: 403 Request not allowed';
  for (const [s, tag] of [[geo, '地区被拒'], [eof, '连不上'], [auth403, '403']]) {
    assert.ok(looksNetworkFailure(s), `${tag} 这句该被认出来，否则不会触发翻转重试`);
  }
});

test('模型正常的中文回答不该被当成网络失败（免得白翻一次）', () => {
  const ok = '[{"title":"我能看见万物回报率","premise":"绑定回报率视界的失业青年陆凡…"}]';
  assert.ok(!looksNetworkFailure(ok));
});

test('记住的模式要能存下来、读回来，并且可以改', () => {
  const f = path.join(os.homedir(), '.novel-studio', 'netmode.json');
  let backup = null;
  try { backup = fs.readFileSync(f, 'utf8'); } catch {}
  try {
    rememberNetMode('__测试模型__', 'proxy');
    assert.equal(getNetMode('__测试模型__'), 'proxy');
    rememberNetMode('__测试模型__', 'direct');
    assert.equal(getNetMode('__测试模型__'), 'direct', '网络翻过来之后，记住的模式也要能跟着翻');
    assert.equal(getNetMode('__从没跑过的模型__'), null, '没记录就返回 null，交给配置决定');
  } finally {
    // 把测试写进去的键清掉，别污染真配置
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      delete m['__测试模型__'];
      fs.writeFileSync(f, JSON.stringify(m, null, 2), 'utf8');
    } catch {}
    if (backup !== null) { try { fs.writeFileSync(f, backup, 'utf8'); } catch {} }
  }
});
