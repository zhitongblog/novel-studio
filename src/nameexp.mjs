// 「书名实验生成器」：为一本书批量生成 N 个候选书名（各主打不同读者钩子）+ 每个配一张【不同画面】的封面底图，
// 供番茄「多书名实验 / 多封面推荐」配实验用。产物落在 book.dir/experiment/（NN.png + manifest.json）。
import fs from 'node:fs';
import path from 'node:path';
import { chatComplete, providerConfigured } from './apichat.mjs';
import { generateCoverBg, ART_ENFORCE } from './imagegen.mjs';

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
// 中国国风强制后缀（复用 imagegen 的 ART_ENFORCE，保持一致）：避免画成西方人/西式场景，且【画面内绝不出文字】。
const ENFORCE = ART_ENFORCE;

function pickProvider(cfg) {
  for (const p of ['zhipu', 'deepseek', 'dashscope']) if (providerConfigured(p, cfg)) return p;
  return null;
}

// 从 bible 抽卖点/主角/时代，喂给出题模型
function bibleDigest(book) {
  const b = readSafe(path.join(book.dir, 'novel_bible.md'));
  const pick = (h) => { const m = b.match(new RegExp('##\\s*' + h + '\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)')); return m ? m[1].trim().replace(/\s+/g, ' ') : ''; };
  return [
    pick('一句话卖点') && ('卖点：' + pick('一句话卖点').slice(0, 300)),
    pick('主角') && ('主角：' + pick('主角').slice(0, 220)),
    pick('时代世界观') && ('时代：' + pick('时代世界观').slice(0, 220)),
  ].filter(Boolean).join('\n');
}

// 主流程。count=候选数。返回 manifest {book, provider, items:[{i,title,hook,cover_prompt,bg}]}。
export async function generateNameExperiment(book, { count = 6, cfg, onLog = () => {} } = {}) {
  const log = (msg, level = 'info') => { try { onLog({ level, msg }); } catch {} };
  const provider = pickProvider(cfg);
  if (!provider) throw new Error('未配置任何 API 文本模型（智谱/DeepSeek/通义），无法生成书名——请在「设置」里填一个 API Key。');
  count = Math.max(2, Math.min(10, Number(count) || 6));
  const digest = bibleDigest(book);
  const genre = book.genre || book.style?.name || '';

  log(`用 ${provider} 生成 ${count} 个候选书名…`, 'act');
  const sys = '你是番茄小说资深主编+封面指导，最懂爆款书名与封面。只输出 JSON，不要任何解释、不要 markdown 代码块围栏。';
  const user =
    `为小说《${book.title}》设计 ${count} 个用于番茄「多书名实验」A/B 测试的候选书名。要求：\n` +
    `① 每个书名主打【不同的读者钩子】(如 绝境反击/打脸/逆袭/权谋/战神/复仇/爽反差/强敌点名/身份反差)，番茄爆款风格、短平快有冲突有代入感、约 10-18 字；\n` +
    `② 为每个书名配一句【英文封面出图提示词 cover_prompt】(≤35 词)：vivid cinematic vertical book-cover key art（单人像填满画面、干净背景，【不要写 poster/海报，别要标题栏或文字】），突出该书名的画面主体(人物神态/动作/服饰)、场景、光影、色调；人物须为中国人东亚面孔、服饰场景符合该时代中国、画面内绝不出现任何文字/字母；\n` +
    `③ 严格贴合下面设定，不得脱离题材/时代/主角；候选之间要有明显差异化。\n` +
    `只输出 JSON 数组，每项形如 {"title":"书名","hook":"钩子(4-6字)","cover_prompt":"english image prompt"}。\n\n` +
    `【小说设定】\n书名：${book.title}\n类型：${genre}\n${digest}`;

  const r = await chatComplete({ provider, cfg, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.9, maxTokens: 4096, onLog });
  const raw = r?.content || '';
  const jsonText = raw.replace(/```(?:json)?/gi, '').trim();
  let arr = null;
  try { const m = jsonText.match(/\[[\s\S]*\]/); arr = JSON.parse(m ? m[0] : jsonText); }
  catch {
    // 截断兜底：逐个抠出完整的 {...} 对象再解析（模型输出被 maxTokens 截断时仍能拿到已完成的候选）
    arr = [];
    for (const o of (jsonText.match(/\{[^{}]*\}/g) || [])) { try { arr.push(JSON.parse(o)); } catch {} }
  }
  arr = (Array.isArray(arr) ? arr : []).filter(x => x && x.title).slice(0, count);
  if (!arr.length) throw new Error('候选书名解析失败（模型输出不规范）：' + raw.slice(0, 160));
  if (!arr.length) throw new Error('模型没返回有效书名');
  log(`已生成 ${arr.length} 个候选书名，开始逐个出【不同画面】封面底图（Imagen）…`, 'act');

  const expDir = path.join(book.dir, 'experiment');
  try { fs.rmSync(expDir, { recursive: true, force: true }); } catch {}   // 清旧的
  fs.mkdirSync(expDir, { recursive: true });
  const items = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    const bgName = `${String(i + 1).padStart(2, '0')}.png`;
    let bg = null, bgErr = '';
    try {
      log(`(${i + 1}/${arr.length}) 出封面：《${it.title}》…`);
      const prompt = String(it.cover_prompt || '').trim();
      generateCoverBg(book, { prompt: prompt ? (prompt + ENFORCE) : undefined, outFile: path.join(expDir, bgName) });
      bg = bgName;
    } catch (e) { bgErr = e.message; log(`《${it.title}》封面失败：${e.message}`, 'warn'); }
    items.push({ i: i + 1, title: String(it.title).trim(), hook: String(it.hook || '').trim(), cover_prompt: String(it.cover_prompt || '').trim(), bg, bgErr });
  }
  const manifest = { book: book.title, slug: book.slug, generatedAt: new Date().toISOString(), provider, count: items.length, items };
  fs.writeFileSync(path.join(expDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const okCount = items.filter(x => x.bg).length;
  log(`✅ 书名实验生成完成：${items.length} 个书名 / ${okCount} 张封面 → experiment/`, 'act');
  return manifest;
}

// 读回已生成的清单（UI 重开时用）
export function readNameExperiment(book) {
  try { return JSON.parse(readSafe(path.join(book.dir, 'experiment', 'manifest.json'))); } catch { return null; }
}
