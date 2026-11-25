"""
StoryAlter 影院级三段式暗黑悬疑配乐与戏剧卡点音效生成器 (48kHz Stereo, NumPy + SciPy)。
用法: python gen_noir_score.py <timeline.json> <out.wav>
"""
import json, math, os, sys
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile

SR = 48000


def lowpass(x, cutoff, order=3):
    sos = butter(order, min(cutoff, SR * 0.45) / (SR * 0.5), btype='low', output='sos')
    return sosfilt(sos, x, axis=0)


def highpass(x, cutoff, order=2):
    sos = butter(order, max(20.0, cutoff) / (SR * 0.5), btype='high', output='sos')
    return sosfilt(sos, x, axis=0)


def bandpass(x, lo, hi, order=2):
    sos = butter(order, [max(20.0, lo) / (SR * 0.5), min(hi, SR * 0.45) / (SR * 0.5)], btype='band', output='sos')
    return sosfilt(sos, x, axis=0)


def schroeder_reverb(stereo, wet=0.35, decay=0.62):
    """Lush dark concert-hall stereo reverb using parallel comb + series allpass filters."""
    out = np.zeros_like(stereo)
    comb_delays_l = [int(SR * d) for d in (0.0297, 0.0371, 0.0411, 0.0437, 0.0531)]
    comb_delays_r = [int(SR * d) for d in (0.0313, 0.0389, 0.0423, 0.0459, 0.0557)]
    for ch, delays in enumerate((comb_delays_l, comb_delays_r)):
        sig = stereo[:, ch]
        acc = np.zeros_like(sig)
        for d in delays:
            buf = sig.copy()
            # 6-tap exponentially decaying feedback approximation (vectorized, fast & clean)
            g = decay
            for k in range(1, 8):
                shift = d * k
                if shift >= len(sig):
                    break
                tap = np.zeros_like(sig)
                tap[shift:] = sig[:-shift] * (g ** k)
                buf += tap
            acc += buf / len(delays)
        # Warm dark hall damping
        acc = lowpass(acc, 3600.0, order=2)
        out[:, ch] = stereo[:, ch] * (1.0 - wet) + acc * wet
    return out


def bowed_cello_chord(dur_sec, freqs, amp=0.18, vibrato_hz=4.8, rng=None):
    """Rich bowed low string ensemble with subtle detuning, bow harmonics, and warm breathing."""
    n = int(dur_sec * SR)
    if n <= 0:
        return np.zeros((0, 2), dtype=np.float64)
    t = np.arange(n, dtype=np.float64) / SR
    rng = rng or np.random.default_rng(42)
    L = np.zeros(n, dtype=np.float64)
    R = np.zeros(n, dtype=np.float64)
    # Slow organic swell envelope
    env = np.ones(n, dtype=np.float64)
    fade_in = min(n // 3, int(SR * 1.4))
    fade_out = min(n // 3, int(SR * 1.2))
    if fade_in > 0:
        env[:fade_in] = np.sin(np.linspace(0, np.pi / 2, fade_in)) ** 2
    if fade_out > 0:
        env[-fade_out:] = np.cos(np.linspace(0, np.pi / 2, fade_out)) ** 2
    breath = 0.85 + 0.15 * np.sin(2 * np.pi * 0.22 * t + 0.4)

    for f0 in freqs:
        for detune, pan in ((-0.0028, 0.35), (0.0, 0.5), (0.0031, 0.65)):
            f = f0 * (1.0 + detune)
            vib = 1.0 + 0.0035 * np.sin(2 * np.pi * (vibrato_hz + detune * 40) * t)
            phase = 2 * np.pi * np.cumsum(f * vib) / SR
            # Bowed string harmonic spectrum (saw-like rolled off)
            voice = (
                1.00 * np.sin(phase)
                + 0.48 * np.sin(2 * phase + 0.2)
                + 0.22 * np.sin(3 * phase + 0.5)
                + 0.11 * np.sin(4 * phase + 0.9)
                + 0.05 * np.sin(5 * phase + 1.2)
            )
            L += voice * (1.0 - pan)
            R += voice * pan
    # Subtle rosin bow air texture
    bow_air = bandpass(rng.standard_normal((n, 2)), 700, 2200, order=2) * 0.015
    st = np.stack([L, R], axis=1) / max(1, len(freqs) * 3)
    st = lowpass(st, 560.0, order=2) + bow_air * 0.35
    return st * (env * breath)[:, None] * amp


def guqin_pluck(freq, dur_sec=3.2, amp=0.22, brightness=0.45, rng=None):
    """Karplus-Strong physical-modeled dark Chinese guqin / felt-string pluck."""
    n = int(dur_sec * SR)
    period = max(8, int(round(SR / freq)))
    rng = rng or np.random.default_rng(7)
    # Soft warm excitation (silk string pluck, filtered noise + fundamental body)
    exc = rng.standard_normal(period)
    exc = lowpass(exc, min(2600.0, freq * 8.0), order=2)
    exc = exc / (np.max(np.abs(exc)) + 1e-9)
    y = np.zeros(n, dtype=np.float64)
    y[:period] = exc
    decay = 0.9968
    b = 0.5 + 0.42 * (1.0 - brightness)
    for i in range(period, n):
        y[i] = decay * (b * y[i - period] + (1.0 - b) * y[i - period - 1])
    # Woody guqin soundboard resonance
    body = bandpass(y, 140, 520, order=2) * 0.45
    y = y * 0.72 + body
    t = np.arange(n, dtype=np.float64) / SR
    # Smooth micro-attack (no harsh click) + natural decay tail
    att = np.minimum(1.0, t / 0.012)
    rel = np.exp(-t / (dur_sec * 0.48))
    return y * att * rel * amp


def sub_boom(dur_sec=2.6, f_start=92.0, f_end=34.0, amp=0.65, metallic=False, rng=None):
    """Theatrical noir sub-bass impact / cliffhanger gong-braam."""
    n = int(dur_sec * SR)
    t = np.arange(n, dtype=np.float64) / SR
    rng = rng or np.random.default_rng(99)
    freq = f_end + (f_start - f_end) * np.exp(-t * 9.5)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    sub = np.sin(phase) * np.exp(-t * 1.45)
    punch = np.sin(2 * np.pi * (140 * np.exp(-t * 28.0) + 42) * t) * np.exp(-t * 18.0) * 0.7
    sig = np.tanh((sub + punch) * 1.6) * 0.75
    L = sig.copy()
    R = sig.copy()
    if metallic:
        # Dark bronze Chinese gong shimmer (inharmonic partials)
        partials = [146.8, 220.0, 297.5, 415.3, 558.0, 742.0, 1085.0]
        for idx, pf in enumerate(partials):
            p_env = np.exp(-t * (0.9 + idx * 0.35)) * (0.14 / (1 + idx * 0.45))
            w = np.sin(2 * np.pi * pf * t + idx * 1.3) * p_env
            L += w * (0.6 if idx % 2 == 0 else 0.4)
            R += w * (0.4 if idx % 2 == 0 else 0.6)
        noise_burst = bandpass(rng.standard_normal((n, 2)), 300, 2600, order=2) * np.exp(-t * 8.0)[:, None] * 0.22
        L += noise_burst[:, 0]
        R += noise_burst[:, 1]
    att = np.minimum(1.0, t / 0.008)
    return np.stack([L * att, R * att], axis=1) * amp


def heartbeat_pulse(amp=0.38):
    """Realistic tense low-frequency lub-dub heartbeat."""
    dur = 0.65
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    lub = np.sin(2 * np.pi * (62 * np.exp(-t * 14) + 34) * t) * np.exp(-t * 16.0)
    t2 = np.maximum(0.0, t - 0.19)
    dub_mask = (t >= 0.19).astype(np.float64)
    dub = np.sin(2 * np.pi * (54 * np.exp(-t2 * 16) + 30) * t2) * np.exp(-t2 * 20.0) * dub_mask * 0.72
    s = lowpass(lub + dub, 160.0, order=2) * amp
    return np.stack([s, s], axis=1)


def frame_drum_hit(amp=0.30, pitch=74.0, rng=None):
    """Muted dark cinema taiko / frame-drum tension hit."""
    dur = 0.42
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    rng = rng or np.random.default_rng(11)
    f = pitch * 0.62 + pitch * 0.85 * np.exp(-t * 24.0)
    skin = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9.0)
    thump = bandpass(rng.standard_normal(n), 90, 620, order=2) * np.exp(-t * 32.0) * 0.55
    s = np.tanh((skin + thump) * 1.4) * amp
    return np.stack([s, s], axis=1)


def wood_impact_thud(amp=0.42, rng=None):
    """Dull distant wooden club / body impact foley."""
    dur = 0.28
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    rng = rng or np.random.default_rng(23)
    body = np.sin(2 * np.pi * (135 * np.exp(-t * 22) + 58) * t) * np.exp(-t * 17.0)
    crack = bandpass(rng.standard_normal(n), 180, 1200, order=2) * np.exp(-t * 42.0) * 0.75
    s = lowpass(body + crack, 950.0, order=2) * amp
    return np.stack([s * 0.9, s * 1.0], axis=1)


def tension_riser(dur_sec=3.8, amp=0.22, rng=None):
    """Cinematic dark breathy string/air swell rising into cliffhanger cut."""
    n = int(dur_sec * SR)
    t = np.arange(n, dtype=np.float64) / SR
    rng = rng or np.random.default_rng(31)
    prog = t / max(0.01, dur_sec)
    # Rising dissonant minor-second string tension (D3 -> Eb3 + A3 -> Bb3)
    f1 = 146.83 + 12.0 * (prog ** 2)
    f2 = 220.00 + 22.0 * (prog ** 2)
    s1 = np.sin(2 * np.pi * np.cumsum(f1) / SR) + 0.35 * np.sin(2 * np.pi * np.cumsum(f2) / SR)
    air = bandpass(rng.standard_normal((n, 2)), 280, 1800, order=2) * (prog ** 2.2)[:, None] * 0.45
    env = (prog ** 2.0) * np.minimum(1.0, (dur_sec - t) / 0.04)
    st = np.stack([s1, s1], axis=1) * 0.5 + air
    return lowpass(st, 2200.0, order=2) * env[:, None] * amp


def add_at(mix, clip, sec):
    start = int(round(sec * SR))
    if start >= len(mix) or start + len(clip) <= 0:
        return
    src_s = max(0, -start)
    dst_s = max(0, start)
    cnt = min(len(clip) - src_s, len(mix) - dst_s)
    if cnt > 0:
        mix[dst_s:dst_s + cnt] += clip[src_s:src_s + cnt]


def load_wav_mono_48k(path):
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        x = data.astype(np.float64) / 32768.0
    elif data.dtype == np.int32:
        x = data.astype(np.float64) / 2147483648.0
    else:
        x = data.astype(np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    if sr != SR:
        n_new = int(round(len(x) * SR / sr))
        x = np.interp(np.linspace(0, len(x) - 1, n_new), np.arange(len(x)), x)
    return x


def main():
    meta_path, out_wav = sys.argv[1], sys.argv[2]
    with open(meta_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)

    total_sec = float(cfg.get('totalSeconds', 72.0))
    style = cfg.get('audioStyle', 'donghua_noir')
    shots = cfg.get('shots', [])
    distant_scream = cfg.get('distantScreamWav', '')
    n_total = int(math.ceil(total_sec * SR))
    rng = np.random.default_rng(2026)

    score = np.zeros((n_total, 2), dtype=np.float64)
    sfx = np.zeros((n_total, 2), dtype=np.float64)
    amb = np.zeros((n_total, 2), dtype=np.float64)

    # 1. 自动识别三段式叙事节点（铺垫段 / 惊变转折镜 / 结尾悬念镜）
    turn_shot = None
    for s in shots:
        txt = f"{s.get('action', '')} {s.get('emotion', '')} {s.get('narration', '')}"
        if any(k in txt for k in ('惨叫', '打斗', '惊觉', '浑身一顿', '骤冷', 'scream', 'shriek')):
            turn_shot = s
            break
    if not turn_shot and len(shots) >= 4:
        turn_shot = shots[int(len(shots) * 0.6)]
    turn_sec = float(turn_shot.get('startSec', total_sec * 0.58)) if turn_shot else total_sec * 0.58

    last_shot = shots[-1] if shots else {'startSec': max(0.0, total_sec - 4.0), 'durationSec': 4.0, 'leadInSec': 1.2}
    last_start = float(last_shot.get('startSec', max(0.0, total_sec - 4.0)))
    cliff_line_sec = last_start + float(last_shot.get('leadInSec', 1.15))
    drop_cut_sec = max(turn_sec + 2.0, cliff_line_sec - 0.35)

    # 2. 场景自适应雪夜北风与室内温暖底噪（按每镜 settingType 动态过渡）
    raw_wind_l = bandpass(rng.standard_normal(n_total), 140, 680, order=2)
    raw_wind_r = bandpass(rng.standard_normal(n_total), 155, 720, order=2)
    t_all = np.arange(n_total, dtype=np.float64) / SR
    gust = 0.55 + 0.45 * np.sin(2 * np.pi * 0.14 * t_all + 0.8) * np.cos(2 * np.pi * 0.05 * t_all)
    wind_gain = np.full(n_total, 0.045, dtype=np.float64)
    for s in shots:
        s0 = max(0, int(float(s.get('startSec', 0)) * SR))
        s1 = min(n_total, int((float(s.get('startSec', 0)) + float(s.get('durationSec', 5))) * SR))
        is_ext = str(s.get('settingType', '')).lower() == 'exterior'
        wind_gain[s0:s1] = 0.058 if is_ext else 0.022
    # Smooth gain transitions over 0.3s
    wind_gain = lowpass(wind_gain, 3.5, order=2)
    amb[:, 0] = raw_wind_l * gust * wind_gain
    amb[:, 1] = raw_wind_r * gust * wind_gain

    # 3. 第一幕：寒夜悬疑铺底（深沉大提琴低音长音 + 稀疏暗黑古琴/弱音琴拨弦）
    act1_dur = max(4.0, turn_sec + 1.2)
    cello_1 = bowed_cello_chord(act1_dur, [73.42, 110.0, 146.83], amp=0.22 if style == 'donghua_noir' else 0.18, rng=rng)
    add_at(score, cello_1, 0.0)

    # Opening subtle cinematic low sub hit
    add_at(sfx, sub_boom(2.0, f_start=72.0, f_end=36.0, amp=0.38, metallic=False, rng=rng), 0.05)

    # Sparse haunting D-minor guqin plucks during Act 1
    scale_notes = [146.83, 174.61, 220.00, 233.08, 220.00, 174.61, 130.81, 146.83, 293.66, 220.00]
    pluck_t = 1.6
    p_idx = 0
    step_sec = 3.2 if style == 'donghua_noir' else 2.4
    while pluck_t < turn_sec - 0.8:
        note_f = scale_notes[p_idx % len(scale_notes)]
        p = guqin_pluck(note_f, dur_sec=3.0, amp=0.17, brightness=0.38, rng=rng)
        pan = 0.35 if p_idx % 2 == 0 else 0.65
        add_at(score, np.stack([p * (1 - pan), p * pan], axis=1), pluck_t)
        pluck_t += step_sec + (0.45 if p_idx % 3 == 0 else -0.25)
        p_idx += 1

    # 4. 转折点（第 10 镜闻声惊觉）：远处惨叫 + 闷棍击打 + 低音震颤 + 心跳脉冲！
    shock_t = turn_sec + 1.25
    add_at(sfx, wood_impact_thud(amp=0.36, rng=rng), shock_t - 0.18)
    add_at(sfx, wood_impact_thud(amp=0.42, rng=rng), shock_t + 0.32)
    add_at(sfx, sub_boom(2.4, f_start=98.0, f_end=35.0, amp=0.58, metallic=False, rng=rng), shock_t + 0.12)

    if distant_scream and os.path.exists(distant_scream):
        sc = load_wav_mono_48k(distant_scream)
        # 室外远处胡同传来的闷声惨叫（带通滤波 + 衰减 + 轻微远距离回声）
        sc = bandpass(sc, 380.0, 2100.0, order=3)
        sc = sc / (np.max(np.abs(sc)) + 1e-9) * 0.28
        sc_st = np.stack([sc * 0.85, sc * 1.0], axis=1)
        sc_st = schroeder_reverb(sc_st, wet=0.58, decay=0.68)
        add_at(sfx, sc_st, shock_t - 0.05)

    # 5. 第二幕：紧张追逐与雪夜逼问（心跳 + 低频紧绷鼓点 + 弦乐拉升）
    act2_dur = max(3.0, drop_cut_sec - (shock_t + 0.4))
    cello_2 = bowed_cello_chord(act2_dur, [73.42, 77.78, 110.0, 155.56], amp=0.25, vibrato_hz=5.8, rng=rng)
    add_at(score, cello_2, shock_t + 0.4)

    # Heartbeat during turn & rush (next ~9 seconds)
    hb_t = shock_t + 0.65
    hb_end = min(drop_cut_sec - 1.0, shock_t + 9.5)
    while hb_t < hb_end:
        add_at(sfx, heartbeat_pulse(amp=0.34), hb_t)
        hb_t += 0.82 if style == 'donghua_noir' else 0.70

    # Driving dark cinema percussion pulse into confrontation
    bpm = 108.0 if style == 'donghua_noir' else (124.0 if style == 'douyin_fast' else 118.0)
    beat_sec = 60.0 / bpm
    drum_t = shock_t + 3.2
    beat_i = 0
    while drum_t < drop_cut_sec - 0.25:
        accent = 0.30 if (beat_i % 4 == 0) else (0.18 if (beat_i % 2 == 0) else 0.11)
        pitch = 68.0 if (beat_i % 4 == 0) else 86.0
        add_at(score, frame_drum_hit(amp=accent, pitch=pitch, rng=rng), drum_t)
        drum_t += beat_sec
        beat_i += 1

    # Add physical impact thuds on violent confrontation shots (e.g. Shot 13 kick / Shot 14 baton)
    for s in shots:
        act = str(s.get('action', ''))
        st_s = float(s.get('startSec', 0))
        if st_s > turn_sec + 1.0 and any(k in act for k in ('踹', '踢', '狠戳', '殴', 'kick', 'stomp')):
            add_at(sfx, wood_impact_thud(amp=0.45, rng=rng), st_s + 0.65)
            add_at(sfx, sub_boom(1.2, f_start=85.0, f_end=40.0, amp=0.35, metallic=False, rng=rng), st_s + 0.68)

    # Tension riser leading right into the silence drop before cliffhanger!
    riser_dur = min(3.8, max(1.5, drop_cut_sec - (shock_t + 4.0)))
    if riser_dur >= 1.5:
        add_at(score, tension_riser(dur_sec=riser_dur, amp=0.22, rng=rng), drop_cut_sec - riser_dur)

    # 6. 第三幕悬念钩子：0.35s 抽空骤停 → 主角喝止 → 重低音铜锣暗黑砸尾！
    # Hard clean duck/silence cut on score right before cliffhanger line
    cut_i0 = max(0, int(drop_cut_sec * SR))
    cut_i1 = min(n_total, int((cliff_line_sec + 0.95) * SR))
    fade_cut = min(int(0.08 * SR), cut_i0)
    if fade_cut > 0:
        score[cut_i0 - fade_cut:cut_i0] *= np.linspace(1.0, 0.0, fade_cut)[:, None]
    score[cut_i0:cut_i1] = 0.0

    # Massive noir cliffhanger boom right as "住手！" finishes!
    boom_t = min(total_sec - 1.2, cliff_line_sec + 0.72)
    add_at(sfx, sub_boom(max(2.2, total_sec - boom_t + 0.2), f_start=105.0, f_end=33.0, amp=0.72, metallic=True, rng=rng), boom_t)

    # 7. 空间混响与母带汇总
    score_wet = schroeder_reverb(score, wet=0.36, decay=0.60)
    mix = score_wet + sfx + amb
    mix = highpass(mix, 28.0, order=2)
    # Soft limiting + clean headroom (-3.5 dBFS)
    peak = float(np.max(np.abs(mix))) + 1e-9
    if peak > 0.66:
        mix = np.tanh(mix / peak * 1.15) * 0.66
    # Clean fade out last 0.25s
    fo = min(len(mix), int(0.25 * SR))
    mix[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None]

    os.makedirs(os.path.dirname(os.path.abspath(out_wav)), exist_ok=True)
    pcm = np.clip(mix * 32767.0, -32768, 32767).astype(np.int16)
    wavfile.write(out_wav, SR, pcm)
    print(f"[SCORE] Generated {total_sec:.2f}s {style} soundtrack (turn={turn_sec:.1f}s, cliffCut={drop_cut_sec:.1f}s, boom={boom_t:.1f}s) -> {out_wav}", flush=True)


if __name__ == '__main__':
    main()
