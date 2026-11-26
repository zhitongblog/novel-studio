// 改编视频 · 多引擎配音适配层（MiniMax 海螺语音 / 阿里云 DashScope Qwen-TTS / 火山豆包语音 / 本机 IndexTTS2）。
//
// 设计原则：
//   · 用户可在全局选引擎（auto / minimax / dashscope / doubao / local），也可按角色自由挑该引擎的任意音色或填自定义 voice_id；
//   · 统一输出 48kHz 单声道 WAV，再交由 videorender.postProcessVoiceWav 做语速、空间混响与 -16 LUFS 母带；
//   · 内置中文生僻字/古风多音字纠偏预处理（如“落闩→落栓”），绝不改动字幕显示原文。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const TTS_PROVIDERS = [
  {
    id: 'auto',
    label: '✨ 自动择优（优先已配云端 CV，无 Key 兜底本机 IndexTTS2）',
    priceHint: '按已配置的引擎计费',
    cloud: false,
  },
  {
    id: 'minimax',
    label: '🎭 MiniMax 海螺语音（番剧/短剧演技最强 · ¥2–3.5/万字）',
    priceHint: 'speech-02-turbo ¥2.0/万字 · speech-02-hd ¥3.5/万字',
    cloud: true,
  },
  {
    id: 'dashscope',
    label: '💰 阿里云百炼 Qwen-TTS（最便宜高性价比 · ¥0.8/万字）',
    priceHint: 'qwen3-tts-flash ¥0.8/万字（可复用通义 DashScope Key）',
    cloud: true,
  },
  {
    id: 'doubao',
    label: '🔥 火山引擎豆包语音（抖音爆款网感同源 · ¥5.0/万字）',
    priceHint: 'Doubao Seed-TTS ¥5.0/万字（需 AppID + Token）',
    cloud: true,
  },
  {
    id: 'local',
    label: '🖥️ 本机 IndexTTS2（完全免费 · 断网离线 · 支持传样本克隆）',
    priceHint: '¥0 免费离线',
    cloud: false,
  },
];

/** 各云端引擎内置的中文精品 CV 音色目录（含默认映射到 8 类角色声线 preset）。 */
export const PROVIDER_VOICES = {
  minimax: [
    { id: 'Chinese (Mandarin)_Serene_Narrator', label: '沉稳磁性影视旁白男声', presets: ['narrator'] },
    { id: 'Chinese (Mandarin)_Gentle_Youth', label: '清朗克制青年男声（男主）', presets: ['young_male'] },
    { id: 'Chinese (Mandarin)_Wise_Women', label: '清冷温润青年女声（女主）', presets: ['young_female'] },
    { id: 'Chinese (Mandarin)_Warm_Girl', label: '灵动少女女声', presets: ['lively_female'] },
    { id: 'Chinese (Mandarin)_Kind-hearted_Elder', label: '沧桑慈祥老年男声', presets: ['elder_male'] },
    { id: 'Chinese (Mandarin)_Kind-hearted_Grandma', label: '沉稳慈祥老年女声', presets: ['elder_female'] },
    { id: 'Chinese (Mandarin)_Male_Announcer', label: '粗犷厚重硬汉/反派男声', presets: ['rough_male'] },
    { id: 'Chinese (Mandarin)_Radio_Host', label: '冷冽磁性/阴冷反派男声', presets: ['cold_male'] },
    { id: 'Chinese (Mandarin)_News_Anchor', label: '标准播音男声', presets: [] },
    { id: 'Chinese (Mandarin)_Cute_Spirit', label: '俏皮元气少女声', presets: [] },
  ],
  dashscope: [
    { id: 'Ethan', label: 'Ethan · 阳光北方沉稳男声（男主）', presets: ['young_male'] },
    { id: 'Cherry', label: 'Cherry · 清亮自然女声（女主）', presets: ['young_female'] },
    { id: 'Chelsie', label: 'Chelsie · 二次元灵动少女声', presets: ['lively_female'] },
    { id: 'Serena', label: 'Serena · 温婉沉稳御姐/长辈女声', presets: ['elder_female'] },
    { id: 'Dylan', label: 'Dylan · 地道京味胡同男声（旁白/老大爷）', presets: ['elder_male', 'narrator'] },
    { id: 'Marcus', label: 'Marcus · 低沉磁性悬疑男声（冷峻/反派）', presets: ['cold_male'] },
    { id: 'Sunny', label: 'Sunny · 豪爽粗犷江湖男声', presets: ['rough_male'] },
    { id: 'Jada', label: 'Jada · 爽朗江湖女声', presets: [] },
  ],
  doubao: [
    { id: 'zh_male_xudong_conversation_wvae_bigtts', label: '磁性故事旁白男声', presets: ['narrator'] },
    { id: 'zh_male_yangguangqingnian_moon_bigtts', label: '沉稳青年男声（男主）', presets: ['young_male'] },
    { id: 'zh_female_gaolengyujie_moon_bigtts', label: '高冷御姐/清冷女主声', presets: ['young_female'] },
    { id: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快灵动少女声', presets: ['lively_female'] },
    { id: 'zh_male_beijingxiaoye_moon_bigtts', label: '地道京味儿胡同男声（老大爷/胡同）', presets: ['elder_male'] },
    { id: 'zh_female_wenrouxiaoya_moon_bigtts', label: '温柔长辈女声', presets: ['elder_female'] },
    { id: 'zh_male_aojiao_moon_bigtts', label: '嚣张霸气/粗犷悍匪男声', presets: ['rough_male'] },
    { id: 'zh_male_lengkugege_emo_v2_mars_bigtts', label: '冷酷阴冷反派男声', presets: ['cold_male'] },
  ],
};

/** 中文易读错生僻字/古风多音字纠偏表（只作用于喂给 TTS 的文本，不改字幕原文）。 */
export const DEFAULT_PRONUNCIATION_MAP = {
  落闩: '落栓',
  门闩: '门栓',
  插闩: '插栓',
  木闩: '木栓',
  铜闩: '铜栓',
  上闩: '上栓',
  作揖: '作衣',
  血泊: '血波',
  忖度: '忖夺',
  给予: '记予',
  给养: '记养',
  咋呼: '扎呼',
};

export function normalizeSpokenText(text, customMap = null) {
  let s = String(text || '').trim();
  if (!s) return '';
  const merged = { ...DEFAULT_PRONUNCIATION_MAP, ...(customMap && typeof customMap === 'object' ? customMap : {}) };
  for (const [wrong, right] of Object.entries(merged)) {
    if (wrong && right && s.includes(wrong)) {
      s = s.split(wrong).join(String(right));
    }
  }
  return s;
}

/** 把中文/英文表演情绪映射到 MiniMax t2a_v2 支持的 emotion 枚举。 */
export function mapEmotionToMinimax(emotion = '') {
  const e = String(emotion || '').trim();
  if (!e) return 'neutral';
  if (/怒|吼|暴|凶|狠|喝|骂|厉|furious|angry|shout/i.test(e)) return 'angry';
  if (/悲|痛|哭|哀|虚弱|绝望|凄|哽咽|sad|grief/i.test(e)) return 'sad';
  if (/恐|怕|惊慌|颤抖|哀求|fear|terrified|scared/i.test(e)) return 'fearful';
  if (/阴冷|嘲讽|冷笑|傲慢|不屑|嫌弃|厌恶|disgust|sneer|cold/i.test(e)) return 'disgusted';
  if (/惊|诧异|震|surpris|shock/i.test(e)) return 'surprised';
  if (/笑|促狭|调侃|喜|开心|得意|温|happy|smile|cheer/i.test(e)) return 'happy';
  return 'neutral';
}

/** 解析各云端 TTS 引擎的配置与可用状态（DashScope 语音自动复用 api.dashscope.apiKey）。 */
export function resolveTtsCredentials(cfg = {}) {
  const tts = cfg?.video?.tts || {};
  const minimaxKey = String(tts.minimax?.apiKey || '').trim();
  const dashKey = String(tts.dashscope?.apiKey || cfg?.api?.dashscope?.apiKey || '').trim();
  const doubaoAppId = String(tts.doubao?.appId || '').trim();
  const doubaoToken = String(tts.doubao?.token || '').trim();
  return {
    preferred: String(tts.provider || 'auto').trim() || 'auto',
    minimax: {
      configured: !!minimaxKey,
      apiKey: minimaxKey,
      groupId: String(tts.minimax?.groupId || '').trim(),
      model: String(tts.minimax?.model || 'speech-02-hd').trim(),
      baseUrl: String(tts.minimax?.baseUrl || 'https://api.minimaxi.com/v1/t2a_v2').trim(),
    },
    dashscope: {
      configured: !!dashKey,
      apiKey: dashKey,
      model: String(tts.dashscope?.model || 'qwen3-tts-flash').trim(),
      baseUrl: String(tts.dashscope?.baseUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation').trim(),
    },
    doubao: {
      configured: !!(doubaoAppId && doubaoToken),
      appId: doubaoAppId,
      token: doubaoToken,
      cluster: String(tts.doubao?.cluster || 'volcano_tts').trim(),
      baseUrl: String(tts.doubao?.baseUrl || 'https://openspeech.bytedance.com/api/v1/tts').trim(),
    },
  };
}

/** 选定实际生效的 TTS 引擎（支持单次调用 overrideProvider 覆盖全局设置）。 */
export function resolveActiveTtsProvider(cfg = {}, overrideProvider = '') {
  const creds = resolveTtsCredentials(cfg);
  const want = String(overrideProvider || creds.preferred || 'auto').trim();
  if (want === 'local') return 'local';
  if (want === 'minimax' || want === 'dashscope' || want === 'doubao') {
    return creds[want]?.configured ? want : 'local';
  }
  // auto：优先已配好 Key 的云端引擎（MiniMax → DashScope → Doubao → local）
  for (const p of ['minimax', 'dashscope', 'doubao']) {
    if (creds[p].configured) return p;
  }
  return 'local';
}

/** 为指定引擎和角色声线 preset 解析默认 voiceId（优先用户自选 voiceId，否则按 preset 匹配该引擎内置 CV）。 */
export function resolveProviderVoiceId(provider, { voicePreset = 'young_male', customVoiceId = '' } = {}) {
  const explicit = String(customVoiceId || '').trim();
  if (explicit) return explicit;
  const list = PROVIDER_VOICES[provider] || [];
  if (!list.length) return '';
  const hit = list.find((v) => Array.isArray(v.presets) && v.presets.includes(voicePreset));
  return (hit || list[0]).id;
}

function convertBufferToWav(buf, extHint, outWav) {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  const tmpRaw = `${outWav}.raw.${extHint || 'mp3'}`;
  fs.writeFileSync(tmpRaw, buf);
  try {
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', tmpRaw, '-ar', '48000', '-ac', '1', outWav], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    if (r.status !== 0 || !fs.existsSync(outWav)) {
      throw new Error(`音频转 WAV 失败：${(r.stderr || '').slice(0, 200)}`);
    }
  } finally {
    try { fs.unlinkSync(tmpRaw); } catch {}
  }
  const durOut = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  return Number((durOut.stdout || '').trim()) || 0;
}

/** 调用 MiniMax 海螺语音 t2a_v2 合成单句台词。 */
export async function synthesizeMinimaxTts(cfg, { text, outWav, voiceId, emotion = '', speed = 1.0, fetchImpl = fetch }) {
  const creds = resolveTtsCredentials(cfg).minimax;
  if (!creds.configured) throw new Error('未配置 MiniMax 语音 API Key');
  const url = creds.groupId ? `${creds.baseUrl}?GroupId=${encodeURIComponent(creds.groupId)}` : creds.baseUrl;
  const body = {
    model: creds.model || 'speech-02-hd',
    text: normalizeSpokenText(text),
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: voiceId || 'Chinese (Mandarin)_Gentle_Youth',
      speed: Math.min(2.0, Math.max(0.5, Number(speed) || 1.0)),
      vol: 1.0,
      pitch: 0,
      emotion: mapEmotionToMinimax(emotion),
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  };
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`MiniMax 语音 HTTP ${resp.status}：${data?.base_resp?.status_msg || data?.error?.message || resp.statusText}`);
  }
  const stCode = data?.base_resp?.status_code;
  if (stCode !== undefined && stCode !== 0) {
    throw new Error(`MiniMax 语音失败（${stCode}）：${data?.base_resp?.status_msg || '未知错误'}`);
  }
  const hexAudio = data?.data?.audio;
  if (!hexAudio || typeof hexAudio !== 'string') {
    throw new Error('MiniMax 语音返回缺少 data.audio');
  }
  const buf = Buffer.from(hexAudio, 'hex');
  const duration = convertBufferToWav(buf, 'mp3', outWav);
  return { file: outWav, duration, provider: 'minimax', voice: body.voice_setting.voice_id, model: body.model };
}

/** 调用阿里云百炼 DashScope Qwen3-TTS (qwen3-tts-flash) 合成单句台词。 */
export async function synthesizeDashscopeTts(cfg, { text, outWav, voiceId, fetchImpl = fetch }) {
  const creds = resolveTtsCredentials(cfg).dashscope;
  if (!creds.configured) throw new Error('未配置阿里云 DashScope API Key（按量付费 sk- Key）');
  const body = {
    model: creds.model || 'qwen3-tts-flash',
    input: {
      text: normalizeSpokenText(text),
      voice: voiceId || 'Ethan',
      language_type: 'Chinese',
    },
  };
  const resp = await fetchImpl(creds.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`阿里云 Qwen-TTS HTTP ${resp.status}：${data?.message || data?.code || resp.statusText}`);
  }
  const audioUrl = data?.output?.audio?.url;
  const audioB64 = data?.output?.audio?.data;
  let buf;
  if (audioUrl) {
    const ar = await fetchImpl(audioUrl, { signal: AbortSignal.timeout(45000) });
    if (!ar.ok) throw new Error(`下载阿里云语音文件失败：HTTP ${ar.status}`);
    buf = Buffer.from(await ar.arrayBuffer());
  } else if (audioB64) {
    buf = Buffer.from(audioB64, 'base64');
  } else {
    throw new Error(`阿里云 Qwen-TTS 未返回音频：${data?.message || JSON.stringify(data).slice(0, 160)}`);
  }
  const duration = convertBufferToWav(buf, 'wav', outWav);
  return { file: outWav, duration, provider: 'dashscope', voice: body.input.voice, model: body.model };
}

/** 调用火山引擎豆包大模型语音 HTTP API 合成单句台词。 */
export async function synthesizeDoubaoTts(cfg, { text, outWav, voiceId, speed = 1.0, fetchImpl = fetch }) {
  const creds = resolveTtsCredentials(cfg).doubao;
  if (!creds.configured) throw new Error('未配置火山豆包语音 AppID / AccessToken');
  const body = {
    app: {
      appid: creds.appId,
      token: creds.token,
      cluster: creds.cluster || 'volcano_tts',
    },
    user: { uid: 'storyalter' },
    audio: {
      voice_type: voiceId || 'zh_male_yangguangqingnian_moon_bigtts',
      encoding: 'mp3',
      speed_ratio: Math.min(2.0, Math.max(0.5, Number(speed) || 1.0)),
      volume_ratio: 1.0,
      pitch_ratio: 1.0,
    },
    request: {
      reqid: crypto.randomUUID(),
      text: normalizeSpokenText(text),
      text_type: 'plain',
      operation: 'query',
    },
  };
  const resp = await fetchImpl(creds.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer;${creds.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(`火山豆包语音 HTTP ${resp.status}：${data?.message || resp.statusText}`);
  }
  if (data?.code !== 3000 || !data?.data) {
    throw new Error(`火山豆包语音失败（${data?.code}）：${data?.message || '未返回音频 data'}`);
  }
  const buf = Buffer.from(data.data, 'base64');
  const duration = convertBufferToWav(buf, 'mp3', outWav);
  return { file: outWav, duration, provider: 'doubao', voice: body.audio.voice_type, cluster: creds.cluster };
}

/** 统一云端 TTS 入口（不含本机 IndexTTS2，由 videorender.synthesizeTts 统一编排云端 + 本地兜底）。 */
export async function synthesizeCloudTts(cfg, { provider, text, outWav, voiceId, voicePreset = 'young_male', emotion = '', speed = 1.0, pronunciationMap = null, fetchImpl = fetch }) {
  const cleanText = normalizeSpokenText(text, pronunciationMap);
  const resolvedVoice = resolveProviderVoiceId(provider, { voicePreset, customVoiceId: voiceId });
  if (provider === 'minimax') {
    return await synthesizeMinimaxTts(cfg, { text: cleanText, outWav, voiceId: resolvedVoice, emotion, speed, fetchImpl });
  }
  if (provider === 'dashscope') {
    return await synthesizeDashscopeTts(cfg, { text: cleanText, outWav, voiceId: resolvedVoice, fetchImpl });
  }
  if (provider === 'doubao') {
    return await synthesizeDoubaoTts(cfg, { text: cleanText, outWav, voiceId: resolvedVoice, speed, fetchImpl });
  }
  throw new Error(`不支持的云端配音引擎：${provider}`);
}
