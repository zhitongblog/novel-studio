// AI 封面底图生成：调用 Google Imagen（出竖版插画），把中文题材润色成英文出图提示词。
// 走 curl 是因为 Node 内置 fetch 不读环境代理；curl -x 显式走代理稳定，且 -o 落盘避开 stdout 缓冲上限。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { getModel } from './models.mjs';
import { proxyUrl } from './unterm.mjs';

// 出图硬约束（所有封面/书名实验封面共用）：强制中国人/东亚面孔/该时代中国场景/国风 +【画面内绝不出现任何文字】。
// ⚠️ 关键坑：Imagen 会照着【版式词】画文字——"poster"→电影海报(带标题+片尾字幕)、"book cover"→画成一本带书名的实体书，
//    都是糊成乱码的假字。书名是我们后期 canvas 叠上去的，底图必须【干净无字】。故【绝不用 poster/book cover 这类版式词】，
//    只描述"单人特写插画·纯净背景"。文字提示用温和的 no text/no letters(说太多反而诱发文字)。配合 sanitizeArtPrompt 兜底剥词。
export const ART_ENFORCE = ', the main character is a Chinese person with East Asian facial features (NOT western or caucasian), authentic Chinese historical setting and costume true to the era, Chinese guofeng aesthetic, cinematic dramatic lighting, highly detailed digital painting, vertical 3:4 full-frame single character portrait, plain clean uncluttered background, no text, no letters, no watermark, no signature';

// 兜底剥掉会诱发文字的【版式词】(poster/book cover/movie poster/typography/title/credits…)，换成"人物特写插画"或删掉。
// 不管 cover_prompt 或模型输出里混进这些词，送进 Imagen 前都清一遍——避免画成带乱码假字的海报/实体书。
export function sanitizeArtPrompt(s) {
  return String(s || '')
    .replace(/\b(movie|film)\s+posters?\b/gi, 'cinematic character portrait')
    .replace(/\b(book\s*covers?|cover\s*art)\b/gi, 'character portrait')
    .replace(/\bposters?\b/gi, 'character portrait')
    .replace(/\b(title\s*bar|title\s*text|typography|captions?|credits?|text overlay|lettering|logos?)\b/gi, '')
    .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
}

// 去掉 ANSI 转义序列与不可见控制字符（codex/claude CLI 输出常带，漏进文本会显示成乱码）。
export function stripCtrl(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')   // ANSI CSI/SGR 序列
    .replace(/\x1b[@-Z\\-_]/g, '')                // 其他 ESC 序列
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // 控制字符(保留 \t\n\r)
}

// 用 CLI 模型(codex/claude)无头跑一段提示，返回原始输出。用于写"英文出图提示词"。
export function runCliPrompt(model, prompt, cfg, timeoutMs = 120000) {
  const m = getModel(model);
  if (!m) return '';
  const env = { ...process.env };
  if (cfg?.enableProxy) { const px = proxyUrl(); if (px) { env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = env.http_proxy = env.https_proxy = px; } }
  const args = model === 'codex' ? ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'] : ['-p'];
  const r = spawnSync(m.bin, args, { encoding: 'utf8', timeout: timeoutMs, input: prompt, cwd: os.tmpdir(), env, maxBuffer: 8 * 1024 * 1024, shell: true, windowsHide: true });
  return (r.stdout || '') + '\n' + (r.stderr || '');
}

// 从 CLI 输出里抽出英文出图提示词：丢中文行、codex/claude CLI 横幅日志，去重(codex 常打印两遍)，拼成一句。
function cleanEnglishPrompt(raw) {
  const t = stripCtrl(String(raw || '')).replace(/```[\s\S]*?```/g, ' ');
  const BANNER = /Reading prompt from stdin|OpenAI Codex|^(workdir|sandbox|reasoning(\s+(effort|summaries))?|session id|model|provider|approval|tokens?(\s+used)?|user|system|---)\s*[:：]/i;
  const META = /^(here(\s|'|’|:)|note|prompt|output|sure|certainly|okay|of course|i['’]?ll|let me|this prompt|english prompt)/i;
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .filter(l => !/[一-鿿]/.test(l) && l.length > 25 && /[a-zA-Z]/.test(l) && !BANNER.test(l) && !META.test(l));
  // 去重相同行（codex exec 常把答案打印两遍：stdout + 回显）
  const seen = new Set(), uniq = [];
  for (const l of lines) { const k = l.slice(0, 60).toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(l); } }
  return uniq.join(' ').replace(/^["'`*\s]+|["'`*\s]+$/g, '').replace(/\s+/g, ' ').trim();
}

const HOST = 'https://generativelanguage.googleapis.com/v1beta';

function gcfg() {
  const g = loadConfig().gemini || {};
  if (!g.apiKey) throw new Error('未配置 Gemini API key（设置里填 AIza... 那串）');
  return g;
}

// 用 curl 经代理 POST JSON，结果落临时文件再读回（响应可达 1~2MB）。
function curlJson(url, bodyObj, timeoutSec = 90) {
  const g = loadConfig().gemini || {};
  const tmp = path.join(os.tmpdir(), 'ns_' + process.pid + '_' + (curlJson._n = (curlJson._n || 0) + 1));
  const reqF = tmp + '.req.json', respF = tmp + '.resp.json';
  fs.writeFileSync(reqF, JSON.stringify(bodyObj), 'utf8');
  const args = ['-s', '-m', String(timeoutSec)];
  if (g.proxy) args.push('-x', g.proxy);
  args.push('-X', 'POST', url, '-H', 'Content-Type: application/json', '-d', '@' + reqF, '-o', respF);

  // 代理(Clash 127.0.0.1:7897)切节点时会瞬断→curl SSL/连接错(exit 35/7/28/56)。
  // 这类网络瞬断重试最多 4 次(指数退避)，不要一挂就让整个封面生成失败。
  const TRANSIENT = new Set([7, 28, 35, 52, 56, 6, 16]);   // 连接/SSL/超时/空回复/DNS 类
  let r, out = {}, lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800 * attempt); } catch {} }   // 同步退避(无CPU空转)
    r = spawnSync('curl', args, { encoding: 'utf8' });
    try { out = JSON.parse(fs.readFileSync(respF, 'utf8')); } catch (e) { out = { _raw: (() => { try { return fs.readFileSync(respF, 'utf8').slice(0, 300); } catch { return ''; } })() }; }
    if (out.predictions || out.candidates) break;   // 成功
    if (out.error) break;                            // API 业务错(key/配额等)，重试无用，直接抛
    if (r.status === 0) break;                       // curl 成功但内容异常(非网络问题)
    lastErr = '(exit ' + r.status + ') ' + (r.stderr || '').slice(0, 120);
    if (!TRANSIENT.has(r.status)) break;             // 非网络瞬断错误，不重试
    // 否则是网络瞬断 → 继续重试
  }
  try { fs.unlinkSync(reqF); } catch {}
  try { fs.unlinkSync(respF); } catch {}
  if (r.status !== 0 && !out.predictions && !out.candidates) throw new Error('网络请求失败' + lastErr + '（代理可能瞬断，已重试；可重试一次或检查 Clash 节点）');
  if (out.error) throw new Error('Gemini ' + out.error.code + '：' + out.error.message);
  return out;
}

// 读 novel_bible.md，抽取贴合封面的内容：时代/世界观、主角形象。
function bibleVisualBits(book) {
  let era = '', hero = '';
  try {
    const bible = fs.readFileSync(path.join(book.dir, 'novel_bible.md'), 'utf8');
    const em = bible.match(/时代\s*\/?\s*世界观[：:]\s*([^\n]+)/);
    if (em) era = em[1].replace(/[（(].*$/, '').trim().slice(0, 100);
    const hm = bible.match(/(?:^|\n)[-\s]*主角[：:]\s*([^\n]+)/);
    if (hm) hero = hm[1].replace(/[（(].*$/, '').trim().slice(0, 100);
  } catch {}
  return { era, hero };
}

// 让 Gemini 文本模型据【书的真实内容(时代/主角/题材)】润色成一句英文出图提示词，
// 并【硬性追加中国化后缀】杜绝"外国人/西式场景"。失败则回退到含内容的兜底。
export function buildArtPrompt(book) {
  const cfg = loadConfig();
  const g = cfg.gemini || {};
  const promptModel = g.promptModel || 'codex';
  const { era, hero } = bibleVisualBits(book);
  const desc = [
    book.title && ('书名《' + book.title + '》'),
    book.genre && ('类型：' + book.genre),
    era && ('时代/世界观：' + era),
    hero && ('主角：' + hero),
    book.style?.name && ('文风：' + book.style.name),
  ].filter(Boolean).join('；');
  // 无论模型输出什么，都追加这段——强制中国人/东亚面孔/该时代中国场景/国风，避免画成西方人。
  const ENFORCE = ART_ENFORCE;
  const fallback = ('Chinese webnovel cover illustration of ' + (hero ? hero.replace(/[，。；,].*$/, '') : 'a determined Chinese hero') + (era ? ', set in ' + era.replace(/[，。；,].*$/, '') : ', historical China')).slice(0, 220);
  const instruction =
    '你是顶级插画指导。为一本中文网络小说写一句【英文出图提示词】，用于 AI 出封面插画。要求：' +
    '①纯英文、一段、画面感极强：明确主体人物(神态/动作/服饰)、场景、构图、光影、色调、艺术风格(如 cinematic, dramatic lighting, highly detailed digital painting)；' +
    '②贴合下面的小说内容(主角形象/时代/场景)；③人物必须是【中国人、东亚面孔】，服饰场景必须符合该时代的【中国】，绝不出现西方人/西式建筑/西方服饰；④画面里不要任何文字/字母/书法。' +
    '只输出这句英文提示词本身，不要解释、不要引号、不要前后缀。\n\n小说信息：' + desc;

  // 默认 codex/claude 无头写提示词（更会描述画面）；promptModel='gemini' 时回退到旧的 API 路径。
  if (promptModel !== 'gemini') {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const t = cleanEnglishPrompt(runCliPrompt(promptModel, instruction, cfg, 120000));
        if (t.length > 15 && !/[一-鿿]/.test(t)) return t + ENFORCE;
      } catch {}
    }
    return fallback + ENFORCE;
  }

  // 旧路径：gemini 文本 API
  if (!g.apiKey) return fallback + ENFORCE;
  const body = {
    contents: [{ parts: [{ text: instruction }] }],
    generationConfig: { temperature: 0.85, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const j = curlJson(`${HOST}/models/${g.textModel}:generateContent?key=${g.apiKey}`, body, 30);
      let t = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '';
      t = t.replace(/^["'""]|["'""]$/g, '').replace(/\s+/g, ' ').trim();
      if (t.length > 10 && !/[一-鿿]/.test(t)) return t + ENFORCE;
    } catch {}
  }
  return fallback + ENFORCE;
}

// 生成封面底图：Imagen 出 3:4 竖图，默认存到 book.dir/cover_bg.png（可用 outFile 另存，供多封面实验用），返回 {file, prompt, w, h}。
export function generateCoverBg(book, { prompt, outFile } = {}) {
  const g = gcfg();
  const artPrompt = sanitizeArtPrompt((prompt && prompt.trim()) || buildArtPrompt(book));   // 剥掉 poster/book cover 等诱发文字的版式词
  const body = { instances: [{ prompt: artPrompt }], parameters: { sampleCount: 1, aspectRatio: '3:4' } };
  const j = curlJson(`${HOST}/models/${g.imageModel}:predict?key=${g.apiKey}`, body, 120);
  const b64 = j.predictions?.[0]?.bytesBase64Encoded || j.predictions?.[0]?.image?.bytesBase64Encoded;
  if (!b64) throw new Error('未返回图片（可能被安全策略拦截，换个题材描述再试）');
  const buf = Buffer.from(b64, 'base64');
  const file = outFile || path.join(book.dir, 'cover_bg.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  let w = 0, h = 0;
  try { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); } catch {}
  return { file, prompt: artPrompt, w, h, bytes: buf.length };
}
