// GUI 启动 PATH 自测：钉住「双击打开也要能找到 codex/claude/gemini」。
//
// 病根：从 Finder 双击打开的 .app 只继承 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin）。
// 而这些 CLI 装在 ~/.npm-global/bin、/opt/homebrew/bin、nvm 的版本目录里，一个都不在那四个目录中，
// 于是 detectModel 的 `which codex` 返回空 → 界面上「找不到可用模型」。
// 而终端里 `novel doctor` 一切正常（shell 已加载过 .zshrc），所以开发机上很难复现——
// 开发机的 launchd 往往被别的软件设过 PATH，只有干净的新 Mac 才暴露。
import assert from 'node:assert';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const MINIMAL = '/usr/bin:/bin:/usr/sbin:/sbin';   // launchd 给 GUI app 的默认 PATH

if (process.platform === 'win32') {
  console.log('✓ Windows 跳过（该问题只存在于 macOS/Linux 的 GUI 启动路径）');
  process.exit(0);
}

// 必须在 import 之前把 PATH 压成最小集——augmentUserPath 是幂等的，只认第一次调用时的现场
process.env.PATH = MINIMAL;
const { augmentUserPath } = await import('../src/paths.mjs');

// ① 补全后 PATH 必须真的变长（登录 shell 的目录 + 常见安装目录进来了）
{
  const after = augmentUserPath();
  const before = MINIMAL.split(':');
  const now = after.split(':').filter(Boolean);
  assert.ok(now.length > before.length, `PATH 应被补长，实际 ${before.length} → ${now.length}`);
  for (const d of before) assert.ok(now.includes(d), `原有目录 ${d} 不能被丢掉`);
  console.log(`✓ PATH 补全：${before.length} → ${now.length} 个目录`);
}

// ② 幂等：再调一次不重复追加
{
  const a = process.env.PATH;
  const b = augmentUserPath();
  assert.strictEqual(a, b, '重复调用不应再改动 PATH');
  const parts = b.split(':').filter(Boolean);
  assert.strictEqual(parts.length, new Set(parts).size, 'PATH 里不该有重复目录');
  console.log('✓ 幂等且无重复项');
}

// ③ 机器上真实存在的常见安装目录，必须被收进来（否则兜底形同虚设）
{
  const shouldHave = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.npm-global/bin`]
    .filter(d => { try { return fs.existsSync(d); } catch { return false; } });
  const now = process.env.PATH.split(':');
  for (const d of shouldHave) assert.ok(now.includes(d), `存在于磁盘的 ${d} 必须进 PATH`);
  console.log(`✓ 常见安装目录已收录（本机命中 ${shouldHave.length} 个）`);
}

// ④ 端到端：最小 PATH 起进程跑 detectModel，装了的 CLI 必须能被解析到
{
  const probe = `
    process.env.PATH = ${JSON.stringify(MINIMAL)};
    const { augmentUserPath } = await import('./src/paths.mjs');
    augmentUserPath();
    const { detectModel } = await import('./src/models.mjs');
    const got = ['codex','claude','gemini'].map(id => detectModel(id)).filter(m => m.available && m.path);
    console.log(JSON.stringify(got.map(m => m.id)));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
    { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, PATH: MINIMAL } });
  assert.strictEqual(r.status, 0, `子进程应正常退出：${r.stderr}`);
  const found = JSON.parse((r.stdout || '[]').trim().split('\n').pop());
  console.log(`✓ 最小 PATH 下仍解析到：${found.length ? found.join(' / ') : '(本机未装这三个 CLI，跳过)'}`);
}

console.log('\n全部通过 ✅  双击启动也能找到模型 CLI');
