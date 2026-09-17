// 书目注册表：book <-> profile <-> 项目目录
import fs from 'node:fs';
import { BOOKS_FILE } from './paths.mjs';
import { ensureDirs } from './config.mjs';

export function loadBooks() {
  ensureDirs();
  if (!fs.existsSync(BOOKS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8')); } catch { return []; }
}

export function saveBooks(books) {
  ensureDirs();
  fs.writeFileSync(BOOKS_FILE, JSON.stringify(books, null, 2), 'utf8');
  return books;
}

export function getBook(id) {
  return loadBooks().find(b => b.id === id || b.slug === id || b.title === id);
}

// 【整条替换，不是合并】曾经这里是 books[i] = { ...books[i], ...book }。
// 展开合并有个隐蔽后果：调用方 delete 掉的字段【删不掉】——旧记录里那个键在展开时又活过来，
// 于是 books.mjs 里三处 delete 全是对着内存做无用功，落盘的还是旧值：
//   · setBookStatus  改回「连载中」→ completedAt 还挂着（2026-09-17 实证：大乾女帝撤回完本后，
//     状态是连载中，completedAt 却仍停在 9/4）
//   · setBookWriteMode  review → auto，reviewEvery 留在盘上
//   · setParticipation  盯着写 → 放手写，reviewEvery=1 留在盘上
// 后两条尤其阴：作者明明切成了「放手写」，重启后 writer 从 book.reviewEvery 播种运行时开关，
// 又按每批停下等审核——表现成"说好放手写，它还是停下来等我"，而配置界面上显示的是全自动。
//
// 改成整条替换是安全的：全部 16 个调用点传的都是完整的书对象
// （13 处来自 getBook()，另外 3 处是 createBook/importBook/clearFlatImport 自己构造的完整对象）。
// ⚠️ 以后要往这里传【局部 patch】，必须改成显式的 patch 接口，别把合并语义悄悄加回来——
// 加回来，上面那三处 delete 就又静默失效了。
export function upsertBook(book) {
  if (!book || !book.id) throw new Error('upsertBook 需要完整的书对象（含 id）');
  const books = loadBooks();
  const i = books.findIndex(b => b.id === book.id);
  if (i >= 0) books[i] = { ...book };
  else books.push(book);
  saveBooks(books);
  return book;
}

export function removeBook(id) {
  const books = loadBooks().filter(b => b.id !== id && b.slug !== id);
  saveBooks(books);
}

// 把书名转成安全的目录/profile slug（保留中文，去掉非法字符）
export function slugify(title) {
  const cleaned = String(title)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')   // Windows 非法文件名字符
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return cleaned || 'book';
}

export function newId() {
  // 简单时间无关 id：基于已有数量 + 标题哈希（避免 Date.now 依赖）
  return 'bk_' + Math.abs(hash(JSON.stringify(loadBooks()) + Math.floor(performance.now()))).toString(36);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}
