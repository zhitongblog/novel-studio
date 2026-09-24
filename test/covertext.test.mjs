// 带字封面 + 字形校验。
//
// 由来：2026-09-24 作者说「现在我们合成的图片有点差劲」。原来的路子是模型只出无字底图、
// 书名作者由前端 canvas 叠上去，而叠字那层只有"居中+宋体+投影"，底图再好也只是素材加字。
// 改成让模型直接画字，但模型画中文最容易错字缺笔，而封面书名必须一字不差
// （番茄那边还要跟书名对得上），所以必须配一道字形校验 + 兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildCoverPromptWithText, normalizeCoverText, sameCoverText,
  parseReadBack, verifyCoverText, generateCoverWithText,
} from '../src/covertext.mjs';

const BOOK = { title: '重生三国，我吕布杀出一片天', dir: '/nope', genre: '历史' };

test('提示词把书名作者原样写进去，并明令不许错字、不许出现别的文字', () => {
  const p = buildCoverPromptWithText(BOOK, { title: BOOK.title, author: '知瞳' });
  assert.ok(p.includes(BOOK.title), '书名要原样出现在提示词里');
  assert.ok(p.includes('知瞳'));
  assert.match(p, /逐字准确/);
  assert.match(p, /不许错字/);
  assert.match(p, /不要出现任何其它文字/, '否则模型会自己加英文/宣传语/出版社名');
  assert.match(p, /排版要求/, '光说"把字加上"会被丢在角落里，版式必须一起交代');
});

test('上一版的问题要喂回提示词——空重试等于摇骰子', () => {
  const p = buildCoverPromptWithText(BOOK, { title: BOOK.title, note: '把「吕」画成了「呂」' });
  assert.match(p, /上一版的问题/);
  assert.ok(p.includes('把「吕」画成了「呂」'));
  // 不给 note 时不该多出这一段
  assert.ok(!buildCoverPromptWithText(BOOK, { title: BOOK.title }).includes('上一版的问题'));
});

test('归一化只抹掉标点写法与书名号，绝不抹掉汉字差异', () => {
  assert.ok(sameCoverText('《重生三国，我吕布杀出一片天》', '重生三国,我吕布杀出一片天'));
  assert.ok(sameCoverText('重生三国， 我吕布杀出一片天', '重生三国，我吕布杀出一片天'));
  // 错一个字就是错——这正是这道校验存在的理由
  assert.ok(!sameCoverText('重生三国，我呂布杀出一片天', '重生三国，我吕布杀出一片天'), '吕/呂 不许算同一个');
  assert.ok(!sameCoverText('重生三国，我吕布杀出一片夭', '重生三国，我吕布杀出一片天'), '天/夭 不许算同一个');
  assert.ok(!sameCoverText('', '重生三国'), '空串不许算通过');
  assert.equal(normalizeCoverText('  《书 名》 '), '书名');
});

test('读回来的两行能解析；带 ANSI 转义也要能解析（CLI 输出常带）', () => {
  const r = parseReadBack('书名=重生三国，我吕布杀出一片天\n作者=知瞳\n');
  assert.equal(r.title, '重生三国，我吕布杀出一片天');
  assert.equal(r.author, '知瞳');
  const withAnsi = parseReadBack('\x1b[32m书名\x1b[0m＝某某传\n作者：张三');
  assert.equal(withAnsi.title, '某某传');
  assert.equal(withAnsi.author, '张三');
  assert.equal(parseReadBack('什么都没有').title, '');
});

test('校验：读到什么就判什么，问题描述要能直接喂回提示词', () => {
  const want = { title: '重生三国，我吕布杀出一片天', author: '知瞳' };
  const ok = verifyCoverText('x.png', want, null, { read: () => ({ title: want.title, author: '知瞳' }) });
  assert.equal(ok.ok, true);

  const wrong = verifyCoverText('x.png', want, null, { read: () => ({ title: '重生三国，我呂布杀出一片天', author: '知瞳' }) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.note, /画成了「重生三国，我呂布杀出一片天」/, '要说清画成了什么，模型才知道盯哪个字');

  // 看不清的字被标成「？」→ 判失败，不许放过
  const blur = verifyCoverText('x.png', want, null, { read: () => ({ title: '重生三国，我吕布杀出一片？', author: '知瞳' }) });
  assert.equal(blur.ok, false);
  assert.match(blur.note, /看不清或缺笔/);

  // 作者没填就不校验它
  const noAuthor = verifyCoverText('x.png', { title: want.title }, null, { read: () => ({ title: want.title, author: '随便什么' }) });
  assert.equal(noAuthor.ok, true, '作者没填就不该拿它判失败');
});

test('校验模型【不许被告知正确答案】——否则它只会复读', async () => {
  const src = fs.readFileSync(new URL('../src/covertext.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('export function readCoverText');
  const j = src.indexOf('export function parseReadBack');
  const body = src.slice(i, j);
  assert.ok(!/\$\{\s*title\s*\}/.test(body) && !body.includes('want.title'),
    'readCoverText 的提示词里绝不能出现真书名——那会让校验退化成橡皮图章');
  assert.match(body, /原样抄下来/);
  assert.match(body, /--allowedTools/, '封面图是不可信输入，claude 只能放开 Read');
  assert.ok(!body.includes('dangerously-skip-permissions'), '绝不允许');
});

test('编排：第一次就画对 → 不重试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvt-'));
  let calls = 0;
  const r = await generateCoverWithText({ ...BOOK, dir }, {
    title: BOOK.title, attempts: 3,
    genWithText: async () => { calls++; },
    verify: () => ({ ok: true, read: { title: BOOK.title }, problems: [], note: '' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1, '一次就过不该再画');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('编排：错两次、第三次对 → 用第三次，且失败原因被喂回去了', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvt-'));
  const prompts = [];
  let n = 0;
  const r = await generateCoverWithText({ ...BOOK, dir }, {
    title: BOOK.title, attempts: 3,
    genWithText: async (p) => { prompts.push(p); },
    verify: () => (++n < 3
      ? { ok: false, read: { title: '错的' }, problems: ['书名画错了'], note: '书名画成了「错的」' }
      : { ok: true, read: { title: BOOK.title }, problems: [], note: '' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.ok(!prompts[0].includes('上一版的问题'), '第一次没有上一版');
  assert.ok(prompts[1].includes('书名画成了「错的」'), '第二次要带上第一次的问题');
  assert.ok(prompts[2].includes('书名画成了「错的」'), '第三次同理');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('编排：三次都不行 → 退回无字底图，且把画错的 cover.png 删掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvt-'));
  const out = path.join(dir, 'cover.png');
  let plain = 0;
  const r = await generateCoverWithText({ ...BOOK, dir }, {
    title: BOOK.title, attempts: 3,
    genWithText: async () => { fs.writeFileSync(out, 'x'); },
    verify: () => ({ ok: false, read: { title: '错的' }, problems: ['错'], note: '错' }),
    genPlain: async () => { plain++; return { file: path.join(dir, 'cover_bg.png') }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, true);
  assert.equal(r.attempts, 3);
  assert.equal(plain, 1, '要退回老路跑一次无字底图');
  assert.ok(!fs.existsSync(out), '画错的成品封面必须删掉，否则会被当成正式封面用');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('编排：校验跑不起来时不许假装通过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvt-'));
  const r = await generateCoverWithText({ ...BOOK, dir }, {
    title: BOOK.title, attempts: 3,
    genWithText: async () => {},
    verify: () => { throw new Error('claude 不可用'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.verifyUnavailable, true, '校验不可用要如实报出来，不能判成"通过"也不该判成"模型画错了"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('两个驱动都支持 outFile——带字成品要落 cover.png，不能覆盖无字底图', () => {
  for (const f of ['covergen_web.mjs', 'covergen_gemini.mjs']) {
    const src = fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    assert.match(src, /outFile \|\| path\.join\(book\.dir, 'cover_bg\.png'\)/,
      f + ' 应支持 outFile，且不传时保持老行为');
  }
});

// ── 前端接线的守闸 ────────────────────────────────────────────────
// 这两条都是实打实会出事的：
//  ① 带字成品封面再叠一层 canvas 字 = 两层字糊在一起；
//  ② 上一次生成成品封面把叠字关掉了，这次生成无字底图却没打回来 = 干净底图上一个字没有。
test('前端：带字成品封面不许再叠字，无字底图必须把叠字打回来', () => {
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="cvOverlay"/, '要有叠字开关');
  assert.match(html, /id="cvGenWithText"/, '要有生成带字成品封面的按钮');
  // drawCover 里要看这个开关
  const i = app.indexOf('function drawCover()');
  const j = app.indexOf('function drawCoverText(');
  assert.match(app.slice(i, j), /cvOverlay/, 'drawCover 必须尊重叠字开关，否则成品封面会被叠两层字');
  // 每一条【无字底图】成功回调都要 cvOverlayOn()
  const n = (app.match(/cvOverlayOn\(\);/g) || []).length;
  assert.ok(n >= 4, `无字底图的成功回调都要打回叠字开关，当前只有 ${n} 处`);
});
