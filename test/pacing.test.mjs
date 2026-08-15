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

// ①b 章不足硬下限 → 事故 + 「补戏不补字」的指令
{
  const short = '“这活儿我接了。”\n\n' + '他把搪瓷缸往桌上一磕。\n\n'.repeat(20);   // ~2000 字以下
  const dir = makeBook([{ num: 1, title: '洗五回就发毛', body: short }]);
  const scan = pacingScan(dir, 1, 1, { std: { ...STD, minChars: 3000 } });
  assert.ok(kinds(scan).includes('under'), '短于硬下限应判 under');
  const ins = buildPacingFixInstruction(scan);
  assert.match(ins, /补的是戏，不是字/, '退回指令必须挡住注水');
  assert.match(ins, /严禁靠复述前情/);
  console.log('✓ 章不足硬下限 → 事故 + 补戏不补字');
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

// ⑥ 文风机械度：堆短句 + 砸数字 → 判 style（治「太守规范 = 公式」）
{
  let body = '“三块二。”\n\n他点头。\n\n“四毛五呢。”\n\n“一百二十个。”\n\n他把缸子往桌上一磕。\n\n';
  while (body.replace(/\s/g, '').length < 3200) body += '“八十六。”\n\n她说。\n\n“三十七块。”\n\n他把本子往前一推。\n\n';
  const dir = makeBook([{ num: 1, title: '一百五十六块八', body }]);
  const scan = pacingScan(dir, 1, 1, { std: STD });
  const st = scan.chapters[0].style;
  assert.ok(st.shortRatio > 0.45, `短句占比应超标，实得 ${st.shortRatio}`);
  assert.ok(st.numPer < 150, `数目应过密，实得每 ${st.numPer} 字一个`);
  assert.ok(kinds(scan).includes('style'), '应判出 style 机械');
  const ins = buildPacingFixInstruction(scan, { warnAlso: true });
  // 【关键】退回指令必须给出【具体要改几处】。「压到四成以下」模型执行不了——它没法边写边统计
  // 自己的短句占比（实测把上限写进 skill 后指标毫无改善，数目密度还从 95 掉到 85 字一个）。
  assert.match(ins, /至少合并掉 \d+ 句/, '必须给出要合并的具体句数');
  assert.match(ins, /删到 \d+ 处以内/, '必须给出数目要删到多少');
  assert.match(ins, /留不超过 3 句/, '把字句要给出保留上限');
  assert.match(ins, /只调语言/, '要挡住"顺手重写情节"');
  console.log('✓ 堆短句 + 砸数字 → 判文风机械，且给出可执行的条数');
}

// ⑦ 长短交错、数目克制的正文 → 不误报
{
  const good = '“这活儿我接了。”\n\n'
    + '他把搪瓷缸往桌上一磕，水溅出来一点，顺着桌沿往下滴，滴在那张已经泛黄的登记表上，把最后一栏的字洇开了。\n\n'
    + '“你说的那个数，我记着呢。”\n\n'
    + '我没接话，先把布袋子摊开给他看，让他自己去摸那道边——针脚是斜的，可布身是整的，这一点他不会看不出来。\n\n';
  let body = good;
  while (body.replace(/\s/g, '').length < 3200) body += good;
  const dir = makeBook([{ num: 1, title: '这活儿我接了', body }]);
  const scan = pacingScan(dir, 1, 1, { std: STD });
  const st = scan.chapters[0].style;
  assert.ok(st.longRatio > 0.08, `应有长句拉开节奏，实得 ${st.longRatio}`);
  assert.ok(st.numPer >= 150, `数目不该过密，实得每 ${st.numPer} 字一个`);
  console.log('✓ 长短交错 + 数目克制 → 不误报');
}

console.log('\n全部通过 ✅  节奏闸判定正确');
