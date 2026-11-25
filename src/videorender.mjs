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
import { fileURLToPath } from 'node:url';
import { explainComfyError } from './imagelocal.mjs';
import { detectGpu } from './localai.mjs';
import { snapFrames, videoDir, getAudioStylePreset } from './videoplan.mjs';

const __DIR = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_TOOLS_DIR = path.resolve(__DIR, '../tools/video');

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

/** 根据配置与分镜参数算输入指纹；关键帧/参考图、提示词、语音模式、种子、模型、尺寸任一变了都会重算。 */
export function computeShotInputHash({ mode = 'fl2va', voiceMode = 'tts', keyframeHash = '', refHashes = [], prompt, seed, width, height, frames, steps, vcfg }) {
  const payload = JSON.stringify({
    mode, voiceMode, keyframeHash, refHashes, prompt, seed: Number(seed) || 1,
    width: Number(width), height: Number(height), frames: Number(frames), steps: Number(steps),
    diffusionModel: mode === 'ref2va' ? vcfg.ref2vaDiffusionModel : vcfg.diffusionModel,
    textEncoder: vcfg.textEncoder,
    videoVae: vcfg.videoVae, audioVae: vcfg.audioVae,
    turboLora: mode === 'ref2va' ? vcfg.ref2vTurboLora : vcfg.turboLora,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** 扫描本书与本机共享声线目录（video/voices、~/.storyalter/voices、ttsRoot/voices），自动按文件名推断 preset。 */
export function listVoiceSamples(book, cfg = {}) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const vcfg = cfg?.video || {};
  const dirs = [
    { dir: path.join(videoDir(book), 'voices'), scope: '本书' },
    { dir: videoDir(book), scope: '本书', shallowPrefix: 'voice_' },
    ...(vcfg.voiceLibraryDir ? [{ dir: vcfg.voiceLibraryDir, scope: '音色库' }] : []),
    ...(home ? [{ dir: path.join(home, '.storyalter', 'voices'), scope: '全局' }] : []),
    { dir: path.join(vcfg.ttsRoot || 'D:/AI/codex-tools/index-tts', 'voices'), scope: 'IndexTTS' },
  ];
  const inferPresetFromName = (name) => {
    const s = name.toLowerCase();
    if (/lively_female|lively|少女|活泼女/.test(s)) return 'lively_female';
    if (/young_female|female|woman|girl|nv|女主|女声/.test(s)) return 'young_female';
    if (/elder_female|old_woman|老太|婆婆/.test(s)) return 'elder_female';
    if (/elder_male|old_man|elder|老头|老者|大爷/.test(s)) return 'elder_male';
    if (/rough_male|rough|gangster|thug|悍匪|反派粗/.test(s)) return 'rough_male';
    if (/cold_male|cold|sinister|阴冷|巡捕/.test(s)) return 'cold_male';
    if (/young_male|male|hero|男主|青年男/.test(s)) return 'young_male';
    if (/narrator|旁白/.test(s)) return 'narrator';
    return '';
  };
  const seen = new Set();
  const out = [];
  for (const item of dirs) {
    try {
      if (!item.dir || !fs.existsSync(item.dir)) continue;
      for (const f of fs.readdirSync(item.dir)) {
        if (!/\.(wav|mp3|m4a|ogg)$/i.test(f)) continue;
        if (item.shallowPrefix && !f.toLowerCase().startsWith(item.shallowPrefix)) continue;
        const abs = path.join(item.dir, f);
        if (seen.has(abs) || !fs.statSync(abs).isFile()) continue;
        seen.add(abs);
        out.push({
          id: `${item.scope}:${f}`,
          label: `[${item.scope}] ${f}`,
          path: abs,
          preset: inferPresetFromName(f),
        });
      }
    } catch {}
  }
  return out;
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

function sameCharacterSet(a = [], b = []) {
  const sa = new Set((a || []).map((x) => String(x || '').trim()).filter(Boolean));
  const sb = new Set((b || []).map((x) => String(x || '').trim()).filter(Boolean));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * 判断是否可以安全接力上一镜尾帧（纯函数）：
 * 以下场景必须断开接力，防止吞掉新入场角色或把室内外/正反打机位锁死颠倒：
 * - 当前镜头已有专属 keyframeRef；
 * - 跨场戏（scene 不同）；
 * - 出场角色集合发生变化（如第 13 镜 2 人 → 第 14 镜马三入场变 3 人）；
 * - 室内外 settingType 切换，或本镜是过肩/反打机位（over-the-shoulder / reverse shot）。
 */
export function shouldRelayPrevFrame(prevShot, curShot) {
  if (!prevShot || !curShot) return false;
  if (curShot.keyframeRef) return false;
  if (!curShot.scene || prevShot.scene !== curShot.scene) return false;
  if (!prevShot.render?.qaFrameRels?.length) return false;
  if (!sameCharacterSet(prevShot.characters, curShot.characters)) return false;
  if (prevShot.settingType && curShot.settingType && prevShot.settingType !== curShot.settingType) return false;
  const camText = `${curShot.camera || ''} ${curShot.prompt || ''}`;
  if (/\b(over[-\s]?the[-\s]?shoulder|reverse\s+shot|from\s+inside\b[\s\S]{0,40}\blooking\s+out|from\s+outside\b[\s\S]{0,40}\blooking\s+in)\b/i.test(camText)) {
    return false;
  }
  return true;
}

/**
 * 统一解析单镜渲染输入（UI 路由与 MCP 共用）：
 * - Keyframe-First（renderMode === 'auto'）：若本镜已有专属静态关键帧（非封面兜底图），默认优先走 fl2va (I2V)
 *   让已审核通过的静态构图自然动起来，避免 ref2va 盲抽空间布局导致现实穿帮；
 * - 多角色锁脸（无专属关键帧且 ref2va 就绪，或显式 renderMode === 'ref2va'）：收集出镜角色定妆照 + 安全同场戏尾帧。
 */
export function prepareShotRenderInputs({
  book, episode, shot, bible, cfg, defaultRef = 'cover_bg', renderMode = 'auto', useR2VOverride,
} = {}) {
  const shots = Array.isArray(episode?.shots) ? episode.shots : [];
  const prevShot = shots.find((x) => x.index === shot.index - 1);
  const canRelay = shouldRelayPrevFrame(prevShot, shot);
  const sameSceneLastFrame = canRelay
    ? resolveKeyframePath(book, prevShot.render.qaFrameRels[prevShot.render.qaFrameRels.length - 1])
    : null;
  const explicitKeyframePath = shot.keyframeRef && shot.keyframeRef !== 'cover_bg'
    ? resolveKeyframePath(book, shot.keyframeRef)
    : null;
  const keyframePath = explicitKeyframePath || sameSceneLastFrame || resolveKeyframePath(book, shot.keyframeRef || defaultRef);

  const r2vAvailable = useR2VOverride !== undefined ? !!useR2VOverride : hasRef2VModels(cfg?.video || {});
  // Keyframe-First：有专属静态关键帧且未强行指定 ref2va 时，优先走 fl2va (I2V) 保留审过关的构图与现实物理
  const preferI2V = renderMode === 'fl2va' || (renderMode === 'auto' && !!explicitKeyframePath);
  const useR2V = !preferI2V && r2vAvailable;

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
    explicitKeyframePath,
    sameSceneLastFrame,
    preferI2V,
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

/** 画幅映射到 H3 兼容的 32 倍数分辨率（standard: 9:16=416×736；hd: 9:16=544×960 供 2D 番剧 + 1080P AI 超分）。 */
export function aspectDimensions(aspect, base = { width: 416, height: 736 }, { quality = 'standard' } = {}) {
  const hd = quality === 'hd';
  if (aspect === '16:9') return hd ? { width: 960, height: 544 } : { width: 640, height: 352 };
  if (aspect === '3:4') return hd ? { width: 640, height: 864 } : { width: 480, height: 640 };
  if (aspect === '4:5') return hd ? { width: 640, height: 800 } : { width: 480, height: 608 };
  if (aspect === '9:16') return hd ? { width: 544, height: 960 } : { width: 416, height: 736 };
  return { width: Number(base?.width) || (hd ? 544 : 416), height: Number(base?.height) || (hd ? 960 : 736) };
}

/** 探测本机是否已安装 2D 动画专用超分模型 RealESRGAN_x4plus_anime_6B.pth。 */
export function hasAnimeUpscaler(cfg = {}) {
  const comfyRoot = cfg?.video?.comfyRoot || 'C:/AI/StoryAlter/ComfyUI';
  const model = cfg?.video?.animeUpscaleModel || path.join(comfyRoot, 'models', 'upscale_models', 'RealESRGAN_x4plus_anime_6B.pth');
  const py = process.platform === 'win32'
    ? path.join(comfyRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(comfyRoot, '.venv', 'bin', 'python');
  return fs.existsSync(model) && fs.existsSync(py) && fs.existsSync(path.join(VIDEO_TOOLS_DIR, 'upscale_anime.py'));
}

/** 用 RealESRGAN_x4plus_anime_6B 将视频 GPU AI 超分至 1080×1920（或 1920×1080）全高清。 */
export function upscaleAnime1080p(inMp4, outMp4, cfg = {}, { width = 1080, height = 1920, onLog } = {}) {
  const comfyRoot = cfg?.video?.comfyRoot || 'C:/AI/StoryAlter/ComfyUI';
  const model = cfg?.video?.animeUpscaleModel || path.join(comfyRoot, 'models', 'upscale_models', 'RealESRGAN_x4plus_anime_6B.pth');
  const py = process.platform === 'win32'
    ? path.join(comfyRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(comfyRoot, '.venv', 'bin', 'python');
  const script = path.join(VIDEO_TOOLS_DIR, 'upscale_anime.py');
  if (!fs.existsSync(model) || !fs.existsSync(py) || !fs.existsSync(script)) {
    throw new Error('缺少 RealESRGAN_x4plus_anime_6B 超分环境或模型');
  }
  onLog?.({ level: 'act', msg: `正在用 RealESRGAN 2D 动画超分至 ${width}×${height} 全高清…` });
  runCmd(py, [script, inMp4, outMp4, String(width), String(height), model], 1800000);
  if (!fs.existsSync(outMp4)) throw new Error('RealESRGAN 1080P 超分未生成输出文件');
  return probeMedia(outMp4);
}

/** 根据整集镜头时间轴与声音流派自动生成三段式暗黑悬疑电影配乐与卡点音效 (48kHz Stereo WAV)。 */
export function generateEpisodeScoreAndSfx({ shots = [], totalSeconds = 60, audioStyle = 'donghua_noir', distantScreamWav = '', outWav, cfg = {}, onLog }) {
  const comfyRoot = cfg?.video?.comfyRoot || 'C:/AI/StoryAlter/ComfyUI';
  const ttsRoot = cfg?.video?.ttsRoot || 'D:/AI/codex-tools/index-tts';
  const pyCandidates = process.platform === 'win32'
    ? [path.join(comfyRoot, '.venv', 'Scripts', 'python.exe'), path.join(ttsRoot, '.venv', 'Scripts', 'python.exe'), 'python']
    : [path.join(comfyRoot, '.venv', 'bin', 'python'), path.join(ttsRoot, '.venv', 'bin', 'python'), 'python3'];
  const py = pyCandidates.find((p) => p === 'python' || p === 'python3' || fs.existsSync(p));
  const script = path.join(VIDEO_TOOLS_DIR, 'gen_noir_score.py');
  if (!py || !fs.existsSync(script)) throw new Error('找不到配乐生成脚本 gen_noir_score.py');
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const metaFile = `${outWav}.timeline.json`;
  fs.writeFileSync(metaFile, JSON.stringify({ totalSeconds, audioStyle, shots, distantScreamWav }, null, 1), 'utf8');
  onLog?.({ level: 'act', msg: `正在按「${getAudioStylePreset(audioStyle).label}」合成三段式配乐与戏剧卡点音效…` });
  try {
    runCmd(py, [script, metaFile, outWav], 120000);
  } finally {
    try { fs.unlinkSync(metaFile); } catch {}
  }
  if (!fs.existsSync(outWav)) throw new Error('三段式配乐生成失败');
  return { file: outWav };
}

/**
 * 按实际配音时长计算短剧镜头剪辑时长（纯函数）：
 * - 解决“2 秒台词却被迫播完 6.5 秒画面”的拖沓感；
 * - 保留 tailPadSec 呼吸留白与 minShotSec 最低镜头时长，绝不截断配音。
 */
export function computeClipTrimDuration({
  videoDuration,
  ttsDuration = 0,
  hasNarration = false,
  minShotSec = 2.6,
  tailPadSec = 0.65,
  trimToTts = true,
}) {
  const vDur = Math.max(0.5, Number(videoDuration) || 5);
  if (!trimToTts || !hasNarration || !(Number(ttsDuration) > 0)) return vDur;
  const target = Math.max(minShotSec, Number(ttsDuration) + tailPadSec);
  return Math.min(vDur, Math.round(target * 100) / 100);
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

/** 渲染单个镜头：有专属关键帧优先走 fl2va (I2V)，无专属关键帧且 ref2va 就绪走多图锁脸 (ref2va)；支持 hd (544×960) 与 native 对口型。 */
export async function renderShot(book, cfg, { episodeIndex, shot, keyframePath, refImagePaths = [], lockedPrompt, aspect = '9:16', quality = 'standard', voiceMode = 'tts', force = false, onLog }) {
  const vcfg = cfg.video || {};
  const base = assertLoopbackUrl(vcfg.comfyUrl || 'http://127.0.0.1:8188');
  const validRefs = (refImagePaths || []).filter((p) => p && fs.existsSync(p));
  const useRef2V = validRefs.length > 0 && hasRef2VModels(vcfg);
  if (!useRef2V && (!keyframePath || !fs.existsSync(keyframePath))) {
    throw new Error('缺少关键帧图片：先选一张封面底图或上传参考图');
  }
  const { width, height } = aspectDimensions(aspect, vcfg, { quality });
  const fps = Number(vcfg.fps) || 24;
  const steps = Number(vcfg.steps) || 4;
  const frames = snapFrames(shot.seconds || 5, fps);
  const seed = Number(shot.seed) || (1000 + episodeIndex * 100 + shot.index);
  const effectivePrompt = lockedPrompt || shot.prompt;
  const keyframeHash = !useRef2V && keyframePath ? sha256File(keyframePath) : '';
  const refHashes = useRef2V ? validRefs.map((p) => sha256File(p)) : [];
  const mode = useRef2V ? 'ref2va' : 'fl2va';
  const inputHash = computeShotInputHash({ mode, voiceMode, keyframeHash, refHashes, prompt: effectivePrompt, seed, width, height, frames, steps, vcfg });

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

/** IndexTTS2 官方真人录音室音色样本到 8 类标准角色声线的映射（全部人工听测筛选，零机械音）。 */
export const OFFICIAL_VOICE_PACK_MAP = [
  { preset: 'narrator', src: 'voice_12.wav', label: '磁性影视旁白男声' },
  { preset: 'young_male', src: 'voice_07.wav', label: '沉稳清朗青年男声' },
  { preset: 'young_female', src: 'voice_08.wav', label: '清冷温润国漫女主声' },
  { preset: 'lively_female', src: 'voice_03.wav', label: '灵动少女女声' },
  { preset: 'elder_male', src: 'emo_sad.wav', label: '沧桑厚重老年男声' },
  { preset: 'elder_female', src: 'voice_02.wav', label: '威严沉稳老年女声' },
  { preset: 'rough_male', src: 'voice_01.wav', label: '粗犷凶悍硬汉/悍匪男声' },
  { preset: 'cold_male', src: 'voice_04.wav', label: '阴冷狡猾反派男声' },
];

/**
 * 一键安装 IndexTTS2 官方真人音色库到 ~/.storyalter/voices/：
 * 若本地 examples/ 尚未下载样本，则自动调用 IndexTTS2 内置下载器从 ModelScope/HF 拉取。
 */
export function installOfficialVoicePack(cfg = {}, { targetDir } = {}) {
  const vcfg = cfg?.video || {};
  const ttsRoot = vcfg.ttsRoot || 'D:/AI/codex-tools/index-tts';
  const examplesDir = path.join(ttsRoot, 'examples');
  const py = process.platform === 'win32'
    ? path.join(ttsRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(ttsRoot, '.venv', 'bin', 'python');
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const destDir = targetDir || path.join(home, '.storyalter', 'voices');

  const missingSrc = OFFICIAL_VOICE_PACK_MAP.filter((m) => !fs.existsSync(path.join(examplesDir, m.src)));
  if (missingSrc.length > 0 && fs.existsSync(py)) {
    runCmd(py, ['-c', 'from indextts.utils.examples_downloader import ensure_examples_available; ensure_examples_available()'], 180000);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const installed = [];
  const missing = [];
  for (const item of OFFICIAL_VOICE_PACK_MAP) {
    const srcPath = path.join(examplesDir, item.src);
    if (!fs.existsSync(srcPath)) {
      missing.push(item.src);
      continue;
    }
    const dstPath = path.join(destDir, `${item.preset}.wav`);
    fs.copyFileSync(srcPath, dstPath);
    installed.push({ preset: item.preset, label: item.label, path: dstPath });
  }
  if (!installed.length) {
    throw new Error(`未找到 IndexTTS2 官方音色样本（检查 ${examplesDir} 是否存在或网络能否访问 ModelScope）`);
  }
  return { ok: true, destDir, installed, missing };
}

/**
 * 根据表演情绪标签校准 IndexTTS2 的 emo_alpha 情绪强度（纯函数）：
 * - 强烈爆发情绪（怒吼/暴怒/凶狠/惊恐/痛哭/嘶喊）提高权重到 0.78，让情绪张力立得住；
 * - 中等张力情绪（阴冷/嘲讽/焦急/悲痛/质问/冷笑）用 0.65；
 * - 细腻克制情绪（轻声/温柔/关切/低沉/平静/淡漠）用 0.48，避免过度用力变夸张。
 */
export function calibrateEmotionParams(emotion = '', overrideWeight = null) {
  const text = String(emotion || '').trim();
  if (!text) return { emotionText: '', emotionWeight: 0 };
  if (Number.isFinite(Number(overrideWeight)) && Number(overrideWeight) > 0) {
    return { emotionText: text, emotionWeight: Math.min(1.0, Math.max(0.2, Number(overrideWeight))) };
  }
  if (/怒|吼|暴|凶|狠|恐|惊|喊|嚎|崩溃|绝望|嘶|狂|furious|shout|angry|terrified|scream/i.test(text)) {
    return { emotionText: text, emotionWeight: 0.78 };
  }
  if (/轻|柔|温|关切|克制|低沉|平静|淡|叹|耳语|whisper|gentle|calm|soft|warm/i.test(text)) {
    return { emotionText: text, emotionWeight: 0.48 };
  }
  return { emotionText: text, emotionWeight: 0.65 };
}

/**
 * 对单条人声配音做广播级后期母带处理 + 声音流派语速 + 场景空间混响：
 * - 裁剪首尾多余空白（保留自然呼吸），避免切镜后半秒才开口或尾音拖沓；
 * - 可选保音高变速（atempo，用于流派节奏如 1.07x 电影番剧 / 1.13x 抖音快节奏）；
 * - 85Hz 高通 + 胸腔/人声清晰度 EQ + 压缩 + EBU R128 响度归一化 (-16 LUFS)；
 * - 可选场景空间混响：室内木屋温暖早反射 / 室外雪夜空旷空气感 / 怒吼胡同回声；
 * - 20ms 首尾淡入淡出防爆音。
 */
export function postProcessVoiceWav(inWav, outWav = inWav, { tempo = 1.0, settingType = '', spatialReverb = false, shouting = false } = {}) {
  if (!inWav || !fs.existsSync(inWav)) throw new Error(`配音文件不存在：${inWav}`);
  const tmpOut = `${outWav}.polish.wav`;
  const durRaw = Number(runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inWav], 15000).trim()) || 0;
  const safeTempo = Math.min(1.35, Math.max(0.85, Number(tempo) || 1.0));
  const tempoPart = Math.abs(safeTempo - 1.0) >= 0.015 ? `atempo=${safeTempo.toFixed(3)},` : '';
  const trimFilter = 'silenceremove=start_periods=1:start_silence=0.04:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.06:start_threshold=-45dB,areverse';
  let spacePart = '';
  if (spatialReverb) {
    const st = String(settingType || '').toLowerCase();
    if (st === 'interior') {
      // 室内木屋近场温暖早反射
      spacePart = ',equalizer=f=220:t=q:w=1.2:g=1.2,aecho=0.82:0.88:18|36:0.13|0.07';
    } else if (st === 'exterior') {
      // 室外雪夜砖墙胡同空气感；怒吼/反派威吓带更明显砖墙回声
      spacePart = shouting
        ? ',highpass=f=95,equalizer=f=3500:t=q:w=1.4:g=1.5,aecho=0.80:0.86:58|118:0.16|0.08'
        : ',highpass=f=95,equalizer=f=3500:t=q:w=1.5:g=1.2,aecho=0.82:0.86:44|88:0.09|0.04';
    }
  }
  const toneFilter = `${tempoPart}highpass=f=85,lowpass=f=13500,equalizer=f=260:t=q:w=1.2:g=1.4,equalizer=f=3200:t=q:w=1.4:g=1.8,acompressor=threshold=-20dB:ratio=2.4:attack=10:release=120:makeup=1.5${spacePart},loudnorm=I=-16:TP=-1.5:LRA=9`;
  const step1 = `${outWav}.trim.wav`;
  try {
    runCmd('ffmpeg', ['-y', '-v', 'error', '-i', inWav, '-af', `${trimFilter},${toneFilter}`, '-ar', '48000', '-ac', '1', step1], 30000);
    const trimmedDur = Number(runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', step1], 15000).trim()) || durRaw;
    if (trimmedDur > 0.15) {
      const fadeOutStart = Math.max(0.05, trimmedDur - 0.025).toFixed(3);
      runCmd('ffmpeg', ['-y', '-v', 'error', '-i', step1, '-af', `afade=t=in:st=0:d=0.02,afade=t=out:st=${fadeOutStart}:d=0.025`, '-ar', '48000', '-ac', '1', tmpOut], 30000);
      fs.renameSync(tmpOut, outWav);
      try { fs.unlinkSync(step1); } catch {}
      return { file: outWav, duration: trimmedDur };
    }
    fs.renameSync(step1, outWav);
    return { file: outWav, duration: trimmedDur || durRaw };
  } catch {
    try { if (fs.existsSync(step1)) fs.unlinkSync(step1); } catch {}
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
    runCmd('ffmpeg', ['-y', '-v', 'error', '-i', inWav, '-af', toneFilter, '-ar', '48000', '-ac', '1', tmpOut], 30000);
    fs.renameSync(tmpOut, outWav);
    const d = Number(runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav], 15000).trim()) || durRaw;
    return { file: outWav, duration: d };
  }
}

/** 合成单句旁白/台词：优先 IndexTTS2（--fp16 + 角色真人音色克隆 + 情绪自适应权重 + 广播母带），否则 edge-tts，最后兜底 Windows SAPI。 */
export function synthesizeTts(cfg, { text, outWav, refAudio, voice, emotion = '', emotionWeight = null, polish = true, tempo = 1.0, settingType = '', spatialReverb = false, shouting = false }) {
  const vcfg = cfg.video || {};
  const ttsRoot = vcfg.ttsRoot || 'D:/AI/codex-tools/index-tts';
  const exe = path.join(ttsRoot, '.venv/Scripts/indextts2.exe');
  const modelDir = vcfg.ttsModelDir || path.join(ttsRoot, 'checkpoints');
  const ref = refAudio || vcfg.ttsRefAudio;
  const edgeVoice = voice || vcfg.edgeVoice || 'zh-CN-YunxiNeural';
  const finish = (res) => {
    if (polish && res?.file && fs.existsSync(res.file)) {
      try {
        const p = postProcessVoiceWav(res.file, res.file, { tempo, settingType, spatialReverb, shouting });
        return { ...res, duration: p.duration, polished: true };
      } catch {}
    }
    return res;
  };
  const tryEdgeOrSapi = () => {
    try { return finish(synthesizeEdgeTts(text, outWav, edgeVoice)); }
    catch (e) {
      if (process.platform === 'win32') return finish(synthesizeWindowsSapi(text, outWav));
      throw e;
    }
  };
  if (!fs.existsSync(exe) || !ref || !fs.existsSync(ref)) {
    return Promise.resolve(tryEdgeOrSapi());
  }
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const emo = calibrateEmotionParams(emotion, emotionWeight);
  const args = ['synth', '--voice', ref, '--output', outWav, '--text', text, '--fp16', '--force'];
  if (emo.emotionText) {
    args.push('--emotion-text', emo.emotionText, '--emotion-weight', String(emo.emotionWeight));
  }
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
      resolve(finish({ file: outWav, duration: Number(meta.trim()) || 0, provider: 'indextts2' }));
    });
  });
}

/**
 * 批量合成整集配音（indextts2 batch 单次加载模型，比逐镜重载快 5–10 倍）：
 * tasks: Array<{ key, text, outWav, refAudio, voice, emotion, emotionWeight, label }>
 * 返回 Map<key, { file, duration, provider, polished }>。
 */
export async function synthesizeTtsBatch(cfg, tasks = [], { polish = true, onLog } = {}) {
  const results = new Map();
  if (!tasks.length) return results;
  const vcfg = cfg.video || {};
  const ttsRoot = vcfg.ttsRoot || 'D:/AI/codex-tools/index-tts';
  const exe = path.join(ttsRoot, '.venv/Scripts/indextts2.exe');
  const modelDir = vcfg.ttsModelDir || path.join(ttsRoot, 'checkpoints');

  const batchTasks = [];
  const fallbackTasks = [];
  for (const t of tasks) {
    const ref = t.refAudio || vcfg.ttsRefAudio;
    if (fs.existsSync(exe) && ref && fs.existsSync(ref)) {
      batchTasks.push({ ...t, ref });
    } else {
      fallbackTasks.push(t);
    }
  }

  if (batchTasks.length > 0) {
    const batchDir = path.dirname(batchTasks[0].outWav);
    fs.mkdirSync(batchDir, { recursive: true });
    const batchFile = path.join(batchDir, `_indextts_batch_${Date.now()}.jsonl`);
    const lines = batchTasks.map((t) => {
      fs.mkdirSync(path.dirname(t.outWav), { recursive: true });
      const emo = calibrateEmotionParams(t.emotion, t.emotionWeight);
      const item = { text: t.text, voice: t.ref, output: t.outWav };
      if (emo.emotionText) {
        item.emotion_text = emo.emotionText;
        item.emotion_weight = emo.emotionWeight;
      }
      return JSON.stringify(item);
    });
    fs.writeFileSync(batchFile, lines.join('\n') + '\n', 'utf8');
    onLog?.({ level: 'act', msg: `正在用 IndexTTS2 批量合成 ${batchTasks.length} 条角色配音（单次加载模型 + FP16）…` });

    const args = ['batch', '--batch-file', batchFile, '--fp16', '--force'];
    if (fs.existsSync(modelDir)) args.push('--model-dir', modelDir);
    const batchOk = await new Promise((resolve) => {
      const p = spawn(exe, args, { windowsHide: true });
      const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, Math.max(240000, batchTasks.length * 45000));
      p.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
      p.on('error', () => { clearTimeout(timer); resolve(false); });
    });
    try { fs.unlinkSync(batchFile); } catch {}

    for (const t of batchTasks) {
      if (batchOk && fs.existsSync(t.outWav)) {
        let dur = Number(runCmd('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', t.outWav], 15000).trim()) || 0;
        let polished = false;
        if (polish) {
          try {
            dur = postProcessVoiceWav(t.outWav, t.outWav, {
              tempo: t.tempo || 1.0,
              settingType: t.settingType || '',
              spatialReverb: !!t.spatialReverb,
              shouting: !!t.shouting,
            }).duration;
            polished = true;
          } catch {}
        }
        results.set(t.key, { file: t.outWav, duration: dur, provider: 'indextts2-batch', polished });
      } else {
        fallbackTasks.push(t);
      }
    }
  }

  for (const t of fallbackTasks) {
    onLog?.({ level: 'act', msg: `合成配音（${t.label || t.key}${t.emotion ? ` · ${t.emotion}` : ''}）…` });
    const r = await synthesizeTts(cfg, {
      text: t.text,
      outWav: t.outWav,
      refAudio: t.refAudio,
      voice: t.voice,
      emotion: t.emotion,
      emotionWeight: t.emotionWeight,
      tempo: t.tempo || 1.0,
      settingType: t.settingType || '',
      spatialReverb: !!t.spatialReverb,
      shouting: !!t.shouting,
      polish,
    });
    results.set(t.key, r);
  }
  return results;
}

/**
 * 合成一集的成片 MP4：按镜头顺序拼接（支持按配音时长裁剪拖尾）；若提供了旁白音轨，则与原环境音混音。
 * 既支持旧调用 shotFiles: string[]，也支持 shotClips: Array<{file:string, trimSec?:number}>。
 */
export function composeEpisode(book, { episodeIndex, shotFiles = [], shotClips = null, narrationFiles = [], assSubtitleFile = '', bgmFile = '', bgmVolume = 0.16, voiceMode = 'tts', onLog }) {
  const clips = Array.isArray(shotClips) && shotClips.length
    ? shotClips
    : (shotFiles || []).map((file) => ({ file }));
  if (!clips.length) throw new Error('没有已渲染的镜头可合成');
  for (const c of clips) if (!c?.file || !fs.existsSync(c.file)) throw new Error(`镜头文件不存在：${c?.file}`);
  const epDir = path.join(videoDir(book), `ep-${String(episodeIndex).padStart(2, '0')}`);
  fs.mkdirSync(epDir, { recursive: true });

  // 如某镜头需要按配音时长收紧拖尾，精确重编码截出子片段，避免关键帧对齐误差导致音画漂移
  const tempTrimFiles = [];
  const finalShotFiles = [];
  let trimmedCount = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const meta = probeMedia(c.file);
    const trimSec = Number(c.trimSec) || 0;
    if (trimSec > 0 && trimSec < meta.duration - 0.2) {
      const trimOut = path.join(epDir, `_trim_${String(i + 1).padStart(2, '0')}.mp4`);
      const trimArgs = ['-y', '-v', 'error', '-i', c.file, '-t', trimSec.toFixed(3), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18'];
      if (meta.hasAudio) trimArgs.push('-c:a', 'aac');
      trimArgs.push(trimOut);
      runCmd('ffmpeg', trimArgs, 120000);
      tempTrimFiles.push(trimOut);
      finalShotFiles.push(trimOut);
      trimmedCount++;
    } else {
      finalShotFiles.push(c.file);
    }
  }

  const listFile = path.join(epDir, 'concat.txt');
  fs.writeFileSync(listFile, finalShotFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const rawConcat = path.join(epDir, '_concat.mp4');
  const mixedMp4 = path.join(epDir, '_mixed.mp4');
  const outMp4 = path.join(epDir, `episode-${String(episodeIndex).padStart(2, '0')}.mp4`);

  onLog?.({ level: 'act', msg: `正在拼接 ${finalShotFiles.length} 个镜头${trimmedCount ? `（已按配音收紧 ${trimmedCount} 镜节奏）` : ''}…` });
  if (trimmedCount > 0) {
    // 含重编码裁剪片段时统一流参数拼接，防止部分 copy 部分重编码的时间基/SPS 差异
    const concatMeta = probeMedia(finalShotFiles[0]);
    const reArgs = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18'];
    if (concatMeta.hasAudio) reArgs.push('-c:a', 'aac');
    reArgs.push(rawConcat);
    runCmd('ffmpeg', reArgs, 180000);
  } else {
    runCmd('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', rawConcat], 120000);
  }
  for (const tf of tempTrimFiles) { try { fs.unlinkSync(tf); } catch {} }

  const validNarr = narrationFiles.filter((n) => n?.file && fs.existsSync(n.file));
  const hasBgm = !!(bgmFile && fs.existsSync(bgmFile));
  const concatMeta = probeMedia(rawConcat);
  const hasOrigAudio = !!concatMeta.hasAudio;
  if (validNarr.length === 0 && !hasBgm) {
    if (voiceMode === 'native' && hasOrigAudio) {
      // 原生对口型模式也做一次人声清晰度与响度归一化，消除 H3 原始直出音量发虚/闷糊
      runCmd('ffmpeg', ['-y', '-v', 'error', '-i', rawConcat, '-c:v', 'copy',
        '-af', 'highpass=f=80,equalizer=f=3000:t=q:w=1.4:g=1.6,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.95',
        '-c:a', 'aac', '-b:a', '192k', mixedMp4], 180000);
      try { fs.unlinkSync(rawConcat); } catch {}
    } else {
      fs.renameSync(rawConcat, mixedMp4);
    }
  } else {
    // 影院级多轨混音：
    // - tts 模式：合并全部人声为 dialogue 总线，用侧链压缩自动闪避原视频底噪（低通 3.8kHz + 音量 0.18）与 BGM；
    // - native 模式：保留 H3 原生对口型人声（并做响度增强），仅对旁白/BGM 混音。
    const inputs = ['-i', rawConcat];
    const filters = [];
    validNarr.forEach((n, idx) => {
      inputs.push('-i', n.file);
      const ms = Math.max(0, Math.round((n.offsetSec || 0) * 1000));
      filters.push(`[${idx + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${idx}]`);
    });

    const hasDialogue = validNarr.length > 0;
    const targetDur = Math.max(0.5, Number(concatMeta.duration) || 5).toFixed(3);
    if (hasDialogue) {
      const narrLabels = validNarr.map((_, idx) => `[v${idx}]`);
      if (narrLabels.length === 1) {
        filters.push(`${narrLabels[0]}apad=whole_dur=${targetDur}[narr_bus]`);
      } else {
        filters.push(`${narrLabels.join('')}amix=inputs=${narrLabels.length}:normalize=0,apad=whole_dur=${targetDur}[narr_bus]`);
      }
    }

    const mixParts = [];
    let scSplitCount = 0;
    const duckOrig = hasOrigAudio && hasDialogue && voiceMode !== 'native';
    const duckBgm = hasBgm && hasDialogue;
    if (hasDialogue) {
      scSplitCount = 1 + (duckOrig ? 1 : 0) + (duckBgm ? 1 : 0);
      if (scSplitCount > 1) {
        const outs = ['[narr_mix]', ...(duckOrig ? ['[narr_sc_bg]'] : []), ...(duckBgm ? ['[narr_sc_bgm]'] : [])];
        filters.push(`[narr_bus]asplit=${scSplitCount}${outs.join('')}`);
      } else {
        filters.push('[narr_bus]acopy[narr_mix]');
      }
      mixParts.push('[narr_mix]');
    }

    if (hasOrigAudio) {
      if (voiceMode === 'native') {
        filters.push('[0:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,equalizer=f=3000:t=q:w=1.4:g=1.6,loudnorm=I=-16:TP=-1.5:LRA=11[bg]');
        mixParts.push('[bg]');
      } else if (duckOrig) {
        filters.push('[0:a]aresample=48000,aformat=channel_layouts=stereo,lowpass=f=3800,volume=0.18[bg_raw]');
        filters.push('[bg_raw][narr_sc_bg]sidechaincompress=threshold=0.015:ratio=8:attack=25:release=300[bg_duck]');
        mixParts.push('[bg_duck]');
      } else {
        filters.push('[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.28[bg]');
        mixParts.push('[bg]');
      }
    }

    if (hasBgm) {
      const bgmIdx = validNarr.length + 1;
      const vol = Math.min(0.8, Math.max(0.02, Number(bgmVolume) || 0.16));
      inputs.push('-stream_loop', '-1', '-i', bgmFile);
      filters.push(`[${bgmIdx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${vol}[bgm_raw]`);
      if (duckBgm) {
        filters.push('[bgm_raw][narr_sc_bgm]sidechaincompress=threshold=0.018:ratio=6:attack=35:release=350[bgm_duck]');
        mixParts.push('[bgm_duck]');
      } else {
        mixParts.push('[bgm_raw]');
      }
    }

    if (mixParts.length === 1) {
      filters.push(`${mixParts[0]}alimiter=limit=0.95:attack=5:release=50[aout]`);
    } else {
      filters.push(`${mixParts.join('')}amix=inputs=${mixParts.length}:duration=first:normalize=0,alimiter=limit=0.95:attack=5:release=50[aout]`);
    }
    runCmd('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'),
      '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', mixedMp4], 180000);
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
