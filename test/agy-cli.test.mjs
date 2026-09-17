// 接 Google Antigravity 的 CLI（命令名 agy）自测。
//
// 实测 agy 1.1.27（2026-09-10）与已有几家的三处不同，每一处不处理都会静默变成"看着可用、一跑就废"：
//   ① 装在 %LOCALAPPDATA%\agy\bin\agy.exe，【默认不进 PATH】（要另跑 `agy install`）
//      → where/which 找不到 → 界面上报"不可用"，用户明明装了却选不到，也看不出为什么。
//   ② -p/--print 是【带参数】的（不带就报 flag needs an argument: -p），不像 claude/gemini 从 stdin 读
//      → 照 stdin 那套喂它只会拿回一屏 usage 帮助，而那玩意会被 cleanSynopsis 洗成"简介"存进书里。
//   ③ 未登录时吐 "Authentication required. Please visit the URL to log in: https://accounts.google.com/..."
//      → 原来的失败特征只认 authentication failed / please log in，对不上 → 当成模型的回答收下去。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODELS, detectModel, resolveBin } from '../src/models.mjs';
import { writeLaunchScript } from '../src/writer.mjs';

console.log('— 模型条目 —');
const m = MODELS.agy;
assert.ok(m, 'MODELS 里要有 agy');
assert.strictEqual(m.bin, 'agy');
assert.deepStrictEqual(m.seedArgs('写第一批', {}), ['--dangerously-skip-permissions', '-i', '写第一批'],
  '默认带免审批 + -i 进交互（-i 后面跟初始指令）');
assert.deepStrictEqual(m.seedArgs('写第一批', { agySkipPermissions: false }), ['-i', '写第一批'],
  'agySkipPermissions=false 时去掉免审批');
console.log('✓ seedArgs：默认 --dangerously-skip-permissions + -i <指令>，可关');

console.log('— 装了但不在 PATH 也要认出来 —');
const d = detectModel('agy');
if (d.available) {
  console.log(`✓ 检测到：${d.path}${d.viaFallback ? '（靠兜底路径，PATH 里没有）' : '（PATH）'}`);
  if (d.viaFallback) {
    assert.strictEqual(resolveBin('agy'), d.path, '兜底找到的必须用绝对路径去 spawn，否则窗口只会打印"不是内部或外部命令"');
    console.log('✓ resolveBin 返回绝对路径');
  }
} else {
  console.log('  (本机没装 agy，跳过检测断言)');
}

console.log('— PATH 里有的仍用命令名 —');
for (const id of ['codex', 'gemini', 'qwen']) {
  const dd = detectModel(id);
  if (dd.available && !dd.viaFallback) {
    assert.strictEqual(resolveBin(id), MODELS[id].bin,
      'where 能找到的一律用命令名：npm 装的 shim 在 Windows 上无扩展名，靠 PATHEXT 才解析到 .cmd，' +
      '拿 where 报的那个无扩展名路径去 spawn 反而跑不起来');
    console.log(`✓ ${id} 仍用命令名`);
  }
}

console.log('— 启动脚本 —');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-agy-'));
try {
  const p = writeLaunchScript({ dir, title: '测试书' }, 'agy', '写第一批 3 章', { enableProxy: false });
  const txt = fs.readFileSync(p, 'utf8');
  assert.ok(txt.includes("'-i','写第一批 3 章'") || txt.includes("'-i'"), '初始指令要进 $seed');
  if (detectModel('agy').viaFallback) {
    assert.ok(/&\s*'[A-Za-z]:\\.*agy\.exe'\s+@seed/.test(txt),
      '不在 PATH 时启动行必须是带引号的绝对路径（路径可能含空格）');
    console.log('✓ 启动行用带引号的绝对路径');
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log('\n全部通过 ✅  agy 接上了（装了但没配 PATH 也能用）');
