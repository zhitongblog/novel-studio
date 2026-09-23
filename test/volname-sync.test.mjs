// 番茄卷名要跟本地对账。
//
// 由来（2026-09-23）：作者发现发到番茄的书卷名是「第一卷：默认」。
// 根因两层：① 番茄建书时自动生成「第一卷：默认」，而建卷逻辑【只补缺的卷、不动已有卷】
// （建卷不可逆，这条谨慎是对的），于是卷1 永远"不缺"，占位名一直留着；
// ② 光治占位名不够——作者要的是【和本地比对】：本地卷名才是准绳，番茄上跟它不一样就该扶正。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fanqieVolSub, PLACEHOLDER_VOL } from '../src/publish.mjs';

const src = fs.readFileSync(new URL('../src/publish.mjs', import.meta.url), 'utf8');

// 按大括号配对取函数体。别用 slice(i, i+N)——窗口一大就越过函数边界读到别处的代码，
// 断言会命中不相干的片段（这条测试第一版就是这么假红的）。
function fnBody(name) {
  const i = src.indexOf(name);
  if (i < 0) throw new Error('找不到函数：' + name);
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('大括号没配平：' + name);
}

test('从番茄卷名里抽副标题', () => {
  assert.equal(fanqieVolSub('第一卷：默认'), '默认');
  assert.equal(fanqieVolSub('第十三卷：九州雷震'), '九州雷震');
  assert.equal(fanqieVolSub('第 3 卷 ： 带空格的'), '带空格的');   // 空格要能吃掉——上一版这里漏了反斜杠，写成了字面的 s
  assert.equal(fanqieVolSub('第1卷'), '', '没有副标题时返回空');
  assert.equal(fanqieVolSub(''), '');
  assert.equal(fanqieVolSub(null), '');
});

test('占位名表：番茄自动生成的那几种要认出来', () => {
  for (const s of ['默认', '默认卷', '未命名', '新建卷', '正文']) {
    assert.ok(PLACEHOLDER_VOL.test(s), '应认作占位名：' + s);
  }
  for (const s of ['寒门破局', '煤山夺命', '默认的江湖']) {
    assert.ok(!PLACEHOLDER_VOL.test(s), '不该误伤真卷名：' + s);
  }
});

test('本地没有卷名时绝不动番茄——更不能把那边清空', () => {
  const body = fnBody('async function syncVolNamesFromLocal');
  assert.match(body, /if \(!wantSub\) continue;/, '本地无名必须直接跳过');
  assert.match(body, /不动番茄，更不清空/, '这条纪律要写在代码里');
});

test('比对的是【本地卷名】，不是只治占位名', () => {
  const body = fnBody('async function syncVolNamesFromLocal');
  assert.match(body, /volDisplayNameForBook/, '本地卷名要走建卷同一条优先级（目录名→大纲→bible）');
  assert.match(body, /wantSub === fqSub/, '一致就跳过');
  // 番茄有名字但和本地不一样时，也要改——这是作者明确要求的
  assert.match(body, /与本地不一致/, '不一致的情况要单独给出原因文案');
});

test('每改一条都要写清楚"番茄叫什么→本地叫什么"，作者才改得回去', () => {
  const body = fnBody('async function syncVolNamesFromLocal');
  assert.match(body, /按本地改成/, '日志要说明改成了什么');
  assert.match(body, /onLog/, '要有日志');
});

test('改名失败不许阻断发章', () => {
  const body = fnBody('async function syncVolNamesFromLocal');
  assert.match(body, /不影响发章/, '失败文案要点明不影响发章');
  assert.ok(!/return \{ ok: false/.test(body), '这个函数不该返回阻断信号');
  // 调用点本身也要包 try
  const call = src.slice(src.indexOf('await syncVolNamesFromLocal') - 200, src.indexOf('await syncVolNamesFromLocal') + 200);
  assert.match(call, /try \{ await syncVolNamesFromLocal/, '调用点要包 try，异常不能掀翻整个发布');
});

test('对账排在建卷之后——新建的卷本来就带着正确名字', () => {
  const create = src.indexOf('createFanqieVolumes({');
  const sync = src.indexOf('await syncVolNamesFromLocal');
  assert.ok(create > 0 && sync > create, '建卷在前、对账在后');
});
