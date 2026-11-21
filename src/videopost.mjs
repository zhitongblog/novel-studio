// 改编视频后期处理：短剧 ASS/SRT 字幕生成、时间轴切行、剪映草稿 (CapCut/Jianying Draft) 导出。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function pad2(n) { return String(Math.floor(n)).padStart(2, '0'); }

/** 秒数转 ASS 时间戳 (H:MM:SS.cs)，避免 .996 舍入进位倒退。 */
export function formatAssTime(sec) {
  const totalCs = Math.round(Math.max(0, Number(sec) || 0) * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

/** 秒数转 SRT 时间戳 (HH:MM:SS,mmm)，避免 .9999 舍入进位倒退。 */
export function formatSrtTime(sec) {
  const totalMs = Math.round(Math.max(0, Number(sec) || 0) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`;
}

/** 将一段中文台词按短剧可读宽度切分并插入换行符，避免单行溢出竖屏画幅。 */
export function wrapCaption(text, maxChars = 14) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  // 优先按标点切分成多句，再按字数折行
  const parts = clean.split(/(?<=[，。！？；：、,.!?;])/).map((s) => s.trim()).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length <= maxChars) {
      cur += p;
    } else {
      if (cur) lines.push(cur);
      if (p.length <= maxChars) {
        cur = p;
      } else {
        for (let i = 0; i < p.length; i += maxChars) {
          const chunk = p.slice(i, i + maxChars);
          if (i + maxChars >= p.length) cur = chunk;
          else lines.push(chunk);
        }
      }
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

/**
 * 根据分镜列表（含实际时长 durationSec 或预估 seconds 与 narration）生成 ASS 与 SRT 字幕文本。
 * @param {Array<{narration?:string, seconds?:number, actualSeconds?:number}>} shots
 * @param {{width?:number, height?:number}} dims
 */
export function buildEpisodeSubtitles(shots, { width = 540, height = 960 } = {}) {
  const maxChars = width >= height ? 24 : 14;
  const fontSize = Math.max(22, Math.round(Math.min(width, height) * 0.056));
  const marginV = Math.round(height * 0.12);

  const assHeader = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Drama,Microsoft YaHei,${fontSize},&H00FFFFFF,&H0000FFFF,&H00121212,&H80000000,-1,0,0,0,100,100,1,0,1,3,1,2,28,28,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const assEvents = [];
  const srtBlocks = [];
  let cursor = 0;
  let srtIdx = 1;

  for (const shot of shots || []) {
    const dur = Math.max(0.5, Number(shot.actualSeconds || shot.seconds || 5));
    const text = String(shot.narration || '').trim();
    const start = cursor + 0.08;
    const end = Math.max(start + 0.3, cursor + dur - 0.08);
    if (text) {
      const wrapped = wrapCaption(text, maxChars);
      assEvents.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Drama,,0,0,0,,${wrapped.replace(/\n/g, '\\N')}`);
      srtBlocks.push(`${srtIdx++}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${wrapped}\n`);
    }
    cursor += dur;
  }

  return {
    ass: [...assHeader, ...assEvents, ''].join('\n'),
    srt: srtBlocks.join('\n'),
    totalSeconds: cursor,
    count: assEvents.length,
  };
}

function uuid() {
  return crypto.randomUUID().toUpperCase();
}

/**
 * 导出剪映草稿工程目录（含 draft_content.json、draft_meta_info.json、媒体文件与字幕）。
 * @param {{outDir:string, title:string, width:number, height:number, clips:Array<{videoPath:string, audioPath?:string, durationSec:number, narration?:string}>}} opts
 */
export function exportJianyingDraft({ outDir, title, width = 540, height = 960, clips = [] }) {
  fs.mkdirSync(outDir, { recursive: true });
  const mediaDir = path.join(outDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const videos = [];
  const audios = [];
  const videoSegments = [];
  const audioSegments = [];
  const texts = [];
  const textSegments = [];

  let cursorUs = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const durUs = Math.max(500000, Math.round((Number(c.durationSec) || 5) * 1_000_000));
    const vExt = path.extname(c.videoPath || '.mp4') || '.mp4';
    const vName = `shot_${String(i + 1).padStart(3, '0')}${vExt}`;
    const vDest = path.join(mediaDir, vName);
    if (c.videoPath && fs.existsSync(c.videoPath)) fs.copyFileSync(c.videoPath, vDest);

    const vMatId = uuid();
    videos.push({
      id: vMatId,
      path: `media/${vName}`,
      material_name: vName,
      type: 'video',
      duration: durUs,
      width,
      height,
    });
    videoSegments.push({
      id: uuid(),
      material_id: vMatId,
      source_timerange: { start: 0, duration: durUs },
      target_timerange: { start: cursorUs, duration: durUs },
      speed: 1.0,
      volume: 1.0,
    });

    if (c.audioPath && fs.existsSync(c.audioPath)) {
      const aExt = path.extname(c.audioPath) || '.wav';
      const aName = `tts_${String(i + 1).padStart(3, '0')}${aExt}`;
      fs.copyFileSync(c.audioPath, path.join(mediaDir, aName));
      const aMatId = uuid();
      audios.push({
        id: aMatId,
        path: `media/${aName}`,
        name: aName,
        type: 'extract_music',
        duration: durUs,
      });
      audioSegments.push({
        id: uuid(),
        material_id: aMatId,
        source_timerange: { start: 0, duration: durUs },
        target_timerange: { start: cursorUs, duration: durUs },
        volume: 1.0,
      });
    }

    if (c.narration && String(c.narration).trim()) {
      const tMatId = uuid();
      texts.push({
        id: tMatId,
        type: 'subtitle',
        content: wrapCaption(c.narration, width >= height ? 24 : 14),
        font_size: 8.0,
        text_color: '#FFFFFF',
      });
      textSegments.push({
        id: uuid(),
        material_id: tMatId,
        target_timerange: { start: cursorUs, duration: durUs },
      });
    }
    cursorUs += durUs;
  }

  const draftContent = {
    id: uuid(),
    name: title || 'StoryAlter 短剧',
    version: 360000,
    fps: 24,
    duration: cursorUs,
    canvas_config: { width, height, ratio: width >= height ? '16:9' : '9:16' },
    materials: { videos, audios, texts },
    tracks: [
      { id: uuid(), type: 'video', flag: 0, segments: videoSegments },
      ...(audioSegments.length ? [{ id: uuid(), type: 'audio', flag: 0, segments: audioSegments }] : []),
      ...(textSegments.length ? [{ id: uuid(), type: 'text', flag: 0, segments: textSegments }] : []),
    ],
  };

  const draftMeta = {
    draft_id: draftContent.id,
    draft_name: draftContent.name,
    draft_fold_path: outDir,
    tm_duration: cursorUs,
    tm_draft_create: Date.now() * 1000,
    tm_draft_modified: Date.now() * 1000,
  };

  fs.writeFileSync(path.join(outDir, 'draft_content.json'), JSON.stringify(draftContent, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'draft_meta_info.json'), JSON.stringify(draftMeta, null, 2), 'utf8');

  const subs = buildEpisodeSubtitles(
    clips.map((c) => ({ actualSeconds: c.durationSec, narration: c.narration })),
    { width, height }
  );
  fs.writeFileSync(path.join(outDir, 'subtitles.srt'), subs.srt, 'utf8');

  return {
    outDir,
    draftContentFile: path.join(outDir, 'draft_content.json'),
    clipCount: clips.length,
    durationSec: Math.round(cursorUs / 1_000_000),
  };
}
