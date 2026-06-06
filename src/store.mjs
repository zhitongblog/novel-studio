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

export function upsertBook(book) {
  const books = loadBooks();
  const i = books.findIndex(b => b.id === book.id);
  if (i >= 0) books[i] = { ...books[i], ...book };
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
