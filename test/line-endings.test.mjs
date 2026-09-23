// 源码换行符必须统一成 LF。
//
// 由来（2026-09-23）：我用 Python 文本模式写文件改代码，Windows 上它会把 \n 翻译成 \r\n
// ——不是只动我编辑的那几行，是【把整个文件的换行符规范化一遍】。
// 后果不是审美问题：review-valid.test.mjs 里一句 src.indexOf('\n}\n', i) 直接返回 -1，
// slice(i, -1) 把整个文件后半段当成了那个函数的函数体，于是别处的 rt.delete(slug)
// 被误判成它的，测试红了却指向一个完全无关的地方，查了很久。
//
// 混合换行还会让「按行切分源码做结构判断」的代码随机失效，而那类代码在这个仓库里有几十处。
// 与其每处都去兼容 \r\n，不如把源头摁住：这道闸红了，就说明有人（多半是我）又用会翻译
// 换行的方式写了文件——重新用 LF 写一遍即可。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOTS = ['src', 'test', 'ui', 'bin'];
const EXTS = /\.(mjs|js|css|html|json|md)$/i;

function collect() {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(p);
        continue;
      }
      if (EXTS.test(e.name)) out.push(p);
    }
  };
  for (const r of ROOTS) walk(path.join(ROOT, r));
  return out;
}

test('src/test/ui/bin 下的源码一律 LF，不许有 CRLF', () => {
  const files = collect();
  assert.ok(files.length > 50, '应扫到足量源码文件，实际 ' + files.length);
  const bad = [];
  for (const p of files) {
    const s = fs.readFileSync(p, 'utf8');
    const crlf = (s.match(/\r\n/g) || []).length;
    if (crlf) bad.push(path.relative(ROOT, p) + `（${crlf} 处 CRLF）`);
  }
  assert.deepEqual(bad, [],
    '这些文件混进了 CRLF——多半是用会翻译换行的方式写的（如 Python 文本模式）。\n' +
    '  重新以 LF 写一遍即可：把内容 .replace(/\r\n/g, "\n") 后写回。\n' +
    '  命中清单：\n    ' + bad.join('\n    '));
});

test('孤立的 \r 也不许有（老 Mac 换行，会让按行切分整段失灵）', () => {
  const bad = [];
  for (const p of collect()) {
    const s = fs.readFileSync(p, 'utf8');
    if (/\r(?!\n)/.test(s)) bad.push(path.relative(ROOT, p));
  }
  assert.deepEqual(bad, [], '含孤立 \r 的文件：' + bad.join(', '));
});
