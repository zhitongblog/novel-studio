// 感情线档位自测：钉住「建书选一次、全程约束分寸」这条链路，以及那条不随档位放宽的红线。
//
// 背景：《重生94》053–118 那 66 章里何艳出现 95 次，却一次真正的心动都没有——写作规范里
// 没有感情线这一节，AI 就把它写成了背景板。所以档位必须进 skill，且【任何档位都注入红线】。
import assert from 'node:assert';
import { ROMANCE_LEVELS, getRomance, resolveRomance, romanceVoice, ROMANCE_REDLINE, DEFAULT_ROMANCE, chapterRomanceSection } from '../src/romance.mjs';
import { skillBody } from '../src/skill.mjs';

// ① 四档齐全且规则互不相同
{
  const ids = ROMANCE_LEVELS.map(r => r.id);
  assert.deepStrictEqual(ids, ['none', 'light', 'warm', 'bold']);
  const rules = new Set(ROMANCE_LEVELS.map(r => r.rules));
  assert.strictEqual(rules.size, 4, '四档规则必须各不相同');
  assert.strictEqual(DEFAULT_ROMANCE, 'warm', '默认走推荐档');
  console.log('✓ 四档齐全、规则互不相同');
}

// ② resolveRomance：字符串 / 对象 / 未知值
{
  assert.strictEqual(resolveRomance('none').id, 'none');
  assert.strictEqual(resolveRomance({ id: 'bold' }).id, 'bold');
  assert.strictEqual(resolveRomance('不存在的档'), null, '未知值返回 null（由 romanceVoice 兜底）');
  assert.strictEqual(resolveRomance({ name: '自定义', rules: '照我说的写' }).id, 'custom');
  console.log('✓ resolveRomance 三种入参');
}

// ③ romanceVoice：字符串 / {id} / 完整对象 / 空 —— 空必须回落到推荐档，不能留给模型自由裁量
{
  assert.strictEqual(romanceVoice('none').name, getRomance('none').name);
  assert.strictEqual(romanceVoice({ id: 'light' }).name, getRomance('light').name);
  assert.strictEqual(romanceVoice(null).name, getRomance(DEFAULT_ROMANCE).name, '没设过 → 推荐档');
  assert.strictEqual(romanceVoice(undefined).name, getRomance(DEFAULT_ROMANCE).name, '老书没这个字段 → 推荐档');
  console.log('✓ romanceVoice 兜底到推荐档');
}

// ④ 档位真的进了写作规范，且各档注入的正文不同
{
  const of = (r) => String(skillBody({ title: '测试', romance: r, standards: {} }));
  assert.match(of('none'), /本书不铺感情线/);
  assert.match(of('light'), /几十章推进一小步/);
  assert.match(of('warm'), /写距离不写身体/);
  assert.match(of('bold'), /仅限成年角色/);
  assert.ok(!of('none').includes('写距离不写身体'), 'none 档不该注入暧昧技法');
  console.log('✓ 四档分别注入 skill');
}

// ⑤ 红线：任何档位都注入，连 none 都要（防模型自作主张加戏越线）
{
  for (const lvl of ['none', 'light', 'warm', 'bold', null]) {
    const s = String(skillBody({ title: '测试', romance: lvl, standards: {} }));
    assert.ok(s.includes('未成年角色（不满 18 岁）'), `${lvl} 档缺未成年红线`);
    assert.ok(s.includes('不写露骨性行为'), `${lvl} 档缺露骨描写红线`);
  }
  assert.match(ROMANCE_REDLINE, /物化异性的招徕语/, '简介措辞的风险也要提示（比正文更容易触发审核）');
  console.log('✓ 红线在所有档位注入');
}

// ⑥ 单章级覆盖：写这一章时可临时改尺度，不动全书档位
{
  const sec = chapterRomanceSection('warm', 'bold');
  assert.match(sec, /本章感情线尺度/, '覆盖时要标明这是本章的临时档位');
  assert.match(sec, /本书基线是/, '要点出跟全书档位的差异');
  assert.match(sec, /色而不淫/);
  assert.match(sec, /写感官，不写器官/);
  assert.ok(sec.includes('未成年角色（不满 18 岁）'), '单章覆盖同样注入红线');

  const same = chapterRomanceSection('warm', 'warm');
  assert.ok(!/本章感情线尺度/.test(same), '跟基线一样时不必强调"本章"');
  const none = chapterRomanceSection('warm', null);
  assert.match(none, /暧昧/, '不覆盖时用全书档位');
  console.log('✓ 单章级尺度覆盖');
}

// ⑦ bold 档必须是「写而不露」，不是「回避」
{
  const bold = getRomance('bold');
  assert.match(bold.rules, /该发生的要发生/, '不能写成回避');
  assert.match(bold.rules, /写事后，不写事中/);
  assert.match(bold.rules, /仅限成年角色/);
  assert.match(bold.rules, /不写露骨过程/);
  console.log('✓ bold = 色而不淫（写而不露，非回避）');
}

console.log('\n全部通过 ✅  感情线档位与红线正确');
