// 本地出图后端：ComfyUI（推荐）/ Stable Diffusion WebUI (A1111·Forge·reForge)。
//
// 为什么要有它：原来的封面底图只能调 Google Imagen——要 key、要代理、要联网、按张计费。
// 本地出图零成本、断网可用、不限张数（书名实验一次要出 5–8 张，云端很肉疼）。
// 接口层面两家都很简单，难的是【别把工作流写死】——ComfyUI 的节点组合随模型换代天天变，
// 所以这里：① 内置两套开箱即用的 preset（SDXL / Qwen-Image）；
//          ② 允许用户把自己在 ComfyUI 里调好的工作流导出成 API 格式的 JSON 直接挂上来（workflowFile），
//             我们只往里替换 %prompt% / %negative% / %seed% / %width% / %height% 这几个占位。
// 这样模型再怎么换代，用户都能自己救自己，不用等这个文件更新。
import fs from 'node:fs';

// 出图负向提示：本项目封面【书名是后期 canvas 叠上去的】，底图必须干净无字——
// 模型自己画的字必糊成乱码。故负向里把文字/水印/签名摁死（与 imagegen.ART_ENFORCE 同一意图）。
// 负向里除了摁文字，还摁【凭空出现的兵器与特效】——本地 LLM 写提示词时爱自己加剑、加光效，
// 出来的封面就跟正文设定对不上。提示词那头已显式禁止（见 imagegen.NO_INVENT），这里再兜一道。
export const LOCAL_NEGATIVE = 'text, letters, words, watermark, signature, logo, caption, subtitle, '
  + 'lowres, worst quality, blurry, jpeg artifacts, extra fingers, bad hands, bad anatomy, deformed face, '
  + 'western face, caucasian, glowing effects, magic aura, energy beam, floating runes';

function root(u) { return String(u || '').replace(/\/+$/, ''); }
function randSeed() { return Math.floor(Math.random() * 2 ** 31); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// —— ComfyUI 内置工作流 preset ——
// 直接构造对象而不是字符串模板：提示词里带引号/换行时，字符串拼 JSON 必炸。
function workflowSdxl({ prompt, negative, width, height, seed, steps, cfgScale, ckpt, sampler, scheduler }) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    5: { class_type: 'KSampler', inputs: {
      seed, steps, cfg: cfgScale, sampler_name: sampler || 'dpmpp_2m', scheduler: scheduler || 'karras',
      denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { filename_prefix: 'novelstudio', images: ['6', 0] } },
  };
}

// Qwen-Image（20B MMDiT）：分体加载 unet + clip(qwen_image 类型) + vae。
// GGUF 需要装 ComfyUI-GGUF 自定义节点（UnetLoaderGGUF）；safetensors 走原生 UNETLoader。
function workflowQwenImage({ prompt, negative, width, height, seed, steps, cfgScale, unet, clip, vae, gguf, clipGguf, sampler, scheduler, shift }) {
  const loader = gguf
    ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: unet } }
    : { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } };
  // 文本编码器也可以走 GGUF：Qwen2.5-VL-7B 的 fp8 版约 9GB，跟 12GB unet 在 12G 卡上要来回换进换出；
  // 换成 GGUF 量化版能显著减少这种换页（代价是提示词理解略降）。二选一由 clipGguf 决定。
  const clipLoader = clipGguf
    ? { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: clip, type: 'qwen_image' } }
    : { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'qwen_image' } };
  return {
    1: loader,
    2: clipLoader,
    3: { class_type: 'VAELoader', inputs: { vae_name: vae } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
    6: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
    7: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: shift || 3.1, model: ['1', 0] } },
    8: { class_type: 'KSampler', inputs: {
      seed, steps, cfg: cfgScale, sampler_name: sampler || 'euler', scheduler: scheduler || 'simple',
      denoise: 1, model: ['7', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { filename_prefix: 'novelstudio', images: ['9', 0] } },
  };
}

// 用户自带工作流（ComfyUI「导出(API)」出来的 JSON）：只替换占位符，其余原样。
// 先 JSON.parse 再逐个字符串值替换 → 提示词里有引号也不会破坏结构。
function applyWorkflowFile(file, vars) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(node)) o[k] = walk(v);
      return o;
    }
    if (typeof node === 'string') {
      let s = node;
      for (const [k, v] of Object.entries(vars)) s = s.split('%' + k + '%').join(String(v));
      // 整个值就是一个数字占位（如 "%seed%"）时还原成数字，否则 ComfyUI 会因类型不符报错。
      if (/^-?\d+$/.test(s) && /%/.test(node)) return Number(s);
      return s;
    }
    return node;
  };
  return walk(raw);
}

// —— ComfyUI ——
// 流程：POST /prompt 排队 → 轮询 /history/{id} 等出图 → GET /view 取二进制。
async function comfyGenerate({ base, wf, timeoutMs, onLog }) {
  const host = root(base);
  const clientId = 'novel-studio-' + Date.now();
  let r;
  try {
    r = await fetch(host + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: clientId }), signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`连不上 ComfyUI（${host}）：${e.message || e}——先启动 ComfyUI 再出图。`);
  }
  const q = await r.json().catch(() => null);
  if (!r.ok || !q?.prompt_id) {
    // ComfyUI 的报错藏在 node_errors 里，直接摊开——最常见是「模型文件名填错 / 自定义节点没装」。
    const ne = q?.node_errors ? JSON.stringify(q.node_errors).slice(0, 400) : '';
    const em = q?.error?.message || q?.error || `HTTP ${r.status}`;
    throw new Error(`ComfyUI 拒绝了这个工作流：${em}${ne ? '｜节点错误：' + ne : ''}`
      + '（常见原因：设置里的模型文件名与 ComfyUI/models 下的实际文件名不一致；或 Qwen-Image GGUF 缺 ComfyUI-GGUF 节点）');
  }
  const id = q.prompt_id;
  onLog({ level: 'info', msg: `  ComfyUI 已排队（${id.slice(0, 8)}），本地出图约 30–120 秒…` });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    let h;
    try { h = await (await fetch(`${host}/history/${id}`, { signal: AbortSignal.timeout(10000) })).json(); } catch { continue; }
    const rec = h?.[id];
    if (!rec) continue;
    if (rec.status?.status_str === 'error') {
      const raw = JSON.stringify(rec.status?.messages || '');
      throw new Error('ComfyUI 执行失败：' + explainComfyError(raw));
    }
    for (const out of Object.values(rec.outputs || {})) {
      const img = (out.images || [])[0];
      if (!img) continue;
      const url = `${host}/view?filename=${encodeURIComponent(img.filename)}`
        + `&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
      const ir = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!ir.ok) throw new Error('取图失败 HTTP ' + ir.status);
      return Buffer.from(await ir.arrayBuffer());
    }
  }
  // 超时不一定是出错，也可能只是【本来就慢】：Qwen-Image 20B 在 12G 卡上实测约 5 分钟，
  // 加了 --cache-none 每次还要重读 22.6GB 模型，正常就会超过 5 分钟。别让用户以为坏了。
  throw new Error(`ComfyUI 出图超时（${Math.round(timeoutMs / 1000)}秒）。`
    + `注意 Qwen-Image 在 12G 卡上【正常也要 5 分钟以上】，加 --cache-none 更久——`
    + `先把「出图超时」调大（设置里的 image.timeoutMs，建议 1800000 即 30 分钟）再判断是不是真卡住。`
    + `若确实卡住：多半是显存不够溢出到内存，换 sdxl preset 或降低分辨率/步数。`);
}

// ComfyUI 的报错很多是底层异常字符串，直译给用户等于没说。这里把最常撞的几种翻成能照做的处理办法。
// 尤其 hostbuf_file_reader_read failed —— 它长得像 IO 错误，实际是【主机内存(提交量)不够】：
// Qwen-Image 的 13GB unet + 9.4GB 文本编码器会让 ComfyUI 提交 ~31GB，
// 32GB 内存 + 小分页文件的机器会正好被打满，而报错里一个字都不提内存。
export function explainComfyError(raw) {
  const t = String(raw || '');
  if (/hostbuf_file_read|hostbuf_file_reader_read/i.test(t)) {
    return '主机内存(提交量)不够 —— Qwen-Image 的 unet + 文本编码器会让 ComfyUI 提交 ~31GB。'
      + '处理：① ComfyUI 启动参数加 --cache-none（用完即卸，不跨次累积）；'
      + '② 调大 Windows 分页文件（系统属性 → 高级 → 性能 → 虚拟内存，给 32GB 以上）；'
      + '③ 改用 GGUF 文本编码器并把设置里的 clipGguf 打开（编码器从 9.4GB 降到约 4GB）；'
      + '④ 或把出图 preset 换成 sdxl（整套才 6.5GB）。';
  }
  if (/out of memory|CUDA out of memory|OutOfMemoryError/i.test(t)) {
    return '显存不够 —— 检查是不是文本模型还占着显存（本项目出图前会自动卸载，'
      + '但若你手动跑了 ollama run 就得手动退出）；或把分辨率/步数调小、换 sdxl preset。';
  }
  if (/not in list|value not in/i.test(t)) {
    return '模型文件名对不上 —— 设置里填的名字与 ComfyUI/models 下的实际文件名不一致：' + t.slice(0, 200);
  }
  return t.slice(0, 400);
}

// —— A1111 / Forge ——（启动参数必须带 --api）
async function a1111Generate({ base, prompt, negative, width, height, steps, cfgScale, sampler, ckpt, timeoutMs }) {
  const host = root(base);
  const body = {
    prompt, negative_prompt: negative, width, height, steps,
    cfg_scale: cfgScale, sampler_name: sampler || 'DPM++ 2M Karras', seed: randSeed(), batch_size: 1,
  };
  if (ckpt) body.override_settings = { sd_model_checkpoint: ckpt };
  let r;
  try {
    r = await fetch(host + '/sdapi/v1/txt2img', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new Error(`本地出图超时（${Math.round(timeoutMs / 1000)}秒）`);
    throw new Error(`连不上 SD WebUI（${host}）：${e.message || e}——启动参数要带 --api。`);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`SD WebUI 返回 ${r.status}：${j?.detail || j?.error || ''}`);
  const b64 = (j?.images || [])[0];
  if (!b64) throw new Error('SD WebUI 未返回图片');
  return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
}

// 统一入口：按 cfg.image 配置出一张图，返回 PNG Buffer。
// 尺寸默认竖版（对齐封面 600×800 画布的 3:4），SDXL 用 896×1152 贴近其训练分辨率，
// Qwen-Image 用 1024×1328（官方原生比例，偏离会明显掉质量）。
export async function generateLocalImage({ prompt, negative, cfg, width, height, onLog = () => {} }) {
  const img = (cfg && cfg.image) || {};
  const backend = img.localBackend === 'a1111' ? 'a1111' : 'comfy';
  const neg = negative || img.negative || LOCAL_NEGATIVE;

  if (backend === 'a1111') {
    const a = img.a1111 || {};
    return await a1111Generate({
      base: a.baseUrl || 'http://127.0.0.1:7860', prompt, negative: neg,
      width: width || a.width || 896, height: height || a.height || 1152,
      steps: a.steps || 28, cfgScale: a.cfgScale || 6, sampler: a.sampler, ckpt: a.ckpt || '',
      timeoutMs: img.timeoutMs || 300000,
    });
  }

  const c = img.comfy || {};
  const preset = c.preset || 'sdxl';
  const isQwen = preset === 'qwen-image';
  const W = width || c.width || (isQwen ? 1024 : 896);
  const H = height || c.height || (isQwen ? 1328 : 1152);
  const vars = {
    prompt, negative: neg, seed: randSeed(), width: W, height: H,
    steps: c.steps || (isQwen ? 20 : 28), cfg: c.cfgScale || (isQwen ? 2.5 : 6),
  };

  let wf;
  if (c.workflowFile && fs.existsSync(c.workflowFile)) {
    onLog({ level: 'info', msg: `  使用自定义 ComfyUI 工作流：${c.workflowFile}` });
    wf = applyWorkflowFile(c.workflowFile, vars);
  } else if (isQwen) {
    wf = workflowQwenImage({
      prompt, negative: neg, width: W, height: H, seed: vars.seed,
      steps: vars.steps, cfgScale: vars.cfg,
      unet: c.unet || 'qwen-image-2512-Q4_K_M.gguf', clip: c.clip || 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
      vae: c.vae || 'qwen_image_vae.safetensors', gguf: c.gguf !== false, clipGguf: c.clipGguf === true,
      sampler: c.sampler, scheduler: c.scheduler, shift: c.shift,
    });
  } else {
    wf = workflowSdxl({
      prompt, negative: neg, width: W, height: H, seed: vars.seed,
      steps: vars.steps, cfgScale: vars.cfg, ckpt: c.ckpt || 'sd_xl_base_1.0.safetensors',
      sampler: c.sampler, scheduler: c.scheduler,
    });
  }
  return await comfyGenerate({
    base: c.baseUrl || 'http://127.0.0.1:8188', wf,
    timeoutMs: img.timeoutMs || 300000, onLog,
  });
}
