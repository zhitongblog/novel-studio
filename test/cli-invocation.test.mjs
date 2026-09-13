// 一次性调用 CLI（立项起书名 / 推荐文风 / 写简介）的参数摆法自测。
//
// 作者报的现象只有一句：「生成失败：AI 返回未能解析为书名候选，请重试或换模型」。
// 真因是两件毫不相干的事，都藏在 runModelOnce 里：
//   ① args = ['-p', prompt] 却同时开着 shell:true —— shell 下 Node 只把 argv 拼成命令行、不转义，
//      整段中文提示词被空格切碎，agy 回一句 `Error: unexpected argument "3".` 就退出；
//      这句报错被当成"模型的回答"拿去解析 JSON，于是报"解析不了"。
//   ② 引擎给子进程注入了代理，Google 按出口 IP 判地区 →
//      `FAILED_PRECONDITION (code 400): User location is not supported for the API use.`
//      同一台机器直连是通的。同样被当成"回答"。
// 两条都只能靠"看懂报错"发现，所以这里既钉参数摆法，也钉失败特征识别。
import assert from 'node:assert';
import test from 'node:test';
import { planCliInvocation, detectCliFailureForTest } from '../src/planner.mjs';

const PROMPT = '你是资深网文主编。请据下面的题材，生成 3 个适合该题材的中文网文书名，各配一句话简介。\n题材：都市';

test('agy：prompt 进 argv，且绝不能过 shell', () => {
  const r = planCliInvocation('agy', PROMPT, 'C:\\Users\\Alex\\AppData\\Local\\agy\\bin\\agy.exe');
  assert.deepEqual(r.args, ['-p', PROMPT]);
  assert.equal(r.viaStdin, false, 'agy 的 -p 是带参数的，不从 stdin 读');
  assert.equal(r.useShell, false, 'prompt 在 argv 里，开 shell 就会被空格切碎');
});

test('铁律：只要 prompt 在 argv 里，任何 bin 形态都不许开 shell', () => {
  for (const bin of ['agy', 'C:\\x\\agy.exe', 'C:\\x\\agy.cmd', '']) {
    const r = planCliInvocation('agy', PROMPT, bin);
    assert.equal(r.useShell, false, `bin=${bin} 时仍不该开 shell`);
  }
});

test('claude：prompt 走 stdin；bin 是真 .exe 就不必过 shell', () => {
  const r = planCliInvocation('claude', PROMPT, 'C:\\Users\\Alex\\.local\\bin\\claude.exe');
  assert.deepEqual(r.args, ['-p']);
  assert.equal(r.viaStdin, true);
  assert.equal(r.useShell, false);
});

test('gemini/qwen：npm 壳没有扩展名，必须过 shell 才跑得起来', () => {
  const r = planCliInvocation('gemini', PROMPT, 'C:\\Users\\Alex\\AppData\\Roaming\\npm\\gemini');
  assert.deepEqual(r.args, ['-p']);
  assert.equal(r.useShell, true, 'npm shim 不过 shell 在 Windows 上起不来');
});

test('codex：子命令 + stdin', () => {
  const r = planCliInvocation('codex', PROMPT, 'D:\\home\\alex\\.npm-global\\codex');
  assert.equal(r.args[0], 'exec');
  assert.equal(r.viaStdin, true);
  assert.equal(r.useShell, true);
});

test('地区被拒 / 参数没传对，都要认成"跑失败"，不许当成模型的回答', () => {
  const geo = 'error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.';
  const bad = 'Error: unexpected argument "3".\nPrompts are read only from -p/--print, -i/--prompt-interactive, or stdin';
  for (const [raw, tag] of [[geo, '地区'], [bad, '参数']]) {
    const f = detectCliFailureForTest(raw, PROMPT);
    assert.ok(f, `${tag}那条应判为失败，实际 null —— 它会被当成书名 JSON 去解析`);
    assert.ok(f.why && f.why.length, '失败原因要说人话');
  }
});

test('正常的中文回答不许被误判成失败', () => {
  const ok = '[{"title":"我能看见万物回报率","premise":"绑定回报率视界的失业青年陆凡，从旧货地摊一步步撬动千亿风投，在都市红尘中玩转财富法则。"}]';
  assert.equal(detectCliFailureForTest(ok, PROMPT), null);
});
