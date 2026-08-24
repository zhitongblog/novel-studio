// AI 封面底图生成。两条后端，由 config.image.backend 决定：
//   'gemini'（默认）：调 Google Imagen——要 key、要代理、按张计费；
//   'local'          ：调本机 ComfyUI / SD WebUI——零成本、断网可用、不限张数（见 imagelocal.mjs）。
// 走 curl 是因为 Node 内置 fetch 不读环境代理；curl -x 显式走代理稳定，且 -o 落盘避开 stdout 缓冲上限。
//
// 【出图提示词要跟着后端换语言】——这是接本地后端最容易做错的一处：
//   · Imagen / Qwen-Image：吃自然语言长句，Qwen-Image 更是【原生中文】，翻成英文反而丢语义；
//   · SDXL 系：文本编码器是英文 CLIP，喂中文等于喂噪声，必须英文 tag 串。
// 故 buildArtPrompt 按后端分别产出，不再一律走「翻成英文」。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { getModel } from './models.mjs';
import { proxyUrl } from './unterm.mjs';
import { generateLocalImage, LOCAL_NEGATIVE } from './imagelocal.mjs';
import { unloadLocalText, detectGpu } from './localai.mjs';
import { chatComplete } from './apichat.mjs';

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

// 【Imagen 路径】据书的真实内容(时代/主角/题材)润色成一句英文出图提示词，
// 并【硬性追加中国化后缀】杜绝"外国人/西式场景"。失败则回退到含内容的兜底。
export function buildArtPromptSync(book) {
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

// —— 本地后端的出图提示词 ——
// Qwen-Image 原生中文：直接用中文描述画面，比「中译英再喂」保真得多（人物气质、时代器物、国风质感）。
// SDXL：文本编码器只认英文，必须英文 tag 串，且同样要摁住「东亚面孔 + 无文字」。
const ZH_ENFORCE = '，主角是中国人、东亚面孔，服饰与场景符合该时代的中国，国风质感，电影级光影，'
  + '高细节数字绘画，竖版 3:4 单人特写，背景干净不杂乱，画面中不要出现任何文字、字母、水印或签名';

// 用【本地模型】把书的设定润色成一句出图提示词。本地模式的要点就是不依赖云端，
// 所以这里不复用 runCliPrompt(codex/claude)，直接调本地 LLM；失败就退回按设定拼的兜底句。
async function localArtPrompt(book, cfg, zh) {
  const { era, hero } = bibleVisualBits(book);
  const desc = [
    book.title && ('书名《' + book.title + '》'),
    book.genre && ('类型：' + book.genre),
    era && ('时代/世界观：' + era),
    hero && ('主角：' + hero),
  ].filter(Boolean).join('；');
  const heroBit = hero ? hero.replace(/[，。；,].*$/, '') : '';
  const eraBit = era ? era.replace(/[，。；,].*$/, '') : '';
  const fallbackZh = (heroBit || '一位神情坚毅的中国主角') + (eraBit ? '，身处' + eraBit : '，历史中国背景');
  const fallbackEn = 'Chinese webnovel cover illustration of ' + (heroBit || 'a determined Chinese hero')
    + (eraBit ? ', set in ' + eraBit : ', historical China');

  // ⚠️ 【别让模型自己加设定】——实测本地 14B 会往画面里塞设定里没有的东西：
  // 设定写的是「形意拳传人」（空手），它却写出「负剑而立」，出来的封面凭空多了一把剑，
  // 跟正文对不上。这类添油加醋在云端强模型上少见，本地模型必须显式摁住。
  const NO_INVENT = '【硬性约束】只能依据上面给出的设定作画。严禁自行添加设定里没有的兵器、法器、坐骑、'
    + '随从、身份标识或超自然元素——设定没写他用兵器，就不要给他任何刀剑枪棍；没写异能，'
    + '就不要有光效、灵气、符文。拿不准的细节宁可不写，也不要编。';

  const instruction = (zh
    ? '你是顶级插画指导。为下面这本中文网络小说写【一句中文出图提示词】，用于 AI 出封面插画。要求：'
      + '①一段话、画面感极强：写清主体人物的神态/动作/服饰、场景、构图、光影、色调；'
      + '②贴合小说的主角形象与时代；③画面里不要任何文字。只输出这句提示词本身，不要解释、不要引号。'
    : '你是顶级插画指导。为下面这本中文网络小说写【一句英文出图提示词】(用于 SDXL)。要求：'
      + '①纯英文、逗号分隔的 tag 串、画面感强：主体人物(神态/动作/服饰)、场景、构图、光影、色调、艺术风格；'
      + '②人物必须是中国人、东亚面孔，服饰场景符合该时代的中国；③不要任何文字/字母。'
      + '只输出这串英文 tag，不要解释、不要引号。'
  ) + '\n\n' + NO_INVENT + '\n\n小说信息：' + desc;

  try {
    const r = await chatComplete({
      provider: 'local', cfg, maxTokens: 400, temperature: 0.85,
      messages: [{ role: 'user', content: instruction }],
    });
    // <think> 推理段 chatComplete 里已统一剥掉，这里只清首尾引号/空白
    let t = String(r.content || '').trim();
    t = t.replace(/^[\s"'\u201c\u201d]+|[\s"'\u201c\u201d]+$/g, '').replace(/\s+/g, ' ').trim();
    if (zh && t.length > 8) return t + ZH_ENFORCE;
    if (!zh && t.length > 15 && !/[\u4e00-\u9fff]/.test(t)) return sanitizeArtPrompt(t) + ART_ENFORCE;
  } catch {}
  return zh ? (fallbackZh + ZH_ENFORCE) : (fallbackEn + ART_ENFORCE);
}

// 生成封面底图：Imagen 出 3:4 竖图，默认存到 book.dir/cover_bg.png（可用 outFile 另存，供多封面实验用），返回 {file, prompt, w, h}。
export async function generateCoverBg(book, { prompt, outFile, onLog = () => {} } = {}) {
  const cfg = loadConfig();
  const backend = cfg.image?.backend || 'gemini';
  let buf, artPrompt;

  if (backend === 'local') {
    // 中文 prompt 只在 ComfyUI + Qwen-Image 上用（SDXL / SD WebUI 的英文 CLIP 读不懂中文）。
    const useZh = cfg.image?.comfy?.preset === 'qwen-image' && cfg.image?.localBackend !== 'a1111';
    artPrompt = (prompt && prompt.trim()) || await localArtPrompt(book, cfg, useZh);
    if (!useZh) artPrompt = sanitizeArtPrompt(artPrompt);   // 英文路径仍要剥掉 poster/book cover 等诱发文字的版式词
    onLog({ level: 'act', msg: '本地出图（' + (cfg.image?.localBackend === 'a1111' ? 'SD WebUI' : 'ComfyUI · ' + (cfg.image?.comfy?.preset || 'sdxl')) + '）…' });
    // 显存不够两边同时占（12G 卡上 14B 文本模型 10G + 出图 12G）→ 先把文本模型请出去。
    // 提示词已经生成完了，这时卸载不影响本次出图；写下一章时 Ollama 会自动重载（约 15 秒）。
    // 显存足够大（≥20G）就不折腾，两边常驻更省事。
    const gpu = detectGpu();
    if (cfg.image?.autoUnloadText !== false && (!gpu.ok || gpu.totalMb < 20000)) {
      const u = await unloadLocalText(cfg.api?.local?.baseUrl, cfg.api?.local?.model);
      if (u.unloaded) onLog({ level: 'info', msg: `  已暂时卸载文本模型 ${u.name} 腾出 ${u.freedGb}G 显存（下次写作会自动重载，约 15 秒）` });
    }
    buf = await generateLocalImage({ prompt: artPrompt, negative: cfg.image?.negative || LOCAL_NEGATIVE, cfg, onLog });
  } else {
    const g = gcfg();
    artPrompt = sanitizeArtPrompt((prompt && prompt.trim()) || buildArtPromptSync(book));   // 剥掉 poster/book cover 等诱发文字的版式词
    const body = { instances: [{ prompt: artPrompt }], parameters: { sampleCount: 1, aspectRatio: '3:4' } };
    const j = curlJson(`${HOST}/models/${g.imageModel}:predict?key=${g.apiKey}`, body, 120);
    const b64 = j.predictions?.[0]?.bytesBase64Encoded || j.predictions?.[0]?.image?.bytesBase64Encoded;
    if (!b64) throw new Error('未返回图片（可能被安全策略拦截，换个题材描述再试）');
    buf = Buffer.from(b64, 'base64');
  }

  const file = outFile || path.join(book.dir, 'cover_bg.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  let w = 0, h = 0;
  try { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); } catch {}
  return { file, prompt: artPrompt, w, h, bytes: buf.length };
}

// 供 UI「只出提示词给用户看/改」用：按当前后端产出对应语言的提示词。
export async function buildArtPromptAuto(book) {
  const cfg = loadConfig();
  if ((cfg.image?.backend || 'gemini') === 'local') {
    const useZh = cfg.image?.comfy?.preset === 'qwen-image' && cfg.image?.localBackend !== 'a1111';
    return await localArtPrompt(book, cfg, useZh);
  }
  return buildArtPromptSync(book);
}

// 兼容旧调用名（Imagen 路径的同步实现）。
export { buildArtPromptSync as buildArtPrompt };
