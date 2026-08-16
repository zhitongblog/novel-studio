// 前端结构自测：钉住「HTML 标签必须闭合、关键弹窗必须是 body 的直接子元素」。
//
// 病根（今天真实踩到的）：往 index.html 插一段新 UI 时漏了一个 </div>，浏览器就把后面
// 所有内容都当成它的子元素——第 406 行的 #publishModal 被吞进了隐藏的「新建书」弹窗里。
// 结果：发布弹窗自己 display:flex、hidden 也去掉了，但父容器 display:none，尺寸 0×0，
// 用户点「发布」什么都不出来。
//
// 这种错最阴的地方是【不报错、不影响语法、开发者查弹窗自身状态时一切正常】——我当时就是
// 只看了弹窗自己的 class 说「能打开」，直到作者说「是无法进入那个操作页面」才去看父链。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'ui', 'index.html'), 'utf8');

// ① div 开闭配平——最直接的一条
{
  const open = (html.match(/<div\b[^>]*>/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;
  assert.strictEqual(open, close, `<div> ${open} 个但 </div> ${close} 个——有标签没闭合，会静默吞掉后面的界面`);
  console.log(`✓ div 配平（${open}/${close}）`);
}

// ② 其它容器标签也配平
{
  for (const tag of ['label', 'section', 'form', 'ul', 'table']) {
    const open = (html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.strictEqual(open, close, `<${tag}> ${open} 个但 </${tag}> ${close} 个`);
  }
  console.log('✓ label/section/form/ul/table 配平');
}

// ③ 关键弹窗必须是顶层的（不能嵌在别的 .modal 里）——嵌套了就会被父级的 hidden 连坐
{
  // 粗粒度但有效：统计每个 modal 起始标签之前的净嵌套深度，顶层 modal 的深度应该一致且最浅
  const MODALS = ['publishModal', 'modal', 'reviewModal', 'cowriteModal'];
  const depthOf = (id) => {
    const at = html.indexOf(`id="${id}"`);
    if (at < 0) return null;
    const before = html.slice(0, at);
    return (before.match(/<div\b[^>]*>/g) || []).length - (before.match(/<\/div>/g) || []).length;
  };
  const depths = {};
  for (const id of MODALS) { const d = depthOf(id); if (d !== null) depths[id] = d; }
  const vals = Object.values(depths);
  assert.ok(vals.length >= 2, '至少应找到两个弹窗');
  const min = Math.min(...vals);
  for (const [id, d] of Object.entries(depths)) {
    assert.strictEqual(d, min, `#${id} 的嵌套深度是 ${d}，其它顶层弹窗是 ${min}——它被套进别的容器里了`);
  }
  console.log('✓ 各弹窗同为顶层（' + Object.keys(depths).join('、') + '）');
}

// ④ app.js 能被解析（语法层兜底）
{
  const js = fs.readFileSync(path.join(process.cwd(), 'ui', 'app.js'), 'utf8');
  assert.doesNotThrow(() => new Function(js), 'app.js 语法错误');
  console.log('✓ app.js 可解析');
}

console.log('\n全部通过 ✅  前端结构完整');
