// 本地模型探测与体检：Ollama / LM Studio / llama.cpp（文本）+ ComfyUI / A1111 (Forge/reForge)（出图）。
//
// 本地模型与云端 API 的三个关键差别，这个文件就是为它们存在的：
//   ① 【没有 API Key】——「可用不可用」不取决于填没填 key，而取决于那个服务进程有没有在跑。
//      所以不能沿用 providerConfigured 那套判断，得真去 HTTP 探一下。
//   ② 【绝不能走代理】——127.0.0.1 走 Clash 会被代理吞掉返回 502/连接拒绝，是本地部署最常见的坑。
//      故 resolveProviderCfg 对 local 强制 proxy=''，这里探测也一律直连。
//   ③ 【显存是硬约束】——12G 卡塞 27B 会静默溢出到内存、慢十倍。故探显存并给出分档建议，
//      而不是让用户拉一个跑不动的模型再来问"为什么这么慢"。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 把 OpenAI 兼容 baseUrl 还原成服务根（去掉尾部 /v1）。Ollama 的原生 API（/api/tags 等）挂在根上。
export function serverRoot(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function getJson(url, timeoutMs = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

function fmtGB(bytes) { return (Number(bytes || 0) / 1e9).toFixed(1) + 'GB'; }

// —— 找到 ollama 可执行文件 ——
// ⚠️ Windows 上装完 Ollama，【已经在运行的进程拿不到新 PATH】——环境变量是进程启动时的快照。
// Novel Studio 桌面版常年开着，用户装完 Ollama 回来点「导入」，spawn('ollama') 必然报
// 「不是内部或外部命令」。所以不能只依赖 PATH，得按已知安装位置兜底。
export function resolveOllamaBin() {
  const isWin = process.platform === 'win32';
  const probe = isWin ? spawnSync('where', ['ollama'], { encoding: 'utf8', windowsHide: true })
                      : spawnSync('which', ['ollama'], { encoding: 'utf8' });
  const hit = (probe.stdout || '').trim().split(/\r?\n/)[0];
  if (probe.status === 0 && hit && fs.existsSync(hit)) return hit;

  const home = os.homedir();
  const candidates = isWin ? [
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
  ] : [
    '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama',
    path.join(home, '.local', 'bin', 'ollama'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

// —— 显卡探测：决定推荐哪一档模型 ——
// ⚠️ 不用 WMI/Win32_VideoController.AdapterRAM——它是 32 位字段，12G 卡会被截成 4G。只信 nvidia-smi。
export function detectGpu() {
  try {
    const r = spawnSync('nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.status !== 0) return { ok: false, reason: '未找到 nvidia-smi（无 N 卡或驱动未装）' };
    const line = (r.stdout || '').trim().split(/\r?\n/)[0] || '';
    const [name, total, used] = line.split(',').map(s => s.trim());
    const totalMb = Number(total) || 0;
    if (!totalMb) return { ok: false, reason: 'nvidia-smi 未返回显存' };
    return { ok: true, name, totalMb, usedMb: Number(used) || 0, freeMb: totalMb - (Number(used) || 0) };
  } catch (e) { return { ok: false, reason: e.message || String(e) }; }
}

// —— 文本服务探测 ——
// 先按 Ollama 原生 /api/tags 探（能顺带拿到已装模型和体积）；不是 Ollama 再按 OpenAI /v1/models 探
// （LM Studio / llama.cpp server / vLLM 都吃这个）。两条都不通才算没起。
export async function probeText(baseUrl, timeoutMs = 4000) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const root = serverRoot(base);
  try {
    const j = await getJson(root + '/api/tags', timeoutMs);
    if (Array.isArray(j?.models)) {
      let version = '';
      try { version = (await getJson(root + '/api/version', 2000))?.version || ''; } catch {}
      return {
        ok: true, kind: 'ollama', baseUrl: base, version,
        models: j.models.map(m => ({ name: m.name, size: m.size, sizeText: fmtGB(m.size) })),
      };
    }
  } catch {}
  try {
    const j = await getJson(base + '/models', timeoutMs);
    const list = j?.data || j?.models || [];
    if (Array.isArray(list)) {
      return { ok: true, kind: 'openai', baseUrl: base, version: '', models: list.map(m => ({ name: m.id || m.name, size: 0, sizeText: '' })) };
    }
  } catch (e) {
    return { ok: false, baseUrl: base, error: hint(e, base)
      + '（Ollama：任意终端跑 `ollama serve`；LM Studio：开 Local Server）' };
  }
  return { ok: false, baseUrl: base, error: '服务有响应但不认识它的接口（既不是 Ollama 也不是 OpenAI 兼容）' };
}

// 本地连不上时给出【能直接照做】的提示，而不是干巴巴一句 fetch failed。
function hint(e, url) {
  const m = e?.message || String(e);
  if (/timeout|aborted|TimeoutError/i.test(m)) return `连接超时（${url}）——服务没起或端口不对`;
  if (/ECONNREFUSED|fetch failed|connect/i.test(m)) return `连不上 ${url} —— 服务没启动`;
  return m;
}

// —— 出图服务探测 ——
export async function probeImage(backend, baseUrl, timeoutMs = 4000) {
  const root = serverRoot(baseUrl);
  try {
    if (backend === 'a1111') {
      const j = await getJson(root + '/sdapi/v1/sd-models', timeoutMs);
      const models = (j || []).map(m => m.model_name || m.title).filter(Boolean);
      return { ok: true, backend, baseUrl: root, models, info: models.length + ' 个模型' };
    }
    // comfy
    const j = await getJson(root + '/system_stats', timeoutMs);
    const d = (j?.devices || [])[0] || {};
    const vram = d.vram_total ? `${fmtGB(d.vram_total)}（空闲 ${fmtGB(d.vram_free)}）` : '';
    return { ok: true, backend, baseUrl: root, models: [], info: [d.name, vram].filter(Boolean).join(' · ') || 'ComfyUI 在线' };
  } catch (e) {
    const svc = backend === 'a1111' ? 'Stable Diffusion WebUI（启动参数要加 --api）' : 'ComfyUI';
    return { ok: false, backend, baseUrl: root, error: hint(e, root) + `——请先启动 ${svc}` };
  }
}

// —— 按显存分档的模型建议 ——
// 写网文的负载特点：上下文包 ~8–15K token（设定圣经+大纲+上一章），单章要连贯输出 3000+ 字。
// 所以【长上下文不崩 + 中文地道】比跑分重要；能不能全塞进显存决定速度差 5–10 倍。
export function recommendText(vramMb) {
  const v = Number(vramMb) || 0;
  const tiers = [
    { min: 24000, model: 'qwen3.8:27b',    q: 'Q4_K_M', size: '≈18GB', note: '显存够就上这个：27B 稠密，中文网文质感最接近云端 API' },
    { min: 16000, model: 'qwen3:30b-a3b',  q: 'Q4_K_M', size: '≈18GB', note: 'MoE 只激活 3B，速度接近 14B、质量接近 30B；显存不够可部分卸载到内存' },
    // 【已在 RTX 3060 12G 上实测】qwen3:14b Q4_K_M + num_ctx 16384 + KV q8_0 = 10.14GB，
    // 100% 在显存、零溢出（Ollama /api/ps 与 nvidia-smi 双向确认）。前提是开了
    // OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0——不开的话 KV 翻倍就真的装不下了。
    { min: 11000, model: 'qwen3:14b',      q: 'Q4_K_M', size: '≈9.0GB', note: '12G 卡的主力档，实测 16K 上下文全量入显存（10.14GB）、零溢出。前提是开 KV 量化，见 novel local 的显存调优提示' },
    { min: 7000,  model: 'qwen3:8b',       q: 'Q4_K_M', size: '≈5.2GB', note: '文笔弱一档，胜在余量大：12G 卡上能开到 60K+ 上下文。设定圣经/大纲特别长、或还要同时跑 ComfyUI 出图抢显存时选它' },
    { min: 0,     model: 'qwen3:4b',       q: 'Q4_K_M', size: '≈2.6GB', note: '仅够跑通流程，长篇写作质量不够，建议配合云端 API 混用' },
  ];
  const pick = tiers.find(t => v >= t.min) || tiers[tiers.length - 1];
  return { pick, tiers };
}

// 显存够不够，不能只看模型权重——【KV cache 是被忽略的另一半】。
// 长上下文写作尤其吃它：14B 级模型每 1K 上下文约 160MB(fp16)，16K 就是 2.6GB，
// 加上 9.3GB 权重正好把 12G 卡挤爆 → Ollama 静默把部分层放到内存，速度掉 3–5 倍，
// 而用户只会觉得"本地模型怎么这么慢"，看不出原因。
//
// 解法是把 KV cache 量化成 q8_0（需同时开 flash attention），显存直接减半、质量几乎无损。
// 这个函数把账算清楚并给出该设的环境变量。
// 【已按真机实测校准】RTX 3060 12G + qwen3:14b Q4_K_M + num_ctx 16384 + KV q8_0：
//   Ollama /api/ps 报 10.14GB，全部在显存、零溢出（nvidia-smi 佐证 11347/12288 MiB）。
//   反推 KV ≈ 1.14GB / 16K token ≈ 71KB/token(q8_0) → fp16 约 140MB per 1K token。
//   最初按 160MB 估、再加 0.6G 缓冲、并按满显存的 88% 算可用，三处都偏保守，
//   合起来把一个【实际可行】的配置判成了不可行——那会误导用户去砍上下文。故按实测收紧。
// freeMb 传入时优先用【真实空闲显存】，比按总量打折准得多（桌面/浏览器占用随时在变）。
export function vramBudget({ vramMb, freeMb, weightsGb, numCtx, kvType = 'f16' }) {
  const perKTokenMb = 140;                       // 实测校准值（14B 级 GQA，fp16）
  const factor = kvType === 'q8_0' ? 0.5 : kvType === 'q4_0' ? 0.25 : 1;
  const kvGb = (numCtx / 1024) * perKTokenMb * factor / 1024;
  const totalGb = weightsGb + kvGb + 0.2;        // Ollama 的 size_vram 已含大部分开销，留 0.2G 即可
  const usableGb = freeMb ? (freeMb / 1024) : (vramMb / 1024) * 0.92;
  return {
    kvGb: +kvGb.toFixed(2), totalGb: +totalGb.toFixed(2), usableGb: +usableGb.toFixed(2),
    fits: totalGb <= usableGb,
  };
}

// 在给定显存下，能【全量入显存】的最大 num_ctx（向下取整到 2048 的整数倍，好填好记）。
// 直接给数字，比让用户自己二分试要省事得多。
export function maxNumCtx({ vramMb, freeMb, weightsGb, kvType = 'q8_0' }) {
  const factor = kvType === 'q8_0' ? 0.5 : kvType === 'q4_0' ? 0.25 : 1;
  const usableGb = freeMb ? (freeMb / 1024) : (vramMb / 1024) * 0.92;
  const budgetGb = usableGb - weightsGb - 0.2;
  if (budgetGb <= 0) return 0;                             // 权重本身就塞不下
  const kTokens = budgetGb * 1024 / (140 * factor);        // 每 1K token 约 140MB(fp16)，实测校准
  return Math.max(2048, Math.floor(kTokens * 1024 / 2048) * 2048);
}

// 12G 卡跑 14B + 16K 上下文的调优建议（设成环境变量后重启 ollama serve 生效）。
export function tuningAdvice(vramMb, weightsGb = 9.0, numCtx = 16384, freeMb = 0) {
  const f16 = vramBudget({ vramMb, freeMb, weightsGb, numCtx, kvType: 'f16' });
  const q8 = vramBudget({ vramMb, freeMb, weightsGb, numCtx, kvType: 'q8_0' });
  if (f16.fits) return { need: false, f16, q8 };
  return {
    need: true, f16, q8,
    fixable: q8.fits,
    env: [
      ['OLLAMA_FLASH_ATTENTION', '1'],
      ['OLLAMA_KV_CACHE_TYPE', 'q8_0'],
    ],
    why: `估算：权重 ${weightsGb}G + ${numCtx / 1024}K 上下文的 KV cache ${f16.kvGb}G ≈ ${f16.totalGb}G，`
      + `超过可用显存 ${f16.usableGb}G → 超出部分会被放到内存跑（落几层慢一两成，落一半就慢数倍）。`
      + `把 KV cache 量化成 q8_0 后降到 ${q8.totalGb}G${q8.fits ? '，可全量入显存' : '；仍紧张的话再把 num_ctx 降到 12288'}。`
      + `（以上是估算，模型装好后用 novel local 看【实测】那一行为准）`,
    suggestCtx: maxNumCtx({ vramMb, freeMb, weightsGb, kvType: 'q8_0' }),
  };
}

export function recommendImage(vramMb) {
  const v = Number(vramMb) || 0;
  if (v >= 11000) {
    return {
      pick: 'qwen-image',
      note: 'Qwen-Image（20B MMDiT，Apache 2.0）GGUF Q4_K_M：12G 显存可跑，中文语义与画面质量目前开源最强，但连文本编码器共约 20GB 磁盘。',
      alt: 'SDXL 系国风大模型（≈6.5GB）：本项目封面书名是后期 canvas 叠的、底图要求【干净无字】，用不上 Qwen-Image 的中文文字渲染优势，省盘可选它。',
    };
  }
  return { pick: 'sdxl', note: 'SDXL / Illustrious 系国风大模型（≈6.5GB），8G 显存可跑。', alt: '' };
}

// 【实测】模型加载后到底有多少在显存、多少落到内存——Ollama 的 /api/ps 直接给了答案，
// 比上面任何估算都准。没加载模型时返回 null（调一次写作或 ollama run 就会加载）。
export async function loadedStatus(baseUrl) {
  try {
    const j = await getJson(serverRoot(baseUrl) + '/api/ps', 4000);
    const m = (j?.models || [])[0];
    if (!m) return null;
    const total = m.size || 0, vram = m.size_vram || 0;
    const pct = total ? Math.round(vram / total * 100) : 0;
    return {
      name: m.name, totalGb: +(total / 1e9).toFixed(2), vramGb: +(vram / 1e9).toFixed(2),
      cpuGb: +((total - vram) / 1e9).toFixed(2), gpuPct: pct,
      // 100% 在显存最快；掉到 90% 以下就该动手了（降 num_ctx / 开 KV 量化 / 换小一档）
      verdict: pct >= 99 ? 'full-gpu' : pct >= 90 ? 'mostly-gpu' : 'spilled',
      contextLength: m.context_length || 0,
    };
  } catch { return null; }
}

// —— 把本地 GGUF 文件导进 Ollama ——
// 为什么需要这个：Ollama 的模型 blob 放在 Cloudflare R2，国内常见直连被墙、走代理也持续 EOF，
// `ollama pull` 卡在某个百分比反复重试下不完。此时只能从魔搭/HF 镜像下 GGUF 再导入。
//
// ⚠️ 关键：GGUF 裸文件【不带 chat 模板】。不写 TEMPLATE 就导入，模型会把整段对话当续写，
//    输出全是乱的（还不报错，只是写出来的东西驴唇不对马嘴）。所以这里按模型族补上模板。
const CHATML_TEMPLATE = `{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}
{{- range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}<|im_start|>assistant
`;

// 目前需要写模板的模型族。Qwen / Yi / 零一 / InternLM 都是 ChatML。
function templateFor(name) {
  const n = String(name || '').toLowerCase();
  if (/qwen|yi-|internlm|chatml/.test(n)) return { template: CHATML_TEMPLATE, stops: ['<|im_start|>', '<|im_end|>'] };
  return null;   // 不认识就不写，交给 Ollama 自己从 GGUF 元数据里推
}

// 生成 Modelfile 内容（导出出来单独可测，也方便用户自己改）。
export function buildModelfile({ ggufPath, name, numCtx = 16384, temperature = 0.85 }) {
  const t = templateFor(name);
  const Q = '"""';   // Modelfile 里 TEMPLATE 用三引号包裹多行内容
  const lines = ['FROM ' + String(ggufPath).replace(/\\/g, '/')];
  if (t) {
    lines.push('', 'TEMPLATE ' + Q + t.template + Q, '');
    for (const st of t.stops) lines.push(`PARAMETER stop "${st}"`);
  }
  lines.push(`PARAMETER temperature ${temperature}`);
  lines.push(`PARAMETER num_ctx ${numCtx}`);
  return lines.join('\n') + '\n';
}

// —— 让 Ollama 立刻释放显存 ——
// 为什么需要：12G 卡上【文本模型和出图模型放不下同时在显存里】。
//   qwen3:14b + 16K 上下文 = 10.14G，Qwen-Image 出一张图要 ~12G。
// 两者都占着的话，ComfyUI 要么 CUDA OOM 直接失败，要么疯狂在显存/内存间倒腾、
// 一张图从 5 分钟变半小时——而用户看到的只是「出图怎么卡死了」，完全不知道是谁在抢。
// 所以本地出图前先把文本模型请出去；写下一章时 Ollama 会自己重新加载（14B 约 15 秒）。
// keep_alive:0 是 Ollama 的立即卸载约定。
export async function unloadLocalText(baseUrl, model) {
  const root = serverRoot(baseUrl || 'http://127.0.0.1:11434/v1');
  try {
    const ps = await getJson(root + '/api/ps', 3000);
    const loaded = (ps?.models || [])[0];
    if (!loaded) return { unloaded: false, reason: 'none-loaded' };
    await fetch(root + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || loaded.name, keep_alive: 0 }),
      signal: AbortSignal.timeout(30000),
    });
    return { unloaded: true, name: loaded.name, freedGb: +((loaded.size_vram || 0) / 1e9).toFixed(2) };
  } catch { return { unloaded: false, reason: 'error' }; }
}

// 一次性体检：文本 + 出图 + 显卡，给 doctor / 设置页用。
export async function localHealth(cfg) {
  const a = (cfg && cfg.api) || {};
  const img = (cfg && cfg.image) || {};
  const gpu = detectGpu();
  const [text, image] = await Promise.all([
    probeText((a.local && a.local.baseUrl) || 'http://127.0.0.1:11434/v1'),
    probeImage(img.localBackend === 'a1111' ? 'a1111' : 'comfy', img.localBackend === 'a1111' ? (img.a1111?.baseUrl || 'http://127.0.0.1:7860') : (img.comfy?.baseUrl || 'http://127.0.0.1:8188')),
  ]);
  return {
    gpu, text, image,
    recommend: {
      text: recommendText(gpu.totalMb), image: recommendImage(gpu.totalMb),
    },
    tuning: gpu.ok ? tuningAdvice(gpu.totalMb, 9.0, (cfg?.api?.local?.numCtx) || 16384, gpu.freeMb) : null,
    loaded: text.ok ? await loadedStatus(text.baseUrl) : null,
  };
}
