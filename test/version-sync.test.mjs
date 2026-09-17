// 四处版本号必须一起动。
//
// 病根：从来没有一起动过。每次发版只有人记得改 desktop/src-tauri/tauri.conf.json，
// 另外三处留在原地，于是越漂越远。2026-09-17 的实况是三个不同的值：
//   tauri.conf.json 1.11.2 / Cargo.toml 1.8.9 / Cargo.lock 1.8.9 / package.json 1.8.6
// 构建日志里 crate 报 "v1.8.9"，产出的安装包却叫 1.11.2——
// 出问题时「你装的是哪一版」这个问题根本答不上来。
//
// f18ac95c 手工对齐过一次（引擎 1.5.0 → 1.8.5）。没有工具兜着，几周后照样漂开。
// 所以这次补的不是"再对齐一次"，是【让它不可能再悄悄漂】：
// 一条命令改全部（bin/bump.mjs），加这条测试当闸——漂了就红。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkVersions, readVersions, setVersion } from '../bin/bump.mjs';

test('四处版本号必须一致——漂了就红，别等发版那天才发现', () => {
  const r = checkVersions();
  const detail = r.versions.map(v => `${v.file}=${v.version || '(没找到)'}`).join('\n  ');
  assert.ok(r.ok, `版本号不一致（${r.distinct.join(' / ')}）：\n  ${detail}\n  修：node bin/bump.mjs <版本号>`);
});

test('四处都要能被认出来——文件改结构了就得改 bump.mjs 的规则', () => {
  for (const v of readVersions()) {
    assert.ok(v.version, `${v.file} 里没认出版本号。改过结构？bin/bump.mjs 的正则要跟着改，否则它会静默漏掉这一处`);
    assert.match(v.version, /^\d+\.\d+\.\d+$/);
  }
});

test('bump 是【定点替换】，不重写文件——行尾和格式一个字节都不能动', () => {
  // 为什么这条重要：tauri.conf.json 用 JSON.parse+stringify 重写会把整个文件洗一遍。
  // 这次合并到 main 时 6 个文件全量冲突，病根就是 CRLF vs LF——每一行都被算成改动。
  // 版本号脚本要是也这么干，等于每次发版都埋一颗冲突雷。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsver-'));
  try {
    // 造一份【故意用 CRLF + 四空格缩进】的假工程
    const mk = (rel, body) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), body); };
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    mk('desktop/src-tauri/tauri.conf.json', crlf('{\n    "productName": "X",\n    "version": "1.0.0"\n}\n'));
    mk('desktop/src-tauri/Cargo.toml', crlf('[package]\nname = "novel-studio-desktop"\nversion = "1.0.0"\nedition = "2021"\n'));
    mk('desktop/src-tauri/Cargo.lock', crlf('[[package]]\nname = "serde"\nversion = "9.9.9"\n\n[[package]]\nname = "novel-studio-desktop"\nversion = "1.0.0"\n'));
    mk('package.json', crlf('{\n    "name": "novel-studio",\n    "version": "1.0.0"\n}\n'));

    setVersion('2.3.4', tmp);

    const conf = fs.readFileSync(path.join(tmp, 'desktop/src-tauri/tauri.conf.json'), 'utf8');
    assert.match(conf, /"version": "2\.3\.4"/);
    assert.ok(conf.includes('\r\n'), 'CRLF 必须原样保留——重写文件会把行尾洗成 LF，下次合并整文件冲突');
    assert.match(conf, /\n {4}"productName"/, '四空格缩进要原样保留，不能被 stringify 洗成两空格');

    const lock = fs.readFileSync(path.join(tmp, 'desktop/src-tauri/Cargo.lock'), 'utf8');
    assert.match(lock, /name = "novel-studio-desktop"\r\nversion = "2\.3\.4"/);
    assert.match(lock, /name = "serde"\r\nversion = "9\.9\.9"/, '依赖的版本号绝不能被顺手改掉');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('版本号格式不对要当场报错，不能写进文件', () => {
  assert.throws(() => setVersion('1.11'), /格式不对/);
  assert.throws(() => setVersion('v1.11.3'), /格式不对/);
  assert.throws(() => setVersion(''), /格式不对/);
});

console.log('\n全部通过 ✅  四处版本号一起动，漂了就红');
