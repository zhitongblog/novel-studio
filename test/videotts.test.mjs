import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  TTS_PROVIDERS, PROVIDER_VOICES, normalizeSpokenText, mapEmotionToMinimax,
  resolveTtsCredentials, resolveActiveTtsProvider, resolveProviderVoiceId,
  synthesizeMinimaxTts, synthesizeDashscopeTts, synthesizeDoubaoTts, synthesizeCloudTts,
} from '../src/videotts.mjs';

function makeTinyMp3Buf() {
  const tmp = path.join(os.tmpdir(), `tiny_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
    '-c:a', 'libmp3lame', '-b:a', '64k', tmp,
  ], { windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg makeTinyMp3Buf failed');
  const buf = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch {}
  return buf;
}

test('normalizeSpokenText 自动纠偏生僻字与用户自定义多音字表', () => {
  assert.equal(normalizeSpokenText('今儿早些落闩吧，门闩别忘了插。'), '今儿早些落栓吧，门栓别忘了插。');
  assert.equal(normalizeSpokenText('血泊中他作揖行礼。'), '血波中他作衣行礼。');
  assert.equal(normalizeSpokenText('阿房宫里长叹。', { 阿房宫: '额旁宫' }), '额旁宫里长叹。');
});

test('mapEmotionToMinimax 映射中文表演情绪到 MiniMax 枚举', () => {
  assert.equal(mapEmotionToMinimax('凶狠怒吼'), 'angry');
  assert.equal(mapEmotionToMinimax('虚弱痛苦哀求'), 'sad');
  assert.equal(mapEmotionToMinimax('惊恐颤抖'), 'fearful');
  assert.equal(mapEmotionToMinimax('阴冷傲慢嘲讽'), 'disgusted');
  assert.equal(mapEmotionToMinimax('慈祥促狭笑意'), 'happy');
  assert.equal(mapEmotionToMinimax('低沉克制'), 'neutral');
});

test('resolveActiveTtsProvider 按用户设置与 Key 可用性择优选择（含 DashScope Key 复用）', () => {
  assert.equal(resolveActiveTtsProvider({}), 'local');
  assert.equal(resolveActiveTtsProvider({ api: { dashscope: { apiKey: 'sk-abc' } } }), 'dashscope');
  assert.equal(resolveActiveTtsProvider({
    api: { dashscope: { apiKey: 'sk-abc' } },
    video: { tts: { provider: 'auto', minimax: { apiKey: 'mm-123' } } },
  }), 'minimax');
  assert.equal(resolveActiveTtsProvider({
    api: { dashscope: { apiKey: 'sk-abc' } },
    video: { tts: { provider: 'local', minimax: { apiKey: 'mm-123' } } },
  }), 'local');
  // 单次覆盖优先级高于全局
  assert.equal(resolveActiveTtsProvider({
    api: { dashscope: { apiKey: 'sk-abc' } },
    video: { tts: { provider: 'local', minimax: { apiKey: 'mm-123' } } },
  }, 'dashscope'), 'dashscope');

  const creds = resolveTtsCredentials({ api: { dashscope: { apiKey: 'sk-reuse' } } });
  assert.equal(creds.dashscope.configured, true);
  assert.equal(creds.dashscope.apiKey, 'sk-reuse');
});

test('resolveProviderVoiceId 优先用户自选 voiceId，否则按 preset 匹配对应引擎内置 CV', () => {
  assert.equal(TTS_PROVIDERS.length, 5);
  assert.ok(PROVIDER_VOICES.minimax.length >= 8);
  assert.ok(PROVIDER_VOICES.dashscope.length >= 7);
  assert.ok(PROVIDER_VOICES.doubao.length >= 8);

  assert.equal(resolveProviderVoiceId('minimax', { voicePreset: 'young_female' }), 'Chinese (Mandarin)_Wise_Women');
  assert.equal(resolveProviderVoiceId('dashscope', { voicePreset: 'young_female' }), 'Cherry');
  assert.equal(resolveProviderVoiceId('dashscope', { voicePreset: 'elder_male' }), 'Dylan');
  assert.equal(resolveProviderVoiceId('doubao', { voicePreset: 'cold_male' }), 'zh_male_lengkugege_emo_v2_mars_bigtts');
  assert.equal(resolveProviderVoiceId('minimax', { voicePreset: 'young_male', customVoiceId: 'my_clone_001' }), 'my_clone_001');
});

test('三家云端 TTS 适配器（MiniMax / DashScope / Doubao）请求结构、解码与转 WAV 端到端单测', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-tts-cloud-'));
  const mp3Buf = makeTinyMp3Buf();
  try {
    // 1. MiniMax t2a_v2 (hex audio + emotion + 落闩纠偏)
    let mmReq = null;
    const mmRes = await synthesizeMinimaxTts(
      { video: { tts: { minimax: { apiKey: 'mm-key', groupId: 'grp-9', model: 'speech-02-hd' } } } },
      {
        text: '今儿早些落闩吧。',
        outWav: path.join(tmpDir, 'mm.wav'),
        voiceId: 'Chinese (Mandarin)_Wise_Women',
        emotion: '凶狠怒吼',
        fetchImpl: async (url, init) => {
          mmReq = { url, headers: init.headers, body: JSON.parse(init.body) };
          return {
            ok: true,
            status: 200,
            json: async () => ({ base_resp: { status_code: 0 }, data: { audio: mp3Buf.toString('hex') } }),
          };
        },
      }
    );
    assert.match(mmReq.url, /GroupId=grp-9/);
    assert.equal(mmReq.body.text, '今儿早些落栓吧。');
    assert.equal(mmReq.body.voice_setting.emotion, 'angry');
    assert.equal(mmRes.provider, 'minimax');
    assert.ok(fs.existsSync(mmRes.file) && mmRes.duration > 0.2);

    // 2. 阿里云 DashScope Qwen3-TTS (URL 下载 + 复用 api.dashscope.apiKey)
    let dsReq = null;
    const dsRes = await synthesizeDashscopeTts(
      { api: { dashscope: { apiKey: 'sk-dash' } } },
      {
        text: '腕子还疼不？',
        outWav: path.join(tmpDir, 'ds.wav'),
        voiceId: 'Ethan',
        fetchImpl: async (url, init) => {
          if (url.includes('multimodal-generation')) {
            dsReq = { url, body: JSON.parse(init.body) };
            return { ok: true, status: 200, json: async () => ({ output: { audio: { url: 'https://mock.oss/audio.mp3' } } }) };
          }
          return { ok: true, status: 200, arrayBuffer: async () => mp3Buf };
        },
      }
    );
    assert.equal(dsReq.body.model, 'qwen3-tts-flash');
    assert.equal(dsReq.body.input.voice, 'Ethan');
    assert.equal(dsRes.provider, 'dashscope');
    assert.ok(fs.existsSync(dsRes.file) && dsRes.duration > 0.2);

    // 3. 火山豆包 Seed-TTS (base64 mp3 + code 3000)
    let dbReq = null;
    const dbRes = await synthesizeDoubaoTts(
      { video: { tts: { doubao: { appId: 'app-1', token: 'tok-2', cluster: 'volcano_tts' } } } },
      {
        text: '住手！',
        outWav: path.join(tmpDir, 'db.wav'),
        voiceId: 'zh_male_beijingxiaoye_moon_bigtts',
        fetchImpl: async (url, init) => {
          dbReq = { url, headers: init.headers, body: JSON.parse(init.body) };
          return { ok: true, status: 200, json: async () => ({ code: 3000, data: mp3Buf.toString('base64') }) };
        },
      }
    );
    assert.equal(dbReq.headers.Authorization, 'Bearer;tok-2');
    assert.equal(dbReq.body.app.appid, 'app-1');
    assert.equal(dbRes.provider, 'doubao');
    assert.ok(fs.existsSync(dbRes.file) && dbRes.duration > 0.2);

    // 4. 统一入口 synthesizeCloudTts 透传 preset 自动选音色
    const unified = await synthesizeCloudTts(
      { video: { tts: { minimax: { apiKey: 'mm-key' } } } },
      {
        provider: 'minimax',
        text: '测试',
        outWav: path.join(tmpDir, 'u.wav'),
        voicePreset: 'elder_male',
        fetchImpl: async (_url, init) => {
          const b = JSON.parse(init.body);
          assert.equal(b.voice_setting.voice_id, 'Chinese (Mandarin)_Kind-hearted_Elder');
          return { ok: true, status: 200, json: async () => ({ base_resp: { status_code: 0 }, data: { audio: mp3Buf.toString('hex') } }) };
        },
      }
    );
    assert.equal(unified.voice, 'Chinese (Mandarin)_Kind-hearted_Elder');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
