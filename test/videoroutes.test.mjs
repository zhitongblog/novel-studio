import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleVideoRoute } from '../src/videoroutes.mjs';
import { savePlan, loadPlan, loadBible, videoDir } from '../src/videoplan.mjs';
import { probeMedia } from '../src/videorender.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-routes-'));
  const book = { slug: 'test-book', title: '测试短剧书', dir: tmp };
  const videoJobs = new Map();
  const logs = [];
  const cfg = {
    video: {
      comfyUrl: 'http://127.0.0.1:59997',
      modelRoot: 'Z:/nonexistent',
      ttsRoot: 'Z:/nonexistent',
      aspect: '9:16',
    },
  };
  const call = async (p, body = {}) => {
    let status = 0;
    let data = null;
    const json = (_res, code, payload) => { status = code; data = payload; };
    const handled = await handleVideoRoute({
      p,
      body: { book: book.slug, ...body },
      cfg,
      res: {},
      json,
      getBook: (slug) => (slug === book.slug ? book : null),
      pushLog: (_slug, entry) => logs.push(entry),
      videoJobs,
    });
    return { handled, status, data };
  };
  const waitJob = async (timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await call('/api/book/video/job-status');
      if (r.data?.status === 'done' || r.data?.status === 'error') return r.data;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('video job timeout');
  };
  return { tmp, book, cfg, call, waitJob, logs, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function makeTinyPngDataUrl() {
  // 1x1 PNG
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  return `data:image/png;base64,${b64}`;
}

function makeTinyWavFile(outPath, sec = 1) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`,
    '-ar', '24000', '-ac', '1', outPath,
  ], { windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg 生成测试 wav 失败');
}

function makeTinyMp4File(outPath, { withAudio = true, sec = 2 } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x1f2438:s=480x608:r=24:d=${sec}`];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `anullsrc=r=32000:cl=stereo`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outPath);
  } else {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath);
  }
  const r = spawnSync('ffmpeg', args, { windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg 生成测试 mp4 失败: ${r.stderr?.toString()}`);
}

test('videoroutes: 定妆保存、资源上传、分镜增删改全流程', async () => {
  const env = makeEnv();
  try {
    // 1. 保存定妆库（含旁白音色与多角色）
    const saveRes = await env.call('/api/book/video/bible/save', {
      visualStyle: 'Cinematic neo-noir',
      narratorVoice: 'D:/v/narr.wav',
      narratorEdgeVoice: 'zh-CN-YunyangNeural',
      characters: [
        { name: '林砚', role: '男主', lookPrompt: '25yo man', edgeVoice: 'zh-CN-YunjianNeural', voiceRefAudio: 'D:/v/lin.wav' },
        { name: '沈知微', role: '女主', lookPrompt: '22yo woman', edgeVoice: 'zh-CN-XiaoxiaoNeural', voiceRefAudio: '' },
      ],
    });
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.data.bible.narratorEdgeVoice, 'zh-CN-YunyangNeural');
    assert.equal(loadBible(env.book).characters.length, 2);

    // 2. 上传关键帧与音频
    const kfRes = await env.call('/api/book/video/upload-keyframe', { filename: 'hero.png', dataUrl: makeTinyPngDataUrl() });
    assert.equal(kfRes.status, 200);
    assert.match(kfRes.data.ref, /^keyframes\/hero_\d+\.png$/);

    const wavTmp = path.join(env.tmp, 'raw.wav');
    makeTinyWavFile(wavTmp, 1);
    const wavB64 = fs.readFileSync(wavTmp).toString('base64');
    const voiceRes = await env.call('/api/book/video/bible/upload-voice', {
      filename: 'linyan.wav', dataUrl: `data:audio/wav;base64,${wavB64}`,
    });
    assert.equal(voiceRes.status, 200);
    assert.ok(fs.existsSync(voiceRes.data.path));

    const badVoice = await env.call('/api/book/video/bible/upload-voice', { filename: 'x.txt', dataUrl: 'not-audio' });
    assert.equal(badVoice.status, 400);

    // 3. 读取 plan（含 edgeVoices）
    savePlan(env.book, {
      version: 1,
      episodes: [{ index: 1, kind: 'episode', title: '第一集', fromChapter: 1, toChapter: 2, shots: [] }],
    });
    const planRes = await env.call('/api/book/video/plan');
    assert.equal(planRes.status, 200);
    assert.ok(Array.isArray(planRes.data.edgeVoices) && planRes.data.edgeVoices.length >= 4);
    assert.equal(planRes.data.keyframes.length, 1);

    // 4. 分镜增删改
    const add1 = await env.call('/api/book/video/shot/add', { episodeIndex: 1, action: '开场雨夜', narration: '雨下个不停。', speaker: 'narrator' });
    const add2 = await env.call('/api/book/video/shot/add', { episodeIndex: 1, action: '推门闯入', narration: '站住！', speaker: '林砚' });
    assert.equal(add1.status, 200);
    assert.equal(add2.data.shots.length, 2);

    const upd = await env.call('/api/book/video/shot/update', {
      episodeIndex: 1, shotIndex: 2, speaker: '沈知微', seed: 424242, seconds: 7, ambience: 'thunderstorm',
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.shot.speaker, '沈知微');
    assert.equal(upd.data.shot.seed, 424242);
    assert.equal(upd.data.shot.seconds, 7);

    const del = await env.call('/api/book/video/shot/delete', { episodeIndex: 1, shotIndex: 1 });
    assert.equal(del.status, 200);
    assert.equal(del.data.shots.length, 1);
    assert.equal(del.data.shots[0].index, 1);
    assert.equal(del.data.shots[0].speaker, '沈知微');
  } finally {
    env.cleanup();
  }
});

test('videoroutes: 合成成片（含无原音轨视频 + BGM 闪避 + ASS 字幕）与导出剪映草稿', async () => {
  const env = makeEnv();
  try {
    const vroot = videoDir(env.book);
    const s1 = path.join(vroot, 'ep-01', 'shots', 's1.mp4');
    const s2 = path.join(vroot, 'ep-01', 'shots', 's2.mp4');
    const bgm = path.join(vroot, 'bgm', 'theme.wav');
    // 刻意构造 6 秒视频 + 短台词，验证 trimToTts 自动收紧镜头节奏
    makeTinyMp4File(s1, { withAudio: false, sec: 6 });
    makeTinyMp4File(s2, { withAudio: false, sec: 6 });
    makeTinyWavFile(bgm, 2);

    savePlan(env.book, {
      version: 1,
      episodes: [{
        index: 1,
        kind: 'episode',
        title: '雨夜交锋',
        fromChapter: 1,
        toChapter: 2,
        aspect: '4:5',
        shots: [
          {
            index: 1, scene: 'S1', action: '镜头一', narration: '黑夜降临。', speaker: 'narrator', seconds: 6,
            render: { fileRel: 'ep-01/shots/s1.mp4', duration: 6 },
          },
          {
            index: 2, scene: 'S1', action: '镜头二', narration: '真相就在门后！', speaker: '林砚', seconds: 6,
            render: { fileRel: 'ep-01/shots/s2.mp4', duration: 6 },
          },
        ],
      }],
    });

    const compStart = await env.call('/api/book/video/episode/compose', {
      episodeIndex: 1,
      useTts: true,
      burnSubtitles: true,
      trimToTts: true,
      bgmPath: bgm,
      bgmVolume: 0.2,
    });
    assert.equal(compStart.status, 200);
    const job = await env.waitJob(60000);
    assert.equal(job.status, 'done', `合成失败: ${job.error}`);

    const plan = loadPlan(env.book);
    const ep = plan.episodes[0];
    assert.ok(ep.outputRel);
    const outFile = path.join(vroot, ep.outputRel);
    assert.ok(fs.existsSync(outFile));
    assert.ok(fs.existsSync(path.join(vroot, 'ep-01', 'episode-01.ass')));
    assert.ok(fs.existsSync(path.join(vroot, 'ep-01', 'episode-01.srt')));

    const meta = probeMedia(outFile);
    assert.equal(meta.width, 960);
    assert.equal(meta.height, 1216);
    assert.equal(meta.hasAudio, true);
    // 原两镜合计 12s，按短台词收紧后应显著低于 10s
    assert.ok(meta.duration >= 4.5 && meta.duration < 10.5, `预期收紧后时长在 4.5–10.5s，实际 ${meta.duration}s`);

    // 导出剪映草稿
    const jy = await env.call('/api/book/video/episode/export-jianying', { episodeIndex: 1 });
    assert.equal(jy.status, 200);
    assert.equal(jy.data.clipCount, 2);
    const dc = JSON.parse(fs.readFileSync(jy.data.draftContentFile, 'utf8'));
    assert.equal(dc.tracks.length, 3); // video + audio(tts) + text(subtitle)

    // native 模式合成：角色台词保留原声（跳过角色 TTS 覆盖），字幕依然正常烧录
    const nativeStart = await env.call('/api/book/video/episode/compose', {
      episodeIndex: 1,
      voiceMode: 'native',
      useTts: true,
      burnSubtitles: true,
    });
    assert.equal(nativeStart.status, 200);
    const nativeJob = await env.waitJob(60000);
    assert.equal(nativeJob.status, 'done', `native 合成失败: ${nativeJob.error}`);
    const planAfterNative = loadPlan(env.book);
    // 第 2 镜 speaker='林砚' 是角色，在 native 模式下应保留原声不生成 ttsRel
    assert.equal(planAfterNative.episodes[0].shots[1].render.ttsRel, '');
    assert.equal(planAfterNative.episodes[0].voiceMode, 'native');
  } finally {
    env.cleanup();
  }
});
