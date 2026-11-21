// 改编视频 · 渲染与合成层：ComfyUI (MiniMax H3 i2v) + IndexTTS + ffmpeg/ffprobe。
//
// 纪律：
//   · 只连本机 loopback ComfyUI（127.0.0.1 / localhost / ::1），不暴露外网；
//   · 用输入哈希（关键帧 + prompt + seed + 模型 + 尺寸 + 帧数 + steps）缓存渲染结果，避免重复烧卡；
//   · prompt_id 只表示提交成功：必须拿到 history 输出、落盘并过 ffprobe 检查，才算这镜渲染成功；
//   · 抽首/中/尾 3 帧图供界面人工质检。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { explainComfyError } from './imagelocal.mjs';
import { detectGpu } from './localai.mjs';
import { snapFrames, videoDir } from './videoplan.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertLoopbackUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { throw new Error(`无效的 ComfyUI 地址：${rawUrl}`); }
  if (!LOOPBACK_HOSTS.has(u.hostname)) {
    throw new Error(`本地渲染引擎只允许连接本机 loopback 地址（收到 ${u.hostname}）`);
  }
  return u.toString().replace(/\/+$/, '');
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
}

/** 根据配置与分镜参数算输入指纹；关键帧/参考图、提示词、种子、模型、尺寸任一变了都会重算。 */
export function computeShotInputHash({ mode = 'fl2va', keyframeHash = '', refHashes = [], prompt, seed, width, height, frames, steps, vcfg }) {
  const payload = JSON.stringify({
    mode, keyframeHash, refHashes, prompt, seed: Number(seed) || 1,
    width: Number(width), height: Number(height), frames: Number(frames), steps: Number(steps),
    diffusionModel: mode === 'ref2va' ? vcfg.ref2vaDiffusionModel : vcfg.diffusionModel,
    textEncoder: vcfg.textEncoder,
    videoVae: vcfg.videoVae, audioVae: vcfg.audioVae,
    turboLora: mode === 'ref2va' ? vcfg.ref2vTurboLora : vcfg.turboLora,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function resolveKeyframePath(book, ref) {
  if (!ref || ref === 'cover_bg') {
    const f = path.join(book.dir, 'cover_bg.png');
    return fs.existsSync(f) ? f : null;
  }
  if (ref.startsWith('exp:')) {
    const name = path.basename(ref.slice(4));
    const f = path.join(book.dir, 'experiment', name);
    return fs.existsSync(f) ? f : null;
  }
  const vroot = path.resolve(videoDir(book));
  const f = path.resolve(vroot, ref);
  return f.startsWith(vroot + path.sep) && fs.existsSync(f) ? f : null;
}

/**
 * 统一解析单镜渲染输入（UI 路由与 MCP 共用）：
 * - 同场戏接力：未指定关键帧且与上一镜同 scene 时，自动复用上一镜尾帧；
 * - 多角色锁脸（ref2va 就绪时）：收集出镜角色定妆照 + 同场戏尾帧，生成 <Picture i> 标签。
 */
export function prepareShotRenderInputs({ book, episode, shot, bible, cfg, defaultRef = 'cover_bg', useR2VOverride } = {}) {
  const shots = Array.isArray(episode?.shots) ? episode.shots : [];
  const prevShot = shots.find((x) => x.index === shot.index - 1);
  const sameSceneLastFrame = (!shot.keyframeRef && shot.scene && prevShot?.scene === shot.scene && prevShot?.render?.qaFrameRels?.length)
    ? resolveKeyframePath(book, prevShot.render.qaFrameRels[prevShot.render.qaFrameRels.length - 1])
    : null;
  const keyframePath = sameSceneLastFrame || resolveKeyframePath(book, shot.keyframeRef || defaultRef);
  const useR2V = useR2VOverride !== undefined ? !!useR2VOverride : hasRef2VModels(cfg?.video || {});
  const refImagePaths = [];
  const refTags = [];
  if (useR2V) {
    const chars = Array.isArray(bible?.characters) ? bible.characters : [];
    for (const name of (shot.characters || [])) {
      const c = chars.find((x) => x.name === name);
      const rp = c?.refImageRef ? resolveKeyframePath(book, c.refImageRef) : null;
      if (rp && !refImagePaths.includes(rp) && refImagePaths.length < 9) {
        refImagePaths.push(rp);
        refTags.push({ name, tag: `<Picture ${refImagePaths.length}>` });
      }
    }
    if (sameSceneLastFrame && !refImagePaths.includes(sameSceneLastFrame) && refImagePaths.length < 9) {
      refImagePaths.push(sameSceneLastFrame);
      refTags.push({ name: '_prev_scene_frame', tag: `<Picture ${refImagePaths.length}>` });
    }
  }
  return {
    keyframePath: keyframePath || refImagePaths[0] || null,
    sameSceneLastFrame,
    refImagePaths,
    charRefTags: refTags.filter((r) => r.name !== '_prev_scene_frame'),
  };
}

export function hasRef2VModels(vcfg) {
  const mr = vcfg?.modelRoot || 'D:/AI/models/minimax-h3';
  return !!(vcfg?.ref2vaDiffusionModel && vcfg?.ref2vTurboLora
    && fs.existsSync(path.join(mr, 'diffusion_models', vcfg.ref2vaDiffusionModel))
    && fs.existsSync(path.join(mr, 'loras', vcfg.ref2vTurboLora)));
}

/** 构造 MiniMax H3 Reference-to-Video（ref2va + turbo 4-step）工作流图，用多张角色定妆图锁脸。 */
export function buildH3Ref2VGraph({ refImageNames = [], prompt, seed, width, height, frames, fps = 24, steps = 4, prefix = 'storyalter/shot_r2v', vcfg }) {
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: vcfg.ref2vaDiffusionModel, weight_dtype: 'default' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: vcfg.ref2vTurboLora, strength_model: 1.0 } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: vcfg.textEncoder, type: 'minimax', device: 'default' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: vcfg.videoVae } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: vcfg.audioVae } },
  };
  const r2vInputs = {
    clip: ['3', 0],
    vae: ['4', 0],
    audio_vae: ['5', 0],
    prompt,
    width,
    height,
    length: frames,
    ref_image_size: 'match',
  };
  refImageNames.slice(0, 9).forEach((name, i) => {
    const id = String(20 + i);
    graph[id] = { class_type: 'LoadImage', inputs: { image: name } };
    r2vInputs[`ref_images.ref_image_${i + 1}`] = [id, 0];
  });
  graph['7'] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: r2vInputs };
  graph['8'] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } };
  graph['9'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } };
  graph['10'] = { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: 'simple', steps, denoise: 1.0 } };
  graph['11'] = { class_type: 'BasicGuider', inputs: { model: ['2', 0], conditioning: ['7', 0] } };
  graph['12'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['8', 0], guider: ['11', 0], sampler: ['9', 0], sigmas: ['10', 0], latent_image: ['7', 1] },
  };
  graph['13'] = { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['4', 0] } };
  graph['14'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['12', 0], vae: ['5', 0] } };
  graph['15'] = { class_type: 'CreateVideo', inputs: { images: ['13', 0], audio: ['14', 0], fps, bit_depth: 8 } };
  graph['16'] = { class_type: 'SaveVideo', inputs: { video: ['15', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } };
  return graph;
}

/** 构造与官方 video_minimax_h3_i2v（turbo 4-step）一致的 ComfyUI API 工作流图。 */
export function buildH3I2VGraph({ imageName, prompt, seed, width, height, frames, fps = 24, steps = 4, prefix = 'storyalter/shot', vcfg }) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: vcfg.diffusionModel, weight_dtype: 'default' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: vcfg.turboLora, strength_model: 1.0 } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: vcfg.textEncoder, type: 'minimax', device: 'default' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: vcfg.videoVae } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: vcfg.audioVae } },
    '6': { class_type: 'LoadImage', inputs: { image: imageName } },
    '7': {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: { clip: ['3', 0], vae: ['4', 0], first_frame: ['6', 0], prompt, width, height, length: frames },
    },
    '8': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '9': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '10': { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: 'simple', steps, denoise: 1.0 } },
    '11': { class_type: 'BasicGuider', inputs: { model: ['2', 0], conditioning: ['7', 0] } },
    '12': {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['8', 0], guider: ['11', 0], sampler: ['9', 0], sigmas: ['10', 0], latent_image: ['7', 1] },
    },
    '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['4', 0] } },
    '14': { class_type: 'VAEDecodeAudio', inputs: { samples: ['12', 0], vae: ['5', 0] } },
    '15': { class_type: 'CreateVideo', inputs: { images: ['13', 0], audio: ['14', 0], fps, bit_depth: 8 } },
    '16': { class_type: 'SaveVideo', inputs: { video: ['15', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } },
  };
}

export function aspectDimensions(aspect, base = { width: 480, height: 608 }) {
  if (aspect === '16:9') return { width: 640, height: 352 };
  if (aspect === '3:4') return { width: 480, height: 640 };
  return { width: Number(base.width) || 480, height: Number(base.height) || 608 };
}

function runCmd(bin, args, timeoutMs = 120000) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (r.error) throw new Error(`${bin} 执行失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${bin} 退出码 ${r.status}：${(r.stderr || r.stdout || '').slice(-400)}`);
  return r.stdout;
}

export function probeMedia(filePath) {
  const out = runCmd('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], 30000);
  const info = JSON.parse(out);
  const duration = Number(info?.format?.duration) || 0;
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!video || !(duration > 0)) throw new Error('ffprobe 未检测到有效视频流');
  return { duration, width: video.width, height: video.height, hasAudio: !!audio };
}

export function extractQaFrames(videoPath, outDir, stem) {
  fs.mkdirSync(outDir, { recursive: true });
  const { duration } = probeMedia(videoPath);
  const points = [
    ['first', 0],
    ['mid', Math.max(0, duration / 2)],
    ['last', Math.max(0, duration - 0.05)],
  ];
  const files = [];
  for (const [tag, ts] of points) {
    const out = path.join(outDir, `${stem}_${tag}.png`);
    runCmd('ffmpeg', ['-y', '-v', 'error', '-ss', ts.toFixed(3), '-i', videoPath, '-frames:v', '1', out], 30000);
    files.push(out);
  }
  return files;
}

async function uploadImageToComfy(base, imagePath) {
  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: mime }), path.basename(imagePath));
  fd.append('overwrite', 'true');
  const r = await fetch(`${base}/upload/image`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`上传关键帧到 ComfyUI 失败：HTTP ${r.status}`);
  const j = await r.json();
  return j.name;
}

async function submitAndWaitComfy(base, graph, timeoutMs, onLog) {
  const clientId = 'storyalter-video-' + Date.now();
  const r = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal: AbortSignal.timeout(30000),
  });
  const q = await r.json().catch(() => ({}));
  if (!r.ok || !q?.prompt_id) {
    const ne = q?.node_errors ? JSON.stringify(q.node_errors).slice(0, 300) : '';
    throw new Error(`ComfyUI 拒绝工作流：${q?.error?.message || r.status}${ne ? ' | ' + ne : ''}`);
  }
  const pid = q.prompt_id;
  onLog?.({ level: 'info', msg: `ComfyUI 任务已入队：${pid.slice(0, 8)}…` });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2500));
    let hist = null;
    try {
      const hr = await fetch(`${base}/history/${pid}`, { signal: AbortSignal.timeout(10000) });
      if (hr.ok) hist = (await hr.json())?.[pid];
    } catch { continue; }
    if (!hist) continue;
    const status = hist.status || {};
    if (status.status_str === 'error') {
      throw new Error(explainComfyError(JSON.stringify(status.messages || status)));
    }
    const outputs = Object.values(hist.outputs || {});
    const files = outputs.flatMap((o) => [...(o.videos || []), ...(o.gifs || []), ...(o.images || [])]);
    if (files.length > 0) {
      const f = files[0];
      const qs = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
      const vr = await fetch(`${base}/view?${qs}`, { signal: AbortSignal.timeout(120000) });
      if (!vr.ok) throw new Error(`下载 ComfyUI 输出失败：HTTP ${vr.status}`);
      return Buffer.from(await vr.arrayBuffer());
    }
    if (status.completed) break;
  }
  throw new Error(`ComfyUI 渲染超时（>${Math.round(timeoutMs / 1000)} 秒）`);
}

/** 渲染单个镜头：有角色定妆图且 ref2va 就绪时自动走多参考图锁脸 (ref2va)，否则走关键帧图生视频 (fl2va)。 */
export async function renderShot(book, cfg, { episodeIndex, shot, keyframePath, refImagePaths = [], lockedPrompt, aspect = '9:16', force = false, onLog }) {
  const vcfg = cfg.video || {};
  const base = assertLoopbackUrl(vcfg.comfyUrl || 'http://127.0.0.1:8188');
  const validRefs = (refImagePaths || []).filter((p) => p && fs.existsSync(p));
  const useRef2V = validRefs.length > 0 && hasRef2VModels(vcfg);
  if (!useRef2V && (!keyframePath || !fs.existsSync(keyframePath))) {
    throw new Error('缺少关键帧图片：先选一张封面底图或上传参考图');
  }
  const { width, height } = aspectDimensions(aspect, vcfg);
  const fps = Number(vcfg.fps) || 24;
  const steps = Number(vcfg.steps) || 4;
  const frames = snapFrames(shot.seconds || 5, fps);
  const seed = Number(shot.seed) || (1000 + episodeIndex * 100 + shot.index);
  const effectivePrompt = lockedPrompt || shot.prompt;
  const keyframeHash = !useRef2V && keyframePath ? sha256File(keyframePath) : '';
  const refHashes = useRef2V ? validRefs.map((p) => sha256File(p)) : [];
  const mode = useRef2V ? 'ref2va' : 'fl2va';
  const inputHash = computeShotInputHash({ mode, keyframeHash, refHashes, prompt: effectivePrompt, seed, width, height, frames, steps, vcfg });

  const epDir = path.join(videoDir(book), `ep-${String(episodeIndex).padStart(2, '0')}`);
  const shotsDir = path.join(epDir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const stem = `shot-${String(shot.index).padStart(2, '0')}-${inputHash}`;
  const outMp4 = path.join(shotsDir, `${stem}.mp4`);
  const qaFrames = ['first', 'mid', 'last'].map((t) => path.join(shotsDir, `${stem}_${t}.png`));

  if (!force && fs.existsSync(outMp4) && qaFrames.every((f) => fs.existsSync(f))) {
    const meta = probeMedia(outMp4);
    onLog?.({ level: 'info', msg: `第 ${shot.index} 镜命中缓存（${mode} · ${inputHash}），跳过渲染` });
    return { ok: true, cached: true, mode, inputHash, file: outMp4, qaFrames, duration: meta.duration };
  }

  // 12G 显存卡：渲染前自动请出 Ollama 文本模型（同 imagegen.mjs）
  if (vcfg.autoUnloadText !== false) {
    try {
      const { detectGpu, unloadLocalText } = await import('./localai.mjs');
      const gpu = detectGpu();
      if (!gpu || gpu.vramMb < 20000) await unloadLocalText(cfg, onLog);
    } catch {}
  }

  const t0 = Date.now();
  onLog?.({ level: 'act', msg: `正在渲染第 ${shot.index} 镜（${mode === 'ref2va' ? `多图锁脸×${validRefs.length}` : '图生视频'} · ${width}×${height}，${frames} 帧，${steps} 步）…` });
  const prompt = shot.ambience ? `${effectivePrompt}\nAmbient sound: ${shot.ambience}` : effectivePrompt;
  const prefix = `storyalter/${book.slug || 'book'}_ep${episodeIndex}_s${shot.index}`;
  let graph;
  if (useRef2V) {
    const refImageNames = [];
    for (const p of validRefs.slice(0, 9)) refImageNames.push(await uploadImageToComfy(base, p));
    graph = buildH3Ref2VGraph({ refImageNames, prompt, seed, width, height, frames, fps, steps, prefix, vcfg });
  } else {
    const imageName = await uploadImageToComfy(base, keyframePath);
    graph = buildH3I2VGraph({ imageName, prompt, seed, width, height, frames, fps, steps, prefix, vcfg });
  }
  const buf = await submitAndWaitComfy(base, graph, Number(vcfg.timeoutMs) || 900000, onLog);
  fs.writeFileSync(outMp4, buf);
  const meta = probeMedia(outMp4);
  const extracted = extractQaFrames(outMp4, shotsDir, stem);
  const renderSec = Math.round((Date.now() - t0) / 100) / 10;
  onLog?.({ level: 'info', msg: `第 ${shot.index} 镜完成（${mode}，耗时 ${renderSec}s，时长 ${meta.duration.toFixed(1)}s）` });
  return { ok: true, cached: false, mode, inputHash, file: outMp4, qaFrames: extracted, duration: meta.duration, renderSec };
}

function synthesizeEdgeTts(text, outWav, voice = 'zh-CN-YunxiNeural') {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const tmpMp3 = outWav.replace(/\.wav$/i, '') + '.edge.mp3';
  const r = spawnSync('python', ['-m', 'edge_tts', '--voice', voice, '--text', String(text || ''), '--write-media', tmpMp3], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (r.status !== 0 || !fs.existsSync(tmpMp3)) {
    throw new Error(`edge-tts 失败：${(r.stderr || r.stdout || '').slice(0, 200)}`);
  }
  runCmd('ffmpeg', ['-y', '-v', 'error', '-i', tmpMp3, '-ar', '24000', '-ac', '1', outWav], 20000);
  try { fs.unlinkSync(tmpMp3); } catch {}
  if (!fs.existsSync(outWav)) throw new Error('edge-tts 转 WAV 失败');
  const meta = runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav], 15000);
  return { file: outWav, duration: Number(meta.trim()) || 0, provider: 'edge-tts', voice };
}

function synthesizeWindowsSapi(text, outWav) {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SetOutputToWaveFile('${String(outWav).replace(/'/g, "''")}')`,
    `$s.Speak('${String(text).replace(/'/g, "''")}')`,
    '$s.Dispose()',
  ].join('; ');
  runCmd('powershell', ['-NoProfile', '-Command', ps], 30000);
  if (!fs.existsSync(outWav)) throw new Error('Windows SAPI 配音生成失败');
  const meta = runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav], 15000);
  return { file: outWav, duration: Number(meta.trim()) || 0, fallback: 'sapi' };
}

/** 合成单句旁白/台词：优先 IndexTTS2（若配了参考音色且可用），否则走 edge-tts 真人神经网络语音，最后兜底 Windows SAPI。 */
export function synthesizeTts(cfg, { text, outWav, refAudio, voice }) {
  const vcfg = cfg.video || {};
  const ttsRoot = vcfg.ttsRoot || 'D:/AI/codex-tools/index-tts';
  const exe = path.join(ttsRoot, '.venv/Scripts/indextts2.exe');
  const modelDir = vcfg.ttsModelDir || path.join(ttsRoot, 'checkpoints');
  const ref = refAudio || vcfg.ttsRefAudio;
  const edgeVoice = voice || vcfg.edgeVoice || 'zh-CN-YunxiNeural';
  const tryEdgeOrSapi = () => {
    try { return synthesizeEdgeTts(text, outWav, edgeVoice); }
    catch (e) {
      if (process.platform === 'win32') return synthesizeWindowsSapi(text, outWav);
      throw e;
    }
  };
  if (!fs.existsSync(exe) || !ref || !fs.existsSync(ref)) {
    return Promise.resolve(tryEdgeOrSapi());
  }
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const args = ['synth', '--voice', ref, '--output', outWav, '--text', text, '--force'];
  if (fs.existsSync(modelDir)) args.push('--model-dir', modelDir);
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('IndexTTS 合成超时')); }, 180000);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(outWav)) {
        try { return resolve(tryEdgeOrSapi()); } catch (fbErr) {
          return reject(new Error(`IndexTTS 失败（${code}）：${err.slice(-200)}；兜底也失败：${fbErr.message}`));
        }
      }
      const meta = runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav], 15000);
      resolve({ file: outWav, duration: Number(meta.trim()) || 0 });
    });
  });
}

/** 合成一集的成片 MP4：按镜头顺序拼接；若提供了旁白音轨，则与原环境音混音。 */
export function composeEpisode(book, { episodeIndex, shotFiles, narrationFiles = [], assSubtitleFile = '', bgmFile = '', bgmVolume = 0.16, onLog }) {
  if (!shotFiles.length) throw new Error('没有已渲染的镜头可合成');
  for (const f of shotFiles) if (!fs.existsSync(f)) throw new Error(`镜头文件不存在：${f}`);
  const epDir = path.join(videoDir(book), `ep-${String(episodeIndex).padStart(2, '0')}`);
  fs.mkdirSync(epDir, { recursive: true });
  const listFile = path.join(epDir, 'concat.txt');
  fs.writeFileSync(listFile, shotFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const rawConcat = path.join(epDir, '_concat.mp4');
  const mixedMp4 = path.join(epDir, '_mixed.mp4');
  const outMp4 = path.join(epDir, `episode-${String(episodeIndex).padStart(2, '0')}.mp4`);

  onLog?.({ level: 'act', msg: `正在拼接 ${shotFiles.length} 个镜头…` });
  runCmd('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', rawConcat], 120000);

  const validNarr = narrationFiles.filter((n) => n?.file && fs.existsSync(n.file));
  const hasBgm = !!(bgmFile && fs.existsSync(bgmFile));
  if (validNarr.length === 0 && !hasBgm) {
    fs.renameSync(rawConcat, mixedMp4);
  } else {
    // 把每句旁白按镜头起止时间偏移后混入（原视频有环境音时压低到 0.25，无原音轨时自动省略 [0:a]）
    const concatMeta = probeMedia(rawConcat);
    const hasOrigAudio = !!concatMeta.hasAudio;
    const inputs = ['-i', rawConcat];
    const filters = [];
    const labels = [];
    if (hasOrigAudio) {
      filters.push('[0:a]volume=0.25[bg]');
      labels.push('[bg]');
    }
    validNarr.forEach((n, idx) => {
      inputs.push('-i', n.file);
      const ms = Math.max(0, Math.round((n.offsetSec || 0) * 1000));
      filters.push(`[${idx + 1}:a]adelay=${ms}|${ms}[v${idx}]`);
      labels.push(`[v${idx}]`);
    });
    if (hasBgm && validNarr.length > 0) {
      // 旁白轨道作为侧链触发器：说话时自动压低 BGM，停顿时自动回升
      const narrLabels = validNarr.map((_, idx) => `[v${idx}]`);
      filters.push(`${narrLabels.join('')}amix=inputs=${narrLabels.length}:normalize=0[narr_raw]`);
      filters.push('[narr_raw]asplit=2[narr_sc][narr_mix]');
      const bgmIdx = validNarr.length + 1;
      const vol = Math.min(0.8, Math.max(0.02, Number(bgmVolume) || 0.18));
      inputs.push('-stream_loop', '-1', '-i', bgmFile);
      filters.push(`[${bgmIdx}:a]volume=${vol}[bgm_raw]`);
      filters.push('[bgm_raw][narr_sc]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=350[bgm_duck]');
      const mixParts = hasOrigAudio ? ['[bg]', '[narr_mix]', '[bgm_duck]'] : ['[narr_mix]', '[bgm_duck]'];
      filters.push(`${mixParts.join('')}amix=inputs=${mixParts.length}:duration=${hasOrigAudio ? 'first' : 'longest'}:normalize=0[aout]`);
    } else {
      if (hasBgm) {
        const bgmIdx = validNarr.length + 1;
        const vol = Math.min(0.8, Math.max(0.02, Number(bgmVolume) || 0.18));
        inputs.push('-stream_loop', '-1', '-i', bgmFile);
        filters.push(`[${bgmIdx}:a]volume=${vol}[bgm]`);
        labels.push('[bgm]');
      }
      if (labels.length === 1) {
        filters.push(`${labels[0]}acopy[aout]`);
      } else {
        filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=${hasOrigAudio ? 'first' : 'longest'}:normalize=0[aout]`);
      }
    }
    runCmd('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'),
      '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', mixedMp4], 180000);
    try { fs.unlinkSync(rawConcat); } catch {}
  }

  if (assSubtitleFile && fs.existsSync(assSubtitleFile)) {
    onLog?.({ level: 'act', msg: '正在高清放大并烧录短剧字幕…' });
    const rawMeta = probeMedia(mixedMp4);
    const needUpscale = rawMeta.width > 0 && rawMeta.width < 720;
    const escAss = assSubtitleFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const vf = needUpscale
      ? `scale=iw*2:ih*2:flags=lanczos,unsharp=5:5:0.65:5:5:0.0,ass='${escAss}'`
      : `ass='${escAss}'`;
    runCmd('ffmpeg', ['-y', '-v', 'error', '-i', mixedMp4, '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-c:a', 'copy', outMp4], 240000);
    try { fs.unlinkSync(mixedMp4); } catch {}
  } else {
    if (fs.existsSync(outMp4)) try { fs.unlinkSync(outMp4); } catch {}
    fs.renameSync(mixedMp4, outMp4);
  }

  const meta = probeMedia(outMp4);
  onLog?.({ level: 'info', msg: `成片已导出：${outMp4}（${meta.duration.toFixed(1)}s）` });
  return { file: outMp4, duration: meta.duration, width: meta.width, height: meta.height };
}

/** 按本机显卡与内存评估是否跑得动 MiniMax H3（纯函数，供单测）。 */
export function evaluateHardware({ gpu, ramGb }) {
  const blockers = [];
  const warnings = [];
  if (!gpu?.ok) {
    blockers.push(`未检测到 NVIDIA 显卡（${gpu?.reason || '无 N 卡'}）：MiniMax H3 无法纯 CPU 运行`);
  } else if (gpu.totalMb < 11000) {
    blockers.push(`显存不足：需要 ≥12GB 显存（当前 ${gpu.name} ${(gpu.totalMb / 1024).toFixed(1)}GB），无法加载 MiniMax H3`);
  }
  if (Number.isFinite(ramGb) && ramGb < 20) {
    warnings.push(`系统内存偏低（当前 ${ramGb.toFixed(0)}GB，建议 ≥32GB）：H3 权重需内存缓冲，连续渲染可能内存不足`);
  }
  return { blockers, warnings };
}

/** 探测本机视频引擎各依赖与硬件是否就绪（不跑真实渲染）。 */
export async function probeVideoEngine(cfg, { gpuOverride } = {}) {
  const vcfg = cfg.video || {};
  const checks = {};
  const gpu = gpuOverride !== undefined ? gpuOverride : detectGpu();
  const ramGb = os.totalmem() / 1024 ** 3;
  const hw = evaluateHardware({ gpu, ramGb });
  checks.gpu = gpu?.ok
    ? { ok: gpu.totalMb >= 11000, detail: `${gpu.name} ${(gpu.totalMb / 1024).toFixed(1)}GB 显存` }
    : { ok: false, detail: gpu?.reason || '未检测到 NVIDIA 显卡' };
  checks.ram = { ok: ramGb >= 20, detail: `${ramGb.toFixed(0)}GB 内存（建议 ≥32GB）` };

  try {
    const base = assertLoopbackUrl(vcfg.comfyUrl || 'http://127.0.0.1:8188');
    const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(4000) });
    checks.comfy = r.ok ? { ok: true, detail: base } : { ok: false, detail: `HTTP ${r.status}` };
  } catch (e) { checks.comfy = { ok: false, detail: e.message || String(e) }; }

  const mr = vcfg.modelRoot || 'D:/AI/models/minimax-h3';
  const reqModels = [
    ['diffusion_models', vcfg.diffusionModel],
    ['text_encoders', vcfg.textEncoder],
    ['vae', vcfg.videoVae],
    ['vae', vcfg.audioVae],
    ['loras', vcfg.turboLora],
  ];
  const missingModels = reqModels.filter(([d, f]) => !f || !fs.existsSync(path.join(mr, d, f))).map(([d, f]) => `${d}/${f}`);
  checks.models = { ok: missingModels.length === 0, detail: missingModels.length ? `缺失 ${missingModels.length} 个模型：${missingModels.join(', ')}` : mr };

  const ttsExe = path.join(vcfg.ttsRoot || 'D:/AI/codex-tools/index-tts', '.venv/Scripts/indextts2.exe');
  checks.tts = { ok: fs.existsSync(ttsExe), detail: ttsExe };
  checks.ref2va = { ok: hasRef2VModels(vcfg), detail: hasRef2VModels(vcfg) ? '支持多角色参考锁脸' : '未下载（可运行 download-h3.ps1 -IncludeRef2V）' };

  for (const bin of ['ffmpeg', 'ffprobe']) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    checks[bin] = { ok: r.status === 0, detail: r.status === 0 ? 'available' : (r.error?.message || 'not found') };
  }

  const blockers = [...hw.blockers];
  if (missingModels.length) blockers.push(`缺少 H3 视频模型（${missingModels.length} 个未安装），请先运行 tools/video/download-h3.ps1 下载到 ${mr}`);
  if (!checks.comfy.ok) blockers.push(`ComfyUI 未启动（${checks.comfy.detail}），请先运行 tools/video/start-comfyui.ps1`);
  if (!checks.ffmpeg.ok || !checks.ffprobe.ok) blockers.push('缺少 ffmpeg / ffprobe（用于抽帧与成片合成）');

  const warnings = [...hw.warnings];
  if (!checks.tts.ok) warnings.push('未检测到 IndexTTS2，合成时将只保留 H3 原生音轨');

  return {
    ready: blockers.length === 0,
    ref2vaReady: checks.ref2va.ok,
    missingModels,
    blockers,
    warnings,
    checks,
  };
}

/**
 * 一键拉起本机 loopback ComfyUI（复用 tools/video/start-comfyui.ps1 相同安全参数）。
 * 若已运行直接返回；否则分离启动子进程并轮询 /system_stats 等待就绪。
 */
export async function startLocalComfyUI(cfg, { waitMs = 45000 } = {}) {
  const vcfg = cfg?.video || {};
  const base = assertLoopbackUrl(vcfg.comfyUrl || 'http://127.0.0.1:8188');
  const u = new URL(base);
  const port = Number(u.port) || 8188;

  // 若已启动，直接返回
  try {
    const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) return { ok: true, alreadyRunning: true, url: base };
  } catch {}

  const comfyRoot = vcfg.comfyRoot || 'C:/AI/StoryAlter/ComfyUI';
  const py = process.platform === 'win32'
    ? path.join(comfyRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(comfyRoot, '.venv', 'bin', 'python');
  const mainPy = path.join(comfyRoot, 'main.py');
  if (!fs.existsSync(py) || !fs.existsSync(mainPy)) {
    throw new Error(`找不到本机 ComfyUI（${comfyRoot}）。请确认 config.video.comfyRoot 或先按 tools/video/README.md 安装 ComfyUI。`);
  }

  const args = [
    mainPy,
    '--listen', '127.0.0.1',
    '--port', String(port),
    '--disable-auto-launch',
    '--fast-disk',
    '--disable-pinned-memory',
  ];
  const child = spawn(py, args, {
    cwd: comfyRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + Math.max(3000, waitMs);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return { ok: true, started: true, pid: child.pid, url: base };
    } catch {}
  }
  return { ok: true, starting: true, pid: child.pid, url: base, note: 'ComfyUI 正在后台初始化，请稍候几秒点击重新检测' };
}
