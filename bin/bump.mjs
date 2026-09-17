#!/usr/bin/env node
// 一条命令改掉【全部四处】版本号。
//
// 为什么要有这个脚本：这四处从来没有一起动过——每次发版只有人记得改
// desktop/src-tauri/tauri.conf.json，另外三处留在原地，于是越漂越远。
// 2026-09-17 的实况：tauri.conf.json 1.11.2 / Cargo.toml 1.8.9 / Cargo.lock 1.8.9 /
// package.json 1.8.6，三个不同的值。构建日志里 crate 报 "v1.8.9"，产出的安装包却叫
// 1.11.2——出问题时"你装的是哪一版"这个问题根本答不上来。
// f18ac95c 手工对齐过一次（引擎 1.5.0 → 1.8.5），没有工具兜着，几周后照样漂开。
//
// 用法：node bin/bump.mjs 1.11.3     （或 npm run bump -- 1.11.3）
//       node bin/bump.mjs patch|minor|major
//       node bin/bump.mjs --check     只检查是否一致，不改（CI/测试用）
//
// 【只做定点替换，不重写文件】保留各文件原有的行尾与格式：
// tauri.conf.json 用 JSON.parse+stringify 重写会把整个文件的缩进/行尾洗一遍，
// 那正是这次合并时 6 个文件全量冲突的来源（CRLF vs LF 把每一行都算成改动）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

// 每处一条规则：文件 + 认出版本号的正则（第 1 组必须是版本号本身）。
// Cargo.lock 只改 novel-studio-desktop 那一条，绝不碰依赖的版本号。
const TARGETS = [
  { file: 'desktop/src-tauri/tauri.conf.json', re: /("version"\s*:\s*")([0-9]+\.[0-9]+\.[0-9]+)(")/ },
  // ⚠️行尾一律写成 \r?\n：这几个文件的行尾在这个仓库里【两种都出现过】
  // （main 归一成 LF，分支还是 CRLF，正是这次合并 6 个文件全量冲突的来源）。
  // 写死 \n 的话，碰上 CRLF 的那一份会【静默认不出来】——版本号漏改一处，又漂回去。
  { file: 'desktop/src-tauri/Cargo.toml', re: /(\[package\][\s\S]{0,200}?\r?\nversion\s*=\s*")([0-9]+\.[0-9]+\.[0-9]+)(")/ },
  { file: 'desktop/src-tauri/Cargo.lock', re: /(name = "novel-studio-desktop"\r?\nversion = ")([0-9]+\.[0-9]+\.[0-9]+)(")/ },
  { file: 'package.json', re: /("version"\s*:\s*")([0-9]+\.[0-9]+\.[0-9]+)(")/ },
];

export function readVersions(root = ROOT) {
  return TARGETS.map(t => {
    const full = path.join(root, t.file);
    let cur = null;
    try { cur = (fs.readFileSync(full, 'utf8').match(t.re) || [])[2] || null; } catch {}
    return { file: t.file, version: cur };
  });
}

// 四处是否一致？返回 { ok, versions, distinct }
export function checkVersions(root = ROOT) {
  const versions = readVersions(root);
  const found = versions.filter(v => v.version).map(v => v.version);
  const distinct = [...new Set(found)];
  return { ok: versions.every(v => v.version) && distinct.length === 1, versions, distinct };
}

function bumpOf(cur, kind) {
  const [a, b, c] = cur.split('.').map(Number);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

export function setVersion(next, root = ROOT) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(next)) throw new Error(`版本号格式不对：${next}（要 x.y.z）`);
  const changed = [];
  for (const t of TARGETS) {
    const full = path.join(root, t.file);
    const s = fs.readFileSync(full, 'utf8');
    const m = s.match(t.re);
    if (!m) throw new Error(`${t.file} 里没找到版本号——改过结构？规则要跟着改（bin/bump.mjs）`);
    if (m[2] === next) { changed.push({ file: t.file, from: m[2], to: next, touched: false }); continue; }
    // 定点替换：只换匹配到的那一处，文件其余部分（含行尾）原样不动
    fs.writeFileSync(full, s.slice(0, m.index) + m[1] + next + m[3] + s.slice(m.index + m[0].length));
    changed.push({ file: t.file, from: m[2], to: next, touched: true });
  }
  return changed;
}

// —— CLI ——
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = process.argv[2];
  if (!arg || arg === '--check') {
    const r = checkVersions();
    for (const v of r.versions) console.log(`  ${(v.version || '(没找到)').padEnd(10)} ${v.file}`);
    if (r.ok) { console.log(`\n✅ 四处一致：${r.distinct[0]}`); process.exit(0); }
    console.log(`\n❌ 版本号不一致：${r.distinct.join(' / ')}`);
    console.log('   修：node bin/bump.mjs <版本号>  （把四处一起对齐）');
    process.exit(arg === '--check' ? 1 : 0);
  }
  const cur = checkVersions().versions.map(v => v.version).filter(Boolean).sort().pop() || '0.0.0';
  const next = ['patch', 'minor', 'major'].includes(arg) ? bumpOf(cur, arg) : arg;
  for (const c of setVersion(next)) {
    console.log(`  ${c.touched ? '✓' : '·'} ${c.file.padEnd(38)} ${c.from} → ${c.to}${c.touched ? '' : '（本来就是）'}`);
  }
  console.log(`\n✅ 四处已对齐到 ${next}`);
}
