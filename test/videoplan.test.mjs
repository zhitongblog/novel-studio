import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractJson, normalizeEpisodes, normalizeShots, matchCharacter, snapFrames,
  revisionOf, staleChapters, parseBibleCharacters, buildEpisodePrompt, buildStoryboardPrompt,
  composeLockedPrompt, composeNativeDialoguePrompt, sanitizeLookPrompt, sanitizeScenePrompt,
  inferVoicePreset, resolveSpeakerVoice, saveBible, loadBible,
} from '../src/videoplan.mjs';

const chapters = Array.from({ length: 10 }, (_, i) => ({ num: i + 1, revision: `r${i + 1}` }));
const opts = { kind: 'episode', targetSeconds: 90, maxEpisodes: 10 };

test('extractJson: fenced / bare / invalid', () => {
  assert.deepStrictEqual(extractJson('说明\n```json\n{"a":1}\n```\n结尾'), { a: 1 });
  assert.deepStrictEqual(extractJson('好的：{"episodes":[{"x":2}]} 以上'), { episodes: [{ x: 2 }] });
  assert.strictEqual(extractJson('no json here'), null);
});

test('normalizeEpisodes: 章号区间 + 内容指纹 + 跳过的章节', () => {
  const { episodes, skippedChapters } = normalizeEpisodes(
    { episodes: [{ fromChapter: 1, toChapter: 3, title: 'A', beats: ['b1'], hook: 'h' }, { fromChapter: 5, toChapter: 6 }] },
    chapters, opts);
  assert.strictEqual(episodes.length, 2);
  assert.deepStrictEqual(
    { index: episodes[0].index, from: episodes[0].fromChapter, to: episodes[0].toChapter, title: episodes[0].title, beats: episodes[0].beats },
    { index: 1, from: 1, to: 3, title: 'A', beats: ['b1'] });
  assert.deepStrictEqual(episodes[0].sourceRevisions, { 1: 'r1', 2: 'r2', 3: 'r3' });
  assert.strictEqual(episodes[1].title, '第2集');
  assert.deepStrictEqual(skippedChapters, [4, 7, 8, 9, 10]);
});

test('normalizeEpisodes: 排序、去重叠、越界与倒序区间', () => {
  const { episodes, warnings } = normalizeEpisodes(
    [{ from: 4, to: 6 }, { from: 0, to: 2 }, { from: 5, to: 5 }, { from: 9, to: 99 }, { from: 8, to: 7 }], chapters, opts);
  assert.deepStrictEqual(episodes.map((e) => [e.fromChapter, e.toChapter]), [[1, 2], [4, 6], [7, 8], [9, 10]]);
  assert.ok(warnings.some((w) => w.includes('重叠')));
});

test('normalizeEpisodes: 部分重叠从上一集之后开始；maxEpisodes 与时长夹紧', () => {
  const a = normalizeEpisodes([{ from: 1, to: 4 }, { from: 3, to: 6 }], chapters, opts);
  assert.strictEqual(a.episodes[1].fromChapter, 5);
  const b = normalizeEpisodes([{ from: 1, to: 1, targetSeconds: 1000 }, { from: 2, to: 2, targetSeconds: 10 }, { from: 3, to: 3 }],
    chapters, { ...opts, maxEpisodes: 2 });
  assert.strictEqual(b.episodes.length, 2);
  assert.strictEqual(b.episodes[0].targetSeconds, 135);
  assert.strictEqual(b.episodes[1].targetSeconds, 45);
});

test('normalizeEpisodes: 垃圾输入只告警不抛错', () => {
  const r = normalizeEpisodes({ nope: true }, chapters, opts);
  assert.strictEqual(r.episodes.length, 0);
  assert.ok(r.warnings.includes('模型未返回有效分集'));
});

test('normalizeShots: 人物匹配、时长夹紧、旁白过长自动加时', () => {
  const characters = [{ name: '林砚' }, { name: '沈知微' }];
  const { shots, totalSeconds } = normalizeShots({
    shots: [
      { chapter: 2, scene: 'S1', characters: ['林砚', '路人甲'], action: '转身', prompt: 'Lin turns', seconds: 2 },
      { chapter: 99, characters: ['沈知微小姐'], prompt: 'Shen walks', seconds: 30,
        narration: '这是一段非常长的旁白需要足够的时间才能读完所以镜头时长必须被自动延长到合适的长度才行' },
      { action: '', prompt: '' },
    ],
  }, { characters, chapterNums: [1, 2, 3], targetSeconds: 30 });
  assert.strictEqual(shots.length, 2);
  assert.deepStrictEqual(shots[0].characters, ['林砚']);
  assert.deepStrictEqual(shots[0].extraCharacters, ['路人甲']);
  assert.strictEqual(shots[0].seconds, 5);
  assert.strictEqual(shots[0].sourceChapter, 2);
  assert.strictEqual(shots[0].speaker, undefined);
  assert.deepStrictEqual(shots[1].characters, ['沈知微']);
  assert.strictEqual(shots[1].seconds, 15);
  assert.strictEqual(shots[1].sourceChapter, 1, '越界章号回落到本集首章');
  assert.strictEqual(shots[1].speaker, 'narrator');
  assert.strictEqual(totalSeconds, 20);
});

test('normalizeShots: 30 字旁白把 5 秒镜头延长到 7 秒；超时长告警', () => {
  const r = normalizeShots([{ prompt: 'x', seconds: 5, narration: '一二三四五六七八九十'.repeat(3) }], { chapterNums: [1] });
  assert.strictEqual(r.shots[0].seconds, 7);
  const many = Array.from({ length: 10 }, () => ({ prompt: 'p', seconds: 10 }));
  assert.match(normalizeShots(many, { chapterNums: [1], targetSeconds: 30 }).warnings[0], /超过目标/);
});

test('matchCharacter 优先精确匹配', () => {
  const cs = [{ name: '林' }, { name: '林砚' }];
  assert.strictEqual(matchCharacter('林砚', cs).name, '林砚');
  assert.strictEqual(matchCharacter('', cs), undefined);
});

test('snapFrames 与 H3 模板 17k+5 网格一致', () => {
  assert.strictEqual(snapFrames(5), 124);
  assert.strictEqual(snapFrames(2), 56);
  assert.strictEqual(snapFrames(3), 73);
  for (const s of [1, 4, 7.3, 10, 15]) assert.strictEqual((snapFrames(s) - 5) % 17, 0);
});

test('revisionOf / staleChapters：原文改动可被发现', () => {
  const a = revisionOf('第一章 正文');
  assert.strictEqual(a, revisionOf('第一章 正文'));
  assert.notStrictEqual(a, revisionOf('第一章 正文（改）'));
  assert.deepStrictEqual(staleChapters({ 1: 'x', 2: 'y', 3: 'z' }, { 1: 'x', 2: 'changed' }), [2, 3]);
});

test('parseBibleCharacters 从设定圣经粗取人物名', () => {
  const bible = '## 基本盘\n- 主角：林砚（落魄书生）\n- 关键配角：沈知微、顾长风；老周\n## 主角\n林砚……\n## 反派阵营\n## 萧景珩\n冷面王爷';
  const names = parseBibleCharacters(bible).map((c) => c.name);
  for (const n of ['林砚', '沈知微', '顾长风', '老周', '萧景珩']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('基本盘'));
});

test('prompt 构造包含关键约束', () => {
  const e = buildEpisodePrompt({ title: '测试书', digestLines: '1 开局', kind: 'episode', targetSeconds: 90, maxEpisodes: 5 });
  assert.match(e.user, /测试书/);
  assert.match(e.user, /最多 5 集/);
  const t = buildEpisodePrompt({ title: 'x', digestLines: '', kind: 'trailer', targetSeconds: 45, maxEpisodes: 1 });
  assert.match(t.user, /预告片/);
  const s = buildStoryboardPrompt({ kind: 'episode', targetSeconds: 60, aspect: '9:16', beats: ['相遇'], cast: '林砚', source: '原文', firstChapter: 3 });
  assert.match(s.user, /一个镜头只拍一个连续动作/);
  assert.match(s.user, /"chapter":3/);
  assert.match(s.user, /1\. 相遇/);
});

test('sanitizeLookPrompt 剥离固定外貌卡中的手持/随身道具，杜绝半身镜多长手穿帮', () => {
  const raw = '24-year-old Chinese man, dark blue tunic, black trousers. His hands are calloused, and he carries a small wooden case with him. His eyes are intense.';
  const clean = sanitizeLookPrompt(raw);
  assert.doesNotMatch(clean, /wooden case|carries/i);
  assert.match(clean, /dark blue tunic/);
  assert.match(clean, /His eyes are intense/);

  const raw2 = '22-year-old Chinese woman, dark green wool coat. She carries a leather notebook and has a sharp gaze.';
  assert.doesNotMatch(sanitizeLookPrompt(raw2), /carries a leather notebook/i);
});

test('sanitizeScenePrompt 消毒直译误导词与门窗混写，并为年代剧补写实防穿帮约束', () => {
  const s = sanitizeScenePrompt(
    'Inside a bone-setting clinic outside the wooden window and doorway.',
    { visualStyle: 'Cinematic 1930s Chinese period drama' }
  );
  assert.doesNotMatch(s, /bone-setting/i);
  assert.match(s, /traditional Chinese herbal medicine clinic/i);
  assert.doesNotMatch(s, /window and doorway/i);
  assert.match(s, /no modern ceiling electric lamps/i);
});

test('composeLockedPrompt 把画风与角色固定外貌注入镜头提示词', () => {
  const bible = {
    visualStyle: 'Cinematic period drama.',
    characters: [
      { name: '林砚', lookPrompt: '25yo Chinese man, dark blue changshan' },
      { name: '沈知微', lookPrompt: '22yo Chinese woman, pale green silk qipao' },
    ],
  };
  const out = composeLockedPrompt(
    { characters: ['林砚', '沈知微'], prompt: 'They walk in the alley.' },
    bible,
    [{ name: '林砚', tag: '<Picture 1>' }]
  );
  assert.match(out, /^Cinematic period drama\./);
  assert.match(out, /\[林砚 \(<Picture 1>\): 25yo Chinese man, dark blue changshan\]/);
  assert.match(out, /\[沈知微: 22yo Chinese woman, pale green silk qipao\]/);
  assert.match(out, /They walk in the alley\./);
  assert.match(out, /no modern ceiling electric lamps/);
});

test('resolveSpeakerVoice 按 speaker 隔离旁白与角色音色，不误用画面首个角色', () => {
  const bible = {
    narratorVoice: 'D:/voices/narrator.wav',
    narratorEdgeVoice: 'zh-CN-YunyangNeural',
    characters: [
      { name: '林砚', voiceRefAudio: 'D:/voices/linyan.wav', edgeVoice: 'zh-CN-YunjianNeural' },
      { name: '沈知微', voiceRefAudio: '', edgeVoice: 'zh-CN-XiaoxiaoNeural' },
    ],
  };
  const cfg = { video: { ttsRefAudio: 'D:/voices/global.wav', edgeVoice: 'zh-CN-YunxiNeural' } };

  const narr = resolveSpeakerVoice({ speaker: 'narrator', characters: ['林砚', '沈知微'] }, bible, cfg);
  assert.strictEqual(narr.speaker, 'narrator');
  assert.strictEqual(narr.refAudio, 'D:/voices/narrator.wav');
  assert.strictEqual(narr.edgeVoice, 'zh-CN-YunyangNeural');

  const heroine = resolveSpeakerVoice({ speaker: '沈知微', characters: ['林砚', '沈知微'] }, bible, cfg);
  assert.strictEqual(heroine.speaker, '沈知微');
  assert.strictEqual(heroine.edgeVoice, 'zh-CN-XiaoxiaoNeural');
  assert.strictEqual(heroine.refAudio, 'D:/voices/narrator.wav');

  const hero = resolveSpeakerVoice({ speaker: '林砚', characters: ['沈知微', '林砚'] }, bible, cfg);
  assert.strictEqual(hero.refAudio, 'D:/voices/linyan.wav');
  assert.strictEqual(hero.edgeVoice, 'zh-CN-YunjianNeural');

  // 无手动音频时，按 voicePreset 自动从 voiceSamples 匹配女声样本
  const samples = [
    { path: 'D:/lib/young_female.wav', preset: 'young_female' },
    { path: 'D:/lib/elder_male.wav', preset: 'elder_male' },
  ];
  const autoFemale = resolveSpeakerVoice(
    { speaker: '沈知微', emotion: '轻声关切', characters: ['沈知微'] },
    { ...bible, characters: [{ name: '沈知微', role: 'Female Lead', lookPrompt: '22-year-old Chinese woman' }] },
    cfg,
    samples
  );
  assert.strictEqual(autoFemale.voicePreset, 'young_female');
  assert.strictEqual(autoFemale.refAudio, 'D:/lib/young_female.wav');
  assert.strictEqual(autoFemale.emotion, '轻声关切');
});

test('inferVoicePreset 与 composeNativeDialoguePrompt 为不同角色生成独立 H3 原生对口型说话指令', () => {
  assert.strictEqual(inferVoicePreset({ name: 'Xu Wan', role: 'Female Lead', lookPrompt: '22-year-old Chinese woman' }), 'young_female');
  assert.strictEqual(inferVoicePreset({ name: 'Lao Liu Tou', role: 'Supporting', lookPrompt: '60-year-old Chinese man' }), 'elder_male');
  assert.strictEqual(inferVoicePreset({ name: 'Liu Er Sa', role: 'Antagonist', lookPrompt: '35-year-old scarred man, broken nose' }), 'rough_male');
  assert.strictEqual(inferVoicePreset({ name: 'Ma San', role: 'Antagonist', lookPrompt: '30-year-old lean pale sinister uniform' }), 'cold_male');

  const bible = {
    characters: [
      { name: '徐晚', role: '女主', lookPrompt: '22-year-old woman', voiceDesc: 'clear, gentle young Chinese female voice' },
    ],
  };
  const nativePrompt = composeNativeDialoguePrompt(
    { speaker: '徐晚', narration: '早利索了，懒得拆。', emotion: '倔强温和' },
    bible,
    'Xu Wan stands outside the window.'
  );
  assert.match(nativePrompt, /Mandarin Chinese with realistic lip-sync/);
  assert.match(nativePrompt, /clear, gentle young Chinese female voice/);
  assert.match(nativePrompt, /倔强温和/);
  assert.match(nativePrompt, /早利索了，懒得拆。/);

  // 旁白不注入人物对口型指令
  const narrPrompt = composeNativeDialoguePrompt(
    { speaker: 'narrator', narration: '子夜北风呼啸。' },
    bible,
    'Alley at night.'
  );
  assert.strictEqual(narrPrompt, 'Alley at night.');
});

test('saveBible / loadBible 保留旁白音色与角色 edgeVoice/voiceRefAudio', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-bible-'));
  try {
    const book = { dir: tmp };
    saveBible(book, {
      visualStyle: 'Period drama',
      narratorVoice: 'D:/v/narr.wav',
      narratorEdgeVoice: 'zh-CN-YunyangNeural',
      characters: [{ name: '林砚', lookPrompt: 'tall', voiceRefAudio: 'D:/v/lin.wav', edgeVoice: 'zh-CN-YunjianNeural' }],
    });
    const loaded = loadBible(book);
    assert.strictEqual(loaded.narratorVoice, 'D:/v/narr.wav');
    assert.strictEqual(loaded.narratorEdgeVoice, 'zh-CN-YunyangNeural');
    assert.strictEqual(loaded.characters[0].voiceRefAudio, 'D:/v/lin.wav');
    assert.strictEqual(loaded.characters[0].edgeVoice, 'zh-CN-YunjianNeural');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
