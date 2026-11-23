import assert from 'node:assert/strict';
import test from 'node:test';
import { auditShotPromptRealism, pickVisionProvider } from '../src/videoqa.mjs';

test('auditShotPromptRealism 精准抓出《灯下记》实拍中出现的高频现实穿帮隐患', () => {
  const bible = {
    visualStyle: 'Cinematic 1930s Chinese period drama, moody lighting',
    characters: [
      { name: 'Chen Yan', lookPrompt: '24yo man, dark blue tunic, carries a small wooden case with him.' },
    ],
  };

  // 1. bone-setting 直译误导词 + 多动作过载 + 隔纸啃食
  const badShot = {
    index: 10,
    scene: 'S1',
    seconds: 6,
    characters: ['Chen Yan'],
    action: '啃糖火烧并惊醒转身',
    prompt: 'Inside a dim bone-setting clinic, Chen Yan unwraps the oil-paper parcel and takes a bite, chews, swallows, and turns sharply toward the door under a ceiling lamp.',
  };
  const r = auditShotPromptRealism(badShot, bible);
  assert.equal(r.ok, false);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('LITERAL_MISLEADING_TERM'), '应抓出 bone-setting');
  assert.ok(codes.includes('OVERLOADED_ACTIONS'), '应抓出多动作过载');
  assert.ok(codes.includes('EATING_WRAPPED_FOOD'), '应抓出未拆包装啃食风险');
  assert.ok(codes.includes('PERIOD_ANACHRONISM'), '应抓出 ceiling lamp 现代吊灯');
  assert.ok(codes.includes('HELD_PROP_IN_LOOK'), '应抓出外貌卡残留木箱');

  // 2. window and doorway 混写
  const s9 = {
    index: 9,
    scene: 'S3',
    seconds: 6,
    characters: ['Chen Yan'],
    prompt: 'Outside the wooden window and doorway of the clinic, Chen Yan waves calmly.',
  };
  const r9 = auditShotPromptRealism(s9, { visualStyle: '' });
  assert.equal(r9.ok, false);
  assert.ok(r9.issues.some((i) => i.code === 'MIXED_WINDOW_DOORWAY'));

  // 3. 干净写实的分镜应通过
  const cleanShot = {
    index: 8,
    scene: 'S3',
    seconds: 6,
    characters: ['Lao Liu Tou'],
    keyframeRef: 'keyframes/s8.png',
    action: '老刘头微笑开口',
    prompt: 'Medium shot in a dark brick hutong at midnight. Lao Liu Tou sits calmly on a wooden stool beside his steaming soup stand and chuckles warmly.',
  };
  const rClean = auditShotPromptRealism(cleanShot, { visualStyle: 'Cinematic 1930s Chinese period drama', characters: [] });
  assert.equal(rClean.ok, true);
  assert.equal(rClean.score, 100);
});

test('pickVisionProvider 按配置顺序选择多模态视觉模型', () => {
  assert.equal(pickVisionProvider({}), null);
  assert.equal(pickVisionProvider({ api: { dashscope: { apiKey: 'sk-1' } } }).provider, 'dashscope');
  assert.equal(pickVisionProvider({ api: { zhipu: { apiKey: 'z.1' } } }).provider, 'zhipu');
  assert.equal(pickVisionProvider({ api: { local: { visionModel: 'qwen2.5vl:7b' } } }).model, 'qwen2.5vl:7b');
});
