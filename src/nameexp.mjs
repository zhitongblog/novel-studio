// 「书名实验生成器」：为一本书批量生成 N 个候选书名（各主打不同读者钩子，严格 ≤15 字且符合番茄字符白名单）
// + 每个配一张【不同画面】的封面底图与合成好书名/作者名的成品封面（NN.titled.png），
// 供番茄「多书名实验 / 多封面推荐」配实验用。产物落在 book.dir/experiment/（NN.png + NN.titled.png + manifest.json）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { chatComplete, pickProvider } from './apichat.mjs';
import { generateCoverBg, ART_ENFORCE } from './imagegen.mjs';
import { loadConfig } from './config.mjs';

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
const ENFORCE = ART_ENFORCE;

// 番茄「多书名实验」书名清洗：
// 1. 仅支持中英文、数字及符号 ，：！？【】
// 2. 不得含有空格
// 3. 长度严格 ≤ 15 字
export function sanitizeFanqieExpTitle(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/[《》「」『』""''"']/g, '');
  s = s.replace(/,/g, '，').replace(/:/g, '：').replace(/!/g, '！').replace(/\?/g, '？').replace(/\[/g, '【').replace(/\]/g, '】');
  // 去掉所有不允许的字符与空白
  s = s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5，：！？【】]/g, '');
  // 去掉首尾标点
  s = s.replace(/^[，：！？]+|[，]+$/g, '');
  if (s.length > 15) s = s.slice(0, 15).replace(/[，：]$/, '');
  return s;
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

// 智谱 cogview-3-flash 兜底出图（国内直连免代理，768x1344 裁顶部 3:4 自动去角标）
async function generateZhipuCoverBg(promptZh, outFile, cfg) {
  const key = cfg?.api?.zhipu?.apiKey || loadConfig()?.api?.zhipu?.apiKey;
  if (!key) throw new Error('未配置智谱 API Key');
  const safePrompt = String(promptZh || '中国古风网络小说主角半身特写插画，眼神坚毅，电影级戏剧光影，写实厚涂数字绘画')
    .replace(/染血|滴血|血洗|杀气腾腾|凶狠|屠尽|造反|劈碎|砸碎|死战|自刎|尸体|碎尸/g, '威严坚毅')
    + '，中国古风审美，电影级戏剧光影，写实厚涂数字绘画，竖版半身特写，画面干净唯美，画面无任何文字';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: 'cogview-3-flash', prompt: safePrompt, size: '768x1344' }),
    }).then(r => r.json());
    const url = resp?.data?.[0]?.url;
    if (url) {
      const buf = Buffer.from(await fetch(url).then(r => r.arrayBuffer()));
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, buf);
      return { file: outFile, bytes: buf.length, provider: 'zhipu-cogview' };
    }
    if (resp?.error?.code === '1301') {
      // 若触发内容过滤，退回安全通用古风人物特写提示词再试一次
      const fallback = '中国古风插画，宏伟古建筑前，一位剑眉星目的中国青年主角身穿华贵古装锦袍与铠甲，神情坚毅自信，温暖金色阳光，电影级戏剧光影，写实厚涂数字绘画，竖版半身特写，画面无任何文字';
      const resp2 = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: 'cogview-3-flash', prompt: fallback, size: '768x1344' }),
      }).then(r => r.json());
      const url2 = resp2?.data?.[0]?.url;
      if (url2) {
        const buf = Buffer.from(await fetch(url2).then(r => r.arrayBuffer()));
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, buf);
        return { file: outFile, bytes: buf.length, provider: 'zhipu-cogview' };
      }
    }
  }
  throw new Error('智谱 cogview 出图失败');
}

// 用本机 Python Pillow 把 experiment/ 下的 NN.png 裁成 600x800（去底部水印）并烤出带双行标题+笔名的 NN.titled.png
export function bakeExperimentTitledCoversServer(expDir, author = '光头通') {
  try {
    const pyCode = `
import os, sys, json, re
from PIL import Image, ImageDraw, ImageFont, ImageFilter

PALETTES = [
    {"line1": (255, 250, 235, 255), "line2": (255, 218, 115, 255), "accent": (255, 215, 120, 180)},
    {"line1": (255, 248, 240, 255), "line2": (255, 195, 110, 255), "accent": (255, 180, 100, 180)},
    {"line1": (245, 252, 255, 255), "line2": (150, 230, 255, 255), "accent": (140, 220, 255, 180)},
    {"line1": (255, 252, 230, 255), "line2": (255, 205, 85, 255), "accent": (245, 200, 90, 180)},
    {"line1": (250, 255, 245, 255), "line2": (235, 225, 145, 255), "accent": (220, 215, 140, 180)},
]

def split_title(title):
    m = re.search(r'[，：！？]', title)
    if m and 0 < m.start() < len(title) - 1:
        return title[:m.start()+1], title[m.start()+1:]
    if len(title) > 8:
        mid = (len(title) + 1) // 2
        return title[:mid], title[mid:]
    return title, ''

def render_one(bg_path, out_path, title, idx=0, author="光头通"):
    img = Image.open(bg_path).convert('RGBA')
    w, h = img.size
    target_h = int(w * 4 / 3)
    if target_h < h:
        img = img.crop((0, 0, w, target_h))
        # 同时把裁掉底部水印后的干净 600x800 底图写回 bg_path，供前端 canvas 直接绘制
        img.resize((600, 800), Image.Resampling.LANCZOS).convert('RGB').save(bg_path, 'PNG')
    img = img.resize((600, 800), Image.Resampling.LANCZOS)
    pal = PALETTES[idx % len(PALETTES)]
    overlay = Image.new('RGBA', (600, 800), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    for y in range(410, 800):
        t = (y - 410) / 390.0
        alpha = int(238 * (t ** 1.32))
        odraw.line([(0, y), (600, y)], fill=(8, 6, 5, alpha))
    odraw.rectangle([18, 18, 582, 782], outline=(pal["accent"][0], pal["accent"][1], pal["accent"][2], 125), width=2)
    odraw.rectangle([24, 24, 576, 776], outline=(pal["accent"][0], pal["accent"][1], pal["accent"][2], 55), width=1)
    odraw.line([(140, 532), (460, 532)], fill=pal["accent"], width=2)
    odraw.polygon([(300, 525), (307, 532), (300, 539), (293, 532)], fill=(pal["line2"][0], pal["line2"][1], pal["line2"][2], 230))
    img = Image.alpha_composite(img, overlay)
    line1, line2 = split_title(title)
    max_len = max(len(line1), len(line2), 1)
    font_size = 54 if max_len <= 7 else (48 if max_len <= 8 else (44 if max_len <= 9 else 40))
    font_path = 'C:/Windows/Fonts/STZHONGS.TTF'
    if not os.path.exists(font_path): font_path = 'C:/Windows/Fonts/simhei.ttf'
    font_title = ImageFont.truetype(font_path, font_size)
    font_author = ImageFont.truetype(font_path, 24)
    txt_layer = Image.new('RGBA', (600, 800), (0, 0, 0, 0))
    sh_layer = Image.new('RGBA', (600, 800), (0, 0, 0, 0))
    tdraw = ImageDraw.Draw(txt_layer)
    sdraw = ImageDraw.Draw(sh_layer)
    def draw_centered(y, text, font, fill, stroke_w=3):
        bbox = tdraw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        x = (600 - tw) // 2
        sdraw.text((x, y + 4), text, font=font, fill=(0, 0, 0, 235), stroke_width=stroke_w+2, stroke_fill=(0, 0, 0, 235))
        tdraw.text((x, y), text, font=font, fill=fill, stroke_width=stroke_w, stroke_fill=(20, 10, 0, 255))
    if line2:
        draw_centered(555, line1, font_title, pal["line1"], 3)
        draw_centered(622, line2, font_title, pal["line2"], 3)
    else:
        draw_centered(590, line1, font_title, pal["line2"], 3)
    if author:
        draw_centered(718, f"{author} · 著", font_author, (240, 232, 215, 235), 2)
    sh_layer = sh_layer.filter(ImageFilter.GaussianBlur(radius=4))
    img = Image.alpha_composite(img, sh_layer)
    img = Image.alpha_composite(img, txt_layer)
    img.convert('P', palette=Image.Palette.ADAPTIVE, colors=256).save(out_path, 'PNG', optimize=True)

exp_dir = sys.argv[1]
author_arg = sys.argv[2] if len(sys.argv) > 2 else "光头通"
m_path = os.path.join(exp_dir, "manifest.json")
with open(m_path, "r", encoding="utf-8") as f:
    m = json.load(f)
author_name = m.get("author") or author_arg
for idx, it in enumerate(m.get("items", [])):
    bg_name = it.get("bg") or f"{idx+1:02d}.png"
    bg_p = os.path.join(exp_dir, bg_name)
    if not os.path.exists(bg_p): continue
    titled_p = os.path.join(exp_dir, re.sub(r'\\.png$', '.titled.png', bg_name, flags=re.I))
    render_one(bg_p, titled_p, it.get("title", ""), idx, author_name)
`;
    const tmpPy = path.join(os.tmpdir(), 'ns_bake_exp_' + process.pid + '.py');
    fs.writeFileSync(tmpPy, pyCode, 'utf8');
    spawnSync('python', [tmpPy, expDir, String(author || '光头通')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    try { fs.unlinkSync(tmpPy); } catch {}
  } catch {}
}

// 主流程。count=候选数（默认 5，对齐番茄多书名实验上限 5 组）。返回 manifest。
export async function generateNameExperiment(book, { count = 5, author = '光头通', cfg, onLog = () => {} } = {}) {
  const log = (msg, level = 'info') => { try { onLog({ level, msg }); } catch {} };
  const provider = pickProvider(cfg);
  if (!provider) throw new Error('没有可用的文本模型。要么在「设置 · API 模型」填一个云端 Key（智谱/DeepSeek/通义），'
    + '要么在「设置 · 本地模型」配好本地 Ollama。');

  count = Math.max(2, Math.min(10, Number(count) || 5));
  const digest = bibleDigest(book);
  const genre = book.genre || book.style?.name || '';

  log(`用 ${provider} 生成 ${count} 个候选书名（严格 ≤15 字）…`, 'act');
  const sys = '你是番茄小说资深主编+封面指导，最懂爆款书名与封面。只输出 JSON 数组，不要任何解释、不要 markdown 代码块围栏。';
  const user =
    `为小说《${book.title}》设计 ${count} 个用于番茄「多书名实验」A/B 测试的候选书名。要求：\n` +
    `① 每个书名主打【不同的读者钩子】(如 绝境反击/打脸/逆袭/权谋/战神/复仇/爽反差/身份反差)，番茄爆款风格、有强烈反差与代入感；\n` +
    `② 【硬性字数与符号限制】每个书名严格控制在 10～15 个字以内（绝对不能超过 15 个字！），不能包含空格，标点符号只能使用中文逗号「，」、冒号「：」、感叹号「！」或问号「？」；\n` +
    `③ 为每个书名配一句【中文古风/国风封面出图提示词 cover_prompt_zh】（40～70字，突出主角半身特写、服饰、场景、电影级戏剧光影，避免血腥暴力敏感词，画面内绝不出现文字）和一句【英文封面提示词 cover_prompt】（≤35 词，vivid cinematic vertical character portrait, East Asian features, no text）；\n` +
    `④ 严格贴合下面设定，不得脱离题材/时代/主角；候选之间要有明显差异化。\n` +
    `只输出 JSON 数组，每项形如 {"title":"书名(≤15字)","hook":"钩子(4-6字)","cover_prompt_zh":"中文封面底图提示词","cover_prompt":"english image prompt"}。\n\n` +
    `【小说设定】\n书名：${book.title}\n类型：${genre}\n${digest}`;

  const r = await chatComplete({ provider, cfg, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.88, maxTokens: 4096, onLog });
  const raw = r?.content || '';
  const jsonText = raw.replace(/```(?:json)?/gi, '').trim();
  let arr = null;
  try { const m = jsonText.match(/\[[\s\S]*\]/); arr = JSON.parse(m ? m[0] : jsonText); }
  catch {
    arr = [];
    for (const o of (jsonText.match(/\{[^{}]*\}/g) || [])) { try { arr.push(JSON.parse(o)); } catch {} }
  }
  arr = (Array.isArray(arr) ? arr : [])
    .map(x => ({ ...x, title: sanitizeFanqieExpTitle(x?.title) }))
    .filter(x => x && x.title && x.title.length >= 4)
    .slice(0, count);
  if (!arr.length) throw new Error('候选书名解析失败（模型输出不规范）：' + raw.slice(0, 160));
  log(`已生成 ${arr.length} 个合规候选书名（≤15字），开始逐个生成专属封面底图…`, 'act');

  const expDir = path.join(book.dir, 'experiment');
  try { fs.rmSync(expDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(expDir, { recursive: true });
  const items = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    const bgName = `${String(i + 1).padStart(2, '0')}.png`;
    const outPath = path.join(expDir, bgName);
    let bg = null, bgErr = '';
    try {
      log(`(${i + 1}/${arr.length}) 出封面：《${it.title}》…`);
      const promptEn = String(it.cover_prompt || '').trim();
      const promptZh = String(it.cover_prompt_zh || it.cover_prompt || '').trim();
      try {
        await generateCoverBg(book, { prompt: promptEn ? (promptEn + ENFORCE) : undefined, outFile: outPath, onLog: (e) => log(e.msg, e.level) });
        bg = bgName;
      } catch (imgErr) {
        log(`主通道出图未成（${imgErr.message}），自动切换智谱 cogview-3-flash 极速出图…`, 'info');
        await generateZhipuCoverBg(promptZh || `${book.title}，${it.title}，主角半身特写`, outPath, cfg);
        bg = bgName;
      }
    } catch (e) {
      // 若书目录已有 cover_bg.png，兜底复制保证不断流
      const fallbackBg = path.join(book.dir, 'cover_bg.png');
      if (fs.existsSync(fallbackBg)) {
        fs.copyFileSync(fallbackBg, outPath);
        bg = bgName;
        log(`《${it.title}》使用本书 cover_bg.png 兜底合成专属书封`, 'info');
      } else {
        bgErr = e.message;
        log(`《${it.title}》封面失败：${e.message}`, 'warn');
      }
    }
    items.push({
      i: i + 1,
      title: it.title,
      hook: String(it.hook || '').trim(),
      cover_prompt: String(it.cover_prompt || '').trim(),
      cover_prompt_zh: String(it.cover_prompt_zh || '').trim(),
      bg,
      bgErr,
    });
  }
  const manifest = {
    bookId: book.publish?.bookId || '',
    book: book.title,
    slug: book.slug,
    author: String(author || '光头通').trim(),
    generatedAt: new Date().toISOString(),
    provider,
    count: items.length,
    items,
  };
  fs.writeFileSync(path.join(expDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  bakeExperimentTitledCoversServer(expDir, manifest.author);
  const okCount = items.filter(x => x.bg).length;
  log(`✅ 书名实验生成完成：${items.length} 个书名 / ${okCount} 张带字封面 → experiment/`, 'act');
  return manifest;
}

// 保存修改后的候选书名/作者笔名，并重新烤制服务端 NN.titled.png
export function updateNameExperimentManifest(book, { items, author } = {}) {
  const expDir = path.join(book.dir, 'experiment');
  fs.mkdirSync(expDir, { recursive: true });
  const cur = readNameExperiment(book) || { book: book.title, slug: book.slug, generatedAt: new Date().toISOString(), items: [] };
  if (author !== undefined) cur.author = String(author || '').trim();
  if (Array.isArray(items)) {
    cur.items = items.map((it, idx) => {
      const old = (cur.items || [])[idx] || {};
      return {
        ...old,
        ...it,
        i: idx + 1,
        title: sanitizeFanqieExpTitle(it.title || old.title || ''),
      };
    });
    cur.count = cur.items.length;
  }
  cur.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(expDir, 'manifest.json'), JSON.stringify(cur, null, 2), 'utf8');
  bakeExperimentTitledCoversServer(expDir, cur.author || '光头通');
  return cur;
}

// 单独重出某一张候选的封面底图
export async function regenerateOneExperimentCover(book, { index, cfg, onLog = () => {} } = {}) {
  const cur = readNameExperiment(book);
  if (!cur || !Array.isArray(cur.items)) throw new Error('尚未生成书名实验清单');
  const idx = Number(index) - 1;
  const it = cur.items[idx];
  if (!it) throw new Error('找不到第 ' + index + ' 组实验项');
  const expDir = path.join(book.dir, 'experiment');
  const bgName = `${String(idx + 1).padStart(2, '0')}.png`;
  const outPath = path.join(expDir, bgName);
  try { fs.unlinkSync(outPath); } catch {}
  const promptZh = String(it.cover_prompt_zh || it.cover_prompt || `${book.title}，${it.title}，古风主角半身特写`).trim();
  await generateZhipuCoverBg(promptZh, outPath, cfg);
  it.bg = bgName;
  it.bgErr = '';
  cur.generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(expDir, 'manifest.json'), JSON.stringify(cur, null, 2), 'utf8');
  bakeExperimentTitledCoversServer(expDir, cur.author || '光头通');
  return cur;
}

// 读回已生成的清单（UI 重开时用）
export function readNameExperiment(book) {
  try { return JSON.parse(readSafe(path.join(book.dir, 'experiment', 'manifest.json'))); } catch { return null; }
}
