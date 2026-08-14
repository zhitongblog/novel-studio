// 平铺归档自测：钉住「哪些根目录文件算正文章节」。
// 历史 bug：archiveFlatChapters 用【白名单排除元文件】，白名单外的 .txt/.md 一律当章节吞进 chapters/。
//   第一次犯：`简介.txt` 被归进 chapters/（已补进白名单）；
//   第二次犯：`重写方案-011起.md` 又被吞——它还带着 011 这个章号数字。
// 补白名单是打地鼠，改成【正向判定 + 设定类前缀否定】才治本。本测试钉住这条边界。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveFlatChapters, volumeDirName } from '../src/books.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
const write = (name) => fs.writeFileSync(path.join(dir, name), '正文若干。', 'utf8');

// 该被归档的：带章号的正文
const CHAPTERS = ['001你先把鞋底放下.txt', '002那个手印你不该按.txt', '第3章 她怎么坐我后桌了.txt'];
// 不该被碰的：元文件 / 设定笔记类（含带数字的）
const KEEP = ['novel_bible.md', 'chapter_index.md', 'continuity_ledger.md', 'AGENTS.md',
  '简介.txt', '重写方案-011起.md', '大纲草案2.md', '人物小传.md', '发布记录20260814.md'];

for (const f of [...CHAPTERS, ...KEEP]) write(f);

const r = archiveFlatChapters(dir);

assert.strictEqual(r.moved, CHAPTERS.length, `应只归档 ${CHAPTERS.length} 个正文，实得 ${r.moved}：${r.names.join('、')}`);
for (const f of CHAPTERS) {
  assert.ok(fs.existsSync(path.join(dir, 'chapters', '卷01', f)), `${f} 应被归进 chapters/卷01/`);
  assert.ok(!fs.existsSync(path.join(dir, f)), `${f} 应已从根目录移走`);
}
for (const f of KEEP) {
  assert.ok(fs.existsSync(path.join(dir, f)), `${f} 不该被当成章节归档`);
}
console.log('✓ 只归档带章号的正文，元文件与设定/方案/简介类原地不动');

// 幂等：再跑一次不该有任何动作
const r2 = archiveFlatChapters(dir);
assert.strictEqual(r2.moved, 0, '二次归档应无动作（幂等）');
console.log('✓ 幂等');

// —— 卷目录名：必须复用已存在的带卷名目录，不能硬拼「卷NN」分叉出第二个 ——
// 历史 bug：共创写作指令硬拼 chapters/卷01/，而书里实际是 chapters/卷01县城开张/，
// 于是每次开写都新建一个 chapters/卷01/ 往里落章，一本书裂成两个卷目录。
{
  const bd = fs.mkdtempSync(path.join(os.tmpdir(), 'voldir-'));
  fs.mkdirSync(path.join(bd, 'chapters', '卷01县城开张'), { recursive: true });
  fs.mkdirSync(path.join(bd, 'chapters', '卷02地区风起'), { recursive: true });
  assert.strictEqual(volumeDirName(bd, 1), '卷01县城开张', '应复用已存在的带卷名目录');
  assert.strictEqual(volumeDirName(bd, 2), '卷02地区风起');
  assert.strictEqual(volumeDirName(bd, 3), '卷03', '该卷还不存在 → 回落到「卷NN」');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'voldir2-'));
  fs.mkdirSync(path.join(bare, 'chapters', '卷01'), { recursive: true });
  assert.strictEqual(volumeDirName(bare, 1), '卷01', '没有卷名时保持「卷NN」');
  console.log('✓ 卷目录名复用已存在目录，不分叉');
}

console.log('\n全部通过 ✅  平铺归档边界 + 卷目录解析正确');
