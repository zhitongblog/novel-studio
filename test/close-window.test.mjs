// 收窗自测：钉住「杀没杀掉要如实返回」。
//
// 病根：killProcess 在 Windows 上是 `try { spawnSync('taskkill', …); return true } catch { return false }`。
// spawnSync 不会因为 taskkill 失败而抛异常——失败只写进 status（128=找不到进程、1=权限不足），
// 于是【杀没杀掉都 return true】，closeWindow 跟着报成功，上层打出「已收起窗口」的日志。
// 实测后果：一次假成功就多留一个空窗口，下一批发现没有活会话又开一个——《重生94》同时开着
// bravo + charlie 两个窗口，作者问「你为什么开了两个 unterm 的窗口」才发现。
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { killProcess, processAlive } from '../src/unterm.mjs';

// ① 不存在的 pid → 必须返回 false（原来恒 true）
{
  assert.strictEqual(killProcess(999999), false, '杀不存在的进程应返回 false');
  assert.strictEqual(killProcess(null), false, 'pid 为空应返回 false');
  console.log('✓ 杀不掉时如实返回 false');
}

// ② processAlive 判活
{
  assert.strictEqual(processAlive(process.pid), true, '自己必须是活的');
  assert.strictEqual(processAlive(999999), false, '不存在的 pid 不该判活');
  assert.strictEqual(processAlive(null), false);
  console.log('✓ processAlive 判活正确');
}

// ③ 真起一个子进程再杀：返回 true 且进程确实没了
{
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 400));
  assert.ok(processAlive(child.pid), '前提：子进程已起来');

  const ok = killProcess(child.pid);
  await new Promise(r => setTimeout(r, 800));
  assert.strictEqual(ok, true, '杀掉真实进程应返回 true');
  assert.strictEqual(processAlive(child.pid), false, '杀完进程必须真的没了');
  console.log('✓ 杀真实进程 → 返回 true 且确实退出');
}

console.log('\n全部通过 ✅  收窗结果如实返回');
