// StoryAlter × Novel Studio 融合模块：
// 1. 分身人格系统（Alter Ego：Soul 灵魂 / Brain 大脑 / Body 躯体 / Experience 经验）
// 2. 拆书仿写与风格提取（Book Analyzer & Cloner）
// 3. 剧情多分支推演（Plot Branch Simulator）

import fs from 'node:fs';
import path from 'node:path';
import { lastChapterTail } from './contextpack.mjs';
import { CONFIG_DIR } from './paths.mjs';

const ALTER_REL = path.join('.studio', 'alter_persona.json');
const GLOBAL_ALTERS_FILE = path.join(CONFIG_DIR, 'global_alters.json');

export const PRESET_ALTERS = {
  shuangwen_blade: {
    id: 'shuangwen_blade',
    name: '热血爽文快刀手',
    soul: {
      coreValues: '有仇当场报、绝不隔夜憋屈，底层逆袭靠狠劲与底牌',
      emotionalTone: '凌厉、痛快、强压迫感后瞬时爆发',
      themes: ['逆袭打脸', '强者为尊', '杀伐果断'],
    },
    brain: {
      structurePreference: '三章一小高潮、十章一大高潮，开局300字必见冲突',
      conflictPattern: '反派层层加码嘲讽 → 主角隐忍蓄力或亮出信息差 → 雷霆反杀并夺取资源',
      satisfactionDesign: '当众反转、越级碾压、战利品即时落袋、旁观者震惊忌惮',
    },
    body: {
      proseStyle: '短句为主，动词密集，少景物抒情，多动作与利益交锋',
      dialogueHabit: '台词简短带刺，潜台词直指利益与生死，不打官腔',
      descriptionPreference: '聚焦代价、伤势、筹码数字与身份反差',
    },
  },
  mystery_architect: {
    id: 'mystery_architect',
    name: '诡秘悬疑布局师',
    soul: {
      coreValues: '等价交换、未知即恐惧、人性在绝境中的算计与微光',
      emotionalTone: '冷峻、克制、层层剥茧的紧绷感',
      themes: ['序列晋升', '幕后布局', '因果代价'],
    },
    brain: {
      structurePreference: '草蛇灰线、多线收束，每章解一个小谜团同时抛出更大的异常',
      conflictPattern: '信息不对称博弈 → 试探规则底线 → 借规则反噬对手',
      satisfactionDesign: '智商压制、马甲掉满地、伏笔跨卷回收时的头皮发麻感',
    },
    body: {
      proseStyle: '细节精准冷冽，感官描写突出异样感，叙事视角严格受限',
      dialogueHabit: '克制礼貌下暗藏机锋，真假掺半，留白多',
      descriptionPreference: '环境冷暖光影、器物旧痕、微表情与反常细节',
    },
  },
  court_strategist: {
    id: 'court_strategist',
    name: '权谋历史老辣笔',
    soul: {
      coreValues: '势利之上见人心，阳谋破阴谋，利益捆绑胜过口头效忠',
      emotionalTone: '沉稳老辣、冷眼旁观、暗流汹涌',
      themes: ['朝堂博弈', '寒门崛起', '乱世基建'],
    },
    brain: {
      structurePreference: '先立小局攒钱粮班底，再借势撬动大局，步步为营',
      conflictPattern: '上位者制衡猜忌 + 对手借刀杀人 → 抓账册/兵权/白手套死穴反将一军',
      satisfactionDesign: '杀人诛心、借力打力、让对手哑巴吃黄连还得主动送筹码',
    },
    body: {
      proseStyle: '古朴洗练而不晦涩，讲究器物制度与人情世故的分寸感',
      dialogueHabit: '话留三分、敲山震虎、称谓与官场规矩严密',
      descriptionPreference: '账目钱粮、舆地险要、茶盏冷热与阶品仪制',
    },
  },
  slice_of_life_master: {
    id: 'slice_of_life_master',
    name: '烟火年代质感流',
    soul: {
      coreValues: '把苦日子过出热乎气，踏实搞钱护家人，时代浪潮里抓先机',
      emotionalTone: '温润接地气、爽感扎实、生活气息浓郁',
      themes: ['年代搞钱', '日常腾飞', '家人守护'],
    },
    brain: {
      structurePreference: '一桩生意接一桩升级，极品亲戚/同行刁难快刀斩乱麻',
      conflictPattern: '现实困境/轻视 → 凭超前眼光与手艺破局 → 攒下第一桶金并扩张盘子',
      satisfactionDesign: '账面数字暴涨、改善伙食置办大件、前倨后恭的现实反差',
    },
    body: {
      proseStyle: '口语化生动自然，极具市井烟火味与年代实感',
      dialogueHabit: '方言俗语点缀得当，人物说话带身份烙印，接地气',
      descriptionPreference: '饭菜油香、票证物价、街巷风物与算盘进账',
    },
  },
};

function alterFilePath(bookDir) {
  return path.join(bookDir, ALTER_REL);
}

export function loadBookAlter(bookDir) {
  if (!bookDir) return null;
  const p = alterFilePath(bookDir);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function saveBookAlter(bookDir, alterInput) {
  if (!bookDir) throw new Error('bookDir 不能为空');
  const globals = loadGlobalAlters();
  let resolved = alterInput;
  if (typeof alterInput === 'string' && globals[alterInput]) {
    resolved = { ...globals[alterInput] };
  } else if (alterInput && alterInput.presetId && globals[alterInput.presetId]) {
    const base = globals[alterInput.presetId];
    resolved = {
      ...base,
      ...alterInput,
      soul: { ...base.soul, ...(alterInput.soul || {}) },
      brain: { ...base.brain, ...(alterInput.brain || {}) },
      body: { ...base.body, ...(alterInput.body || {}) },
    };
  }
  const existing = loadBookAlter(bookDir) || {};
  const merged = {
    id: resolved?.id || existing.id || 'custom_alter',
    name: resolved?.name || existing.name || '专属写作分身',
    soul: { ...(existing.soul || {}), ...(resolved?.soul || {}) },
    brain: { ...(existing.brain || {}), ...(resolved?.brain || {}) },
    body: { ...(existing.body || {}), ...(resolved?.body || {}) },
    experience: {
      totalChapters: existing.experience?.totalChapters || 0,
      totalWords: existing.experience?.totalWords || 0,
      learnedRules: existing.experience?.learnedRules || [],
      ...(resolved?.experience || {}),
    },
    updatedAt: new Date().toISOString(),
  };
  const dir = path.join(bookDir, '.studio');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(alterFilePath(bookDir), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function recordAlterGrowth(bookDir, { chaptersAdded = 0, wordsAdded = 0, learnedRule = '' } = {}) {
  const alter = loadBookAlter(bookDir);
  if (!alter) return null;
  alter.experience = alter.experience || { totalChapters: 0, totalWords: 0, learnedRules: [] };
  alter.experience.totalChapters = (alter.experience.totalChapters || 0) + Number(chaptersAdded || 0);
  alter.experience.totalWords = (alter.experience.totalWords || 0) + Number(wordsAdded || 0);
  if (learnedRule && !alter.experience.learnedRules.includes(learnedRule)) {
    alter.experience.learnedRules.push(learnedRule);
    if (alter.experience.learnedRules.length > 30) {
      alter.experience.learnedRules = alter.experience.learnedRules.slice(-30);
    }
  }
  alter.updatedAt = new Date().toISOString();
  fs.writeFileSync(alterFilePath(bookDir), JSON.stringify(alter, null, 2), 'utf8');
  return alter;
}

export function buildAlterPromptSection(bookDirOrAlter) {
  const alter = typeof bookDirOrAlter === 'string' ? loadBookAlter(bookDirOrAlter) : bookDirOrAlter;
  if (!alter) return '';
  const soul = alter.soul || {};
  const brain = alter.brain || {};
  const body = alter.body || {};
  const exp = alter.experience || {};

  const lines = [
    `## 🎭 专属写作分身（StoryAlter · ${alter.name || '自定义分身'}）`,
    `> 本书绑定了专属写作分身，请在【不违反本书范本与连续性铁律】的前提下贯彻以下三维创作人格：`,
  ];

  if (soul.coreValues || soul.emotionalTone || (soul.themes && soul.themes.length)) {
    lines.push('### 【灵魂 Soul · 价值与基调】');
    if (soul.coreValues) lines.push(`- 核心价值主轴：${soul.coreValues}`);
    if (soul.emotionalTone) lines.push(`- 情感基调：${soul.emotionalTone}`);
    if (Array.isArray(soul.themes) && soul.themes.length) lines.push(`- 母题偏好：${soul.themes.join('、')}`);
  }

  if (brain.structurePreference || brain.conflictPattern || brain.satisfactionDesign) {
    lines.push('### 【大脑 Brain · 冲突与爽点结构】');
    if (brain.structurePreference) lines.push(`- 结构节奏：${brain.structurePreference}`);
    if (brain.conflictPattern) lines.push(`- 冲突推进模式：${brain.conflictPattern}`);
    if (brain.satisfactionDesign) lines.push(`- 爽点兑现方式：${brain.satisfactionDesign}`);
  }

  if (body.proseStyle || body.dialogueHabit || body.descriptionPreference) {
    lines.push('### 【躯体 Body · 行文与对白习惯】');
    if (body.proseStyle) lines.push(`- 句式与行文：${body.proseStyle}`);
    if (body.dialogueHabit) lines.push(`- 对话习惯：${body.dialogueHabit}`);
    if (body.descriptionPreference) lines.push(`- 描写重心：${body.descriptionPreference}`);
  }

  if (Array.isArray(exp.learnedRules) && exp.learnedRules.length > 0) {
    lines.push('### 【分身实战习得经验（作者反馈沉淀）】');
    for (const r of exp.learnedRules.slice(-10)) {
      lines.push(`- ${r}`);
    }
  }

  return lines.join('\n');
}

// —— 拆书仿写（Book Analyzer & Cloner）——
export function buildBookClonePrompt({ sampleText, targetGenre = '', targetTitle = '', customNote = '' }) {
  const snippet = String(sampleText || '').slice(0, 12000);
  return [
    '你是资深网文主编与拆书专家。请对下面的【样书文本】进行深度拆解，并据此脱胎换骨生成一部【同爽点骨架、全新世界观与人设】的原创长篇立项方案。',
    '',
    targetTitle ? `目标新书名：《${targetTitle}》` : '请同时为新书拟定 3 个极具番茄/起点爆款潜力的书名。',
    targetGenre ? `目标题材方向：${targetGenre}` : '',
    customNote ? `作者额外要求：${customNote}` : '',
    '',
    '请严格输出以下 JSON 结构（不要包含多余解释，直接输出合法 JSON）：',
    '```json',
    '{',
    '  "recommendedTitle": "主推新书名",',
    '  "alternativeTitles": ["备选书名1", "备选书名2"],',
    '  "genre": "题材分类标签",',
    '  "synopsis": "150-250字爆款简介（亮出主角身份困境+金手指/破局立意+核心看点）",',
    '  "alterPersona": {',
    '    "name": "从样书提炼的分身名",',
    '    "soul": { "coreValues": "...", "emotionalTone": "...", "themes": ["..."] },',
    '    "brain": { "structurePreference": "...", "conflictPattern": "...", "satisfactionDesign": "..." },',
    '    "body": { "proseStyle": "...", "dialogueHabit": "...", "descriptionPreference": "..." }',
    '  },',
    '  "worldSetting": "脱胎换骨后的全新世界观与力量/势力体系",',
    '  "protagonist": { "name": "主角名", "identity": "身份与开局处境", "goldenFinger": "核心依仗/破局能力" },',
    '  "volume1Outline": [',
    '    { "chapter": 1, "title": "第1章标题", "beat": "核心冲突与事件", "hook": "章末钩子" },',
    '    { "chapter": 2, "title": "第2章标题", "beat": "核心冲突与事件", "hook": "章末钩子" },',
    '    { "chapter": 3, "title": "第3章标题", "beat": "黄金三章立威/破局高潮", "hook": "章末钩子" }',
    '  ]',
    '}',
    '```',
    '',
    '【样书文本】',
    snippet,
  ].filter(Boolean).join('\n');
}

// —— 剧情多分支推演（Plot Simulator）——
export function buildPlotSimulationPrompt(book, { focusQuestion = '', chapterCount = 5 } = {}) {
  const dir = book.dir;
  const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const bible = readOr(path.join(dir, 'novel_bible.md')).slice(0, 4000);
  const ledger = readOr(path.join(dir, 'continuity_ledger.md')).slice(0, 4000);
  const tail = lastChapterTail(book, 1500);

  return [
    `你是《${book.title}》的首席剧情推演策划。基于当前已写到的进度（第 ${tail.num || 0} 章），请推演接下来 ${chapterCount} 章的 **3 条截然不同的剧情分支走向**（例如：A 激进破局线 / B 设局反钓鱼线 / C 暗线揭秘或势力洗牌线）。`,
    focusQuestion ? `\n【作者当前纠结的核心问题/方向】：${focusQuestion}\n` : '',
    '每条分支必须严守本书连续性台账（死者不复生、知情边界不串、伏笔可联动），并评估其爽点烈度与潜在风险。',
    '',
    '请严格输出以下 JSON 格式：',
    '```json',
    '{',
    '  "currentChapter": ' + (tail.num || 0) + ',',
    '  "branches": [',
    '    {',
    '      "id": "A",',
    '      "title": "分支名称（如：雷霆反制·当堂掀桌）",',
    '      "style": "爽点密集 / 悬疑反转 / 稳扎稳打",',
    '      "summary": "100字核心走向概述",',
    '      "satisfactionScore": 9,',
    '      "riskNote": "对后续大纲或战力体系的潜在影响提醒",',
    '      "payoffsTriggered": ["顺手推进或回收的伏笔名称"],',
    '      "beats": [',
    '        { "chapter": ' + ((tail.num || 0) + 1) + ', "event": "本章核心事件与冲突", "advance": "人物/关系/线索推进", "hook": "章末钩子" }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '【设定圣经摘录】',
    bible,
    '',
    '【连贯性台账当前态】',
    ledger,
    '',
    tail.tail ? `【第 ${tail.num} 章结尾原文】\n${tail.tail}` : '',
  ].filter(Boolean).join('\n');
}

// 将推演选中的分支 beats 直接追加写入当前卷分章大纲文件
export function applySimulatedBranchToOutline(book, branch, volNum = 1) {
  if (!book?.dir || !branch || !Array.isArray(branch.beats) || !branch.beats.length) {
    throw new Error('无效的分支 beat 数据');
  }
  const odir = path.join(book.dir, 'outlines');
  fs.mkdirSync(odir, { recursive: true });
  const tag = '卷' + String(volNum || 1).padStart(2, '0');
  let targetFile = '';
  try {
    const files = fs.readdirSync(odir).filter(f => /\.md$/i.test(f));
    targetFile = files.find(f => f.includes(tag)) || files[files.length - 1] || `${tag}分章大纲.md`;
  } catch {
    targetFile = `${tag}分章大纲.md`;
  }
  const fullPath = path.join(odir, targetFile);
  const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : `# 《${book.title}》${tag} 分章大纲\n\n| 章号 | 核心事件 / 冲突 | 推进了什么（人物 / 关系 / 线索） | 章末钩子 |\n|---|---|---|---|\n`;

  const newRows = branch.beats.map(b => {
    const chStr = String(b.chapter || '').padStart(3, '0');
    const ev = String(b.event || '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
    const adv = String(b.advance || '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
    const hk = String(b.hook || '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
    return `| ${chStr} | ${ev} | ${adv} | ${hk} |`;
  });

  const block = `\n\n<!-- 剧情推演采纳分支：${branch.title || branch.id} (${new Date().toISOString().slice(0, 10)}) -->\n` + newRows.join('\n') + '\n';
  fs.writeFileSync(fullPath, existing.replace(/\s*$/, '') + block, 'utf8');
  return { file: path.join('outlines', targetFile), addedBeats: newRows.length };
}

// —— 全局写作分身库（内置 4 大流派预设 + 作者从样书/语料训练沉淀的自定义分身）——
export function loadGlobalAlters() {
  let custom = {};
  try {
    if (fs.existsSync(GLOBAL_ALTERS_FILE)) {
      custom = JSON.parse(fs.readFileSync(GLOBAL_ALTERS_FILE, 'utf8')) || {};
    }
  } catch { custom = {}; }
  return { ...PRESET_ALTERS, ...custom };
}

export function saveGlobalAlter(alterObj) {
  if (!alterObj || !alterObj.name) throw new Error('分身名称不能为空');
  let custom = {};
  try {
    if (fs.existsSync(GLOBAL_ALTERS_FILE)) {
      custom = JSON.parse(fs.readFileSync(GLOBAL_ALTERS_FILE, 'utf8')) || {};
    }
  } catch { custom = {}; }
  const id = alterObj.id && alterObj.id !== 'custom_alter'
    ? String(alterObj.id).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')
    : 'alter_' + Date.now().toString(36);
  const entry = {
    id,
    name: String(alterObj.name).trim(),
    sourceBook: alterObj.sourceBook || '',
    soul: {
      coreValues: alterObj.soul?.coreValues || '',
      emotionalTone: alterObj.soul?.emotionalTone || '',
      themes: Array.isArray(alterObj.soul?.themes) ? alterObj.soul.themes : String(alterObj.soul?.themes || '').split(/[、，,]/).map(s => s.trim()).filter(Boolean),
    },
    brain: {
      structurePreference: alterObj.brain?.structurePreference || '',
      conflictPattern: alterObj.brain?.conflictPattern || '',
      satisfactionDesign: alterObj.brain?.satisfactionDesign || '',
    },
    body: {
      proseStyle: alterObj.body?.proseStyle || '',
      dialogueHabit: alterObj.body?.dialogueHabit || '',
      descriptionPreference: alterObj.body?.descriptionPreference || '',
    },
    experience: alterObj.experience || { totalChapters: 0, totalWords: 0, learnedRules: [] },
    isCustom: true,
    updatedAt: new Date().toISOString(),
  };
  custom[id] = entry;
  fs.mkdirSync(path.dirname(GLOBAL_ALTERS_FILE), { recursive: true });
  fs.writeFileSync(GLOBAL_ALTERS_FILE, JSON.stringify(custom, null, 2), 'utf8');
  return entry;
}

export function deleteGlobalAlter(id) {
  if (PRESET_ALTERS[id]) throw new Error('内置预设分身不可删除');
  let custom = {};
  try {
    if (fs.existsSync(GLOBAL_ALTERS_FILE)) {
      custom = JSON.parse(fs.readFileSync(GLOBAL_ALTERS_FILE, 'utf8')) || {};
    }
  } catch { custom = {}; }
  delete custom[id];
  fs.writeFileSync(GLOBAL_ALTERS_FILE, JSON.stringify(custom, null, 2), 'utf8');
  return { ok: true, id };
}

export function extractAlterFromSamplePrompt({ sampleText, sourceTitle = '', genre = '' }) {
  const snippet = String(sampleText || '').slice(0, 9000);
  return [
    '你是资深网文主编与文风解构专家。请深度剖析下面的【样书正文】，提炼出这位作者的「三维写作分身（StoryAlter：Soul 灵魂 / Brain 大脑 / Body 躯体）」，供 AI 在创作新书时100%复刻其叙事灵魂、冲突节拍与行文手感（只学写法与爽点机制，不抄原书专有名词）。',
    sourceTitle ? `样书来源：《${sourceTitle}》` : '',
    genre ? `题材参考：${genre}` : '',
    '',
    '请严格输出以下 JSON 格式（不要输出任何多余解释）：',
    '```json',
    '{',
    `  "name": "${sourceTitle ? sourceTitle.slice(0, 12) + '·专属分身' : '名家拆书分身'}",`,
    '  "soul": {',
    '    "coreValues": "一句话概括主角处世哲学与核心价值主轴（如：有仇当场报、利益算计到骨子里、外冷内热护短）",',
    '    "emotionalTone": "叙事整体情绪张力与基调（如：冷峻紧绷、市井诙谐、杀伐果断）",',
    '    "themes": ["核心母题1", "核心母题2", "核心母题3"]',
    '  },',
    '  "brain": {',
    '    "structurePreference": "章节开合与悬念节拍（如：开篇直入冲突、三段式反转、章末必留硬钩子）",',
    '    "conflictPattern": "矛盾升级与破局套路（如：反派轻视立靶 → 主角亮底牌降维反杀 → 顺手收割筹码）",',
    '    "satisfactionDesign": "爽点兑现的具体手法（如：借旁观者视角衬托、账面数字暴涨、杀人诛心）"',
    '  },',
    '  "body": {',
    '    "proseStyle": "句式长短、换行节奏、动词密度与口语度特征",',
    '    "dialogueHabit": "人物台词风格、潜台词留白、口癖或机锋特点",',
    '    "descriptionPreference": "最擅长描写的实锚（如：器物细节、微表情、身份反差、身体感官）"',
    '  }',
    '}',
    '```',
    '',
    '【样书正文】',
    snippet,
  ].filter(Boolean).join('\n');
}

export function parseAlterJson(rawOutput, fallbackTitle = '样书分身') {
  const s = String(rawOutput || '');
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i) || s.match(/(\{[\s\S]*\})/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    const data = obj.alterPersona || obj;
    return {
      name: data.name || `${fallbackTitle}·写作分身`,
      sourceBook: fallbackTitle,
      soul: data.soul || {},
      brain: data.brain || {},
      body: data.body || {},
    };
  } catch {
    return null;
  }
}
