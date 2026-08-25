#!/usr/bin/env node
// 把 skills/ 下的技能装到本机各家 AI 的技能目录。
//
//   node skills/install.mjs            # 装到所有检测到的 AI
//   node skills/install.mjs --list     # 只看会装到哪儿
//   node skills/install.mjs claude     # 只装 claude
//   node skills/install.mjs --skill unzoo-fanqie-publish
//
// 各家的技能目录约定不同，但格式是一样的：<目录>/<技能名>/SKILL.md（带 YAML frontmatter）。
// 所以同一份技能能同时装给 Claude Code、Codex、Gemini CLI。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

const TARGETS = [
  { id: 'claude', name: 'Claude Code', dir: path.join(HOME, '.claude', 'skills') },
  { id: 'codex', name: 'Codex', dir: path.join(HOME, '.codex', 'skills') },
  { id: 'gemini', name: 'Gemini CLI', dir: path.join(HOME, '.gemini', 'skills') },
];

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const only = argv.filter(a => !a.startsWith('--'));
const skillArg = (() => { const i = argv.indexOf('--skill'); return i >= 0 ? argv[i + 1] : null; })();

// 本仓库里有哪些技能：skills/<名字>/SKILL.md
const skills = fs.readdirSync(HERE)
  .filter(d => fs.existsSync(path.join(HERE, d, 'SKILL.md')))
  .filter(d => !skillArg || d === skillArg);

if (!skills.length) {
  console.error(skillArg ? `找不到技能：${skillArg}` : '没找到任何技能（skills/<名字>/SKILL.md）');
  process.exit(1);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

let installed = 0;
for (const t of TARGETS) {
  if (only.length && !only.includes(t.id)) continue;
  // 家目录下有 .claude / .codex / .gemini 才认为装了这家；技能目录不存在就建
  const rootExists = fs.existsSync(path.dirname(t.dir));
  if (!rootExists) { console.log(`—  ${t.name.padEnd(12)} 未检测到（${path.dirname(t.dir)} 不存在），跳过`); continue; }

  for (const s of skills) {
    const dst = path.join(t.dir, s);
    if (listOnly) { console.log(`   ${t.name.padEnd(12)} → ${dst}`); continue; }
    fs.rmSync(dst, { recursive: true, force: true });   // 覆盖安装，别留上一版的残file
    copyDir(path.join(HERE, s), dst);
    console.log(`✅ ${t.name.padEnd(12)} → ${dst}`);
    installed++;
  }
}

if (!listOnly) {
  console.log(installed ? `\n装好 ${installed} 处。新开一个会话即可用。` : '\n什么都没装（没检测到目标 AI，或用 --list 看看）。');
}
