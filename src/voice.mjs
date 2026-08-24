// 文风注入 —— 把「对标文风」真正送进写作提示词。
//
// 【为什么单独做这个模块】
// 项目里本来就有「📚 对标风格」：从番茄截图里让 AI 分析出一份 {name, rules} 存进 book.style。
// 但查下来它只被封面生成和书名实验用到（而且只取了 name），
// 共创 / 单章重写 / API 写作【三条写正文的路径，一条都没用上】——bookGist() 里根本没有文风。
// 所以用户感觉"对标文风没效果"不是效果弱，是压根没接线。
//
// 【比接线更关键的一件事：范文原文 > 范文的描述】
// 原来的链路是：真实范文 → AI 分析 → 一段"多用短句、注重实锚、对话带潜台词"的规则描述 → 提示词。
// 这一步是【有损压缩】：把范文里真正独特的东西（句子的呼吸、偏爱的意象、说话的方式）
// 全滤成了任何一本网文都适用的通用建议。而模型【模仿例子的能力远强于遵守描述】。
// 所以这里除了 rules，还支持挂【原文片段】(book.styleRefs)，直接给模型看"要写成这样"。

import fs from 'node:fs';
import path from 'node:path';

// 单段范文的长度上限：太短学不到句子的呼吸，太长挤占上下文（本地模型尤其吃紧）。
const ONE_MAX = 1200;
const TOTAL_MAX = 3600;

// 读本书挂着的范文片段。存放约定：书目录下 style_refs/*.txt，一个文件一段。
// 用文件而不是塞进 books.json：范文动辄几千字，塞进配置会把它撑爆，也不好编辑。
export function readStyleRefs(book, { totalMax = TOTAL_MAX } = {}) {
  const dir = path.join(book.dir, 'style_refs');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => /\.(txt|md)$/i.test(f)).sort();
  } catch { return []; }
  const out = [];
  let used = 0;
  for (const f of files) {
    if (used >= totalMax) break;
    let t = '';
    try { t = fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { continue; }
    if (!t) continue;
    const room = Math.min(ONE_MAX, totalMax - used);
    const seg = t.slice(0, room);
    out.push({ name: f.replace(/\.(txt|md)$/i, ''), text: seg });
    used += seg.length;
  }
  return out;
}

// 文风段：规则（如果有）+ 原文片段（如果有）。两者都没有就返回空串，不往提示词里塞噪音。
export function voiceSection(book) {
  const lines = [];
  const st = book && book.style;
  if (st && st.rules) {
    lines.push(`【对标文风：${st.name || '自定义'}】`);
    lines.push(String(st.rules).trim());
  }

  const refs = readStyleRefs(book);
  if (refs.length) {
    lines.push('');
    lines.push('【文风范本（最重要）】：下面是作者认可的文字。');
    lines.push('你要学的是它的【句子呼吸、用词习惯、叙述距离、对话的说法、标点节奏】——');
    lines.push('也就是"这个人是怎么写字的"，而不是它写了什么。');
    lines.push('⚠️ 严禁照抄范本里的情节、人物、地名、专有名词或成句——只学写法，内容必须全部是本书自己的。');
    lines.push('比起上面任何一条规则描述，【这些范本更能说明作者要什么】，冲突时以范本为准。');
    for (const r of refs) {
      lines.push('');
      lines.push(`—— 范本《${r.name}》 ——`);
      lines.push(r.text);
    }
    lines.push('—— 范本结束 ——');
  }

  return lines.length ? '\n' + lines.join('\n') + '\n' : '';
}

// 有没有可用的文风信息（供 UI 提示"这本书还没设对标文风"）。
export function hasVoice(book) {
  return !!(book && book.style && book.style.rules) || readStyleRefs(book).length > 0;
}

// 写入一段范文（UI 上传用）。返回落盘的文件名。
export function saveStyleRef(book, name, text) {
  const dir = path.join(book.dir, 'style_refs');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || '范本').trim().replace(/[\\/:*?"<>|\r\n]+/g, '').slice(0, 40) || '范本';
  const fp = path.join(dir, safe + '.txt');
  fs.writeFileSync(fp, String(text || '').trim() + '\n', 'utf8');
  return safe + '.txt';
}

export function listStyleRefs(book) {
  const dir = path.join(book.dir, 'style_refs');
  try {
    return fs.readdirSync(dir).filter(f => /\.(txt|md)$/i.test(f)).map(f => {
      let n = 0;
      try { n = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\s/g, '').length; } catch {}
      return { file: f, name: f.replace(/\.(txt|md)$/i, ''), chars: n };
    });
  } catch { return []; }
}

export function removeStyleRef(book, file) {
  const safe = path.basename(String(file || ''));
  if (!/\.(txt|md)$/i.test(safe)) return false;
  try { fs.unlinkSync(path.join(book.dir, 'style_refs', safe)); return true; } catch { return false; }
}
