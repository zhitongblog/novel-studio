import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatAssTime, formatSrtTime, wrapCaption, buildEpisodeSubtitles, exportJianyingDraft } from '../src/videopost.mjs';

test('formatAssTime and formatSrtTime format timestamps accurately', () => {
  assert.equal(formatAssTime(0), '0:00:00.00');
  assert.equal(formatAssTime(65.5), '0:01:05.50');
  assert.equal(formatAssTime(59.996), '0:01:00.00');
  assert.equal(formatSrtTime(65.5), '00:01:05,500');
  assert.equal(formatSrtTime(59.9999), '00:01:00,000');
});

test('wrapCaption breaks long Chinese narration into readable lines', () => {
  const out = wrapCaption('黑夜里，他推开那扇尘封已久的铁门，看见了满屋子的火光。', 12);
  assert.ok(out.includes('\n'));
  for (const line of out.split('\n')) {
    assert.ok(line.length <= 16);
  }
});

test('buildEpisodeSubtitles generates valid ASS and SRT from shots', () => {
  const res = buildEpisodeSubtitles([
    { actualSeconds: 5, narration: '第一镜旁白。' },
    { actualSeconds: 6, narration: '' },
    { actualSeconds: 7, narration: '第三镜台词，冲突爆发！' },
  ], { width: 540, height: 960 });

  assert.equal(res.count, 2);
  assert.equal(res.totalSeconds, 18);
  assert.match(res.ass, /PlayResX: 540/);
  assert.match(res.ass, /Dialogue: 0,0:00:00\.08,0:00:04\.92/);
  assert.match(res.ass, /Dialogue: 0,0:00:11\.08,0:00:17\.92/);
  assert.match(res.srt, /1\n00:00:00,080 --> 00:00:04,920/);
});

test('exportJianyingDraft writes draft_content.json, draft_meta_info.json, and subtitles.srt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-draft-'));
  try {
    const v1 = path.join(tmp, 'src1.mp4');
    const a1 = path.join(tmp, 'src1.wav');
    fs.writeFileSync(v1, 'fake-mp4');
    fs.writeFileSync(a1, 'fake-wav');
    const outDir = path.join(tmp, 'draft');
    const r = exportJianyingDraft({
      outDir,
      title: '测试短剧',
      width: 540,
      height: 960,
      clips: [{ videoPath: v1, audioPath: a1, durationSec: 5, narration: '开场旁白' }],
    });
    assert.equal(r.clipCount, 1);
    assert.equal(r.durationSec, 5);
    assert.ok(fs.existsSync(path.join(outDir, 'draft_content.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'draft_meta_info.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'subtitles.srt')));
    assert.ok(fs.existsSync(path.join(outDir, 'media', 'shot_001.mp4')));
    assert.ok(fs.existsSync(path.join(outDir, 'media', 'tts_001.wav')));
    const dc = JSON.parse(fs.readFileSync(path.join(outDir, 'draft_content.json'), 'utf8'));
    assert.equal(dc.tracks.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
