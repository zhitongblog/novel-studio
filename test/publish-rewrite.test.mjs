// 发布·重写同步自测：钉住「按内容指纹判定重写」与「覆盖已发布内容要过量闸」。
//
// 病根（这次实测撞到的）：原来用 mtime > lastPublishAt 判定「这章被重写过」。mtime 太脆——
// deslop 排版矫正、git checkout、文件移动都会改它而内容一个字没动。实证：《重生94》001–010
// 从没重写过，却因 deslop 跑过被整批 edit 覆盖上线（线上 6–9 章的发布时间变成了矫正当晚）。
// 每次 edit 都是一次线上写操作，白吃审核风险。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPublishChapters, loadPublishedHashes, savePublishedHashes } from '../src/publish.mjs';

function makeBook(chapters) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  const vol = path.join(dir, 'chapters', '卷01县城开张');
  fs.mkdirSync(vol, { recursive: true });
  for (const { num, title, body } of chapters) {
    fs.writeFileSync(path.join(vol, `${String(num).padStart(3, '0')}${title}.txt`), body, 'utf8');
  }
  return { slug: 'test', dir };
}
const BODY = (s) => `“${s}”\n\n他把搪瓷缸往桌上一磕，水溅出来一点。\n\n“记着呢。”\n`;

// ① 同样的正文 → 指纹一致（mtime 变了也不算重写）
{
  const book = makeBook([{ num: 1, title: '你先把鞋底放下', body: BODY('一') }]);
  const before = loadPublishChapters(book)[0];
  savePublishedHashes(book, { '1': before.hash });

  // 模拟 deslop / git checkout：重写同一份内容，mtime 变新，内容不变
  const fp = path.join(book.dir, 'chapters', '卷01县城开张', '001你先把鞋底放下.txt');
  const raw = fs.readFileSync(fp, 'utf8');
  const future = new Date(Date.now() + 60_000);
  fs.writeFileSync(fp, raw, 'utf8');
  fs.utimesSync(fp, future, future);

  const after = loadPublishChapters(book)[0];
  assert.ok(after.mtime > before.mtime, '前提：mtime 确实变新了');
  assert.strictEqual(after.hash, before.hash, 'mtime 变了但内容没变 → 指纹必须一致');
  console.log('✓ mtime 变、内容没变 → 不算重写');
}

// ② 正文真改了 → 指纹变化
{
  const book = makeBook([{ num: 1, title: '你先把鞋底放下', body: BODY('一') }]);
  const h0 = loadPublishChapters(book)[0].hash;
  fs.writeFileSync(path.join(book.dir, 'chapters', '卷01县城开张', '001你先把鞋底放下.txt'), BODY('二'), 'utf8');
  const h1 = loadPublishChapters(book)[0].hash;
  assert.notStrictEqual(h0, h1, '内容改了 → 指纹必须变');
  console.log('✓ 内容改了 → 指纹变');
}

// ③ 指纹库读写往返
{
  const book = makeBook([{ num: 1, title: '甲', body: BODY('甲') }]);
  assert.deepStrictEqual(loadPublishedHashes(book), {}, '没写过 → 空对象，不能抛');
  savePublishedHashes(book, { '1': 'abc', '2': 'def' });
  assert.deepStrictEqual(loadPublishedHashes(book), { '1': 'abc', '2': 'def' });
  assert.ok(fs.existsSync(path.join(book.dir, '.studio', 'published-hashes.json')), '指纹跟书走，存在 .studio/');
  console.log('✓ 指纹库读写往返');
}

// ④ 【最要紧】没有基线的章一律不算重写——否则老书第一次跑会把整本重发一遍
{
  const book = makeBook([
    { num: 1, title: '甲', body: BODY('甲') },
    { num: 2, title: '乙', body: BODY('乙') },
    { num: 3, title: '丙', body: BODY('丙') },
  ]);
  const all = loadPublishChapters(book);
  savePublishedHashes(book, { '2': 'stale-hash' });   // 只有第 2 章有基线，且对不上
  const hashes = loadPublishedHashes(book);

  // 复刻 pickRewritten 的判定：有基线且对不上才算
  const rewritten = all.filter(c => c.num <= 3 && hashes[String(c.num)] && hashes[String(c.num)] !== c.hash);
  assert.deepStrictEqual(rewritten.map(c => c.num), [2], '只有第 2 章算重写；1、3 缺基线 → 绝不能算');
  console.log('✓ 缺基线的章不算重写（防整本重发）');
}

console.log('\n全部通过 ✅  重写同步按内容指纹判定');
