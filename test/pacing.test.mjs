// 节奏闸自测：钉住四条确定性判定 + 一个真实误报的回归。
// 覆盖：①章长超标判事故并给拆章指令；②连续 ≥2 章事务流程判事故；③前世回忆里的钱不计入量级曲线
//       （真实误报：《重生94》022「上辈子我做过的最小一个单子是三十七万」被当成本世战果）；
//       ④章末总结抒情判假钩子；⑤全部合规时不打扰（instruction 为 null）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pacingScan, buildPacingFixInstruction, inspectChapter } from '../src/pacing.mjs';

const STD = { targetCharsLo: 3000, targetCharsHi: 3600, hardMax: 6000 };

// 造一本临时书：chapters/卷01/NNN章名.txt
function makeBook(chapters) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacing-'));
  const vol = path.join(dir, 'chapters', '卷01');
  fs.mkdirSync(vol, { recursive: true });
  for (const { num, title, body } of chapters) {
    fs.writeFileSync(path.join(vol, `${String(num).padStart(3, '0')}${title}.txt`), body, 'utf8');
  }
  return dir;
}

// 一段合规正文：有对话、章末是具体台词钩子，长度落在 3000–3600
function goodBody(seedLine = '“这活儿我接了。”', tailLine = '“明天你就知道了。”') {
  const para = '他把搪瓷缸往桌上一磕，水溅出来一点。\n\n“你说的那个数，我记着呢。”\n\n我没接话，先把布袋子摊开给他看。\n\n';
  let s = seedLine + '\n\n';
  while (s.replace(/\s/g, '').length < 3100) s += para;
  return s + tailLine + '\n';
}

const kinds = (scan) => scan.issues.map(i => i.kind);

// ① 章长超标 → 事故 + 拆章指令
{
  const long = goodBody() + goodBody() + goodBody();   // ~9000 字
  const dir = makeBook([{ num: 1, title: '开张', body: long }]);
  const scan = pacingScan(dir, 1, 1, { std: STD });
  assert.ok(kinds(scan).includes('overlong'), '超长章应判 overlong');
  const ins = buildPacingFixInstruction(scan);
  assert.match(ins, /拆成每章 3000–3600 字/, '应给出拆章指令');
  assert.match(ins, /chapter_index\.md/, '应要求同步章名表');
  console.log('✓ 章长超标 → 事故 + 拆章指令');
}

// ② 连续 ≥2 章事务流程 → 事故（章名命中是强信号；正文密度兜住口语章名）
{
  // 一章满是单据词的走账正文：真实病灶长这样（《重生94》023「抬头先空着」整章在谈报价单怎么填）
  const paperBody = goodBody().replace(/他把搪瓷缸往桌上一磕，水溅出来一点。/g,
    '报价单的抬头先空着，等执照下来再填，验收单和结款日子都写在存根上。');
  const dir = makeBook([
    { num: 1, title: '抬头先空着', body: paperBody },
    { num: 2, title: '这单得挂我妈名下', body: paperBody },
    { num: 3, title: '你欠我的那一回', body: goodBody() },
  ]);
  const scan = pacingScan(dir, 1, 3, { std: STD });
  assert.ok(kinds(scan).includes('paperwork'), '连着两章办手续应判 paperwork');
  assert.match(buildPacingFixInstruction(scan), /障碍、筹码或背景质感/);
  console.log('✓ 连续 ≥2 章事务流程 → 事故');
}

// ③ 前世回忆里的钱不计入量级曲线（真实误报回归）
{
  const dir = makeBook([{
    num: 1, title: '我拿什么跟自己比',
    body: '上辈子我做过的最小一个单子是三十七万。那年我三十一岁。\n\n' + goodBody() + '这一单是一百五十六块八。\n',
  }]);
  const c = inspectChapter(path.join(dir, 'chapters', '卷01', '001我拿什么跟自己比.txt'), 1, STD);
  assert.strictEqual(c.money, 156, `前世的三十七万不该进曲线，实得 ${c.money}`);
  console.log('✓ 前世回忆里的钱不计入量级曲线');
}

// ④ 章末总结抒情 → 假钩子
{
  const dir = makeBook([{ num: 1, title: '开张', body: goodBody('“我干。”', '而这一切，才刚刚开始。') }]);
  const scan = pacingScan(dir, 1, 1, { std: STD });
  assert.ok(kinds(scan).includes('hook'), '章末假钩子应被判出');
  console.log('✓ 章末总结抒情 → 假钩子');
}

// ⑤ 合规批次不打扰：无事故 → instruction 为 null
{
  const dir = makeBook([
    { num: 1, title: '你先把鞋底放下', body: goodBody('“你把鞋底放下。”', '“那你倒是说说，你拿什么还。”') },
    { num: 2, title: '她怎么坐我后桌了', body: goodBody('“谁让你坐这儿的。”', '“下回换你带我。”') },
  ]);
  const scan = pacingScan(dir, 1, 2, { std: STD });
  assert.ok(!kinds(scan).includes('overlong'), '合规章长不该报事故');
  assert.ok(!kinds(scan).includes('paperwork'), '非流程章不该报 paperwork');
  assert.strictEqual(buildPacingFixInstruction(scan), null, '无事故时不应打扰作者');
  console.log('✓ 合规批次不打扰');
}

console.log('\n全部通过 ✅  节奏闸判定正确');
