// 本轮停止点：--until N。
//
// 由来（2026-09-23）：任务里写得明明白白「只写第 009 章一章，写完就停，不要续写 010」，
// agy 照样一口气写到了 015——七章。
//
// 根因不是模型不听话，是【那句话只是给模型的初始 prompt，而 autopilot 是另一套逻辑】：
// 它在模型一空闲时就发「继续」，只看三个数——untilChapter、书级 targetChapters、
// 续写次数上限（默认 40）。那本书 targetChapters 没设，于是一路续到 40 次才会停。
// 想只写 N 章，光在 prompt 里说没用，必须有这道闸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

function fnBody(src, name) {
  const i = src.indexOf(name);
  if (i < 0) throw new Error('找不到：' + name);
  const open = src.indexOf('{', i);
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('括号没配平：' + name);
}

test('两条挂 autopilot 的路径都认 untilChapter——漏一条就还能失控', () => {
  for (const f of ['src/writer.mjs', 'src/attach.mjs']) {
    const src = read(f);
    const body = fnBody(src, 'shouldStopContinue');
    assert.match(body, /untilChapter > 0/, f + ' 的停机判据没看 untilChapter');
    assert.match(body, /maxChapter >= untilChapter/, f + ' 应按【已写到的最大章号】判停');
  }
});

test('untilChapter 是本轮参数，不许写进书的持久设置', () => {
  for (const f of ['src/writer.mjs', 'src/attach.mjs', 'src/cli.mjs']) {
    const src = read(f);
    assert.ok(!/setBookTarget|targetChapters\s*=/.test(src.slice(src.indexOf('untilChapter'))),
      f + '：--until 不该改写 targetChapters，那是书级设置');
  }
});

test('untilChapter 缺省为 0 = 不限，老行为不变', () => {
  assert.match(read('src/writer.mjs'), /untilChapter = 0/, 'writer 默认 0');
  assert.match(read('src/attach.mjs'), /untilChapter = 0/, 'attach 默认 0');
  // 0 时判据要短路，不能误停
  const body = fnBody(read('src/writer.mjs'), 'shouldStopContinue');
  assert.match(body, /untilChapter > 0 &&/, '必须先判 >0 再比大小，否则 0 会把每一轮都停掉');
});

test('CLI 解析 --until 并透传', () => {
  const cli = read('src/cli.mjs');
  assert.match(cli, /parseInt\(f\.until/, '要解析 --until');
  assert.match(cli, /startWriting\(\{[^}]*untilChapter/, '要传进 startWriting');
});

test('启动时要把本轮停止点打出来——不打的话作者不知道这轮会写到哪', () => {
  const cli = read('src/cli.mjs');
  assert.match(cli, /本轮停止点/, '缺少停止点提示');
  assert.match(cli, /未设/, '没设 --until 时也要说明会写到哪为止（这正是失控那次的盲区）');
});

test('帮助文本要点明「任务里写只写一章拦不住 autopilot」', () => {
  const help = read('bin/novel.mjs');
  assert.match(help, /--until/, '帮助里要有 --until');
  assert.match(help, /拦不住 autopilot/, '要写明为什么需要它——否则下次还是只在 --task 里写一句');
});
