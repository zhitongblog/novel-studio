// 静态资源缓存自测：钉住「改了前端，浏览器必须拿到新的」。
//
// 病根：serveStatic 一个缓存头都不发，浏览器按启发式缓存把 index.html / app.js 存下来。
// 于是改完前端，用户那边还跑着旧代码——表现成【点了按钮没反应】：发布弹窗在新 app.js 里
// 能正常打开（实测 openPublish 无异常、hidden 正常变 false），但用户浏览器加载的是缓存里的旧版。
// 这类 bug 在开发机上永远复现不出来，因为开发者总在强刷。
import assert from 'node:assert';
import net from 'node:net';
import { spawn } from 'node:child_process';

// 端口写死会被机器上任何一个占了该口的无关进程撞停（实测撞过一次，报成"测试服务未能启动"，
// 看着像产品坏了其实是环境噪音）。改成向内核要一个空闲口。
const PORT = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const srv = spawn(process.execPath, ['bin/novel.mjs', 'serve', '--port', String(PORT)], {
  cwd: process.cwd(), stdio: 'ignore', detached: false,
});
const base = `http://127.0.0.1:${PORT}`;

// 等服务起来
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(base + '/'); if (r.ok) { up = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 500));
}
assert.ok(up, '测试服务未能启动');

try {
  // ① 静态资源必须带 no-cache + ETag
  const r1 = await fetch(base + '/app.js');
  assert.strictEqual(r1.status, 200);
  const cc = r1.headers.get('cache-control') || '';
  const etag = r1.headers.get('etag') || '';
  assert.match(cc, /no-cache/, 'Cache-Control 必须是 no-cache（否则浏览器会拿旧代码）');
  assert.ok(etag.length > 0, '必须发 ETag，否则没法做 304 校验');
  console.log('✓ app.js 带 no-cache + ETag');

  // ② 带 If-None-Match 且没改动 → 304（省流量，同时保证内容是最新的）
  const r2 = await fetch(base + '/app.js', { headers: { 'If-None-Match': etag } });
  assert.strictEqual(r2.status, 304, '未改动时应返回 304');
  console.log('✓ 未改动 → 304');

  // ③ index.html 同样受保护
  const r3 = await fetch(base + '/');
  assert.match(r3.headers.get('cache-control') || '', /no-cache/, 'index.html 也必须 no-cache');
  console.log('✓ index.html 同样 no-cache');

  // ④ ETag 随内容变化：不同文件的 ETag 必须不同
  const r4 = await fetch(base + '/style.css');
  if (r4.ok) {
    assert.notStrictEqual(r4.headers.get('etag'), etag, '不同文件的 ETag 不能相同');
    console.log('✓ ETag 按文件区分');
  }

  console.log('\n全部通过 ✅  静态资源不会再喂旧代码');
} finally {
  try { srv.kill('SIGKILL'); } catch {}
}
