// 创建一本书的项目骨架：目录结构 + bible + index + 大纲 + 各模型上下文文件
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { contextFiles } from './skill.mjs';

// 把书目录初始化为 git 仓库：① codex 要求"受信目录"（git 仓库即受信），否则拒绝运行；
// ② 给小说项目天然的版本管理（每批可提交）。best-effort，git 缺失则跳过。
function gitInit(dir) {
  try {
    if (fs.existsSync(path.join(dir, '.git'))) return;
    const r = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return;
    fs.writeFileSync(path.join(dir, '.gitignore'), '.studio/\n', 'utf8');
    spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    spawnSync('git', ['-c', 'user.name=Novel Studio', '-c', 'user.email=novel@studio.local',
      'commit', '-m', '初始化书目'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  } catch {}
}

// 重写/重立项前自动 git 存档，返回 short hash（供"可回退"提示）。best-effort。
export function gitSnapshot(dir, message) {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
    spawnSync('git', ['-c', 'user.name=Novel Studio', '-c', 'user.email=novel@studio.local',
      'commit', '-m', message || '重写前自动存档', '--allow-empty'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
    const h = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    return (h.stdout || '').trim() || null;
  } catch { return null; }
}

export function scaffoldBook(book) {
  const dir = book.dir;
  const std = book.standards || {};
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outlines'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });

  // 第一卷目录
  const vol1 = path.join(dir, 'chapters', '卷01');
  fs.mkdirSync(vol1, { recursive: true });

  writeIfMissing(path.join(dir, 'novel_bible.md'), bibleTemplate(book));
  writeIfMissing(path.join(dir, 'chapter_index.md'), indexTemplate(book));
  writeIfMissing(path.join(dir, 'outlines', '卷01分章大纲.md'), outlineTemplate(book));
  writeIfMissing(path.join(dir, 'continuity_ledger.md'), ledgerTemplate(book));

  // 各模型上下文文件（写作 skill），每次刷新以保证最新标准
  const files = contextFiles(book);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }

  // 初始化 git 仓库（codex 受信目录 + 版本管理）
  gitInit(dir);
  return dir;
}

// 仅当书的标准变化时刷新上下文文件
export function refreshContext(book) {
  const files = contextFiles(book);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(book.dir, name), content, 'utf8');
  }
}

function writeIfMissing(p, content) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
}

function bibleTemplate(b) {
  const std = b.standards || {};
  return `# 《${b.title}》设定圣经（novel_bible.md）

## 一句话卖点
${b.genre || '（类型 / 卖点 / 目标读者）'}

## 基本盘
- 目标读者：
- 时代 / 世界观：
- 力量体系：${std.system || '（是否用系统？传统武侠/国术"以武正道"建议弱系统，只记录或结算，不替代修炼与道德抉择）'}
- 主角：
- 关键配角：
- 对抗势力：
- 主题：
- 禁区（taboo）：

## 全书规模
- 目标总字数：${std.totalWords || '?'}
- 卷数：${std.volumes || '?'}
- 每卷约章数：${std.chaptersPerVolume || '?'}
- 单章目标字数：${std.targetCharsLo || 3000}–${std.targetCharsHi || 3600}

## 节奏与格局承诺（必填，防止原地打转 / 流水账）
> 每卷一句：本卷主角处境从「什么状态」升到「什么状态」（地点 / 权力层级 / 实力 / 对手量级 / 所辖范围）。
- 卷01：从「」→「」
- 卷02：从「」→「」
- 单阶段目标兑现章数上限：3–8 章；禁止把办牌/验册/对账/盘点等事务流程写成连续多章主线。
- 爽点节拍：每约 ___ 章给读者一次可感的进展或胜利（赢一场 / 收一人 / 揭真相 / 上台阶 / 打脸）。

## 长线弧光
- 中期弧（20–60 章）：
- 卷弧（150–300 章）：

## 命名风格 / 口吻基线
-
`;
}

function indexTemplate(b) {
  return `# 《${b.title}》章节索引（chapter_index.md）

| 全局章号 | 章名 | 卷 | 路径 | 状态 |
|---|---|---|---|---|
`;
}

function ledgerTemplate(b) {
  return `# 《${b.title}》连贯性台账（continuity_ledger.md）

> 每批写完顺手更新；全文逻辑自检时以此为索引快速比对，避免重读全书。

## 时间线锚点
-

## 人物现状 / 已知信息（谁知道什么）
-

## 未回收伏笔
-

## 欠债 / 承诺
-

## 伤势 / 状态
-

## 关键物件去向
-

## 地名 / 组织 / 名词表
-

## 待查（“待查”逻辑的开放问题）
-
`;
}

function outlineTemplate(b) {
  const per = b.standards?.chaptersPerVolume || '?';
  return `# 《${b.title}》卷01 分章大纲

> 章号区间：001–${per}
> 本卷阶段目标：
> 卷末局面（交给下一卷的钩子）：

## 分章 beat（动笔前必须细化到逐章一行）

| 章号 | 核心事件 / 冲突 | 推进了什么（人物 / 关系 / 线索） | 章末钩子 |
|---|---|---|---|
| 001 | 开篇：抓读者的第一个场景 + 核心悬念 | | |

## 本卷伏笔布点表

| 伏笔 | 埋设章号 | 计划回收章号 | 状态 |
|---|---|---|---|
|  |  |  | 未回收 |
`;
}
