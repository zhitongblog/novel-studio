// AI 封面底图生成：调用 Google Imagen（出竖版插画），把中文题材润色成英文出图提示词。
// 走 curl 是因为 Node 内置 fetch 不读环境代理；curl -x 显式走代理稳定，且 -o 落盘避开 stdout 缓冲上限。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.mjs';

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
  const r = spawnSync('curl', args, { encoding: 'utf8' });
  let out = {};
  try { out = JSON.parse(fs.readFileSync(respF, 'utf8')); } catch (e) { out = { _raw: (() => { try { return fs.readFileSync(respF, 'utf8').slice(0, 300); } catch { return ''; } })() }; }
  try { fs.unlinkSync(reqF); } catch {}
  try { fs.unlinkSync(respF); } catch {}
  if (r.status !== 0 && !out.predictions && !out.candidates) throw new Error('curl 失败(' + r.status + ')：' + (r.stderr || '').slice(0, 200));
  if (out.error) throw new Error('Gemini ' + out.error.code + '：' + out.error.message);
  return out;
}

// 让 Gemini 文本模型把"书名/题材/文风"润色成一句英文出图提示词（不含文字，竖版插画）。失败则回退到本地拼接。
export function buildArtPrompt(book) {
  const g = gcfg();
  const desc = [
    book.title && ('书名《' + book.title + '》'),
    book.genre && ('题材：' + book.genre),
    book.style?.name && ('文风：' + book.style.name + (book.style.short ? '（' + book.style.short + '）' : '')),
  ].filter(Boolean).join('；');
  // 纯英文兜底（不嵌中文，避免 Imagen 把"题材里的中文注意事项"当画面元素）
  const fallback = 'Chinese webnovel cover illustration, dramatic historical martial-arts story set in Republic-era China, cinematic lighting, atmospheric, highly detailed, vertical poster composition, no text, no letters';
  const body = {
    contents: [{ parts: [{ text:
      '为一本中文网络小说生成"封面插画"的英文出图提示词。要求：一句话、纯英文、画面感强、电影质感、竖版海报构图、不含任何文字/字母/书法。' +
      '只输出提示词本身，不要解释、不要引号。\n小说信息：' + desc }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } },
  };
  for (let attempt = 0; attempt < 2; attempt++) {   // 文本模型偶尔返回空，重试一次
    try {
      const j = curlJson(`${HOST}/models/${g.textModel}:generateContent?key=${g.apiKey}`, body, 30);
      let t = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '';
      t = t.replace(/^["'""]|["'""]$/g, '').replace(/\s+/g, ' ').trim();
      if (t.length > 10 && !/[一-鿿]/.test(t)) return t + ', vertical poster, no text';
    } catch {}
  }
  return fallback;
}

// 生成封面底图：Imagen 出 3:4 竖图，存到 book.dir/cover_bg.png，返回 {file, prompt, w, h}。
export function generateCoverBg(book, { prompt } = {}) {
  const g = gcfg();
  const artPrompt = (prompt && prompt.trim()) || buildArtPrompt(book);
  const body = { instances: [{ prompt: artPrompt }], parameters: { sampleCount: 1, aspectRatio: '3:4' } };
  const j = curlJson(`${HOST}/models/${g.imageModel}:predict?key=${g.apiKey}`, body, 120);
  const b64 = j.predictions?.[0]?.bytesBase64Encoded || j.predictions?.[0]?.image?.bytesBase64Encoded;
  if (!b64) throw new Error('未返回图片（可能被安全策略拦截，换个题材描述再试）');
  const buf = Buffer.from(b64, 'base64');
  const file = path.join(book.dir, 'cover_bg.png');
  fs.mkdirSync(book.dir, { recursive: true });
  fs.writeFileSync(file, buf);
  let w = 0, h = 0;
  try { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); } catch {}
  return { file, prompt: artPrompt, w, h, bytes: buf.length };
}
