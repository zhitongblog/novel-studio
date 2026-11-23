// 改编视频 · 现实常识与时代穿帮质检器（静态规则闸 + 可选多模态 VLM 视觉审片）。
//
// 目标：在烧卡渲染前（检查分镜 Prompt 与静态关键帧）以及渲染后（检查首/中/尾 QA 帧）
// 尽早抓出反常识穿帮：挂大腿骨、现代吊灯、踩窗台、连纸咬食物、室内外颠倒、多人漏人等。
import fs from 'node:fs';
import path from 'node:path';
import { extractJson, isPeriodStyle, sanitizeLookPrompt } from './videoplan.mjs';
import { resolveProviderCfg } from './apichat.mjs';

const PERIOD_ANACHRONISM_RE = /\b(led\s+lamp|fluorescent|ceiling\s+lamp|plastic|smartphone|neon|modern\s+boots?)\b/i;

/**
 * 确定性静态常识审计（纯函数、零成本、离线瞬跑）：
 * 检查分镜 Prompt、角色外貌卡与上一镜衔接中的高频穿帮隐患。
 */
export function auditShotPromptRealism(shot, bible = {}, prevShot = null) {
  const issues = [];
  const prompt = String(shot?.prompt || '');
  const action = String(shot?.action || '');

  // 1. 中式专名直译误导词（如 bone-setting → 墙上挂骨头）
  if (/\bbone[-\s]?setting\b/i.test(prompt)) {
    issues.push({
      code: 'LITERAL_MISLEADING_TERM',
      severity: 'high',
      msg: 'Prompt 含 "bone-setting"，英文模型会按字面在墙上挂动物/人骨头',
      fixHint: '替换为 "traditional Chinese herbal medicine clinic"',
    });
  }

  // 2. 窗台与门口混写导致半截门窗缝合怪（踩窗台）
  if (/\bwindow\b/i.test(prompt) && /\bdoorway\b/i.test(prompt) && /\b(window\s+and\s+doorway|doorway\s+and\s+window)\b/i.test(prompt)) {
    issues.push({
      code: 'MIXED_WINDOW_DOORWAY',
      severity: 'high',
      msg: 'Prompt 同时混写 window and doorway，模型易将门窗融成齐腰半截框导致人物踩窗台',
      fixHint: '单镜明确只拍门口或只拍窗边，不要混写',
    });
  }

  // 3. 单镜动作过载（5–6 秒内塞入 3+ 复合动作易糊成怪异姿势）
  const multiActionHits = [
    /\bunwrap(?:s|ping)?\b/i,
    /\bbite(?:s|ing)?\b|\bchew(?:s|ing)?\b|\bswallow(?:s|ing)?\b/i,
    /\bturn(?:s|ing)?\b|\bwhip(?:s|ping)?\b/i,
    /\brise(?:s|ing)?\b|\bstand(?:s|ing)?\s+up\b/i,
    /\bfling(?:s|ing)?\b|\bopen(?:s|ing)?\b/i,
    /\bsnatch(?:es|ing)?\b|\bgrab(?:s|bing)?\b/i,
    /\bcharge(?:s|ing)?\b|\brun(?:s|ning)?\b/i,
  ].filter((re) => re.test(prompt)).length;
  if (multiActionHits >= 3 && (Number(shot?.seconds) || 5) <= 7) {
    issues.push({
      code: 'OVERLOADED_ACTIONS',
      severity: 'medium',
      msg: `单镜 ${shot?.seconds || 5}s 内塞入过多连续动作（命中 ${multiActionHits} 组），视频模型易融合变形`,
      fixHint: '每镜保留 1 个核心物理动作，拆分拆包/进食/听声转头',
    });
  }

  // 4. 连着包装纸啃食物风险
  if (/\b(oil[-\s]?paper|parcel|wrapper|paper\s+bag)\b/i.test(prompt) && /\b(bite|bites|biting|eat|eating|chew)\b/i.test(prompt) && !/\b(unwrapped|open\s+paper|held\s+bare|exposed)\b/i.test(prompt)) {
    issues.push({
      code: 'EATING_WRAPPED_FOOD',
      severity: 'high',
      msg: '同时描写油纸包与咬食，未注明食物已裸露取出，模型极易画出隔纸啃包',
      fixHint: '改为“油纸平摊在桌上，手拿已取出的裸露烧饼咬一口”',
    });
  }

  // 5. 年代剧违和词或缺失光源约束
  if (isPeriodStyle(bible?.visualStyle || prompt) && PERIOD_ANACHRONISM_RE.test(prompt)) {
    issues.push({
      code: 'PERIOD_ANACHRONISM',
      severity: 'high',
      msg: '年代剧 Prompt 中出现了现代元素词汇（LED/塑料/霓虹/现代靴等）',
      fixHint: '替换为符合时代背景的布鞋/旧皮鞋与煤油灯/烛光',
    });
  }

  // 6. 固定外貌卡残留手持道具
  const chars = Array.isArray(bible?.characters) ? bible.characters : [];
  for (const name of (shot?.characters || [])) {
    const c = chars.find((x) => x.name === name);
    if (c?.lookPrompt && sanitizeLookPrompt(c.lookPrompt) !== c.lookPrompt.trim()) {
      issues.push({
        code: 'HELD_PROP_IN_LOOK',
        severity: 'medium',
        msg: `角色「${name}」的固定外貌卡含手持道具描述，半身镜易多长穿帮手臂（渲染前已自动清洗）`,
        fixHint: '建议在「① 资产定妆」里删掉 carries/holding 道具句',
      });
    }
  }

  // 7. 关键帧未生成警告（纯 ref2va 复杂多人/交互镜头风险提示）
  if (!shot?.keyframeRef && ((shot?.characters?.length || 0) >= 2 || /反拍|过肩|推门|踹|啃|吃|窗口/.test(action))) {
    issues.push({
      code: 'RECOMMEND_KEYFRAME_FIRST',
      severity: 'low',
      msg: '多人交互或复杂空间镜头建议先生成/上传静态关键帧，审核构图无误后再转动态视频（Keyframe-First）',
      fixHint: '点击「🎨 AI关键帧」或上传关键帧后，系统自动走 I2V 保持画面稳定',
    });
  }

  // 8. 上下镜人数变化提示
  if (prevShot && prevShot.scene && prevShot.scene === shot?.scene) {
    const prevSet = new Set(prevShot.characters || []);
    const added = (shot?.characters || []).filter((n) => !prevSet.has(n));
    if (added.length > 0 && !shot?.keyframeRef) {
      issues.push({
        code: 'NEW_CAST_ENTERED',
        severity: 'low',
        msg: `同场戏新入场角色（${added.join('、')}），系统已自动断开上一镜尾帧接力以防吞人`,
        fixHint: '无需手动处理，或为本镜提供含全部角色的静态关键帧效果更佳',
      });
    }
  }

  const highCount = issues.filter((i) => i.severity === 'high').length;
  const medCount = issues.filter((i) => i.severity === 'medium').length;
  const score = Math.max(0, 100 - highCount * 25 - medCount * 10 - (issues.length - highCount - medCount) * 3);
  return { ok: highCount === 0, score, issues };
}

/** 从配置中挑一个可用的视觉多模态模型（DashScope qwen-vl / 智谱 glm-4v / 本地 Ollama VL）。 */
export function pickVisionProvider(cfg = {}) {
  const api = cfg?.api || {};
  if (api.dashscope?.apiKey) {
    return { provider: 'dashscope', model: api.dashscope.visionModel || 'qwen-vl-max' };
  }
  if (api.zhipu?.apiKey) {
    return { provider: 'zhipu', model: api.zhipu.visionModel || 'glm-4v-flash' };
  }
  if (api.bailian?.apiKey) {
    return { provider: 'bailian', model: api.bailian.visionModel || 'qwen-vl-max' };
  }
  if (api.local?.visionModel) {
    return { provider: 'local', model: api.local.visionModel };
  }
  return null;
}

/**
 * 调用多模态 VLM 对关键帧或渲染抽帧做真实视觉审片：
 * 检查人物数量/漏人、室内外颠倒、多手畸形、时代穿帮、反物理动作、灯光过度失真。
 */
export async function inspectImageRealism({ imagePath, shot, bible = {}, cfg = {}, onLog } = {}) {
  const promptAudit = auditShotPromptRealism(shot, bible);
  if (!imagePath || !fs.existsSync(imagePath)) {
    return {
      ...promptAudit,
      visionChecked: false,
      note: '尚无关键帧或渲染图，已完成分镜 Prompt 常识防呆检查',
    };
  }
  const vp = pickVisionProvider(cfg);
  if (!vp) {
    return {
      ...promptAudit,
      visionChecked: false,
      note: '未配置多模态视觉 API（DashScope/智谱/本地 VL），仅返回静态规则审计',
    };
  }

  const pc = resolveProviderCfg(vp.provider, cfg);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const expectedChars = (shot?.characters || []).join('、') || '（无指定）';

  const sys = '你是影视级短剧视效质检总监，极其严格地审查 AI 生成画面是否符合现实物理常识与时代逻辑。只输出 JSON。';
  const textPrompt = `请严格审查这张短剧画面（关键帧或视频抽帧）是否符合现实常识与剧本设定：
- 预期画风/时代：${bible?.visualStyle || '写实剧集'}
- 预期地点：${shot?.location || '未注明'}（${shot?.settingType || '未注明室内外'}）
- 预期出镜人物（必须全部合理出现，不能漏人）：${expectedChars}
- 预期动作：${shot?.action || ''}

请重点抓出以下 6 类硬伤（有一条就算不通过 passed:false）：
1. 时代/道具穿帮（如民国/古装出现现代白色电吊灯、塑料、景区霓虹灯笼、墙上莫名挂骨头、现代亮面马术靴）；
2. 空间逻辑错误（室内外颠倒、门窗融成齐腰半截框、人物踩窗台等反常识站位）；
3. 动作反常识（隔着没拆的包装纸啃食物、穿模、悬空）；
4. 肢体畸形/多手/无头残肢（画面边缘凭空冒出第三只手或断臂）；
5. 漏人/多陌生人（预期多人同框却少了某核心角色）；
6. 灯光违和（要求寒夜孤灯却亮如白昼或满街干冰浓雾）。

输出 JSON：
\`\`\`json
{"passed":true,"score":88,"issues":["具体问题1"],"suggestedPromptFix":"若不通过，给出一段精简的英文修正建议"}
\`\`\``;

  onLog?.({ level: 'act', msg: `正在用 ${vp.model} 审视第 ${shot?.index || ''} 镜画面现实常识…` });
  const url = `${pc.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (pc.apiKey) headers.Authorization = `Bearer ${pc.apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: vp.model,
      temperature: 0.2,
      max_tokens: 1000,
      messages: [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            { type: 'text', text: textPrompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`视觉质检请求失败（HTTP ${resp.status}）：${data?.error?.message || data?.message || 'unknown'}`);
  }
  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content);
  if (!parsed) throw new Error('视觉质检未返回有效 JSON');

  const vIssues = Array.isArray(parsed.issues)
    ? parsed.issues.map((msg) => ({ code: 'VISION_QA', severity: 'high', msg: String(msg), fixHint: String(parsed.suggestedPromptFix || '') }))
    : [];
  const mergedIssues = [...promptAudit.issues, ...vIssues];
  const vScore = Number.isFinite(Number(parsed.score)) ? Number(parsed.score) : promptAudit.score;
  const passed = parsed.passed !== false && promptAudit.ok;
  return {
    ok: passed,
    visionChecked: true,
    provider: vp.provider,
    model: vp.model,
    score: Math.min(promptAudit.score, vScore),
    issues: mergedIssues,
    suggestedPromptFix: String(parsed.suggestedPromptFix || '').trim(),
    checkedAt: new Date().toISOString(),
  };
}
