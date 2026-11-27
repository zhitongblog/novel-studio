// 番茄官方规则定期学习模块（Fanqie Rules Learner）
// 定期从番茄作家后台（公告中心 / 连载资讯 / 官方课堂 / 内容发布规范）增量抓取全部官方规则、
// 低质治理公告、账号处罚公示、签约与更新节奏政策、审稿级文字与排版教程，沉淀为结构化知识库，
// 并自动提炼为紧凑红线供 skill.mjs（写作提示词）与 chapgate.mjs（审校闸门）消费。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './paths.mjs';
import { UnzooClient } from './fanqie.mjs';
import { loadBooks } from './store.mjs';

export const FANQIE_RULES_DIR = path.join(CONFIG_DIR, 'fanqie-rules');
export const FANQIE_RULES_ARTICLES_DIR = path.join(FANQIE_RULES_DIR, 'articles');
export const FANQIE_RULES_INDEX = path.join(FANQIE_RULES_DIR, 'index.json');
export const FANQIE_RULES_DIGEST = path.join(FANQIE_RULES_DIR, 'digest.md');

// 核心种子清单：覆盖平台总规范、10月低质治理/处罚、完本与更新节奏政策、以及官方全套防低质课堂
export const SEED_RULE_ARTICLES = [
  { id: '7237084151751376957', title: '番茄平台内容发布规范', category: 'compliance' },
  { id: '7709405659476803608', title: '番茄小说低质治理公告（10月）', category: 'governance' },
  { id: '7706792381944709182', title: '2026年10月番茄平台账号违规处罚公告', category: 'governance' },
  { id: '7709025087524962329', title: '番茄小说完本签约作品章节发布节奏调整通知', category: 'policy' },
  { id: '7710098549966389273', title: '番茄小说完本签约模式福利指南', category: 'policy' },
  { id: '7711651779401760830', title: '投稿前必看：开篇设定自然、场面立体的2个关键', category: 'craft' },
  { id: '7709437590268543038', title: '投稿前必看：缺钩子、流水账、切入慢，开篇这样救', category: 'craft' },
  { id: '7706791304272805913', title: '投稿前必查：告别“文风呆板”和“错误排版”', category: 'craft' },
  { id: '7704982125124010009', title: '投稿前必查：影响作品质量的8个文字硬伤', category: 'craft' },
  { id: '7672341247800918040', title: '告别重复表达：学会给文字做“减法”', category: 'craft' },
  { id: '7668245714413027390', title: '告别“出戏感”：写出让读者上头的质感网文', category: 'craft' },
  { id: '7672343903181226008', title: '告别低级失误：发稿前必做的四步自查', category: 'craft' },
  { id: '7673406206286757950', title: '告别中期疲软：长篇防崩文自救指南', category: 'craft' },
  { id: '7673467691482497086', title: '告别千人一面：带你写出有血有肉的人物', category: 'craft' },
];

// 自动发现过滤：只收录规则/治理/处罚/签约/节奏/写作质量教程，跳过纯征文颁奖、专访、短故事活动广告
const RULE_TITLE_INCLUDE = /低质|治理|整治|处罚|违规|规范|规则|必查|必看|告别|文字硬伤|文风|排版|防崩|自查|签约|完本|节奏|调整通知|作家等级|审核|推荐|原创|版权|开篇|人物|场景|动作描写/;
const RULE_TITLE_EXCLUDE = /拟获奖公示|获奖名单|专访|激励计划|征文|开学季|漫剧改编|风向标|短故事.*(激励|高热|导语)/;

export function isRelevantRuleTitle(title) {
  const t = String(title || '').trim();
  if (!t || t.length < 4) return false;
  if (RULE_TITLE_EXCLUDE.test(t)) return false;
  return RULE_TITLE_INCLUDE.test(t);
}

export function classifyRuleArticle(title, text = '') {
  const s = `${title || ''}\n${String(text || '').slice(0, 400)}`;
  if (/内容发布规范|安全规范|红线|审核规范/.test(s)) return 'compliance';
  if (/低质治理|整治|违规处罚|封禁|下架|拒签/.test(s)) return 'governance';
  if (/签约|完本|作家等级|节奏调整|福利指南|全勤|分成/.test(s)) return 'policy';
  return 'craft';
}

const CATEGORY_LABELS = {
  compliance: '一、平台内容发布总规范与安全/版权红线',
  governance: '二、低质治理与账号违规处罚月度动向',
  policy: '三、签约模式、作家等级与章节发布节奏新规',
  craft: '四、官方审稿级文风、排版、开篇与中后期质检标准',
};

// 清洗番茄文章页 innerText：去掉顶部导航、左侧目录重复栏、底部评论与版权页脚
export function cleanArticleText(raw, title = '') {
  let lines = String(raw || '').replace(/\r\n/g, '\n').split('\n').map(l => l.trim());
  // 去掉评论区及页脚
  const cutIdx = lines.findIndex((l, idx) => idx > 5 && (/^评论(\s*\d+)?$/.test(l) || /^0\/300评论$/.test(l) || /^《番茄小说网用户协议》$/.test(l)));
  if (cutIdx > 0) lines = lines.slice(0, cutIdx);
  // 定位正文起点（番茄文章页通常在「番茄小说网 2026-xx-xx」发布时间行后进入正文）
  const metaIdx = lines.findIndex(l => /^番茄小说网\s*20\d{2}-\d{2}-\d{2}/.test(l));
  let publishedAt = '';
  if (metaIdx >= 0) {
    const m = lines[metaIdx].match(/(20\d{2}-\d{2}-\d{2})/);
    if (m) publishedAt = m[1];
    lines = lines.slice(metaIdx + 1);
  } else {
    // 兜底去掉前 6 行导航（作家福利 / 作家课堂 / 帮助中心 / 分享等）
    const shareIdx = lines.findIndex(l => l === '分享');
    if (shareIdx >= 0 && shareIdx < 20) lines = lines.slice(shareIdx + 1);
  }
  // 压缩连续空行并剔除残余 UI 噪音
  const cleaned = [];
  let prevEmpty = false;
  for (const l of lines) {
    if (!l) {
      if (!prevEmpty && cleaned.length) cleaned.push('');
      prevEmpty = true;
      continue;
    }
    if (/^(举报|分享|收藏|点赞|\d+)$/.test(l)) continue;
    cleaned.push(l);
    prevEmpty = false;
  }
  const body = cleaned.join('\n').trim();
  const inferredTitle = title || (lines.find(Boolean) || '').slice(0, 60);
  return { title: inferredTitle, publishedAt, body };
}

// 从单篇官方文章确定性抽取关键要点（标题层级、数据指标、处罚条款、自查方法），无需额外调 LLM
export function extractRuleTakeaways(title, body) {
  const lines = String(body || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const points = [];
  const seen = new Set();
  const push = (s) => {
    const clean = s.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 8 || clean.length > 180) return;
    const key = clean.slice(0, 32);
    if (seen.has(key)) return;
    seen.add(key);
    points.push(clean);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 1. 治理数据与处罚条款
    if (/拒绝签约|处置低质|封禁账号|不予推荐|处置下架|仅开放|完本签约|严禁|不得|禁止/.test(l)) {
      push(l);
    }
    // 2. 教程结构化小标题与方法论
    if (/^([一二三四五六七八九十]+、|\d+[、.．]|方法[一二三四五]|第[一二三四五]步|[①②③④⑤])/.test(l)) {
      // 如果小标题太短，拼上下一行解释
      if (l.length < 18 && lines[i + 1] && !/^(🔍|✒|💡|改前|改后|例如)/.test(lines[i + 1])) {
        push(`${l}：${lines[i + 1].slice(0, 120)}`);
      } else {
        push(l);
      }
    }
    // 3. 官方明确标识的问题清单（・开头）
    if (/^[・·•]/.test(l) && /破折号|标点|段落|重复|不是|排比|流水账|烂尾|升华|模板|错别字|主语|指代|比喻|形容词|短对话|乱分|空气/.test(l)) {
      push(l);
    }
  }
  // 兜底：若规则体裁不含上述前缀，取前几段实质内容
  if (points.length < 3) {
    for (const l of lines) {
      if (l.length >= 25 && !/^(课程内容|适用对象|预计学习时长|上节课|这节课)/.test(l)) {
        push(l.slice(0, 140));
        if (points.length >= 6) break;
      }
    }
  }
  return points.slice(0, 14);
}

export function loadRulesIndex() {
  try {
    return JSON.parse(fs.readFileSync(FANQIE_RULES_INDEX, 'utf8'));
  } catch {
    return { updatedAt: null, totalArticles: 0, lastNewCount: 0, articles: {}, history: [] };
  }
}

export function saveRulesIndex(idx) {
  fs.mkdirSync(FANQIE_RULES_ARTICLES_DIR, { recursive: true });
  fs.writeFileSync(FANQIE_RULES_INDEX, JSON.stringify(idx, null, 2), 'utf8');
}

export function buildRulesDigest(idx) {
  const arts = Object.values(idx.articles || {});
  const byCat = { compliance: [], governance: [], policy: [], craft: [] };
  for (const a of arts) {
    const cat = byCat[a.category] ? a.category : 'craft';
    byCat[cat].push(a);
  }
  for (const k of Object.keys(byCat)) {
    byCat[k].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) || String(b.id).localeCompare(String(a.id)));
  }

  const out = [
    '# 番茄小说官方规则与防低质红线知识库（自动定期学习）',
    '',
    `- 最近同步时间：${idx.updatedAt || '尚未同步'}`,
    `- 已学习官方规则/课堂篇数：**${arts.length}** 篇`,
    `- 存储位置：\`${FANQIE_RULES_DIR}\``,
    '',
    '## 核心硬红线速查（直接指导写作与审校闸）',
    '',
    '1. **四类低质高压线**：AI粗制滥造、格式混乱、结构失常、空洞水文（10月单月拒签 11 万本、处置 1.5 万本）；另**叙事未完/仓促烂尾一律不予推荐**。',
    '2. **句式去机械化**：严控 `不是……而是……` / `不是……是……` 高频复读；禁止参数清单式罗列与**连续 3 句及以上同构排比**；单章破折号 `——` 尽量归零或控制在 2 处以内。',
    '3. **描写具体化**：一个名词最多带一个修饰词；砍掉 `无边/极致/深入骨髓` 式抽象叠词与 `弧度为2mm的微笑` 式假精确比喻；单章比喻 ≤ 2 处。',
    '4. **对白与排版**：禁止连续 5 行以上光秃秃“念台词”短对话（必须穿插动作/神态/场景）；禁止特殊装饰符（`△★♥♛√`）、中英文标点混用、句中空格、频繁 3–5 字独立碎段与**半句切章**。',
    '5. **首尾与推进**：禁止“清晨阳光/天气预报”模板章首与复述上章结尾；禁止章尾上帝视角哲理升华（`强者之路注定孤独`）；每章必须至少完成 1 项实质推进（新信息 / 关系变化 / 冲突升级 / 风险加深），避免单一手法连写多章。',
    '6. **安全与版权底线**：严禁涉政/色情低俗/血腥猎奇/违背公序良俗；严禁洗稿融梗抄袭（版权违规直接封号）。',
    '',
  ];

  for (const cat of ['compliance', 'governance', 'policy', 'craft']) {
    const list = byCat[cat];
    if (!list.length) continue;
    out.push(`## ${CATEGORY_LABELS[cat]}`, '');
    for (const a of list) {
      out.push(`### ${a.title}${a.publishedAt ? `（${a.publishedAt}）` : ''}`);
      out.push(`- 链接：${a.url} | 本地存档：\`articles/${a.id}.md\``);
      const pts = Array.isArray(a.takeaways) ? a.takeaways : [];
      for (const p of pts.slice(0, 10)) out.push(`- ${p}`);
      out.push('');
    }
  }

  return out.join('\n');
}

// 提供给 skill.mjs 注入写作提示词的紧凑红线块（控制在 ~650 字内，不撑爆上下文）
export function fanqieRulesPromptSection() {
  const idx = loadRulesIndex();
  const syncedNote = idx.updatedAt
    ? `（已同步番茄官方最新规则 ${idx.totalArticles || 0} 篇，最近学习：${String(idx.updatedAt).slice(0, 10)}）`
    : '（基于番茄 2026 年 10–11 月低质治理公告与官方作家课堂红线）';
  return [
    `**10. 番茄官方防低质与审稿红线${syncedNote}**`,
    '- **杜绝句式过度工整**：单章严控「不是……而是…… / 不是……是……」不超过 2 处；禁止把设定写成参数清单（如 `炉径：… / 炉壁：…`）；**连续 3 句及以上的同结构排比直接删改**。',
    '- **杜绝描写用力过猛**：一个名词最多带一个修饰词；删掉「无边的、极致的、深入骨髓的」这类抽象强形容词叠词，禁止「弧度2mm的微笑」式假精确比喻；单章比喻 ≤ 2 处，脑补不出具体画面的全删。',
    '- **杜绝纯对话乒乓堆砌**：禁止连续 4–5 行以上无动作、无神态、无场景的“念剧本式”短对话，合并「嗯/啊/是吗/然后呢」过渡水词。',
    '- **杜绝排版与首尾模板**：正文禁用 `△★♥♛√` 等装饰符与句中乱空格；禁止半句强行切章；禁止「清晨阳光透过树叶」式天气预报章首，禁止章尾上帝视角讲大道理升华（如「强者之路注定孤独」），章尾一律落回具体动作或悬念钩子。',
    '- **每章必须有实质推进 & 严禁烂尾**：每章至少完成 1 项（新信息 / 关系变化 / 冲突升级 / 风险加深），禁止用同一手法（纯打架/纯吵架/纯独白）连拖多章；完结收尾必须交代清楚核心矛盾与人物归宿。',
  ].join('\n');
}

export function loadFanqieRulesStatus() {
  const idx = loadRulesIndex();
  const arts = Object.values(idx.articles || {});
  const counts = { compliance: 0, governance: 0, policy: 0, craft: 0 };
  for (const a of arts) counts[a.category] = (counts[a.category] || 0) + 1;
  let staleDays = null;
  if (idx.updatedAt) {
    staleDays = Math.floor((Date.now() - Date.parse(idx.updatedAt)) / 86400000);
  }
  return {
    updatedAt: idx.updatedAt,
    staleDays,
    totalArticles: arts.length,
    lastNewCount: idx.lastNewCount || 0,
    counts,
    digestPath: FANQIE_RULES_DIGEST,
    indexPath: FANQIE_RULES_INDEX,
    exists: fs.existsSync(FANQIE_RULES_DIGEST),
  };
}

function resolveDefaultProfilePath(explicit) {
  if (explicit) return explicit;
  try {
    const books = loadBooks();
    const hit = books.find(b => b.publish?.profilePath && (!b.publish?.platform || b.publish.platform === 'fanqie'));
    if (hit) return hit.publish.profilePath;
  } catch {}
  return '';
}

// 定期增量学习入口：从番茄作家后台发现并拉取所有最新规则与官方课堂文章，写入本地知识库并刷新 digest.md
export async function syncFanqieRules({ profilePath = '', maxPages = 2, force = false, onLog = () => {} } = {}) {
  const prof = resolveDefaultProfilePath(profilePath);
  if (!prof) throw new Error('未找到可用的番茄 Unzoo profilePath（请传入 --profile 或先绑定任意番茄书籍）');

  fs.mkdirSync(FANQIE_RULES_ARTICLES_DIR, { recursive: true });
  const idx = loadRulesIndex();
  const candidateMap = new Map();
  for (const s of SEED_RULE_ARTICLES) {
    candidateMap.set(s.id, {
      id: s.id,
      title: s.title,
      url: `https://fanqienovel.com/writer/zone/article/${s.id}`,
      category: s.category,
    });
  }

  const client = new UnzooClient(prof, onLog);
  await client.ensureTabId();

  // 1. 扫描作者公告页（全部 / 连载资讯 / 官方课堂，含翻页）
  onLog({ level: 'act', msg: '📚 正在扫描番茄作家后台公告中心与官方课堂目录…' });
  await client.navigate('https://fanqienovel.com/main/writer/notice');
  await client.sleep(2200);

  const collectPageLinks = async () => {
    const raw = await client.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('a[href*="/writer/zone/article/"]')).map(a => ({
      title: a.textContent.trim().replace(/\\s+/g, ' '),
      href: a.href.split('#')[0],
      id: (a.href.match(/article\\/(\\d+)/) || [])[1] || ''
    })).filter(x => x.id))`);
    try { return JSON.parse(raw || '[]'); } catch { return []; }
  };

  const tabNames = ['全部', '连载资讯', '官方课堂'];
  for (const tab of tabNames) {
    await client.evaluate(`(() => {
      const els = Array.from(document.querySelectorAll('[role="tab"], [class*="tab"], div, span'));
      const el = els.find(e => e.textContent && e.textContent.trim() === ${JSON.stringify(tab)} && e.children.length === 0);
      if (el) el.click();
    })()`);
    await client.sleep(1400);
    for (let p = 1; p <= maxPages; p++) {
      const links = await collectPageLinks();
      for (const l of links) {
        if (isRelevantRuleTitle(l.title) && !candidateMap.has(l.id)) {
          candidateMap.set(l.id, {
            id: l.id,
            title: l.title,
            url: l.href,
            category: classifyRuleArticle(l.title),
          });
        }
      }
      if (p < maxPages) {
        const nextOk = await client.evaluate(`(() => {
          const next = Array.from(document.querySelectorAll('button, li, a')).find(e => e.textContent && e.textContent.trim() === String(${p + 1}));
          if (next) { next.click(); return true; }
          return false;
        })()`);
        if (!nextOk) break;
        await client.sleep(1500);
      }
    }
  }

  // 2. 额外探测作家课堂首页链接（抓取更多文字/排版/剧情/签约教程）
  try {
    await client.navigate('https://fanqienovel.com/writer/zone/tutorial?enter_from=menu');
    await client.sleep(2000);
    const tutLinks = await collectPageLinks();
    for (const l of tutLinks) {
      if (isRelevantRuleTitle(l.title) && !candidateMap.has(l.id)) {
        candidateMap.set(l.id, {
          id: l.id,
          title: l.title,
          url: l.href,
          category: classifyRuleArticle(l.title),
        });
      }
    }
  } catch {}

  onLog({ level: 'info', msg: `🔎 共发现 ${candidateMap.size} 篇番茄规则与官方教程，开始增量学习…` });

  // 3. 逐篇拉取尚未存档（或 force=true）的官方正文，并顺带发现文中交叉引用的新规则链接
  const queue = [...candidateMap.values()];
  const queuedIds = new Set(queue.map(x => x.id));
  let fetched = 0;
  const newArticles = [];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const existing = idx.articles[item.id];
    const mdPath = path.join(FANQIE_RULES_ARTICLES_DIR, `${item.id}.md`);
    if (!force && existing && fs.existsSync(mdPath)) continue;

    onLog({ level: 'act', msg: `📖 [${fetched + 1}] 学习：${item.title} (${item.id})` });
    await client.navigate(item.url);
    await client.sleep(1800);
    const pageDataRaw = await client.evaluate(`JSON.stringify({
      text: document.body.innerText || '',
      subLinks: Array.from(document.querySelectorAll('a[href*="/writer/zone/article/"]')).map(a => ({
        title: a.textContent.trim().replace(/\\s+/g, ' '),
        href: a.href.split('#')[0],
        id: (a.href.match(/article\\/(\\d+)/) || [])[1] || ''
      })).filter(x => x.id)
    })`);
    let pageData = { text: '', subLinks: [] };
    try { pageData = JSON.parse(pageDataRaw || '{}'); } catch {}

    // 顺带收录文章正文中推荐的其他官方规则/教程（限最多 40 篇防无限扩散）
    for (const sl of pageData.subLinks || []) {
      if (queue.length < 40 && !queuedIds.has(sl.id) && isRelevantRuleTitle(sl.title)) {
        queuedIds.add(sl.id);
        queue.push({ id: sl.id, title: sl.title, url: sl.href, category: classifyRuleArticle(sl.title) });
      }
    }

    const cleaned = cleanArticleText(pageData.text, item.title);
    if (!cleaned.body || cleaned.body.length < 80) {
      onLog({ level: 'warn', msg: `⚠️ 跳过空内容文章：${item.title} (${item.id})` });
      continue;
    }

    const hash = crypto.createHash('sha1').update(cleaned.body).digest('hex').slice(0, 12);
    const category = item.category || classifyRuleArticle(cleaned.title, cleaned.body);
    const takeaways = extractRuleTakeaways(cleaned.title, cleaned.body);

    const mdContent = [
      `# ${cleaned.title}`,
      '',
      `- 文章ID：\`${item.id}\``,
      `- 分类：\`${category}\``,
      `- 发布日期：${cleaned.publishedAt || '未知'}`,
      `- 原文链接：${item.url}`,
      `- 学习时间：${new Date().toISOString()}`,
      '',
      '---',
      '',
      cleaned.body,
      '',
    ].join('\n');
    fs.writeFileSync(mdPath, mdContent, 'utf8');

    const isNew = !existing;
    idx.articles[item.id] = {
      id: item.id,
      title: cleaned.title,
      url: item.url,
      category,
      publishedAt: cleaned.publishedAt || existing?.publishedAt || '',
      fetchedAt: new Date().toISOString(),
      chars: cleaned.body.length,
      hash,
      takeaways,
    };
    fetched++;
    if (isNew) newArticles.push({ id: item.id, title: cleaned.title, category, publishedAt: cleaned.publishedAt });
  }

  idx.updatedAt = new Date().toISOString();
  idx.totalArticles = Object.keys(idx.articles).length;
  idx.lastNewCount = newArticles.length;
  idx.history = [
    ...(Array.isArray(idx.history) ? idx.history.slice(-19) : []),
    { at: idx.updatedAt, discovered: queue.length, fetched, newCount: newArticles.length, total: idx.totalArticles },
  ];

  saveRulesIndex(idx);
  const digest = buildRulesDigest(idx);
  fs.writeFileSync(FANQIE_RULES_DIGEST, digest, 'utf8');

  onLog({
    level: 'info',
    msg: `✅ 番茄规则学习完成：共存档 ${idx.totalArticles} 篇（本次新学 ${newArticles.length} 篇 / 刷新 ${fetched} 篇），已生成 ${FANQIE_RULES_DIGEST}`,
  });

  return {
    ok: true,
    total: idx.totalArticles,
    fetched,
    newCount: newArticles.length,
    newArticles,
    digestPath: FANQIE_RULES_DIGEST,
    indexPath: FANQIE_RULES_INDEX,
  };
}
