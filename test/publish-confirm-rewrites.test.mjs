// 覆盖已发布章的「二次确认」闭环自测。
//
// 病根（作者实测踩到的）：src/publish.mjs 有一道闸——一次要 edit 覆盖的已发布章超过
// rewriteSyncLimit(默认3) 就中止，要求调用方带 confirmRewrites 放行。但 ui/app.js 里
// 发布请求【从来不传这个参数】，而预览又会把按钮点亮成「📤 同步 N 个重写章 ▶」。
// 于是《重生美利坚》这类整本重写过的书：按钮亮着、一点必被拦、指纹也不会刷新 → 永远发不出去，
// 且 UI 上没有任何别的路可走（republish 接口没有入口）。
//
// 这个文件钉死那条闭环：服务端要的放行参数，前端必须真的发得出来。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { rewriteSyncLimitOf } from '../src/publish.mjs';

const app = fs.readFileSync(path.join(process.cwd(), 'ui', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(process.cwd(), 'ui', 'index.html'), 'utf8');

// ① 阈值取法：默认 3、可 per-book 覆盖、脏值退回默认（预览与真发共用同一个函数，防两边漂）
{
  assert.strictEqual(rewriteSyncLimitOf({}), 3);
  assert.strictEqual(rewriteSyncLimitOf({ rewriteSyncLimit: 0 }), 0);
  assert.strictEqual(rewriteSyncLimitOf({ rewriteSyncLimit: 99 }), 99);
  assert.strictEqual(rewriteSyncLimitOf({ rewriteSyncLimit: 'NaN' }), 3);
  assert.strictEqual(rewriteSyncLimitOf(null), 3);
  console.log('OK 覆盖阈值：默认3 / 可覆盖 / 脏值不毒化');
}

// ② 发布请求必须能带上 confirmRewrites —— 少了它，超阈值的书 100% 发不出去
{
  const post = app.match(/api\('\/api\/book\/publish',\s*'POST',\s*\{[^}]*\}/);
  assert.ok(post, '找不到 /api/book/publish 的调用');
  assert.ok(/confirmRewrites/.test(post[0]), '发布请求没带 confirmRewrites：服务端的重写闸将永远拦死，且 UI 无路可走');
  console.log('OK 发布请求带 confirmRewrites');
}

// ③ 放行前必须先弹确认（覆盖线上不可逆，绝不能默默 true）
{
  assert.ok(/confirmRewrites = true/.test(app), '没有把 confirmRewrites 置真的分支');
  const at = app.indexOf('confirmRewrites = true');
  const before = app.slice(Math.max(0, at - 900), at);
  assert.ok(/confirm\(/.test(before), 'confirmRewrites 被无条件置真了——覆盖已发布章必须先问作者一句');
  console.log('OK 放行前有二次确认');
}

// ④ 阈值在弹窗里可配、且存得下来
{
  assert.ok(/id="pbRwLimit"/.test(html), '发布弹窗缺「覆盖确认阈值」输入框');
  assert.ok(/rewriteSyncLimit:\s*Math\.max/.test(app), 'pbCfg 没把 rewriteSyncLimit 存进发布配置');
  assert.ok(/#pbRwLimit'\)\.value =/.test(app), 'pbFill 没回填 rewriteSyncLimit');
  console.log('OK 阈值可配可存可回填');
}

console.log('全部通过 [OK]  覆盖已发布章的二次确认闭环');
