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

/** 将单个超长中文短句按均衡字数折行，避免 14+2 劈词留孤尾。 */
function balanceSplitSegment(seg, maxChars) {
  if (seg.length <= maxChars) return [seg];
  const lineCount = Math.ceil(seg.length / maxChars);
  const ideal = Math.ceil(seg.length / lineCount);
  const out = [];
  let pos = 0;
  for (let l = 0; l < lineCount; l++) {
    const rem = seg.length - pos;
    if (l === lineCount - 1 || rem <= maxChars) {
      out.push(seg.slice(pos));
      break;
    }
    const linesLeft = lineCount - l;
    let cut = pos + Math.ceil(rem / linesLeft);
    // 尽量在常见虚词/连接字之后断开（的、了、着、在、向、与、和、却、便、就、把、被），减少把实词劈开
    const lo = Math.max(pos + 3, cut - 3);
    const hi = Math.min(pos + maxChars, cut + 2);
    for (let k = cut; k >= lo; k--) {
      if (/[的了着在上里中前后与和却便就把被是]/.test(seg[k - 1])) { cut = k; break; }
    }
    if (cut > hi) cut = Math.min(pos + maxChars, pos + ideal);
    out.push(seg.slice(pos, cut));
    pos = cut;
  }
  return out.filter(Boolean);
}

/** 将一段中文台词按短剧可读宽度切分并插入换行符，均衡换行且避免劈词留 1–2 字孤尾。 */
export function wrapCaption(text, maxChars = 13) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  // 优先按标点切分成短句，再尽量合并短句、对超长短句做均衡折行
  const parts = clean.split(/(?<=[，。！？；：、,.!?;])/).map((s) => s.trim()).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const p of parts) {
    if (!cur && p.length <= maxChars) {
      cur = p;
    } else if (cur && (cur + p).length <= maxChars) {
      cur += p;
    } else {
      if (cur) { lines.push(cur); cur = ''; }
      if (p.length <= maxChars) {
        cur = p;
      } else {
        const balanced = balanceSplitSegment(p, maxChars);
        for (let i = 0; i < balanced.length - 1; i++) lines.push(balanced[i]);
        cur = balanced[balanced.length - 1] || '';
      }
    }
  }
  if (cur) lines.push(cur);
  // 若最后一行过短（<=2 汉字且不含独立短句）且与上一行合并后超幅不大，或可从上一行借 2 字平衡
  if (lines.length >= 2) {
    const last = lines[lines.length - 1];
    const prev = lines[lines.length - 2];
    const lastBare = last.replace(/[，。！？；：、,.!?;…]/g, '');
    if (lastBare.length > 0 && lastBare.length <= 2 && !/[，。！？；：]/.test(prev.slice(-1))) {
      const merged = prev + last;
      if (merged.length <= maxChars + 1) {
        lines.splice(lines.length - 2, 2, merged);
      } else {
        const re = balanceSplitSegment(merged, maxChars);
        lines.splice(lines.length - 2, 2, ...re);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 将长台词按中文标点与字数占比拆成多条连续字幕（每条严格控制在 1–2 行，避免 3 行大字压画面）。
 */
export function splitSubtitleCues(text, startSec, endSec, maxCharsPerCue = 18) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const totalDur = Math.max(0.3, endSec - startSec);
  const segs = clean.split(/(?<=[，。！？；：,.!?;])/).map((s) => s.trim()).filter(Boolean);
  if (clean.length <= maxCharsPerCue || segs.length <= 1) {
    return [{ start: startSec, end: endSec, text: clean }];
  }
  const chunks = [];
  let cur = '';
  for (const seg of segs) {
    if (cur && (cur + seg).length > maxCharsPerCue) {
      chunks.push(cur);
      cur = seg;
    } else {
      cur += seg;
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length <= 1) return [{ start: startSec, end: endSec, text: clean }];
  const weights = chunks.map((c) => Math.max(1, c.replace(/[，。！？；：、,.!?;…\s]/g, '').length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const cues = [];
  let t = startSec;
  chunks.forEach((chunk, i) => {
    const isLast = i === chunks.length - 1;
    const dur = isLast ? Math.max(0.3, endSec - t) : Math.max(0.4, (totalDur * weights[i]) / totalWeight);
    const nextT = isLast ? endSec : Math.min(endSec - 0.1, t + dur);
    cues.push({ start: t, end: nextT, text: chunk });
    t = nextT;
  });
  return cues;
}

/**
 * 根据分镜列表（含实际时长 actualSeconds / 预估 seconds、可选 ttsDurationSec 与 narration）生成 ASS 与 SRT 字幕文本。
 * @param {Array<{narration?:string, seconds?:number, actualSeconds?:number, ttsDurationSec?:number}>} shots
 * @param {{width?:number, height?:number}} dims
 */
export function buildEpisodeSubtitles(shots, { width = 416, height = 736 } = {}) {
  const isWide = width >= height;
  const maxChars = isWide ? 22 : 12;
  const maxCharsPerCue = isWide ? 34 : 18;
  const fontSize = Math.max(20, Math.round(Math.min(width, height) * 0.044));
  const marginV = Math.round(height * 0.11);

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
    `Style: Drama,Microsoft YaHei,${fontSize},&H00FFFFFF,&H0000FFFF,&H00101018,&H90000000,-1,0,0,0,100,100,0.5,0,1,2.2,0.8,2,24,24,${marginV},1`,
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
    const ttsDur = Number(shot.ttsDurationSec) || 0;
    // 若有实际配音时长且比镜头短，字幕随配音结束（留 0.25s 缓冲），不干挂屏幕
    const rawEnd = ttsDur > 0 ? Math.min(cursor + dur - 0.08, start + ttsDur + 0.25) : (cursor + dur - 0.08);
    const end = Math.max(start + 0.3, rawEnd);
    if (text) {
      const cues = splitSubtitleCues(text, start, end, maxCharsPerCue);
      for (const cue of cues) {
        const wrapped = wrapCaption(cue.text, maxChars).replace(/[，。！？；：、,.!?;]$/g, (m) => (m === '？' || m === '！' ? m : ''));
        assEvents.push(`Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},Drama,,0,0,0,,${wrapped.replace(/\n/g, '\\N')}`);
        srtBlocks.push(`${srtIdx++}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${wrapped}\n`);
      }
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
