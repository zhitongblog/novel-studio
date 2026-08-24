// 中文大模型 API 客户端（OpenAI 兼容 /chat/completions）。
//
// 支持：智谱 GLM（open.bigmodel.cn）、DeepSeek（api.deepseek.com）、通义 DashScope（compatible-mode）。
// 三家的对话接口都遵循 OpenAI 格式，所以一套代码全搞定：
//   POST {baseUrl}/chat/completions
//   Header: Authorization: Bearer <apiKey>
//   Body:   { model, messages:[{role,content}], temperature, max_tokens, stream:false }
//   返回:   { choices:[{ message:{ content } }], usage:{...} }
//
// 智谱说明：v4 接口可直接把 API Key（形如 id.secret）当 Bearer token 用，无需自己签 JWT。
//
// 与「网页版写作」的区别：模型直接把整段回答用 HTTP 返回，稳、无浏览器那套脆弱输入；
// 落盘/解析仍由 Novel Studio 自己做（见 apiwriter.mjs，复用 webwriter 的解析与落盘）。
//
// 【本地模型 provider: 'local'】——同一条 HTTP 通道，指到 127.0.0.1 上自己跑的 Ollama / LM Studio /
// llama.cpp / vLLM。零成本、零额度、断网可写、内容不出本机。三处与云端不同、必须特殊处理：
//   ① 不需要 API Key（keyless）——不能因为"没填 key"就拒绝调用；
//   ② 【绝不走代理】——127.0.0.1 经 Clash 会被吞成 502/拒绝连接，是本地部署第一大坑，故强制 proxy=''；
//   ③ 【Ollama 默认 num_ctx=4096】——本项目上下文包动辄 8–15K token，走 OpenAI 兼容端点会被
//      【静默截断】：设定圣经/大纲/上一章结尾被悄悄砍掉，模型开始跑题、写重复，且没有任何报错。
//      所以探到是 Ollama 就改走它的原生 /api/chat，显式传 options.num_ctx（见 localChat）。
import { serverRoot } from './localai.mjs';

// 各家 provider 的默认 baseUrl / 默认模型（config.api.<provider> 可覆盖）。
export const API_PROVIDERS = {
  zhipu:     { name: '智谱 GLM',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  deepseek:  { name: 'DeepSeek',       baseUrl: 'https://api.deepseek.com',             model: 'deepseek-chat' },
  dashscope: { name: '通义千问 API',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  // —— 以下三家都是 OpenAI 兼容，接法与上面完全一样，只是域名/模型名不同 ——
  // 阿里云百炼【Token Plan / Coding Plan】——订阅制，用 sk-sp- 开头的专用 key，
  // 走【独立端点】，与按量付费的 dashscope 完全隔离、不能混用（官方明说；混用会 401）。
  // 值在于一个 key 拿到多家旗舰：qwen3.8-max / qwen3.7-max / glm-5.2 / deepseek-v4-pro …
  // ⚠️ 模型名跟按量付费那套【不一样】（没有 qwen-plus 这种），填错会 404 Model not exist。
  bailian:   { name: '百炼订阅（Token Plan）', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'deepseek-v4-pro' },
  // 豆包：字节火山方舟。⚠️ 它的 model 字段填的是你在控制台建的【推理接入点 ID】(ep-xxxx)，
  // 不是模型名——这一点跟其它家都不一样，填错会直接 404，所以设置页要单独提示。
  doubao:    { name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
  // Kimi：长文本见长，适合当"挑刺/润色"那一轮，而不是打初稿。
  moonshot:  { name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  // 文心：百度千帆的 OpenAI 兼容端点。
  ernie:     { name: '文心一言（千帆）', baseUrl: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.5-turbo-128k' },
  // 本地模型：默认指向 Ollama。LM Studio 改成 http://127.0.0.1:1234/v1，llama.cpp server 改成 :8080/v1。
  local:     { name: '本地模型',       baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:14b', local: true },
};

// 供 UI/校验用：这些 provider 不需要 API Key。
export function isKeylessProvider(provider) { return !!API_PROVIDERS[provider]?.local; }

// 从全局 cfg 解析某 provider 的有效配置（apiKey / baseUrl / model / temperature / maxTokens / timeoutMs / proxy）。
export function resolveProviderCfg(provider, cfg) {
  const p = API_PROVIDERS[provider];
  if (!p) throw new Error('未知 API 提供方：' + provider + '（可选 ' + Object.keys(API_PROVIDERS).join('|') + '）');
  const a = (cfg && cfg.api) || {};
  const u = (a[provider]) || {};
  const local = !!p.local;
  return {
    provider,
    name: p.name,
    local,
    keyless: local,                                    // 本地模型不需要 key，写作端据此跳过 key 校验
    apiKey: (u.apiKey || '').trim(),
    baseUrl: (u.baseUrl || p.baseUrl).replace(/\/+$/, ''),
    model: u.model || p.model,
    temperature: typeof u.temperature === 'number' ? u.temperature
      : (typeof a.temperature === 'number' ? a.temperature : 0.85),
    maxTokens: u.maxTokens || a.maxTokens || 8192,
    // 本地生成慢得多：14B 出 3000 字单章约 2–4 分钟，加上长上下文的预填充，5 分钟的云端超时会误杀。
    timeoutMs: u.timeoutMs || (local ? 1800000 : (a.timeoutMs || 300000)),
    // 本地一律直连——把全局代理带进 127.0.0.1 的请求会连不上（本地部署第一大坑）。
    proxy: local ? '' : (a.proxy || ''),
    // 仅本地：flavor 'auto'|'ollama'|'openai'；numCtx 决定能喂多长的上下文包；keepAlive 让模型常驻显存不反复加载。
    flavor: u.flavor || 'auto',
    numCtx: u.numCtx || 16384,
    keepAlive: u.keepAlive || '30m',
    // Qwen3 等混合推理模型默认会先吐一段 <think>…</think> 再写正文。写网文【不需要】这段思考，
    // 而它要真金白银地吃掉 num_predict 预算——思考花掉 3K token，正文就少 3K，
    // 表现是「章节写到一半没了、没有 <<<END>>>」，而且不报错。故默认关掉。
    think: u.think === true,
  };
}

// 调一次对话补全，返回 { content, usage }。messages = [{role:'system'|'user'|'assistant', content}]。
// 失败抛错（含状态码与服务端信息）；apiKey 缺失/额度/鉴权错都有明确提示。
export async function chatComplete({ provider, cfg, messages, temperature, maxTokens, onLog = () => {} }) {
  const pc = resolveProviderCfg(provider, cfg);
  // 本地模型走独立路径：无需 key，且探到 Ollama 就用原生 /api/chat 显式给 num_ctx（否则上下文被静默截断）。
  if (pc.local) return await localChat({ pc, messages, temperature, maxTokens, onLog });
  if (!pc.apiKey) {
    throw new Error(`未配置 ${pc.name} 的 API Key。请在「设置」里填入 api.${provider}.apiKey（`
      + ({
        zhipu: '智谱 open.bigmodel.cn → API Keys，形如 id.secret；glm-4.5-flash 免费',
        deepseek: 'platform.deepseek.com → API Keys',
        dashscope: 'dashscope.console.aliyun.com → API-KEY（有免费额度）',
        bailian: '百炼订阅：bailian.console.aliyun.com 订阅 Token Plan / Coding Plan 后拿到的 sk-sp- 开头的 key。⚠️ 与按量付费的 sk- key 不通用',
        doubao: '火山方舟 console.volcengine.com/ark → API Key；另需在「在线推理」建一个接入点，把 ep-xxxx 填到模型名里',
        moonshot: 'platform.moonshot.cn → API Key',
        ernie: '百度千帆 console.bce.baidu.com/qianfan → API Key',
      }[provider] || '到该平台控制台申请 API Key')
      + '）。');
  }
  if (provider === 'doubao' && !pc.model) {
    throw new Error('豆包需要填【推理接入点 ID】（形如 ep-2024xxxx），不是模型名。'
      + '到火山方舟控制台 →「在线推理」→ 创建接入点，把那串 ep- 开头的 ID 填进「设置 · API 模型」的豆包模型名里。');
  }
  const url = `${pc.baseUrl}/chat/completions`;
  const body = {
    model: pc.model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : pc.temperature,
    max_tokens: maxTokens || pc.maxTokens,
    stream: false,
  };
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + pc.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(pc.timeoutMs),
  };
  // 需要代理时（一般国内直连三家都不用）：用 undici ProxyAgent（Node 内置 fetch 支持 dispatcher）。
  if (pc.proxy) {
    try {
      const { ProxyAgent } = await import('undici');
      opts.dispatcher = new ProxyAgent(pc.proxy);
    } catch { onLog({ level: 'warn', msg: '未能加载 undici ProxyAgent，忽略代理直连' }); }
  }

  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`${pc.name} 调用超时(${Math.round(pc.timeoutMs / 1000)}s)`);
    throw new Error(`${pc.name} 连接失败：${e.message || e}`);
  }
  let data = null;
  try { data = await resp.json(); } catch {}
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || data?.msg || `HTTP ${resp.status}`;
    // 常见错误更友好
    if (resp.status === 401 || /invalid.*key|unauthorized|鉴权|token/i.test(msg)) throw new Error(`${pc.name} 鉴权失败（API Key 不对或已失效）：${msg}`);
    if (resp.status === 429 || /rate|quota|限流|额度/i.test(msg)) throw new Error(`${pc.name} 限流/额度用尽：${msg}`);
    // 订阅制平台的模型名与按量付费那套不同，填错只会得到一句 Model not exist —— 直接告诉用户怎么查。
    if (/model.*not.*exist|model_not_found/i.test(msg)) {
      throw new Error(`${pc.name} 没有模型「${pc.model}」。该平台的模型名与按量付费那套不同，`
        + `跑 \`novel models --list ${provider}\` 可以列出当前可用的模型名，再到设置里改。原始信息：${msg}`);
    }
    throw new Error(`${pc.name} 返回错误 ${resp.status}：${msg}`);
  }
  const content = data?.choices?.[0]?.message?.content
    || (Array.isArray(data?.choices?.[0]?.message?.content) ? data.choices[0].message.content.map(x => x.text || '').join('') : '')
    || '';
  if (!content || !String(content).trim()) throw new Error(`${pc.name} 返回空内容（choices 无正文）`);
  return { content: String(content), usage: data?.usage || null, model: pc.model };
}

// —— 本地模型调用 ——
// flavor 只探一次并缓存：每章都去探一遍 /api/version 是白白多一次往返。
const flavorCache = new Map();
async function detectFlavor(pc) {
  if (pc.flavor && pc.flavor !== 'auto') return pc.flavor;
  const root = serverRoot(pc.baseUrl);
  if (flavorCache.has(root)) return flavorCache.get(root);
  let f = 'openai';
  try {
    const r = await fetch(root + '/api/version', { signal: AbortSignal.timeout(4000) });
    if (r.ok && (await r.json().catch(() => null))?.version) f = 'ollama';
  } catch {}
  flavorCache.set(root, f);
  return f;
}

// 本地连不上/模型没拉，给出能照做的提示——本地部署的失败几乎全是这三种，别让用户对着 fetch failed 猜。
function localError(e, pc) {
  const m = e?.message || String(e);
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new Error(`本地模型超时（${Math.round(pc.timeoutMs / 60000)} 分钟未出结果）。`
      + `多半是模型太大溢出到内存在龟速跑：换小一档（如 qwen3:14b），或调小 numCtx。`);
  }
  if (/ECONNREFUSED|fetch failed|connect|socket/i.test(m)) {
    return new Error(`连不上本地模型服务 ${pc.baseUrl} —— 服务没启动。`
      + `Ollama：任意终端跑 \`ollama serve\`；LM Studio：开 Local Server 并把地址改成 http://127.0.0.1:1234/v1。`);
  }
  return new Error(`本地模型调用失败：${m}`);
}

async function localChat({ pc, messages, temperature, maxTokens, onLog }) {
  const flavor = await detectFlavor(pc);
  const temp = typeof temperature === 'number' ? temperature : pc.temperature;
  const maxTok = maxTokens || pc.maxTokens;
  const root = serverRoot(pc.baseUrl);

  // 粗估上下文占用：中文约 1 字 ≈ 1 token，英文/标点更省。喂料超过 num_ctx 的 80% 就预警——
  // 这是本地模型"写着写着开始跑题"的头号原因，而它本身【不会报错】，只会安静地把前面截掉。
  const chars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  const estIn = Math.round(chars * 0.8);
  if (flavor === 'ollama' && estIn + maxTok > pc.numCtx * 0.95) {
    onLog({ level: 'warn', msg: `  ⚠ 上下文吃紧：喂料≈${estIn} + 输出上限 ${maxTok} 已接近 num_ctx ${pc.numCtx}`
      + `（超出部分会被静默截断→跑题/复读）。建议把「本地上下文长度」调到 ${Math.ceil((estIn + maxTok) / 4096) * 4096} 以上，或减小每章目标字数。` });
  }

  if (flavor === 'ollama') {
    // 原生 /api/chat：唯一能显式指定 num_ctx 的路径（OpenAI 兼容端点不透传，默认 4096 会截断长上下文）。
    const body = {
      model: pc.model, messages, stream: false, keep_alive: pc.keepAlive,
      think: pc.think,
      options: { num_ctx: pc.numCtx, temperature: temp, num_predict: maxTok },
    };
    const post = (b) => fetch(root + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b), signal: AbortSignal.timeout(pc.timeoutMs),
    });
    let resp;
    try { resp = await post(body); } catch (e) { throw localError(e, pc); }
    let data = await resp.json().catch(() => null);
    // 非推理模型收到 think 字段会报错——这不是用户的错，去掉重试一次即可。
    if (!resp.ok && /think/i.test(String(data?.error || ''))) {
      const { think, ...noThink } = body;
      try { resp = await post(noThink); data = await resp.json().catch(() => null); }
      catch (e) { throw localError(e, pc); }
    }
    if (!resp.ok) {
      const msg = data?.error || `HTTP ${resp.status}`;
      if (/not found|no such model|pull/i.test(String(msg))) {
        throw new Error(`本地没有模型「${pc.model}」。先拉一个：ollama pull ${pc.model}（或到设置里改成已装的模型）。原始信息：${msg}`);
      }
      throw new Error(`本地模型返回错误 ${resp.status}：${msg}`);
    }
    // 兜底：即使 think:false，个别模型/模板仍会把 <think> 段写进 content——剥掉再交给下游，
    // 否则 parseChapters 有可能把模型「在思考里演练的格式」当成正文抓走。
    const content = stripThink(data?.message?.content || '');
    if (!String(content).trim()) throw new Error('本地模型返回空内容（可能 num_predict 太小或模型加载失败）');
    return {
      content: String(content), model: pc.model,
      // 对齐 OpenAI 的 usage 字段名，让记账/日志那套原样复用（本地单价为 0，只统计量）。
      usage: { prompt_tokens: data?.prompt_eval_count || 0, completion_tokens: data?.eval_count || 0,
               total_tokens: (data?.prompt_eval_count || 0) + (data?.eval_count || 0) },
    };
  }

  // LM Studio / llama.cpp / vLLM：标准 OpenAI 兼容端点（各自在自己的界面里设上下文长度）。
  let resp;
  try {
    resp = await fetch(`${pc.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (pc.apiKey || 'local') },
      body: JSON.stringify({ model: pc.model, messages, temperature: temp, max_tokens: maxTok, stream: false }),
      signal: AbortSignal.timeout(pc.timeoutMs),
    });
  } catch (e) { throw localError(e, pc); }
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`本地模型返回错误 ${resp.status}：${data?.error?.message || data?.error || 'HTTP ' + resp.status}`);
  const content = stripThink(data?.choices?.[0]?.message?.content || '');
  if (!String(content).trim()) throw new Error('本地模型返回空内容');
  return { content: String(content), usage: data?.usage || null, model: pc.model };
}

// 剥掉推理模型的思考段。含未闭合的情况（被 num_predict 截断时只有开标签，
// 那种回复本来也没有正文，剥完变空 → 上面会抛「返回空内容」，比把思考当正文落盘好得多）。
export function stripThink(s) {
  return String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

// 挑一个"能用的" provider（给书名实验、卷名生成这类顺手要调模型的功能用）。
// ⚠️ 这里必须包含 'local'——否则只配了本地模型的用户会拿到 null，功能直接报错。
// 之前 nameexp/volname 各自硬编码了 ['zhipu','deepseek','dashscope'] 两份，加本地 provider 时
// 正好两处都漏掉了。收成一处，以后新增 provider 不会再漏。
// 顺序上云端优先：它们快得多，而这类任务只调一两次、省不出什么钱；本地作为兜底。
export function pickProvider(cfg, order = ['zhipu', 'deepseek', 'dashscope', 'local']) {
  for (const p of order) if (API_PROVIDERS[p] && providerConfigured(p, cfg)) return p;
  return null;
}

// 探测某 provider 是否"配好了"（供 UI/detectModel 用）。
// 本地模型没有 key 的概念——只要配了地址就算配好，真正可用性由 localai.probeText 去探服务在不在。
export function providerConfigured(provider, cfg) {
  try {
    const pc = resolveProviderCfg(provider, cfg);
    return pc.keyless ? !!pc.baseUrl : !!pc.apiKey;
  } catch { return false; }
}
