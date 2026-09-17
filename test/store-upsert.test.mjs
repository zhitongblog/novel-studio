// upsertBook 必须【整条替换】，不能合并——否则 delete 掉的字段永远删不掉。
//
// 病根：原来是 books[i] = { ...books[i], ...book }。展开合并有个隐蔽后果——
// 调用方 delete 掉的键，在展开时从旧记录里又活过来，于是 books.mjs 里那三处 delete
// 全是对着内存做无用功，落盘的还是旧值。
//
// 2026-09-17 实证：《大乾女帝贴身神探》两周前被标成「已完本」（9/4，当时 480 章），
// 之后又写了 45 章到 525；把状态撤回「连载中」后，status 变了，
// completedAt 却仍停在 9/4——setBookStatus 里明明写着 delete b.completedAt。
//
// 另外两处更阴：
//   setBookWriteMode  review → auto     ，reviewEvery 留在盘上
//   setParticipation  盯着写 → 放手写   ，reviewEvery=1 留在盘上
// 重启后 writer 从 book.reviewEvery 播种运行时审核开关，又按每批停下等审核——
// 表现成「说好放手写，它还是停下来等我」，而配置界面上显示的是全自动。
import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../src/store.mjs', import.meta.url), 'utf8');
const BOOKS = fs.readFileSync(new URL('../src/books.mjs', import.meta.url), 'utf8');

test('upsertBook 是整条替换，不是展开合并', () => {
  const fn = SRC.slice(SRC.indexOf('export function upsertBook'), SRC.indexOf('export function removeBook'));
  assert.ok(/books\[i\] = \{ \.\.\.book \}/.test(fn), '必须整条替换');
  assert.ok(!/\{ \.\.\.books\[i\], \.\.\.book \}/.test(fn),
    '不能写成 { ...books[i], ...book }——那样 delete 掉的字段会从旧记录里活过来，落盘的还是旧值');
});

test('不完整的对象要当场报错，而不是悄悄把整本书写瘪', () => {
  const fn = SRC.slice(SRC.indexOf('export function upsertBook'), SRC.indexOf('export function removeBook'));
  assert.ok(/!book \|\| !book\.id/.test(fn),
    '既然改成整条替换，传进来的就必须是完整对象；传个局部 patch 会把其余字段全抹掉，要在入口拦住');
});

// 下面三条钉住"确实有人依赖 delete 生效"——哪天有人把合并语义加回来，这里会红
test('setBookStatus 改回连载中要真的清掉 completedAt', () => {
  const fn = BOOKS.slice(BOOKS.indexOf('export function setBookStatus'));
  assert.ok(/delete b\.completedAt/.test(fn.slice(0, 600)),
    '书不是已完本了，就不该还挂着完本时间戳——对账/发布流程会据它判断');
});

test('切回全自动要真的清掉 reviewEvery', () => {
  const fn = BOOKS.slice(BOOKS.indexOf('export function setBookWriteMode'));
  assert.ok(/else delete b\.reviewEvery/.test(fn.slice(0, 600)),
    '留着它，重启后 writer 会据此又按每批停下等审核——而界面上显示的是全自动');
});

test('参与度切成放手写/卷口把关，要真的清掉 reviewEvery', () => {
  const fn = BOOKS.slice(BOOKS.indexOf('export function setParticipation'));
  assert.ok(/else delete b\.reviewEvery/.test(fn.slice(0, 600)),
    '同上：participation 变了但 reviewEvery 还在，就是「说好放手写，它还是停下来等我」');
});

console.log('\n全部通过 ✅  delete 掉的字段，落盘时是真的没了');
