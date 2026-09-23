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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCliInvocation, detectCliFailureForTest, resolveGenModel } from '../src/planner.mjs';
import { trustAgyWorkspace } from '../src/models.mjs';

const PROMPT = '你是资深网文主编。请据下面的题材，生成 3 个适合该题材的中文网文书名，各配一句话简介。\n题材：都市';

test('agy：prompt 进 argv，且绝不能过 shell', () => {
  const r = planCliInvocation('agy', PROMPT, 'C:\\Users\\Alex\\AppData\\Local\\agy\\bin\\agy.exe');
  assert.deepEqual(r.args, ['--dangerously-skip-permissions', '-p', PROMPT]);
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
  assert.deepEqual(r.args, ['-p', '--dangerously-skip-permissions']);
  assert.equal(r.viaStdin, true);
  assert.equal(r.useShell, false);
});

test('gemini/qwen：npm 壳没有扩展名，必须过 shell 才跑得起来', () => {
  const r = planCliInvocation('gemini', PROMPT, 'C:\\Users\\Alex\\AppData\\Roaming\\npm\\gemini');
  assert.deepEqual(r.args, ['-p', '--yolo']);
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

test('元任务绝不能落到 agy 头上：它的凭据不落盘，-p 每次都要人贴授权码', () => {
  const picked = resolveGenModel('agy');
  assert.notEqual(picked, 'agy', '选了 agy 也要换成别的 CLI 去跑书名/简介');
  if (picked) assert.ok(['codex', 'gemini', 'qwen', 'claude'].includes(picked), `换成了意外的模型：${picked}`);
});

test('trustAgyWorkspace：写进去、且不重复写', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhome_'));
  const old = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  try {
    const dir = path.join(home, 'books', '某本书');
    assert.equal(trustAgyWorkspace(dir), true, '第一次应写入');
    assert.equal(trustAgyWorkspace(dir), false, '第二次应认出已存在、不重复写');
    const f = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(cfg.trustedWorkspaces, [path.resolve(dir)]);
  } finally {
    if (old === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = old;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('每个模型都必须自带免审批开关——无头模式弹不出审批框，弹了就是零产出', () => {
  // 作者现场：「a tool required the "command" permission that headless mode cannot prompt for,
  // so it was auto-denied」→「本批无产出，停止」→「无状态写作结束：共 1 批、新增 0 章」。
  const FLAGS = {
    claude: '--dangerously-skip-permissions',
    agy: '--dangerously-skip-permissions',
    gemini: '--yolo',
    qwen: '--yolo',
    codex: '--dangerously-bypass-approvals-and-sandbox',
  };
  for (const [id, flag] of Object.entries(FLAGS)) {
    const r = planCliInvocation(id, PROMPT, id === 'claude' ? 'x/claude.exe' : 'x/' + id);
    assert.ok(r.args.includes(flag), `${id} 少了免审批开关 ${flag}：实际 ${JSON.stringify(r.args)}`);
  }
});
