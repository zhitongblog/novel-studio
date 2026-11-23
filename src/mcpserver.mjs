// Novel Studio 的 MCP stdio server：把"管理书 + 启动写作"暴露为 MCP tools，
// 供 Claude Code / 其它 MCP 客户端直接调用。零依赖，行分隔 JSON-RPC over stdio。
import { loadConfig } from './config.mjs';
import { listBooksWithStats, createBook, getBook } from './books.mjs';
import { detectAll, MODELS } from './models.mjs';

// 模型 id 白名单从 MODELS 动态派生，新增模型（如 trae）自动纳入，不再漏改 schema。
const MODEL_IDS = Object.keys(MODELS);
import { listInstances } from './unterm.mjs';
import { startWriting } from './writer.mjs';
import { listSessions, sendToBook, stopBook, streamBook } from './attach.mjs';
import { loadUsage, bookUsage } from './usage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { loadPlan, savePlan, loadBible, saveBible, planEpisodes, generateStoryboard, extractCharacterBible, composeLockedPrompt, composeNativeDialoguePrompt, generatePublishCopy, resolveSpeakerVoice, videoDir } from './videoplan.mjs';
import { renderShot, synthesizeTts, composeEpisode, aspectDimensions, prepareShotRenderInputs, computeClipTrimDuration, probeMedia, resolveKeyframePath, listVoiceSamples } from './videorender.mjs';
import { auditShotPromptRealism, inspectImageRealism } from './videoqa.mjs';
import { buildEpisodeSubtitles, exportJianyingDraft } from './videopost.mjs';

const TOOLS = [
  { name: 'novel_list_books', description: '列出所有已登记的书及章节统计', inputSchema: { type: 'object', properties: {} } },
  { name: 'novel_create_book', description: '新建一本书（注册 + 生成项目骨架 + 绑定 unterm profile）', inputSchema: {
    type: 'object', required: ['title'],
    properties: {
      title: { type: 'string', description: '书名' },
      genre: { type: 'string', description: '类型/卖点' },
      model: { type: 'string', enum: MODEL_IDS },
      totalWords: { type: 'string' }, volumes: { type: 'string' },
      chaptersPerVolume: { type: 'string' }, batchSize: { type: 'number' },
    } } },
  { name: 'novel_start_writing', description: '为指定书开一个绑定 profile 的 Unterm 实例、开代理、启动选定模型并注入写作指令，随后 autopilot 自动监控应答。', inputSchema: {
    type: 'object', required: ['book'],
    properties: {
      book: { type: 'string', description: '书名或 slug' },
      model: { type: 'string', enum: MODEL_IDS },
      task: { type: 'string', description: '写作指令，如"续写5章并自检"' },
    } } },
  { name: 'novel_models', description: '检测各写作 CLI（codex/claude/gemini/trae…）的可用性', inputSchema: { type: 'object', properties: {} } },
  { name: 'novel_instances', description: '列出运行中的 Unterm 实例', inputSchema: { type: 'object', properties: {} } },
  { name: 'novel_list_sessions', description: '列出运行中的写作会话', inputSchema: { type: 'object', properties: {} } },
  { name: 'novel_send_instruction', description: '中途穿插一条指令到正在写作的窗口（注入按键）', inputSchema: {
    type: 'object', required: ['book', 'task'],
    properties: { book: { type: 'string', description: '书名或 slug' }, task: { type: 'string', description: '要穿插的指令' } } } },
  { name: 'novel_peek_screen', description: '读取某本书写作窗口当前屏幕内容（一帧镜像）', inputSchema: {
    type: 'object', required: ['book'], properties: { book: { type: 'string' } } } },
  { name: 'novel_stop_writing', description: '停止并关闭某本书的写作窗口', inputSchema: {
    type: 'object', required: ['book'], properties: { book: { type: 'string' } } } },
  { name: 'novel_usage', description: 'Token 用量统计（可选指定 book，否则返回全部）', inputSchema: {
    type: 'object', properties: { book: { type: 'string' } } } },
  { name: 'novel_video_bible', description: '读取或提取/保存某本书的角色定妆库（支持绑定本地定妆照与音色）', inputSchema: {
    type: 'object', required: ['book'],
    properties: {
      book: { type: 'string' },
      action: { type: 'string', enum: ['get', 'extract', 'save'] },
      visualStyle: { type: 'string' },
      characters: { type: 'array' },
    } } },
  { name: 'novel_video_plan', description: '读取或 AI 生成某本书的短剧分集/卷预告规划', inputSchema: {
    type: 'object', required: ['book'],
    properties: {
      book: { type: 'string' },
      action: { type: 'string', enum: ['get', 'generate'] },
      kind: { type: 'string', enum: ['episode', 'trailer'] },
      fromChapter: { type: 'number' },
      toChapter: { type: 'number' },
      targetSeconds: { type: 'number' },
    } } },
  { name: 'novel_video_storyboard', description: '为指定集生成分镜脚本（默认纯影视对白模式，可选漫剧旁白模式）', inputSchema: {
    type: 'object', required: ['book', 'episodeIndex'],
    properties: { book: { type: 'string' }, episodeIndex: { type: 'number' }, aspect: { type: 'string', enum: ['9:16', '4:5', '3:4', '16:9'] }, dialogueMode: { type: 'string', enum: ['drama', 'narration'] } } } },
  { name: 'novel_video_render', description: '用本机 ComfyUI (MiniMax H3) 渲染指定集的全部或单个镜头（支持 Keyframe-First I2V 与 native 原生对口型说话）', inputSchema: {
    type: 'object', required: ['book', 'episodeIndex'],
    properties: { book: { type: 'string' }, episodeIndex: { type: 'number' }, shotIndex: { type: 'number' }, force: { type: 'boolean' }, renderMode: { type: 'string', enum: ['auto', 'fl2va', 'ref2va'] }, voiceMode: { type: 'string', enum: ['tts', 'native'] } } } },
  { name: 'novel_video_compose', description: '合成指定集成片 MP4（支持 IndexTTS2 多角色情绪配音或保留 H3 原生对口型人声、ASS 字幕烧录、BGM 自动闪避）', inputSchema: {
    type: 'object', required: ['book', 'episodeIndex'],
    properties: { book: { type: 'string' }, episodeIndex: { type: 'number' }, useTts: { type: 'boolean' }, burnSubtitles: { type: 'boolean' }, trimToTts: { type: 'boolean' }, voiceMode: { type: 'string', enum: ['tts', 'native'] }, bgmPath: { type: 'string' } } } },
  { name: 'novel_video_export_jianying', description: '导出指定集的剪映草稿工程目录', inputSchema: {
    type: 'object', required: ['book', 'episodeIndex'],
    properties: { book: { type: 'string' }, episodeIndex: { type: 'number' } } } },
  { name: 'novel_video_publish_copy', description: '为指定集生成抖音/快手/小红书短剧发布文案（标题、简介、话题标签与封面花字）', inputSchema: {
    type: 'object', required: ['book', 'episodeIndex'],
    properties: { book: { type: 'string' }, episodeIndex: { type: 'number' } } } },
  { name: 'novel_video_qa', description: '对指定集或单镜执行现实常识与时代穿帮质检（Prompt 防呆 + 可选多模态视觉审片）', inputSchema: {
    type: 'object', required: ['book', 'episodeIndex'],
    properties: { book: { type: 'string' }, episodeIndex: { type: 'number' }, shotIndex: { type: 'number' }, useVision: { type: 'boolean' } } } },
];

function slugOf(idOrSlug) { const b = getBook(idOrSlug); return b ? b.slug : idOrSlug; }

async function dispatch(name, args) {
  const cfg = loadConfig();
  if (name === 'novel_list_books') return listBooksWithStats().map(b => ({ title: b.title, slug: b.slug, model: b.model, profile: b.profile, chapters: b.stats.chapters, kb: b.stats.kb, dir: b.dir }));
  if (name === 'novel_models') return detectAll();
  if (name === 'novel_instances') return listInstances().map(i => ({ id: i.id, version: i.version, mcp_port: i.mcp_port, cwd: i.cwd }));
  if (name === 'novel_list_sessions') return listSessions().map(s => ({ title: s.title, slug: s.slug, model: s.model, instance: s.instanceId, pane: s.pane, pid: s.pid, startedAt: s.startedAt }));
  if (name === 'novel_send_instruction') { const r = await sendToBook(slugOf(args.book), args.task, cfg); return { ok: true, ...r }; }
  if (name === 'novel_stop_writing') return stopBook(slugOf(args.book));
  if (name === 'novel_usage') {
    if (args.book) { const slug = slugOf(args.book); return { book: slug, total: bookUsage(slug) }; }
    return loadUsage();
  }
  if (name === 'novel_peek_screen') {
    let frame = '';
    const h = await streamBook(slugOf(args.book), cfg, (txt) => { frame = txt; }, { intervalMs: 300 });
    await new Promise(r => setTimeout(r, 700));
    h.stop();
    return { screen: frame };
  }
  if (name === 'novel_create_book') { const b = createBook(args, cfg); return { ok: true, title: b.title, dir: b.dir, profile: b.profile }; }
  if (name === 'novel_start_writing') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    const model = args.model || book.model || cfg.defaultModel;
    const instruction = args.task || `请阅读 AGENTS.md 写作规范与 novel_bible.md，续写下一批 ${book.standards?.batchSize || 5} 章并自检。`;
    const logs = [];
    const sess = await startWriting({ book, model, instruction, cfg, onLog: (e) => logs.push(e.msg) });
    return { ok: true, instance: sess.instance.id, mcp_port: sess.instance.mcp_port, pane: sess.paneId, autopilot: !!cfg.autopilot.enabled, logs };
  }
  if (name === 'novel_video_bible') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    if (args.action === 'extract') return await extractCharacterBible(book, cfg);
    if (args.action === 'save') { saveBible(book, { visualStyle: args.visualStyle, characters: args.characters }); return loadBible(book); }
    return loadBible(book);
  }
  if (name === 'novel_video_plan') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    if (args.action === 'generate') {
      const out = await planEpisodes(book, cfg, { kind: args.kind || 'episode', fromChapter: args.fromChapter, toChapter: args.toChapter, targetSeconds: args.targetSeconds });
      const cur = loadPlan(book);
      const keep = (cur.episodes || []).filter(e => e.kind !== (args.kind || 'episode'));
      const next = [...keep, ...out.episodes].map((e, i) => ({ ...e, index: i + 1 }));
      savePlan(book, { ...cur, version: 1, episodes: next });
      return { episodes: next, warnings: out.warnings };
    }
    return loadPlan(book);
  }
  if (name === 'novel_video_storyboard') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find(e => e.index === Number(args.episodeIndex));
    if (!ep) throw new Error('找不到第 ' + args.episodeIndex + ' 集');
    const aspect = args.aspect || cfg.video?.aspect || '9:16';
    const dialogueMode = args.dialogueMode === 'narration' ? 'narration' : 'drama';
    const sb = await generateStoryboard(book, cfg, ep, { aspect, dialogueMode });
    ep.shots = sb.shots; ep.totalSeconds = sb.totalSeconds; ep.sourceRevisions = sb.sourceRevisions; ep.aspect = aspect; ep.dialogueMode = dialogueMode;
    savePlan(book, cur);
    return { episodeIndex: ep.index, shots: sb.shots.length, totalSeconds: sb.totalSeconds, dialogueMode };
  }
  if (name === 'novel_video_render') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find(e => e.index === Number(args.episodeIndex));
    if (!ep?.shots?.length) throw new Error('这一集还没有分镜');
    const bible = loadBible(book);
    const voiceMode = args.voiceMode === 'native' || args.voiceMode === 'tts' ? args.voiceMode : (ep.voiceMode === 'native' ? 'native' : 'tts');
    ep.voiceMode = voiceMode;
    const targets = args.shotIndex ? ep.shots.filter(s => s.index === Number(args.shotIndex)) : ep.shots;
    const vroot = videoDir(book);
    for (const s of targets) {
      const { keyframePath, refImagePaths, charRefTags } = prepareShotRenderInputs({
        book, episode: ep, shot: s, bible, cfg, defaultRef: 'cover_bg', renderMode: args.renderMode || 'auto',
      });
      let lockedPrompt = composeLockedPrompt(s, bible, charRefTags);
      if (voiceMode === 'native') lockedPrompt = composeNativeDialoguePrompt(s, bible, lockedPrompt, cfg);
      const r = await renderShot(book, cfg, { episodeIndex: ep.index, shot: s, keyframePath, refImagePaths, lockedPrompt, aspect: ep.aspect || '9:16', voiceMode, force: !!args.force });
      s.render = {
        mode: r.mode,
        voiceMode,
        inputHash: r.inputHash,
        fileRel: path.relative(vroot, r.file).replace(/\\/g, '/'),
        qaFrameRels: (r.qaFrames || []).map((f) => path.relative(vroot, f).replace(/\\/g, '/')),
        duration: r.duration,
        renderSec: r.renderSec || 0,
      };
      savePlan(book, cur);
    }
    return { ok: true, rendered: targets.length, voiceMode };
  }
  if (name === 'novel_video_compose') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find(e => e.index === Number(args.episodeIndex));
    if (!ep?.shots?.length) throw new Error('这一集还没有分镜');
    const bible = loadBible(book);
    const voiceMode = args.voiceMode === 'native' || args.voiceMode === 'tts' ? args.voiceMode : (ep.voiceMode === 'native' ? 'native' : 'tts');
    ep.voiceMode = voiceMode;
    const voiceSamples = listVoiceSamples(book, cfg);
    const vroot = videoDir(book);
    const epDir = path.join(vroot, `ep-${String(ep.index).padStart(2, '0')}`);
    const trimToTts = args.trimToTts !== false;
    const shotClips = [], narrationFiles = [];
    let offsetSec = 0;
    for (const s of ep.shots) {
      if (!s.render?.fileRel) throw new Error(`第 ${s.index} 镜未渲染`);
      const f = path.join(vroot, s.render.fileRel);
      const origDur = Number(s.render.duration) || Number(s.seconds) || 5;
      let ttsDur = 0;
      const sp = resolveSpeakerVoice(s, bible, cfg, voiceSamples);
      const needTts = !!(args.useTts !== false && s.narration?.trim() && !(voiceMode === 'native' && sp.isCharacter));
      if (needTts) {
        const wav = path.join(epDir, 'tts', `shot-${String(s.index).padStart(2, '0')}.wav`);
        const t = await synthesizeTts(cfg, { text: s.narration.trim(), outWav: wav, refAudio: sp.refAudio, voice: sp.edgeVoice, emotion: sp.emotion });
        ttsDur = Number(t.duration) || 0;
        s.render.ttsRel = path.relative(vroot, t.file).replace(/\\/g, '/');
        s.render.ttsDuration = ttsDur;
        narrationFiles.push({ file: t.file, offsetSec });
      }
      const clipDur = computeClipTrimDuration({ videoDuration: origDur, ttsDuration: ttsDur, hasNarration: needTts, trimToTts: trimToTts && needTts });
      s.render.trimmedDuration = clipDur;
      shotClips.push({ file: f, trimSec: clipDur < origDur - 0.2 ? clipDur : 0 });
      offsetSec += clipDur;
    }
    let assSubtitleFile = '';
    if (args.burnSubtitles !== false) {
      const firstMeta = probeMedia(shotClips[0].file);
      const dims = (firstMeta.width && firstMeta.height) ? { width: firstMeta.width, height: firstMeta.height } : aspectDimensions(ep.aspect || '9:16');
      const subs = buildEpisodeSubtitles(ep.shots.map(s => ({
        ...s,
        actualSeconds: s.render?.trimmedDuration || s.render?.duration || s.seconds,
        ttsDurationSec: s.render?.ttsDuration || 0,
      })), dims);
      if (subs.count > 0) {
        assSubtitleFile = path.join(epDir, `episode-${String(ep.index).padStart(2, '0')}.ass`);
        fs.writeFileSync(assSubtitleFile, subs.ass, 'utf8');
        fs.writeFileSync(path.join(epDir, `episode-${String(ep.index).padStart(2, '0')}.srt`), subs.srt, 'utf8');
      }
    }
    const out = composeEpisode(book, { episodeIndex: ep.index, shotClips, narrationFiles, assSubtitleFile, bgmFile: args.bgmPath || '', voiceMode });
    ep.outputRel = path.relative(vroot, out.file).replace(/\\/g, '/'); ep.outputDuration = out.duration;
    savePlan(book, cur);
    return { ok: true, file: out.file, duration: out.duration, voiceMode };
  }
  if (name === 'novel_video_export_jianying') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find(e => e.index === Number(args.episodeIndex));
    if (!ep?.shots?.length) throw new Error('这一集还没有分镜');
    const vroot = videoDir(book);
    const dims = aspectDimensions(ep.aspect || '9:16');
    const clips = ep.shots.map(s => {
      if (!s.render?.fileRel) throw new Error(`第 ${s.index} 镜未渲染`);
      return { videoPath: path.join(vroot, s.render.fileRel), audioPath: s.render.ttsRel ? path.join(vroot, s.render.ttsRel) : '', durationSec: Number(s.render.duration) || Number(s.seconds) || 5, narration: s.narration || '' };
    });
    return exportJianyingDraft({ outDir: path.join(vroot, `ep-${String(ep.index).padStart(2, '0')}`, 'jianying_draft'), title: `${book.title} - 第${ep.index}集`, width: dims.width, height: dims.height, clips });
  }
  if (name === 'novel_video_publish_copy') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find(e => e.index === Number(args.episodeIndex));
    if (!ep) throw new Error('找不到第 ' + args.episodeIndex + ' 集');
    const copy = await generatePublishCopy(book, cfg, ep);
    ep.publishCopy = copy;
    savePlan(book, cur);
    return { ok: true, episodeIndex: ep.index, publishCopy: copy };
  }
  if (name === 'novel_video_qa') {
    const book = getBook(args.book);
    if (!book) throw new Error('找不到书：' + args.book);
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find(e => e.index === Number(args.episodeIndex));
    if (!ep?.shots?.length) throw new Error('这一集还没有分镜');
    const bible = loadBible(book);
    const targets = args.shotIndex ? ep.shots.filter(s => s.index === Number(args.shotIndex)) : ep.shots;
    const results = [];
    for (const s of targets) {
      const prevShot = ep.shots.find(x => x.index === s.index - 1) || null;
      const imgPath = (s.keyframeRef && resolveKeyframePath(book, s.keyframeRef))
        || (s.render?.qaFrameRels?.[1] && resolveKeyframePath(book, s.render.qaFrameRels[1]))
        || null;
      const qa = (args.useVision !== false && imgPath)
        ? await inspectImageRealism({ imagePath: imgPath, shot: s, bible, cfg }).catch(e => ({ ...auditShotPromptRealism(s, bible, prevShot), visionChecked: false, note: e.message }))
        : { ...auditShotPromptRealism(s, bible, prevShot), visionChecked: false };
      s.qa = { ...qa, checkedAt: new Date().toISOString() };
      results.push({ shotIndex: s.index, ok: qa.ok, score: qa.score, issueCount: qa.issues.length, issues: qa.issues });
    }
    savePlan(book, cur);
    return { ok: true, episodeIndex: ep.index, results };
  }
  throw new Error('未知 tool：' + name);
}

export function runMcpServer() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) handle(line);
    }
  });
  // 保持存活；客户端断开 stdin 时退出
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));

  async function handle(line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    const reply = (result, error) => {
      if (id == null) return; // 通知无需回复
      process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
    };
    try {
      if (method === 'initialize') {
        return reply({ protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'storyalter', version: '2.0.0' } });
      }
      if (method === 'tools/list') return reply({ tools: TOOLS });
      if (method === 'tools/call') {
        const out = await dispatch(params.name, params.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      }
      if (method === 'ping') return reply({});
      if (method && method.startsWith('notifications/')) return; // 忽略
      return reply(null, { code: -32601, message: 'Unknown method: ' + method });
    } catch (e) {
      return reply(null, { code: -32603, message: e.message });
    }
  }
}
