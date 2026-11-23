// 改编视频 HTTP 路由处理器（由 src/server.mjs 转发 /api/book/video/*）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  loadPlan, savePlan, loadBible, saveBible, composeLockedPrompt, composeNativeDialoguePrompt,
  extractCharacterBible, currentRevisions, staleChapters, planEpisodes, generateStoryboard,
  generatePublishCopy, resolveSpeakerVoice, EDGE_VOICES, VOICE_PRESETS, videoDir,
} from './videoplan.mjs';
import {
  renderShot, synthesizeTts, composeEpisode, probeVideoEngine, hasRef2VModels,
  aspectDimensions, prepareShotRenderInputs, computeClipTrimDuration, probeMedia,
  resolveKeyframePath, listVoiceSamples,
} from './videorender.mjs';
import { auditShotPromptRealism, inspectImageRealism } from './videoqa.mjs';
import { buildEpisodeSubtitles, exportJianyingDraft } from './videopost.mjs';
import { generateCoverBg } from './imagegen.mjs';

async function generateZhipuImage(apiKey, prompt, outFile) {
  const r = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'cogview-3-flash', prompt }),
  });
  const j = await r.json();
  const url = j?.data?.[0]?.url;
  if (!url) throw new Error(j?.error?.message || '智谱生图未返回图片');
  const img = await fetch(url);
  const buf = Buffer.from(await img.arrayBuffer());
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buf);
  return { file: outFile, bytes: buf.length };
}

async function generateImageWithFallback(book, { prompt, outFile, aspectRatio, cfg, onLog }) {
  try {
    return await generateCoverBg(book, { prompt, outFile, aspectRatio, onLog });
  } catch (localErr) {
    const zhipuKey = cfg?.api?.zhipu?.apiKey;
    if (zhipuKey) {
      onLog?.({ level: 'act', msg: '本地生图不可用，改用智谱 CogView 在线生图…' });
      return await generateZhipuImage(zhipuKey, prompt, outFile);
    }
    throw new Error(
      `生图失败（${localErr.message}）。\n` +
      '解决方式任选其一：\n' +
      '1) 在「设置」配置智谱/Gemini API Key 用于在线生图；\n' +
      '2) 在本机 ComfyUI 安装 SDXL 或 ComfyUI-GGUF + Qwen-Image 模型；\n' +
      '3) 点击「📤 上传」使用外部图片，或让 AI 助手通过 storyalter mcp 帮你生成并绑定。'
    );
  }
}

function toVideoRel(book, absPath) {
  return path.relative(videoDir(book), absPath).replace(/\\/g, '/');
}

function listKeyframes(book) {
  const out = [];
  const bg = path.join(book.dir, 'cover_bg.png');
  if (fs.existsSync(bg)) {
    out.push({ ref: 'cover_bg', label: '封面底图 (cover_bg.png)', url: `/api/book/cover-bg?book=${encodeURIComponent(book.slug)}` });
  }
  try {
    for (const f of fs.readdirSync(path.join(book.dir, 'experiment')).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).slice(0, 12)) {
      out.push({ ref: `exp:${f}`, label: `书名实验 · ${f}`, url: `/api/book/exp-image?book=${encodeURIComponent(book.slug)}&file=${encodeURIComponent(f)}` });
    }
  } catch {}
  try {
    for (const f of fs.readdirSync(path.join(videoDir(book), 'keyframes')).filter((n) => /\.(png|jpe?g|webp)$/i.test(n))) {
      const rel = `keyframes/${f}`;
      out.push({ ref: rel, label: `参考图 · ${f}`, url: `/api/book/video/file?book=${encodeURIComponent(book.slug)}&rel=${encodeURIComponent(rel)}` });
    }
  } catch {}
  return out;
}

function startVideoJob(videoJobs, slug, kind, msg, pushLog, fn) {
  const cur = videoJobs.get(slug);
  if (cur && cur.status === 'running') return { ok: true, started: true, already: true };
  videoJobs.set(slug, { status: 'running', kind, msg });
  const onLog = (e) => {
    const j = videoJobs.get(slug);
    if (j && j.status === 'running') j.msg = e.msg;
    pushLog(slug, { level: e.level || 'info', source: 'video', msg: e.msg });
  };
  Promise.resolve()
    .then(() => fn(onLog))
    .then((data) => {
      videoJobs.set(slug, { status: 'done', kind, msg: '完成', data });
    })
    .catch((e) => {
      const em = e?.message || String(e);
      videoJobs.set(slug, { status: 'error', kind, msg: em, error: em });
      pushLog(slug, { level: 'error', source: 'video', msg: em });
    });
  return { ok: true, started: true };
}

export async function handleVideoRoute({ p, body, cfg, res, json, getBook, pushLog, videoJobs }) {
  if (!p.startsWith('/api/book/video/')) return false;
  const book = getBook(body?.book);
  if (!book) { json(res, 400, { error: '找不到书' }); return true; }
  const slug = book.slug;

  if (p === '/api/book/video/job-status') {
    json(res, 200, { ok: true, ...(videoJobs.get(slug) || { status: 'idle' }) });
    return true;
  }

  if (p === '/api/book/video/plan') {
    const plan = loadPlan(book);
    const bible = loadBible(book);
    const revs = await currentRevisions(book);
    const episodes = (plan.episodes || []).map((ep) => ({
      ...ep,
      staleChapters: staleChapters(ep.sourceRevisions, revs),
    }));
    json(res, 200, {
      ok: true,
      plan: { ...plan, episodes },
      bible,
      ref2vaReady: hasRef2VModels(cfg.video || {}),
      keyframes: listKeyframes(book),
      edgeVoices: EDGE_VOICES,
      voicePresets: VOICE_PRESETS,
      voiceSamples: listVoiceSamples(book, cfg),
    });
    return true;
  }

  if (p === '/api/book/video/bible/extract') {
    const resObj = startVideoJob(videoJobs, slug, 'bible', '正在从设定圣经提取角色定妆卡…', pushLog, async (onLog) => {
      return await extractCharacterBible(book, cfg, { onLog });
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/bible/save') {
    saveBible(book, {
      visualStyle: body.visualStyle,
      narratorVoice: body.narratorVoice,
      narratorEdgeVoice: body.narratorEdgeVoice,
      characters: body.characters,
    });
    json(res, 200, { ok: true, bible: loadBible(book) });
    return true;
  }

  if (p === '/api/book/video/bible/upload-voice') {
    const dataUrl = String(body.dataUrl || '');
    const m = dataUrl.match(/^data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) { json(res, 400, { error: '无效的音频格式（支持 wav/mp3/m4a/ogg）' }); return true; }
    const extMap = { mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', mp4: 'm4a', m4a: 'm4a', ogg: 'ogg' };
    const ext = extMap[m[1].toLowerCase()] || 'wav';
    const rawName = String(body.filename || 'voice').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'voice';
    const name = `${rawName}_${Date.now()}.${ext}`;
    const dir = path.join(videoDir(book), 'voices');
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, Buffer.from(m[2], 'base64'));
    json(res, 200, { ok: true, path: abs, rel: `voices/${name}` });
    return true;
  }

  if (p === '/api/book/video/bible/gen-portrait') {
    const charName = String(body.characterName || '').trim();
    if (!charName) { json(res, 400, { error: '缺少 characterName' }); return true; }
    const resObj = startVideoJob(videoJobs, slug, 'portrait', `正在生成角色「${charName}」定妆照…`, pushLog, async (onLog) => {
      const bible = loadBible(book);
      const ch = (bible.characters || []).find((c) => c.name === charName);
      const style = String(body.visualStyle || bible.visualStyle || '电影感国风短剧写实').trim();
      const lookPrompt = String(body.lookPrompt || body.look || ch?.lookPrompt || '').trim();
      const prompt = [style, `character portrait of ${charName}`, lookPrompt, 'solo, clean background, centered upper body, high detail, no text, no watermark'].filter(Boolean).join(', ');
      const safe = charName.replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 24) || 'char';
      const fileName = `char_${safe}_${Date.now()}.png`;
      const outFile = path.join(videoDir(book), 'keyframes', fileName);
      await generateImageWithFallback(book, { prompt, outFile, aspectRatio: '3:4', cfg, onLog });
      const rel = `keyframes/${fileName}`;
      if (ch) {
        ch.refImageRef = rel;
        if (lookPrompt) ch.lookPrompt = lookPrompt;
      } else {
        bible.characters.push({ name: charName, role: '', lookPrompt, refImageRef: rel, voiceRefAudio: '', edgeVoice: '' });
      }
      saveBible(book, bible);
      return { characterName: charName, ref: rel, url: `/api/book/video/file?book=${encodeURIComponent(slug)}&rel=${encodeURIComponent(rel)}`, bible: loadBible(book) };
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/shot/gen-keyframe') {
    const epIdx = Number(body.episodeIndex);
    const shotIdx = body.shotIndex ? Number(body.shotIndex) : 0;
    const onlyMissing = body.onlyMissing !== false && !shotIdx;
    const resObj = startVideoJob(videoJobs, slug, 'keyframe', `正在生成第 ${epIdx} 集分镜关键帧…`, pushLog, async (onLog) => {
      const cur = loadPlan(book);
      const ep = (cur.episodes || []).find((e) => e.index === epIdx);
      if (!ep?.shots?.length) throw new Error('这一集还没有分镜');
      const bible = loadBible(book);
      const aspect = body.aspect || ep.aspect || cfg.video?.aspect || '9:16';
      const targets = shotIdx
        ? ep.shots.filter((s) => s.index === shotIdx)
        : ep.shots.filter((s) => !onlyMissing || !s.keyframeRef);
      if (!targets.length) return { episodeIndex: epIdx, generated: 0, message: '所有镜头均已有关键帧' };
      let generated = 0;
      for (const s of targets) {
        onLog({ level: 'act', msg: `生成第 ${s.index} 镜关键帧…` });
        const prompt = `${composeLockedPrompt(s, bible)}, cinematic keyframe still, high detail, no text, no subtitles`;
        const fileName = `shot_ep${epIdx}_s${s.index}_${Date.now()}.png`;
        const outFile = path.join(videoDir(book), 'keyframes', fileName);
        await generateImageWithFallback(book, { prompt, outFile, aspectRatio: aspect, cfg, onLog });
        s.keyframeRef = `keyframes/${fileName}`;
        savePlan(book, cur);
        generated++;
      }
      return { episodeIndex: epIdx, generated };
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/upload-keyframe') {
    const dataUrl = String(body.dataUrl || '');
    const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) { json(res, 400, { error: '无效的图片格式（仅支持 png/jpg/webp）' }); return true; }
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const rawName = String(body.filename || 'keyframe').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'keyframe';
    const name = `${rawName}_${Date.now()}.${ext}`;
    const dir = path.join(videoDir(book), 'keyframes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
    const rel = `keyframes/${name}`;
    json(res, 200, { ok: true, ref: rel, url: `/api/book/video/file?book=${encodeURIComponent(slug)}&rel=${encodeURIComponent(rel)}` });
    return true;
  }

  if (p === '/api/book/video/upload-bgm') {
    const dataUrl = String(body.dataUrl || '');
    const m = dataUrl.match(/^data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) { json(res, 400, { error: '无效的音频格式（支持 mp3/wav/m4a/ogg）' }); return true; }
    const extMap = { mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', mp4: 'm4a', m4a: 'm4a', ogg: 'ogg' };
    const ext = extMap[m[1].toLowerCase()] || 'mp3';
    const rawName = String(body.filename || 'bgm').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'bgm';
    const name = `${rawName}_${Date.now()}.${ext}`;
    const dir = path.join(videoDir(book), 'bgm');
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, Buffer.from(m[2], 'base64'));
    json(res, 200, { ok: true, path: abs, rel: `bgm/${name}` });
    return true;
  }

  if (p === '/api/book/video/episodes/plan') {
    const kind = body.kind === 'trailer' ? 'trailer' : 'episode';
    const resObj = startVideoJob(videoJobs, slug, 'plan', `正在规划${kind === 'trailer' ? '卷预告' : '短剧分集'}…`, pushLog, async (onLog) => {
      const out = await planEpisodes(book, cfg, {
        kind, fromChapter: body.fromChapter, toChapter: body.toChapter,
        targetSeconds: body.targetSeconds, maxEpisodes: body.maxEpisodes, onLog,
      });
      const cur = loadPlan(book);
      const keep = (cur.episodes || []).filter((e) => e.kind !== kind);
      const next = [...keep, ...out.episodes].map((e, i) => ({ ...e, index: i + 1 }));
      savePlan(book, { ...cur, version: 1, episodes: next });
      return { episodes: next, skippedChapters: out.skippedChapters, warnings: out.warnings };
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/storyboard') {
    const epIdx = Number(body.episodeIndex);
    const dialogueMode = body.dialogueMode === 'narration' ? 'narration' : 'drama';
    const resObj = startVideoJob(videoJobs, slug, 'storyboard', `正在为第 ${epIdx} 集生成分镜（${dialogueMode === 'drama' ? '纯影视对白' : '漫剧旁白'}）…`, pushLog, async (onLog) => {
      const cur = loadPlan(book);
      const ep = (cur.episodes || []).find((e) => e.index === epIdx);
      if (!ep) throw new Error(`找不到第 ${epIdx} 集`);
      const aspect = body.aspect || cfg.video?.aspect || '9:16';
      const sb = await generateStoryboard(book, cfg, ep, { aspect, dialogueMode, onLog });
      ep.shots = sb.shots;
      ep.totalSeconds = sb.totalSeconds;
      ep.sourceRevisions = sb.sourceRevisions;
      ep.aspect = aspect;
      ep.dialogueMode = dialogueMode;
      savePlan(book, cur);
      return { episodeIndex: epIdx, ...sb };
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/shot/update') {
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find((e) => e.index === Number(body.episodeIndex));
    const shot = ep?.shots?.find((s) => s.index === Number(body.shotIndex));
    if (!shot) { json(res, 404, { error: '找不到对应镜头' }); return true; }
    for (const k of ['prompt', 'ambience', 'narration', 'action', 'keyframeRef', 'speaker', 'emotion', 'scene', 'settingType']) {
      if (typeof body[k] === 'string') shot[k] = body[k];
    }
    if (Array.isArray(body.characters)) {
      shot.characters = body.characters.map((x) => String(x || '').trim()).filter(Boolean);
    }
    if (body.seconds !== undefined) shot.seconds = Math.min(15, Math.max(5, Math.round(Number(body.seconds) || 5)));
    if (body.seed !== undefined && Number.isFinite(Number(body.seed))) shot.seed = Math.round(Number(body.seed));
    ep.totalSeconds = ep.shots.reduce((a, s) => a + (Number(s.seconds) || 5), 0);
    savePlan(book, cur);
    json(res, 200, { ok: true, shot });
    return true;
  }

  if (p === '/api/book/video/shot/add') {
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find((e) => e.index === Number(body.episodeIndex));
    if (!ep) { json(res, 404, { error: '找不到对应集' }); return true; }
    if (!Array.isArray(ep.shots)) ep.shots = [];
    const last = ep.shots[ep.shots.length - 1];
    const insertAfter = body.afterIndex ? Number(body.afterIndex) : ep.shots.length;
    const pos = Math.min(ep.shots.length, Math.max(0, insertAfter));
    const newShot = {
      index: pos + 1,
      scene: String(body.scene || last?.scene || `S${pos + 1}`),
      characters: Array.isArray(body.characters) ? body.characters : (last?.characters ? [...last.characters] : []),
      extraCharacters: [],
      location: String(body.location || last?.location || ''),
      action: String(body.action || '新增过渡镜头'),
      camera: String(body.camera || 'medium shot, slow push-in'),
      narration: String(body.narration || ''),
      speaker: String(body.speaker || 'narrator'),
      prompt: String(body.prompt || ''),
      ambience: String(body.ambience || ''),
      seconds: Math.min(15, Math.max(5, Math.round(Number(body.seconds) || 5))),
      sourceChapter: ep.fromChapter || 1,
    };
    ep.shots.splice(pos, 0, newShot);
    ep.shots.forEach((s, i) => { s.index = i + 1; });
    ep.totalSeconds = ep.shots.reduce((a, s) => a + (Number(s.seconds) || 5), 0);
    savePlan(book, cur);
    json(res, 200, { ok: true, shot: newShot, shots: ep.shots });
    return true;
  }

  if (p === '/api/book/video/shot/delete') {
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find((e) => e.index === Number(body.episodeIndex));
    if (!ep?.shots?.length) { json(res, 404, { error: '找不到对应镜头' }); return true; }
    const targetIdx = Number(body.shotIndex);
    const before = ep.shots.length;
    ep.shots = ep.shots.filter((s) => s.index !== targetIdx);
    if (ep.shots.length === before) { json(res, 404, { error: '找不到对应镜头' }); return true; }
    ep.shots.forEach((s, i) => { s.index = i + 1; });
    ep.totalSeconds = ep.shots.reduce((a, s) => a + (Number(s.seconds) || 5), 0);
    savePlan(book, cur);
    json(res, 200, { ok: true, shots: ep.shots });
    return true;
  }

  if (p === '/api/book/video/shot/qa') {
    const epIdx = Number(body.episodeIndex);
    const shotIdx = body.shotIndex ? Number(body.shotIndex) : 0;
    const useVision = body.useVision !== false;
    const resObj = startVideoJob(videoJobs, slug, 'qa', `正在对第 ${epIdx} 集执行现实常识质检…`, pushLog, async (onLog) => {
      const cur = loadPlan(book);
      const ep = (cur.episodes || []).find((e) => e.index === epIdx);
      if (!ep?.shots?.length) throw new Error('这一集还没有分镜');
      const bible = loadBible(book);
      const targets = shotIdx ? ep.shots.filter((s) => s.index === shotIdx) : ep.shots;
      if (!targets.length) throw new Error(`找不到第 ${shotIdx} 镜`);
      let flagged = 0;
      for (const s of targets) {
        const prevShot = ep.shots.find((x) => x.index === s.index - 1) || null;
        // 优先审静态关键帧（渲染前拦穿帮），其次审已渲染中帧
        const imgPath = (s.keyframeRef && resolveKeyframePath(book, s.keyframeRef))
          || (s.render?.qaFrameRels?.[1] && resolveKeyframePath(book, s.render.qaFrameRels[1]))
          || null;
        let resQa;
        if (useVision && imgPath) {
          try {
            resQa = await inspectImageRealism({ imagePath: imgPath, shot: s, bible, cfg, onLog });
          } catch (e) {
            onLog({ level: 'warn', msg: `第 ${s.index} 镜视觉审片失败（${e.message}），降级为静态规则检查` });
            resQa = { ...auditShotPromptRealism(s, bible, prevShot), visionChecked: false, note: e.message };
          }
        } else {
          resQa = { ...auditShotPromptRealism(s, bible, prevShot), visionChecked: false };
        }
        s.qa = { ...resQa, checkedAt: new Date().toISOString() };
        if (!resQa.ok) flagged++;
        savePlan(book, cur);
      }
      return { episodeIndex: epIdx, checked: targets.length, flagged };
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/shot/render') {
    const epIdx = Number(body.episodeIndex);
    const shotIdx = body.shotIndex ? Number(body.shotIndex) : 0;
    const force = !!body.force;
    const defaultRef = body.defaultKeyframeRef || 'cover_bg';
    const renderMode = ['auto', 'fl2va', 'ref2va'].includes(body.renderMode) ? body.renderMode : 'auto';
    const probe = await probeVideoEngine(cfg);
    if (!probe.ready) {
      json(res, 400, { error: probe.blockers.join('；') });
      return true;
    }
    const resObj = startVideoJob(videoJobs, slug, 'render', `准备渲染第 ${epIdx} 集…`, pushLog, async (onLog) => {
      const cur = loadPlan(book);
      const ep = (cur.episodes || []).find((e) => e.index === epIdx);
      if (!ep?.shots?.length) throw new Error('这一集还没有分镜');
      const targets = shotIdx ? ep.shots.filter((s) => s.index === shotIdx) : ep.shots;
      if (!targets.length) throw new Error(`找不到第 ${shotIdx} 镜`);
      const aspect = ep.aspect || cfg.video?.aspect || '9:16';
      const voiceMode = body.voiceMode === 'native' || body.voiceMode === 'tts'
        ? body.voiceMode
        : (ep.voiceMode === 'native' ? 'native' : 'tts');
      ep.voiceMode = voiceMode;
      const bible = loadBible(book);
      for (const s of targets) {
        const { keyframePath, refImagePaths, charRefTags } = prepareShotRenderInputs({
          book, episode: ep, shot: s, bible, cfg, defaultRef, renderMode,
        });
        let lockedPrompt = composeLockedPrompt(s, bible, charRefTags);
        if (voiceMode === 'native') {
          lockedPrompt = composeNativeDialoguePrompt(s, bible, lockedPrompt, cfg);
        }
        const r = await renderShot(book, cfg, {
          episodeIndex: epIdx, shot: s, keyframePath, refImagePaths, lockedPrompt, aspect, voiceMode, force, onLog,
        });
        s.render = {
          mode: r.mode,
          voiceMode,
          inputHash: r.inputHash,
          fileRel: toVideoRel(book, r.file),
          qaFrameRels: r.qaFrames.map((f) => toVideoRel(book, f)),
          duration: r.duration,
          renderSec: r.renderSec || 0,
        };
        savePlan(book, cur);
      }
      return { episodeIndex: epIdx, rendered: targets.length, voiceMode };
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/episode/compose') {
    const epIdx = Number(body.episodeIndex);
    const useTts = body.useTts !== false;
    const burnSubtitles = body.burnSubtitles !== false;
    const trimToTts = body.trimToTts !== false;
    const bgmFile = String(body.bgmPath || '').trim();
    const bgmVolume = body.bgmVolume !== undefined ? Number(body.bgmVolume) : 0.16;
    const resObj = startVideoJob(videoJobs, slug, 'compose', `正在合成第 ${epIdx} 集成片…`, pushLog, async (onLog) => {
      const cur = loadPlan(book);
      const ep = (cur.episodes || []).find((e) => e.index === epIdx);
      if (!ep?.shots?.length) throw new Error('这一集还没有分镜');
      const voiceMode = body.voiceMode === 'native' || body.voiceMode === 'tts'
        ? body.voiceMode
        : (ep.voiceMode === 'native' ? 'native' : 'tts');
      ep.voiceMode = voiceMode;
      const bible = loadBible(book);
      const voiceSamples = listVoiceSamples(book, cfg);
      const vroot = videoDir(book);
      const epDir = path.join(vroot, `ep-${String(epIdx).padStart(2, '0')}`);
      fs.mkdirSync(epDir, { recursive: true });
      const shotClips = [];
      const narrationFiles = [];
      let offsetSec = 0;
      for (const s of ep.shots) {
        if (!s.render?.fileRel) throw new Error(`第 ${s.index} 镜还没有渲染，先全部渲染后再合成`);
        const f = path.join(vroot, s.render.fileRel);
        const origDur = Number(s.render.duration) || Number(s.seconds) || 5;
        let ttsDur = 0;
        const sp = resolveSpeakerVoice(s, bible, cfg, voiceSamples);
        // native 模式下：角色台词保留 H3 原生对口型人声（跳过 TTS 覆盖），仅旁白才按需走 TTS
        const needTtsForShot = !!(useTts && s.narration?.trim() && !(voiceMode === 'native' && sp.isCharacter));
        if (needTtsForShot) {
          const wav = path.join(epDir, 'tts', `shot-${String(s.index).padStart(2, '0')}.wav`);
          onLog({ level: 'act', msg: `合成第 ${s.index} 镜配音（${sp.label}${sp.emotion ? ` · ${sp.emotion}` : ''}）…` });
          const t = await synthesizeTts(cfg, {
            text: s.narration.trim(),
            outWav: wav,
            refAudio: sp.refAudio,
            voice: sp.edgeVoice,
            emotion: sp.emotion,
          });
          ttsDur = Number(t.duration) || 0;
          s.render.ttsRel = toVideoRel(book, t.file);
          s.render.ttsDuration = ttsDur;
          narrationFiles.push({ file: t.file, offsetSec });
        } else if (voiceMode === 'native' && sp.isCharacter) {
          s.render.ttsRel = '';
          s.render.ttsDuration = 0;
        }
        const clipDur = computeClipTrimDuration({
          videoDuration: origDur,
          ttsDuration: ttsDur,
          hasNarration: needTtsForShot,
          trimToTts: trimToTts && needTtsForShot,
        });
        s.render.trimmedDuration = clipDur;
        shotClips.push({ file: f, trimSec: clipDur < origDur - 0.2 ? clipDur : 0 });
        offsetSec += clipDur;
      }

      let assSubtitleFile = '';
      if (burnSubtitles) {
        const firstMeta = probeMedia(shotClips[0].file);
        const dims = (firstMeta.width && firstMeta.height)
          ? { width: firstMeta.width, height: firstMeta.height }
          : aspectDimensions(ep.aspect || cfg.video?.aspect || '9:16');
        const subs = buildEpisodeSubtitles(
          ep.shots.map((s) => ({
            ...s,
            actualSeconds: s.render?.trimmedDuration || s.render?.duration || s.seconds,
            ttsDurationSec: s.render?.ttsDuration || 0,
          })),
          dims
        );
        if (subs.count > 0) {
          assSubtitleFile = path.join(epDir, `episode-${String(epIdx).padStart(2, '0')}.ass`);
          fs.writeFileSync(assSubtitleFile, subs.ass, 'utf8');
          fs.writeFileSync(path.join(epDir, `episode-${String(epIdx).padStart(2, '0')}.srt`), subs.srt, 'utf8');
        }
      }

      const out = composeEpisode(book, { episodeIndex: epIdx, shotClips, narrationFiles, assSubtitleFile, bgmFile, bgmVolume, voiceMode, onLog });
      ep.outputRel = toVideoRel(book, out.file);
      ep.outputDuration = out.duration;
      savePlan(book, cur);
      return { episodeIndex: epIdx, outputRel: ep.outputRel, duration: out.duration, voiceMode };
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/episode/publish-copy') {
    const epIdx = Number(body.episodeIndex);
    const resObj = startVideoJob(videoJobs, slug, 'publish-copy', `正在为第 ${epIdx} 集生成短剧发布文案…`, pushLog, async (onLog) => {
      const cur = loadPlan(book);
      const ep = (cur.episodes || []).find((e) => e.index === epIdx);
      if (!ep) throw new Error(`找不到第 ${epIdx} 集`);
      const copy = await generatePublishCopy(book, cfg, ep, { onLog });
      ep.publishCopy = copy;
      savePlan(book, cur);
      return { episodeIndex: epIdx, publishCopy: copy };
    });
    json(res, 200, resObj);
    return true;
  }

  if (p === '/api/book/video/open-dir') {
    const epIdx = Number(body.episodeIndex);
    const sub = String(body.sub || '').trim();
    const vroot = videoDir(book);
    let target = vroot;
    if (epIdx > 0) {
      target = path.join(vroot, `ep-${String(epIdx).padStart(2, '0')}`);
      if (sub === 'jianying') target = path.join(target, 'jianying_draft');
    }
    fs.mkdirSync(target, { recursive: true });
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    json(res, 200, { ok: true, dir: target });
    return true;
  }

  if (p === '/api/book/video/episode/export-jianying') {
    const epIdx = Number(body.episodeIndex);
    const cur = loadPlan(book);
    const ep = (cur.episodes || []).find((e) => e.index === epIdx);
    if (!ep?.shots?.length) { json(res, 400, { error: '这一集还没有分镜' }); return true; }
    const vroot = videoDir(book);
    const clips = [];
    for (const s of ep.shots) {
      if (!s.render?.fileRel) { json(res, 400, { error: `第 ${s.index} 镜还没有渲染，请先渲染所有镜头` }); return true; }
      clips.push({
        videoPath: path.join(vroot, s.render.fileRel),
        audioPath: s.render.ttsRel ? path.join(vroot, s.render.ttsRel) : '',
        durationSec: Number(s.render.trimmedDuration) || Number(s.render.duration) || Number(s.seconds) || 5,
        narration: s.narration || '',
      });
    }
    const dims = aspectDimensions(ep.aspect || cfg.video?.aspect || '9:16');
    const outDir = path.join(vroot, `ep-${String(epIdx).padStart(2, '0')}`, 'jianying_draft');
    const r = exportJianyingDraft({
      outDir,
      title: `${book.title} - 第${epIdx}集 ${ep.title || ''}`.trim(),
      width: dims.width,
      height: dims.height,
      clips,
    });
    json(res, 200, { ok: true, ...r });
    return true;
  }

  return false;
}
