// 改编视频 · 规划层：长篇 → 分集（短剧连载 / 卷预告）→ 分镜。
//
// 设计见 docs/video/design.md。要点：
//   · 不逐章改编。一集 = 一段连续章节（按剧情弧切），1–3 分钟；卷预告 = 一集 kind:'trailer'。
//   · 分集的输入是【逐章摘要】（outlines/.chapter-digest.json，由「重建大纲」流程产出），
//     不是全文——几百章的书只有摘要装得下。缺摘要会提示先跑摘要。
//   · 分镜的输入是这一集章节的正文（按预算截断）+ 设定圣经里的人物。
//   · 每集/每个分镜都记下来源章节的内容指纹（sourceRevisions），原文改了能发现「这集过期了」。
//   · 模型调用：先走 API（chatComplete），没配或失败退到本机 CLI（同 volname.mjs 的做法）。
//
// 本文件上半部分是纯函数（无 I/O，test/videoplan.test.mjs 覆盖），下半部分才读盘和调模型。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MIN_SHOT_SECONDS = 5;    // H3 训练时长下限约 124 帧 ≈ 5.17s，再短动作发挥不开
export const MAX_SHOT_SECONDS = 15;
export const DEFAULT_SECONDS = { episode: 90, trailer: 45 };
const TTS_CHARS_PER_SEC = 4.5;        // 中文旁白语速，用来给旁白长的镜头加时长

// ───────────────────────── 纯函数 ─────────────────────────

/** 从模型输出里抠出第一个 JSON（```json 围栏或裸 JSON）。抠不到返回 null。 */
export function extractJson(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  for (const c of [fenced?.[1], s]) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const close = c[start] === '{' ? '}' : ']';
    const end = c.lastIndexOf(close);
    if (end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)); } catch { /* 试下一个 */ }
  }
  return null;
}

const str = (v, fb = '') => (typeof v === 'string' ? v.trim() : fb);
const strList = (v) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);

export function clampSeconds(s) {
  return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, Math.round(s)));
}

export function countSpokenChars(text) {
  const t = String(text || '');
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (t.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words * 2;
}

/** 帧数吸附到 H3 的 17k+5 网格（与官方模板 ComfyMathExpression 一致）。 */
export function snapFrames(seconds, fps = 24) {
  const n = Math.max(5, Math.round(seconds * fps));
  return n + ((((5 - (n % 17)) % 17) + 17) % 17);
}

/**
 * 模型给的分集按【章号】引用章节；规整成按顺序、不重叠、连续的真实章节区间。
 * chapters: [{num, revision}]（已按 num 排序）
 */
export function normalizeEpisodes(raw, chapters, { kind, targetSeconds, maxEpisodes }) {
  const warnings = [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.episodes) ? raw.episodes : [];
  const byNum = new Map(chapters.map((c) => [c.num, c]));
  const minNo = chapters[0]?.num ?? 1;
  const maxNo = chapters[chapters.length - 1]?.num ?? 0;

  const ranges = list.map((e) => {
    let from = Math.round(Number(e?.fromChapter ?? e?.from));
    let to = Math.round(Number(e?.toChapter ?? e?.to ?? from));
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (from > to) [from, to] = [to, from];
    from = Math.max(from, minNo);
    to = Math.min(to, maxNo);
    return from > to ? null : { e, from, to };
  }).filter(Boolean).sort((a, b) => a.from - b.from);

  const episodes = [];
  let lastTo = minNo - 1;
  for (const r of ranges) {
    if (episodes.length >= maxEpisodes) break;
    if (r.to <= lastTo) { warnings.push(`丢弃与前一集重叠的分集：第${r.from}-${r.to}章`); continue; }
    const from = Math.max(r.from, lastTo + 1);
    const sourceRevisions = {};
    for (let n = from; n <= r.to; n++) {
      const ch = byNum.get(n);
      if (ch) sourceRevisions[String(n)] = ch.revision;
    }
    if (!Object.keys(sourceRevisions).length) continue;
    const t = Number(r.e?.targetSeconds);
    episodes.push({
      index: episodes.length + 1,
      kind,
      title: str(r.e?.title, `第${episodes.length + 1}集`),
      fromChapter: from,
      toChapter: r.to,
      sourceRevisions,
      logline: str(r.e?.logline),
      beats: strList(r.e?.beats),
      hook: str(r.e?.hook),
      targetSeconds: Number.isFinite(t) && t > 0
        ? Math.round(Math.min(Math.max(t, targetSeconds * 0.5), targetSeconds * 1.5))
        : targetSeconds,
    });
    lastTo = r.to;
  }
  const covered = new Set(episodes.flatMap((e) => Object.keys(e.sourceRevisions).map(Number)));
  const skippedChapters = chapters.filter((c) => !covered.has(c.num)).map((c) => c.num);
  if (!episodes.length) warnings.push('模型未返回有效分集');
  return { episodes, skippedChapters, warnings };
}

/** 模型写的人物名 → 已知人物（先精确，再包含）。 */
export function matchCharacter(name, characters) {
  const n = str(name);
  if (!n) return undefined;
  return characters.find((c) => c.name === n)
    || characters.find((c) => c.name.length >= 2 && (n.includes(c.name) || c.name.includes(n)));
}

/** 规整分镜。characters: [{name}]；chapterNums: 本集章号（兜底 sourceChapter 用）。 */
export function normalizeShots(raw, { characters = [], chapterNums = [], targetSeconds = 0 }) {
  const warnings = [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.shots) ? raw.shots : [];
  const nums = new Set(chapterNums);
  const shots = [];
  for (const s of list) {
    const prompt = str(s?.prompt);
    const action = str(s?.action);
    if (!prompt && !action) continue;
    const cast = [];
    const extras = [];
    for (const name of strList(s?.characters)) {
      const hit = matchCharacter(name, characters);
      if (hit) { if (!cast.includes(hit.name)) cast.push(hit.name); }
      else if (!extras.includes(name)) extras.push(name);
    }
    const ch = Math.round(Number(s?.chapter));
    const sec = Number(s?.seconds);
    const narration = str(s?.narration) || undefined;
    shots.push({
      index: shots.length + 1,
      scene: str(s?.scene, `S${shots.length + 1}`),
      settingType: ['interior', 'exterior'].includes(str(s?.settingType).toLowerCase()) ? str(s?.settingType).toLowerCase() : '',
      characters: cast,
      extraCharacters: extras,
      location: str(s?.location),
      action,
      camera: str(s?.camera),
      narration,
      speaker: narration ? str(s?.speaker, 'narrator') : undefined,
      emotion: narration ? str(s?.emotion) : '',
      prompt: prompt || action,
      ambience: str(s?.ambience),
      seconds: clampSeconds(Number.isFinite(sec) ? sec : MIN_SHOT_SECONDS),
      sourceChapter: nums.has(ch) ? ch : (chapterNums[0] ?? null),
    });
  }
  for (const shot of shots) {
    if (!shot.narration) continue;
    const need = clampSeconds(Math.ceil(countSpokenChars(shot.narration) / TTS_CHARS_PER_SEC));
    if (need > shot.seconds) shot.seconds = need;
  }
  const totalSeconds = shots.reduce((a, s) => a + s.seconds, 0);
  if (targetSeconds > 0 && totalSeconds > targetSeconds * 1.5) {
    warnings.push(`分镜总时长 ${totalSeconds}s 明显超过目标 ${targetSeconds}s，建议删减镜头`);
  }
  if (!shots.length) warnings.push('模型未返回有效镜头');
  return { shots, totalSeconds, warnings };
}

/** 内容指纹：原文一改就变。 */
export function revisionOf(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
}

/** 哪些章节在规划之后被改过（指纹不一致或已删除）。 */
export function staleChapters(sourceRevisions, current) {
  return Object.entries(sourceRevisions || {})
    .filter(([num, rev]) => current[num] !== rev)
    .map(([num]) => Number(num));
}

export function buildEpisodePrompt({ title, digestLines, kind, targetSeconds, maxEpisodes }) {
  const brief = kind === 'trailer'
    ? `做 1 支 ${targetSeconds} 秒的预告片：只挑最强的冲突、高潮和悬念，范围可覆盖全部章节，结尾必须留钩子，不剧透结局。`
    : `改编为每集约 ${targetSeconds} 秒（约 ${Math.round(targetSeconds / 6)} 个镜头）的竖屏短剧连载，最多 ${maxEpisodes} 集。\n`
      + '规则：\n'
      + '- 一集对应一段连续章节，按剧情弧切分，不要逐章切；铺垫、日常、心理描写多的章节并入相邻集或整体跳过\n'
      + '- 每集必须有：开场 3 秒抓人的画面、至少一个冲突或爽点、结尾悬念钩子\n'
      + '- 集与集章节范围不重叠、按顺序';
  const sys = '你是短剧总编剧，擅长把长篇网文改编成竖屏短剧连载。只输出JSON。';
  const user = `作品：《${title}》\n${brief}\n\n【逐章摘要】（格式：章号 核心事件|推进|钩子）\n${digestLines}\n\n输出：\n`
    + '```json\n'
    + `{"episodes":[{"fromChapter":1,"toChapter":3,"title":"集标题","logline":"一句话看点","beats":["节拍1","节拍2","节拍3"],"hook":"结尾悬念","targetSeconds":${targetSeconds}}]}\n`
    + '```';
  return { sys, user };
}

export function buildStoryboardPrompt({ kind, targetSeconds, aspect, logline, beats, cast, source, firstChapter, dialogueMode = 'drama' }) {
  const shotCount = Math.max(3, Math.round(targetSeconds / 6));
  const isDrama = dialogueMode !== 'narration';
  const voiceRule = isDrama
    ? '- 【纯影视对白模式（极其重要）】不要写解说式旁白！凡是画面本身能演出来的动作/环境（如刮风、烧水、走路、打斗），narration 必须留空 ""，靠环境音和画面讲故事；只有在人物张嘴说话时，才填角色台词到 narration、speaker 填该角色原名（不要填 narrator）、emotion 填简短中文表演情绪（如“冷峻”、“轻声关切”、“凶狠怒吼”、“阴冷嘲讽”）。全集最多只允许开场或重大转折出现 0–1 句极简旁白\n'
    : '- 旁白/台词写中文，简短口语化，每镜不超过 24 字（保证 5–6 秒念完不超视频时长）；画面动作必须与当镜旁白/台词严格对应，emotion 填表演情绪\n';
  const sys = '你是顶级竖屏短剧导演，同时精通 AI 视频生成与视听语言。只输出JSON。';
  const user = `把下面的小说片段改编成一集${kind === 'trailer' ? '预告片' : '短剧'}的分镜表。\n`
    + `目标总时长约 ${targetSeconds} 秒，约 ${shotCount} 个镜头，画幅 ${aspect}。\n`
    + (logline ? `本集看点：${logline}\n` : '')
    + (beats?.length ? `必须呈现的节拍：\n${beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n` : '')
    + '\n分镜与现实常识硬规则（必须全部遵守，杜绝 AI 穿帮）：\n'
    + '- 一个镜头只拍一个连续动作（一镜一空间一简单物理动作）：每镜 5–8 秒只拍 1 个清晰动作，严禁塞入多个复合动作（例如不要同一镜里既剥纸又咬饼又听惨叫又起身），也不要同时混写“门口和窗台（window and doorway）”导致门窗融合畸形\n'
    + '- 显式标注室内外 settingType（"interior" 或 "exterior"）：室内戏只能拍室内陈设，室外戏只能拍室外街景，禁止室内外空间颠倒\n'
    + '- 严禁中式专名直译误导视频模型：例如“正骨堂/医馆”必须写 traditional Chinese herbal medicine clinic（绝不写 bone-setting，否则模型会在墙上挂动物骨头！）\n'
    + '- 饮食与道具物理合理：若拍吃东西，必须写明食物已拆开拿在手里、油纸平摊在桌上，严禁把“油纸包”和“咬一口”混在一起导致连纸咬；人物姿势必须双脚着地或坐稳椅凳，绝不出现踩窗台等反常识动作\n'
    + '- 时代与光源写实：年代剧/古装剧严禁出现现代白色吸顶吊灯、现代亮面马术高筒靴、满街古镇景区彩灯和舞台干冰浓雾；寒夜孤灯戏只用真实单一主光源（马灯/煤炉/微弱月光）\n'
    + '- 视觉与剧情连贯：同一场戏（相同 scene）相邻镜头保持一致的墙面材质、陈设与光线方向；切到下一个地点前必须有因果衔接\n'
    + '- 开场镜头 3 秒内抓住注意力，结尾镜头停在悬念上\n'
    + voiceRule
    + '- 台词简短口语化，每镜不超过 24 字（保证 5–6 秒念完不超视频时长）；人物说话镜头需在画面 prompt 中写明说话人的神态与嘴部说话动作\n'
    + '- prompt 用英文写给视频模型：按时间顺序描述人物动作、表情、镜头运动、写实光线和空间位置；不要在 prompt 里重复塞入未出镜或不需要的手持道具\n'
    + '- ambience 用英文写环境音和音效（不要音乐）\n'
    + '- characters 必须列出当镜所有出镜人物（包括背影、窗内/桌对面交互的另一方，例如甲递东西给乙，必须同时填 ["甲", "乙"]），使用人物设定里的原名\n'
    + `\n【人物设定】\n${cast || '（无）'}\n\n【原文】\n${source}\n\n输出：\n`
    + '```json\n'
    + `{"shots":[{"chapter":${firstChapter},"scene":"S1","settingType":"interior","location":"地点","characters":["人物名"],"action":"中文动作描述","camera":"slow push-in, medium close-up","narration":"角色台词（无对白纯画面镜留空）","speaker":"人物原名或 narrator","emotion":"情绪（如冷峻/轻声/怒吼）","prompt":"English video prompt","ambience":"English ambience","seconds":6}]}\n`
    + '```';
  return { sys, user };
}

/** 从设定圣经里粗取人物名：「主角：张三」「## 主角」下的首个名字、「关键配角：甲、乙」。 */
export function parseBibleCharacters(bible) {
  const text = String(bible || '');
  const names = new Set();
  const add = (s) => {
    const n = String(s || '').replace(/[（(].*$/, '').replace(/[*_`\s]/g, '').trim();
    if (n && n.length >= 2 && n.length <= 6 && /^[\u4e00-\u9fa5·]+$/.test(n)) names.add(n);
  };
  for (const m of text.matchAll(/(?:主角|男主|女主|反派|配角)[^：:\n]{0,4}[：:]\s*([^\n，,；;。]+)/g)) add(m[1]);
  for (const m of text.matchAll(/关键配角[：:]\s*([^\n]+)/g)) m[1].split(/[、，,；;\s]+/).forEach(add);
  for (const m of text.matchAll(/^#{2,4}\s*([\u4e00-\u9fa5·]{2,6})\s*$/gm)) {
    if (!/主角|配角|反派|设定|世界|时代|卖点|主线|伏笔|人物|势力|地图|规则|简介|基本盘|阵营|背景|大纲|概述|金手指|体系|风格|节奏|结局|开篇|卷/.test(m[1])) add(m[1]);
  }
  return [...names].map((name) => ({ name }));
}

// ───────────────────────── 读盘 / 调模型 ─────────────────────────

export function videoDir(book) { return path.join(book.dir, 'video'); }
export function planFile(book) { return path.join(videoDir(book), 'plan.json'); }
export function bibleFile(book) { return path.join(videoDir(book), 'bible.json'); }

export const EDGE_VOICES = [
  { id: 'zh-CN-YunxiNeural', label: '云希 · 沉稳男声（旁白/男主）' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 热血武侠男声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 新闻播音男声' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温暖女声（女主）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 灵动少女声' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 少年声' },
];

export function loadBible(book) {
  try {
    const b = JSON.parse(fs.readFileSync(bibleFile(book), 'utf8'));
    return {
      visualStyle: b?.visualStyle || '',
      narratorVoice: b?.narratorVoice || '',
      narratorEdgeVoice: b?.narratorEdgeVoice || '',
      characters: Array.isArray(b?.characters) ? b.characters : [],
    };
  } catch {
    return { visualStyle: '', narratorVoice: '', narratorEdgeVoice: '', characters: [] };
  }
}
export function saveBible(book, bible) {
  fs.mkdirSync(videoDir(book), { recursive: true });
  const prev = loadBible(book);
  fs.writeFileSync(bibleFile(book), JSON.stringify({
    visualStyle: bible?.visualStyle !== undefined ? String(bible.visualStyle || '').trim() : prev.visualStyle,
    narratorVoice: bible?.narratorVoice !== undefined ? String(bible.narratorVoice || '').trim() : prev.narratorVoice,
    narratorEdgeVoice: bible?.narratorEdgeVoice !== undefined ? String(bible.narratorEdgeVoice || '').trim() : prev.narratorEdgeVoice,
    characters: Array.isArray(bible?.characters) ? bible.characters : prev.characters,
  }, null, 1), 'utf8');
}

export const VISUAL_STYLE_PRESETS = [
  {
    id: 'anime_25d',
    label: '🎨 国风电影厚涂 2.5D（推荐）',
    short: '2.5D厚涂国漫',
    prompt: 'High-budget 2.5D Chinese donghua animated feature film style, rich painterly brushwork, subtle crisp ink outlines, dramatic warm lantern rim lighting vs cold atmospheric shadows, expressive stylized anime characters, cinematic depth of field, no live-action photorealism',
  },
  {
    id: 'anime_2d_cel',
    label: '✒️ 2D 精品赛璐璐番剧',
    short: '2D赛璐璐',
    prompt: 'High-budget 2D cel-shaded Chinese anime series style, crisp clean black ink linework, dramatic cel shading, expressive anime eyes, hand-painted atmospheric background, no live-action photorealism',
  },
  {
    id: 'donghua_3d',
    label: '🧊 3D 电影级国漫 CG',
    short: '3D国漫CG',
    prompt: 'High-end 3D Chinese donghua CG animated film style, Unreal Engine 5 cinematic stylized rendering, detailed cloth physics, volumetric atmospheric lighting, refined stylized Asian CG faces',
  },
  {
    id: 'live_action',
    label: '🎬 电影写实真人',
    short: '写实真人',
    prompt: 'Cinematic Chinese period drama, realistic 35mm film grain, natural moody lighting, authentic textures',
  },
];

export const DEFAULT_VISUAL_STYLE = VISUAL_STYLE_PRESETS[0].prompt;

export const VOICE_PRESETS = [
  { id: 'young_male', label: '沉稳青年男声', defaultDesc: 'low, calm young Chinese male voice', defaultEdge: 'zh-CN-YunxiNeural' },
  { id: 'young_female', label: '清冷/温柔青年女声', defaultDesc: 'clear, gentle young Chinese female voice', defaultEdge: 'zh-CN-XiaoxiaoNeural' },
  { id: 'lively_female', label: '灵动少女女声', defaultDesc: 'bright, lively young Chinese girl voice', defaultEdge: 'zh-CN-XiaoyiNeural' },
  { id: 'elder_male', label: '沧桑/慈祥老年男声', defaultDesc: 'warm, weathered elderly Chinese male voice', defaultEdge: 'zh-CN-YunyangNeural' },
  { id: 'elder_female', label: '沉稳老年女声', defaultDesc: 'calm, authoritative elderly Chinese female voice', defaultEdge: 'zh-CN-XiaoyiNeural' },
  { id: 'rough_male', label: '粗犷悍匪/硬汉男声', defaultDesc: 'rough, gruff, intimidating Chinese male voice', defaultEdge: 'zh-CN-YunjianNeural' },
  { id: 'cold_male', label: '阴冷/狡猾反派男声', defaultDesc: 'sharp, cold, arrogant Chinese male voice', defaultEdge: 'zh-CN-YunxiNeural' },
];

/** 从角色设定自动推断声线预设（没填 voicePreset 时按 lookPrompt/role 兜底）。 */
export function inferVoicePreset(ch) {
  if (!ch) return 'young_male';
  if (ch.voicePreset && VOICE_PRESETS.some((p) => p.id === ch.voicePreset)) return ch.voicePreset;
  const txt = `${ch.role || ''} ${ch.lookPrompt || ''} ${ch.name || ''}`.toLowerCase();
  const isFemale = /\b(woman|female|girl|lady|heroine)\b|女|姑娘|小姐|夫人|婆|娘/.test(txt);
  const ageMatch = txt.match(/(\d{2})[\s-]*(?:year|yo)/);
  const age = ageMatch ? Number(ageMatch[1]) : 0;
  const isElder = age > 0
    ? age >= 50
    : (/\b(elder|elderly|senior|mentor|aged)\b|\bold\s+(?:man|woman|lady|master|sage)\b|老|大爷|伯|翁|爷/.test(txt));
  const isAntag = /\b(antagonist|villain|gangster|thug|scarred|broken nose)\b|反派|恶|匪|帮|凶/.test(txt);
  if (isFemale) return isElder ? 'elder_female' : 'young_female';
  if (isElder) return 'elder_male';
  if (isAntag) return /\b(lean|pale|sinister|uniform|smirk|calculating)\b|阴|冷|巡捕/.test(txt) ? 'cold_male' : 'rough_male';
  return 'young_male';
}

/**
 * 按镜头说话人（shot.speaker）解析配音参考音频、edge-tts 音色、H3 声线描述与表演情绪（纯函数）：
 * - speaker === 'narrator' 或未指定：走全书旁白音色（bible.narratorVoice → cfg.video.ttsRefAudio）；
 * - speaker 为角色名：优先该角色 voiceRefAudio → 自动匹配音色库中同 preset 样本 → 旁白兜底，并透传 emotion。
 */
export function resolveSpeakerVoice(shot, bible, cfg = {}, voiceSamples = []) {
  const vcfg = cfg?.video || {};
  const speaker = str(shot?.speaker, 'narrator');
  const emotion = str(shot?.emotion);
  const autoNarrator = Array.isArray(voiceSamples)
    ? voiceSamples.find((vs) => vs.preset === 'narrator' && vs.path)
    : null;
  const defaultRef = str(bible?.narratorVoice) || str(vcfg.ttsRefAudio) || str(autoNarrator?.path);
  const defaultEdge = str(bible?.narratorEdgeVoice) || str(vcfg.edgeVoice) || 'zh-CN-YunxiNeural';
  if (!speaker || speaker.toLowerCase() === 'narrator' || speaker === '旁白') {
    return {
      speaker: 'narrator',
      isCharacter: false,
      refAudio: defaultRef,
      edgeVoice: defaultEdge,
      voicePreset: 'narrator',
      voiceDesc: 'calm cinematic Chinese male narrator voice',
      emotion,
      label: '旁白',
    };
  }
  const ch = matchCharacter(speaker, Array.isArray(bible?.characters) ? bible.characters : []);
  const presetId = inferVoicePreset(ch);
  const preset = VOICE_PRESETS.find((p) => p.id === presetId) || VOICE_PRESETS[0];
  const autoSample = Array.isArray(voiceSamples)
    ? voiceSamples.find((vs) => vs.preset === presetId && vs.path)
    : null;
  return {
    speaker: ch?.name || speaker,
    isCharacter: true,
    refAudio: str(ch?.voiceRefAudio) || str(autoSample?.path) || defaultRef,
    edgeVoice: str(ch?.edgeVoice) || preset.defaultEdge || defaultEdge,
    voicePreset: presetId,
    voiceDesc: str(ch?.voiceDesc) || preset.defaultDesc,
    emotion,
    label: ch?.name || speaker,
  };
}

/**
 * 为 MiniMax H3 原生对口型说话模式（voiceMode === 'native'）注入角色中文台词与声线描述（纯函数）。
 * 仅在角色开口（非旁白）且有 narration 台词时注入，保留自然口型同步与人物各自声线。
 */
export function composeNativeDialoguePrompt(shot, bible, basePrompt, cfg = {}) {
  const prompt = str(basePrompt || shot?.prompt);
  const line = str(shot?.narration);
  if (!line) return prompt;
  const sp = resolveSpeakerVoice(shot, bible, cfg);
  if (!sp.isCharacter) return prompt;
  const emo = sp.emotion ? `, tone: ${sp.emotion}` : '';
  const dialogueCue = `${sp.speaker} speaks naturally in Mandarin Chinese with realistic lip-sync, using a ${sp.voiceDesc}${emo}: “${line}”.`;
  return prompt ? `${prompt} ${dialogueCue}` : dialogueCue;
}

/**
 * 为后期配音模式（voiceMode === 'tts'，推荐）注入画面口型动作与静音环境约束（纯函数）：
 * - 人物台词镜头：保留动画/影视口型动作与表情表演，同时禁止 H3 视频模型在底噪里胡乱生成人声杂音；
 * - 无台词或纯旁白镜头：要求 H3 仅生成干净环境音，不混入多余说话声。
 */
export function composeDubbedSpeakingPrompt(shot, bible, basePrompt, cfg = {}) {
  const prompt = str(basePrompt || shot?.prompt);
  const line = str(shot?.narration);
  const sp = line ? resolveSpeakerVoice(shot, bible, cfg) : null;
  const cue = sp?.isCharacter
    ? `${sp.speaker} speaks expressively with natural animated mouth movement and ${sp.emotion || 'vivid'} facial expression. Audio: subtle atmospheric ambient foley only, no spoken dialogue or background voices.`
    : 'Audio: subtle atmospheric ambient foley only, no spoken dialogue or background voices.';
  return prompt ? `${prompt} ${cue}` : cue;
}

/**
 * 清洗角色固定外貌卡中的手持/随身道具从句（纯函数）：
 * 防止如 "carries a small wooden case" 写死在全书外貌卡里，导致半身/窗内镜头凭空多长出一只提箱手穿帮。
 * 手持道具应由具体分镜 shot.prompt 按需描写，而不是每镜强塞。
 */
export function sanitizeLookPrompt(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  // 去掉整句形式的 "He/She carries/holds ..." 或 ", and he/she carries/holds ..."
  s = s.replace(/(?:^|[.;]\s*)(?:he|she|they)\s+(?:always\s+)?(?:carries|carrying|holds|holding)\b[^.;]*[.;]?/gi, ' ');
  s = s.replace(/,?\s*\band\s+(?:he|she|they)\s+(?:always\s+)?(?:carries|carrying|holds|holding)\b[^.;]*/gi, '');
  s = s.replace(/,?\s*\b(?:always\s+)?(?:carries|carrying|holds|holding)\s+(?:a|an|the|his|her)\b[^,.;]*/gi, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/^[.,;\s]+/, '').trim();
  return s;
}

/** 判断画风/提示词是否属于年代剧或古装剧，用于自动附加时代反穿帮约束。 */
export function isPeriodStyle(text) {
  return /\b(period\s+drama|19[0-4]\d|1930s|1920s|republic\s+of\s+china|ancient|dynasty|hutong|qing|ming|tang|song|han\s+dynasty|wuxia|xianxia)\b|民国|古装|古代|胡同|长衫|旗袍/i.test(String(text || ''));
}

/** 判断画风是否属于 2.5D/2D/3D 动画/国漫路线，用于全程锁定动画画风、防止漂回写实恐怖谷。 */
export function isAnimeStyle(text) {
  return /\b(2\.5d|2d|3d|anime|donghua|cel[-\s]?shaded|painterly|animated|illustration|cartoon)\b|国漫|动画|厚涂|赛璐璐|番剧/i.test(String(text || ''));
}

/**
 * 渲染前场景提示词常识消毒（纯函数）：
 * - 替换英文视频模型极易按字面曲解的直译词（如 bone-setting → traditional Chinese herbal medicine）；
 * - 拆分混写的 window and doorway，防止门窗融合成齐腰半截框导致踩窗台；
 * - 动画画风自动附加风格锁定尾注（绝不漂回真人写实）；年代剧自动补齐防现代穿帮尾注。
 */
export function sanitizeScenePrompt(prompt, bible = {}) {
  let s = String(prompt || '').trim();
  if (!s) return '';
  s = s.replace(/\bbone[-\s]?setting\s+clinic\b/gi, 'traditional Chinese herbal medicine clinic');
  s = s.replace(/\bbone[-\s]?setting\b/gi, 'traditional Chinese herbal medicine');
  s = s.replace(/\boutside\s+the\s+wooden\s+window\s+and\s+doorway\b/gi, 'standing outside the wooden clinic doorway');
  s = s.replace(/\bwindow\s+and\s+doorway\b/gi, 'wooden doorway');
  s = s.replace(/\bdoorway\s+and\s+window\b/gi, 'wooden doorway');
  s = s.replace(/\s{2,}/g, ' ').trim();
  const combined = `${bible?.visualStyle || ''} ${s}`;
  const anime = isAnimeStyle(combined);
  const period = isPeriodStyle(combined);
  if (anime && !/consistent stylized animated/i.test(s)) {
    s += period
      ? ' Consistent stylized animated art style throughout motion, crisp character design, grounded natural posture, authentic period architecture, no modern ceiling electric lamps, no modern glossy riding boots, no live-action photorealism, no extra limbs.'
      : ' Consistent stylized animated art style throughout motion, crisp character design, grounded natural posture, no live-action photorealism, no extra limbs.';
  } else if (period && !/no modern ceiling/i.test(s)) {
    s += ' Grounded realistic human posture, authentic period architecture, no modern ceiling electric lamps, no modern glossy riding boots, no extra limbs.';
  }
  return s;
}

/**
 * 渲染前外貌锁定（纯函数）：把全书画风 + 出镜角色的固定英文外貌卡（以及 ref2va 的 <Picture i> 编号）
 * 自动注入镜头提示词，并对场景提示词做常识消毒，防止长篇连载换脸、多长手与时代穿帮。
 */
export function composeLockedPrompt(shot, bible, refTags = []) {
  const parts = [];
  const style = str(bible?.visualStyle);
  if (style) parts.push(style);
  const chars = Array.isArray(bible?.characters) ? bible.characters : [];
  const tagMap = new Map(refTags.map((r) => [r.name, r.tag]));
  for (const name of (shot?.characters || [])) {
    const c = chars.find((x) => x.name === name);
    const tag = tagMap.get(name);
    const cleanLook = sanitizeLookPrompt(c?.lookPrompt);
    if (cleanLook || tag) {
      parts.push(`[${name}${tag ? ` (${tag})` : ''}: ${cleanLook || 'keep exact appearance and outfit from ' + tag}]`);
    }
  }
  parts.push(sanitizeScenePrompt(str(shot?.prompt), bible));
  return parts.filter(Boolean).join(' ');
}

/** 从 novel_bible.md + continuity_ledger.md 提取主要角色，生成彼此差异化的英文外貌卡。 */
export async function extractCharacterBible(book, cfg, { onLog } = {}) {
  const bibleMd = readBible(book);
  let ledger = '';
  try { ledger = fs.readFileSync(path.join(book.dir, 'continuity_ledger.md'), 'utf8').slice(0, 4000); } catch {}
  if (!bibleMd && !ledger) throw new Error('找不到 novel_bible.md，请先立项或重建设定圣经');

  const sys = '你是影视选角与美术总监，专门把网文人物设定转成 AI 视频用的高区分度角色外貌卡。只输出JSON。';
  const user = `从下面的设定圣经里提取主要角色和关键配角（最多 12 人），为每人写一条**固定英文外貌描述（lookPrompt）**以及**专属声线描述（voiceDesc / voicePreset）**。
要求：
1. **强制拉开视觉区分度**：不同角色在发型、脸型/气质、服饰剪影、主色调、贴身小配饰（如发带/耳饰/玉佩）上必须明显不同，绝不能全员一张脸或同款衣服；
2. lookPrompt 用英文写，简洁具体（25–45 词），仅包含：年龄、性别、族群、五官/伤疤特征、发型、固定服装与颜色；
3. **红线：严禁写入任何手持或随身道具**（如木箱、笔记本、马灯、武器、汤担、拐杖、手提包等），也不要写剧情动作——否则半身/室内镜头会强行多长出穿帮手臂；道具只由具体分镜按需描写；
4. 为每人配 voicePreset（从 young_male / young_female / elder_male / elder_female / rough_male / cold_male 中选最贴合的）和简短英文 voiceDesc（用于原生对口型说话的声线气质，如 "low, calm young Chinese male voice"、"clear gentle young Chinese female voice"）；
5. 同时给一句简短的全书英文画风前缀 visualStyle（如年代质感、色调、光影、镜头风格）。

【设定圣经】
${bibleMd.slice(0, 12000)}
${ledger ? `\n【人物现状】\n${ledger.slice(0, 3000)}` : ''}

输出：
\`\`\`json
{"visualStyle":"${DEFAULT_VISUAL_STYLE}","characters":[{"name":"角色名","role":"主角/女主/反派/配角","voicePreset":"young_male","voiceDesc":"low, calm 24-year-old Chinese male voice","lookPrompt":"25-year-old Chinese man, ..."}]}
\`\`\``;

  const text = await askModel(book, cfg, sys, user, { maxTokens: 4000, temperature: 0.4, onLog });
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.characters)) throw new Error('角色定妆提取失败：模型未返回有效 JSON');

  const prev = loadBible(book);
  const prevByName = new Map(prev.characters.map((c) => [c.name, c]));
  const merged = parsed.characters
    .map((c) => {
      const name = str(c?.name);
      if (!name) return null;
      const old = prevByName.get(name);
      const item = {
        name,
        role: str(c?.role, old?.role || ''),
        lookPrompt: sanitizeLookPrompt(str(c?.lookPrompt, old?.lookPrompt || '')),
        refImageRef: old?.refImageRef || '',
        voiceRefAudio: old?.voiceRefAudio || '',
        edgeVoice: old?.edgeVoice || '',
        voicePreset: str(c?.voicePreset, old?.voicePreset || ''),
        voiceDesc: str(c?.voiceDesc, old?.voiceDesc || ''),
      };
      if (!item.voicePreset) item.voicePreset = inferVoicePreset(item);
      return item;
    })
    .filter(Boolean);
  for (const old of prev.characters) {
    if (!merged.some((m) => m.name === old.name)) merged.push(old);
  }
  const next = {
    visualStyle: prev.visualStyle || str(parsed.visualStyle) || DEFAULT_VISUAL_STYLE,
    narratorVoice: prev.narratorVoice || '',
    narratorEdgeVoice: prev.narratorEdgeVoice || '',
    characters: merged,
  };
  saveBible(book, next);
  return next;
}

export function loadPlan(book) {
  try { return JSON.parse(fs.readFileSync(planFile(book), 'utf8')); } catch { return { version: 1, episodes: [] }; }
}
export function savePlan(book, plan) {
  fs.mkdirSync(videoDir(book), { recursive: true });
  fs.writeFileSync(planFile(book), JSON.stringify(plan, null, 1), 'utf8');
}

async function listChaptersWithRevision(book) {
  const { listChapters } = await import('./outlinerebuild.mjs');
  return listChapters(book).map((c) => {
    let text = '';
    try { text = fs.readFileSync(c.file, 'utf8'); } catch { /* 读不到当空 */ }
    return { ...c, revision: revisionOf(text), text };
  });
}

/** 当前每章指纹 {num: rev}，给「过期检测」用。 */
export async function currentRevisions(book) {
  const out = {};
  for (const c of await listChaptersWithRevision(book)) out[String(c.num)] = c.revision;
  return out;
}

function readBible(book) {
  try { return fs.readFileSync(path.join(book.dir, 'novel_bible.md'), 'utf8'); } catch { return ''; }
}

/** 先 API，再本机 CLI。返回原始文本。 */
async function askModel(book, cfg, sys, user, { maxTokens = 8000, temperature = 0.5, onLog } = {}) {
  const log = (msg, level = 'info') => onLog?.({ level, msg });
  const { pickProvider, chatComplete } = await import('./apichat.mjs');
  const provider = pickProvider(cfg);
  let apiErr = '';
  if (provider) {
    try {
      log(`用 ${provider} 生成…`, 'act');
      const r = await chatComplete({ provider, cfg, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature, maxTokens, onLog });
      if (r?.content?.trim()) return r.content;
    } catch (e) { apiErr = e.message || String(e); log(`API 失败（${apiErr.slice(0, 80)}），改用本机 CLI`, 'warn'); }
  }
  const { reviewerCandidates, runModelOnceAsync, stripNoise } = await import('./editor.mjs');
  for (const m of reviewerCandidates(book.model, cfg)) {
    try {
      log(`用本机 ${m} 生成…`, 'act');
      const out = stripNoise(await runModelOnceAsync(m, `${sys}\n\n${user}`, cfg, 600000));
      if (out.trim()) return out;
    } catch (e) { log(`${m} 失败：${String(e.message || e).slice(0, 80)}`, 'warn'); }
  }
  throw new Error('没有可用的模型：' + (apiErr || (provider ? 'API 返回为空' : '未配置 API，本机 CLI 也没给出结果')));
}

const MAX_DIGEST_CHARS = 60000;
const MAX_SOURCE_CHARS = 24000;

/**
 * 分集规划。opts: {kind, fromChapter?, toChapter?, targetSeconds?, maxEpisodes?, onLog}
 * 结果写进 video/plan.json（替换同 kind 的旧规划之外的部分由调用方决定，这里只返回）。
 */
export async function planEpisodes(book, cfg, opts = {}) {
  const kind = opts.kind === 'trailer' ? 'trailer' : 'episode';
  const targetSeconds = Math.round(Math.min(kind === 'trailer' ? 90 : 300, Math.max(kind === 'trailer' ? 20 : 45, Number(opts.targetSeconds) || DEFAULT_SECONDS[kind])));
  const maxEpisodes = Math.round(Math.min(100, Math.max(1, Number(opts.maxEpisodes) || (kind === 'trailer' ? 1 : 30))));
  const { loadDigests } = await import('./outlinerebuild.mjs');
  let digests = loadDigests(book);
  let chapters = await listChaptersWithRevision(book);
  if (opts.fromChapter) chapters = chapters.filter((c) => c.num >= Number(opts.fromChapter));
  if (opts.toChapter) chapters = chapters.filter((c) => c.num <= Number(opts.toChapter));
  if (!chapters.length) throw new Error('这个范围里没有章节');

  const warnings = [];
  let missing = chapters.filter((c) => !digests[String(c.num)]);
  if (missing.length > chapters.length * 0.3 && chapters.length > 5) {
    opts.onLog?.({ level: 'act', msg: `检测到 ${missing.length}/${chapters.length} 章缺逐章摘要，正在自动补齐摘要…` });
    try {
      const { buildAllDigests } = await import('./outlinerun.mjs');
      await buildAllDigests(book, { model: book.model || cfg?.defaultModel || 'agy', cfg, onLog: opts.onLog });
      digests = loadDigests(book);
      missing = chapters.filter((c) => !digests[String(c.num)]);
    } catch (e) {
      warnings.push(`自动生成逐章摘要部分失败（${e.message}），缺摘要章节将用正文节选代替`);
    }
  }
  if (missing.length) {
    warnings.push(`${missing.length} 章暂无逐章摘要，已直接用正文节选/章名代替`);
  }

  const lines = [];
  let used = 0;
  let lastNum = chapters[chapters.length - 1].num;
  for (const c of chapters) {
    let summary = digests[String(c.num)];
    if (!summary) {
      const excerpt = String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, chapters.length <= 5 ? 1500 : 280);
      summary = excerpt ? `${c.name || ''}｜${excerpt}` : (c.name || '（无摘要）');
    }
    const line = `${c.num} ${summary}`;
    if (used + line.length > MAX_DIGEST_CHARS) {
      lastNum = c.num - 1;
      warnings.push(`章节太多，本次只规划到第${lastNum}章，剩下的请按范围分批规划`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  chapters = chapters.filter((c) => c.num <= lastNum);

  const { sys, user } = buildEpisodePrompt({ title: book.title, digestLines: lines.join('\n'), kind, targetSeconds, maxEpisodes });
  const text = await askModel(book, cfg, sys, user, { maxTokens: 6000, temperature: 0.5, onLog: opts.onLog });
  const parsed = extractJson(text);
  if (!parsed) throw new Error('分集规划失败：模型没有返回有效 JSON');
  const r = normalizeEpisodes(parsed, chapters, { kind, targetSeconds, maxEpisodes });
  return { ...r, warnings: [...warnings, ...r.warnings] };
}

/** 一集 → 分镜。episode: {fromChapter, toChapter, logline, beats, targetSeconds, kind}；opts: {aspect, onLog} */
export async function generateStoryboard(book, cfg, episode, opts = {}) {
  const from = Number(episode.fromChapter), to = Number(episode.toChapter);
  if (!(from > 0) || !(to >= from)) throw new Error('章节范围无效');
  if (to - from > 11) throw new Error('单集章节范围过大（最多 12 章）');
  const chapters = (await listChaptersWithRevision(book)).filter((c) => c.num >= from && c.num <= to);
  if (!chapters.length) throw new Error(`第${from}-${to}章不存在`);

  const per = Math.floor(MAX_SOURCE_CHARS / chapters.length);
  const source = chapters.map((c) => {
    const body = c.text.trim();
    const t = body.length > per ? `${body.slice(0, Math.floor(per * 0.7))}\n……\n${body.slice(-Math.floor(per * 0.3))}` : body;
    return `【第${c.num}章 ${c.name}】\n${t}`;
  }).join('\n\n');

  const bible = readBible(book);
  const charBible = loadBible(book);
  const characters = charBible.characters.length ? charBible.characters : parseBibleCharacters(bible);
  const castSection = bible.match(/##\s*(?:主角|人物)[\s\S]{0,2500}?(?=\n##\s|$)/)?.[0] || '';
  const castNotes = charBible.characters.length
    ? charBible.characters.map((c) => `- ${c.name}（${c.role}）：${c.lookPrompt}`).join('\n')
    : [characters.map((c) => c.name).join('、'), castSection].filter(Boolean).join('\n');
  const kind = episode.kind === 'trailer' ? 'trailer' : 'episode';
  const targetSeconds = Math.round(Math.min(300, Math.max(20, Number(episode.targetSeconds) || DEFAULT_SECONDS[kind])));
  const { sys, user } = buildStoryboardPrompt({
    kind, targetSeconds, aspect: opts.aspect || '9:16', logline: episode.logline, beats: episode.beats,
    cast: castNotes,
    source, firstChapter: from,
    dialogueMode: opts.dialogueMode || episode.dialogueMode || 'drama',
  });
  const text = await askModel(book, cfg, sys, user, { maxTokens: 8000, temperature: 0.6, onLog: opts.onLog });
  const parsed = extractJson(text);
  if (!parsed) throw new Error('分镜生成失败：模型没有返回有效 JSON');
  const r = normalizeShots(parsed, { characters, chapterNums: chapters.map((c) => c.num), targetSeconds });
  return { ...r, sourceRevisions: Object.fromEntries(chapters.map((c) => [String(c.num), c.revision])) };
}

/** 为单集短剧/卷预告生成多平台发布文案（爆款标题、简介、话题标签、封面花字）。 */
export async function generatePublishCopy(book, cfg, episode, { onLog } = {}) {
  const shots = Array.isArray(episode?.shots) ? episode.shots : [];
  const lines = shots.slice(0, 16).map((s) => `第${s.index}镜：${s.action || ''}${s.narration ? `｜台词：${s.narration}` : ''}`).join('\n');
  const sys = '你是抖音/快手/小红书短剧运营主编，擅长写高完播率与高点击率的短剧发布文案。只输出JSON。';
  const user = `作品：《${book.title}》
类型：${episode.kind === 'trailer' ? '卷预告' : `短剧第 ${episode.index} 集`}《${episode.title || ''}》
看点：${episode.logline || ''}
结尾钩子：${episode.hook || ''}
分镜概览：
${lines || '（暂无分镜）'}

请生成发布文案包，要求：
1. titles：3 个不同风格的短剧标题（悬念型、冲突反转型、情绪共鸣型），每个 14–28 字；
2. caption：一段 60–120 字的平台简介（带追更引导，不剧透结局）；
3. hashtags：6–8 个高流量中文话题标签（不带 # 号）；
4. coverText：2 行适合竖屏封面的吸睛大字（每行 4–8 字）。

输出：
\`\`\`json
{"titles":["标题1","标题2","标题3"],"caption":"简介","hashtags":["AI短剧","网文改编"],"coverText":["主标题","副标题"]}
\`\`\``;
  const text = await askModel(book, cfg, sys, user, { maxTokens: 2000, temperature: 0.7, onLog });
  const parsed = extractJson(text);
  if (!parsed) throw new Error('发布文案生成失败：模型未返回有效 JSON');
  return {
    titles: strList(parsed.titles).slice(0, 5),
    caption: str(parsed.caption),
    hashtags: strList(parsed.hashtags).map((t) => t.replace(/^#+/, '')).filter(Boolean).slice(0, 12),
    coverText: strList(parsed.coverText).slice(0, 3),
    generatedAt: new Date().toISOString(),
  };
}
