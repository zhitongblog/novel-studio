import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertLoopbackUrl, computeShotInputHash, buildH3I2VGraph, buildH3Ref2VGraph,
  aspectDimensions, computeClipTrimDuration, evaluateHardware, probeVideoEngine,
  prepareShotRenderInputs, shouldRelayPrevFrame, startLocalComfyUI,
} from '../src/videorender.mjs';

const vcfg = {
  diffusionModel: 'm.safetensors',
  textEncoder: 'te.safetensors',
  videoVae: 'vv.safetensors',
  audioVae: 'av.safetensors',
  turboLora: 'lora.safetensors',
};

test('assertLoopbackUrl 只放行本机地址，拒绝远程地址', () => {
  assert.strictEqual(assertLoopbackUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
  assert.strictEqual(assertLoopbackUrl('http://localhost:8188'), 'http://localhost:8188');
  assert.throws(() => assertLoopbackUrl('http://192.168.1.10:8188'), /loopback/);
  assert.throws(() => assertLoopbackUrl('https://evil.example.com'), /loopback/);
  assert.throws(() => assertLoopbackUrl('not-a-url'), /无效/);
});

test('computeShotInputHash：相同输入一致，任一参数改动即变化', () => {
  const base = { keyframeHash: 'abc', prompt: 'p', seed: 1, width: 480, height: 608, frames: 124, steps: 4, vcfg };
  const h0 = computeShotInputHash(base);
  assert.strictEqual(h0, computeShotInputHash({ ...base }));
  assert.notStrictEqual(h0, computeShotInputHash({ ...base, seed: 2 }));
  assert.notStrictEqual(h0, computeShotInputHash({ ...base, prompt: 'p2' }));
  assert.notStrictEqual(h0, computeShotInputHash({ ...base, keyframeHash: 'def' }));
  assert.notStrictEqual(h0, computeShotInputHash({ ...base, voiceMode: 'native' }));
  assert.notStrictEqual(h0, computeShotInputHash({ ...base, vcfg: { ...vcfg, turboLora: 'lora2.safetensors' } }));
});

test('buildH3I2VGraph 生成与官方模板一致的节点图', () => {
  const g = buildH3I2VGraph({ imageName: 'a.png', prompt: 'hello', seed: 7, width: 480, height: 608, frames: 124, vcfg });
  assert.strictEqual(g['1'].class_type, 'UNETLoader');
  assert.strictEqual(g['2'].inputs.lora_name, 'lora.safetensors');
  assert.strictEqual(g['7'].class_type, 'MiniMaxH3ImageToVideo');
  assert.strictEqual(g['7'].inputs.length, 124);
  assert.strictEqual(g['10'].inputs.steps, 4);
  assert.strictEqual(g['16'].class_type, 'SaveVideo');
});

test('buildH3Ref2VGraph 绑定多张角色定妆图到 MiniMaxH3ReferenceToVideo', () => {
  const g = buildH3Ref2VGraph({
    refImageNames: ['hero.png', 'heroine.png'],
    prompt: '<Picture 1> talks to <Picture 2>',
    seed: 9, width: 480, height: 608, frames: 124,
    vcfg: { ...vcfg, ref2vaDiffusionModel: 'r2v.safetensors', ref2vTurboLora: 'r2v_lora.safetensors' },
  });
  assert.strictEqual(g['1'].inputs.unet_name, 'r2v.safetensors');
  assert.strictEqual(g['2'].inputs.lora_name, 'r2v_lora.safetensors');
  assert.strictEqual(g['7'].class_type, 'MiniMaxH3ReferenceToVideo');
  assert.deepStrictEqual(g['7'].inputs['ref_images.ref_image_1'], ['20', 0]);
  assert.deepStrictEqual(g['7'].inputs['ref_images.ref_image_2'], ['21', 0]);
  assert.strictEqual(g['20'].inputs.image, 'hero.png');
  assert.strictEqual(g['21'].inputs.image, 'heroine.png');
});

test('aspectDimensions 映射常用画幅（均为 32 倍数）', () => {
  assert.deepStrictEqual(aspectDimensions('9:16'), { width: 416, height: 736 });
  assert.deepStrictEqual(aspectDimensions('4:5'), { width: 480, height: 608 });
  assert.deepStrictEqual(aspectDimensions('16:9'), { width: 640, height: 352 });
  assert.deepStrictEqual(aspectDimensions('3:4'), { width: 480, height: 640 });
});

test('computeClipTrimDuration 按实际配音自动收紧短剧镜头拖尾', () => {
  // 2.01s 台词配 6.58s 镜头 → 收紧到 2.66s，不再干等 4.5s
  assert.strictEqual(computeClipTrimDuration({ videoDuration: 6.58, ttsDuration: 2.01, hasNarration: true }), 2.66);
  // 6.68s 旁白配 6.58s 镜头 → 保留原视频全长
  assert.strictEqual(computeClipTrimDuration({ videoDuration: 6.58, ttsDuration: 6.68, hasNarration: true }), 6.58);
  // 极短台词 0.8s → 保底 minShotSec 2.6s
  assert.strictEqual(computeClipTrimDuration({ videoDuration: 6.0, ttsDuration: 0.8, hasNarration: true }), 2.6);
  // 关闭裁剪或无旁白空镜 → 原样保留
  assert.strictEqual(computeClipTrimDuration({ videoDuration: 6.58, ttsDuration: 2.01, hasNarration: true, trimToTts: false }), 6.58);
  assert.strictEqual(computeClipTrimDuration({ videoDuration: 6.58, ttsDuration: 0, hasNarration: false }), 6.58);
});

test('evaluateHardware 识别无 N 卡、显存不足、内存偏低', () => {
  assert.match(evaluateHardware({ gpu: { ok: false, reason: '无 N 卡' }, ramGb: 32 }).blockers[0], /未检测到 NVIDIA 显卡/);
  assert.match(evaluateHardware({ gpu: { ok: true, name: 'RTX 3060 8GB', totalMb: 8192 }, ramGb: 32 }).blockers[0], /显存不足/);
  const lowRam = evaluateHardware({ gpu: { ok: true, name: 'RTX 3060', totalMb: 12288 }, ramGb: 16 });
  assert.strictEqual(lowRam.blockers.length, 0);
  assert.match(lowRam.warnings[0], /系统内存偏低/);
  const ok = evaluateHardware({ gpu: { ok: true, name: 'RTX 3060', totalMb: 12288 }, ramGb: 32 });
  assert.deepStrictEqual(ok, { blockers: [], warnings: [] });
});

test('probeVideoEngine 在缺失文件与配置不足时返回 blockers 且不抛错', async () => {
  const r = await probeVideoEngine(
    { video: { comfyUrl: 'http://127.0.0.1:59999', modelRoot: 'Z:/nonexistent', ttsRoot: 'Z:/nonexistent', ...vcfg } },
    { gpuOverride: { ok: true, name: 'GTX 1060', totalMb: 6144 } }
  );
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.missingModels.length, 5);
  assert.strictEqual(r.checks.comfy.ok, false);
  assert.strictEqual(r.checks.models.ok, false);
  assert.strictEqual(r.checks.tts.ok, false);
  assert.ok(r.blockers.some((b) => b.includes('显存不足')));
  assert.ok(r.blockers.some((b) => b.includes('缺少 H3 视频模型')));
  assert.ok(r.blockers.some((b) => b.includes('ComfyUI 未启动')));
});

test('prepareShotRenderInputs 支持多角色锁脸与同场戏上一镜尾帧自动接力', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-prep-'));
  try {
    const book = { dir: tmp };
    const kfDir = path.join(tmp, 'video', 'keyframes');
    const shotDir = path.join(tmp, 'video', 'ep-01', 'shots');
    fs.mkdirSync(kfDir, { recursive: true });
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(kfDir, 'hero.png'), 'hero');
    fs.writeFileSync(path.join(kfDir, 'heroine.png'), 'heroine');
    fs.writeFileSync(path.join(shotDir, 's1_last.png'), 'lastframe');

    const bible = {
      characters: [
        { name: '林砚', refImageRef: 'keyframes/hero.png' },
        { name: '沈知微', refImageRef: 'keyframes/heroine.png' },
      ],
    };
    const episode = {
      shots: [
        { index: 1, scene: 'S1', settingType: 'exterior', characters: ['林砚', '沈知微'], render: { qaFrameRels: ['ep-01/shots/s1_first.png', 'ep-01/shots/s1_last.png'] } },
        { index: 2, scene: 'S1', settingType: 'exterior', characters: ['林砚', '沈知微'], keyframeRef: '' },
      ],
    };
    const out = prepareShotRenderInputs({
      book, episode, shot: episode.shots[1], bible, cfg: { video: {} }, useR2VOverride: true,
    });
    assert.ok(out.sameSceneLastFrame.endsWith('s1_last.png'));
    assert.strictEqual(out.refImagePaths.length, 3);
    assert.deepStrictEqual(out.charRefTags, [
      { name: '林砚', tag: '<Picture 1>' },
      { name: '沈知微', tag: '<Picture 2>' },
    ]);

    // 有专属静态关键帧时，auto 模式自动走 Keyframe-First I2V（不强塞 ref2va 覆盖已审构图）
    const shotWithKf = { index: 2, scene: 'S1', characters: ['林砚'], keyframeRef: 'keyframes/hero.png' };
    const i2vOut = prepareShotRenderInputs({
      book, episode, shot: shotWithKf, bible, cfg: { video: {} }, renderMode: 'auto', useR2VOverride: true,
    });
    assert.strictEqual(i2vOut.preferI2V, true);
    assert.strictEqual(i2vOut.refImagePaths.length, 0);
    assert.ok(i2vOut.keyframePath.endsWith('hero.png'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shouldRelayPrevFrame 在新角色入场、室内外切换或过肩反打时断开尾帧接力', () => {
  const s13 = { index: 13, scene: 'S4', settingType: 'exterior', characters: ['Lao Zhan', 'Liu Er Sa'], render: { qaFrameRels: ['a.png', 'b.png'] } };
  // 同角色同场景允许接力
  assert.strictEqual(shouldRelayPrevFrame(s13, { index: 14, scene: 'S4', settingType: 'exterior', characters: ['Liu Er Sa', 'Lao Zhan'] }), true);
  // 马三新入场 → 必须断开接力防止吞人
  assert.strictEqual(shouldRelayPrevFrame(s13, { index: 14, scene: 'S4', settingType: 'exterior', characters: ['Ma San', 'Liu Er Sa', 'Lao Zhan'] }), false);
  // 过肩反拍 → 必须断开接力防止室内外颠倒
  assert.strictEqual(shouldRelayPrevFrame(s13, { index: 14, scene: 'S4', settingType: 'exterior', characters: ['Lao Zhan', 'Liu Er Sa'], camera: 'over-the-shoulder from inside window' }), false);
  // 室内外切换 → 必须断开接力
  assert.strictEqual(shouldRelayPrevFrame(s13, { index: 14, scene: 'S4', settingType: 'interior', characters: ['Lao Zhan', 'Liu Er Sa'] }), false);
});

test('startLocalComfyUI 拒绝非 loopback 地址且在缺失安装目录时给出明确报错', async () => {
  await assert.rejects(
    () => startLocalComfyUI({ video: { comfyUrl: 'http://192.168.1.9:8188' } }),
    /loopback/
  );
  await assert.rejects(
    () => startLocalComfyUI({ video: { comfyUrl: 'http://127.0.0.1:59998', comfyRoot: 'Z:/nonexistent-comfy' } }),
    /找不到本机 ComfyUI/
  );
});
