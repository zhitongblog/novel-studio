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

// 各家 provider 的默认 baseUrl / 默认模型（config.api.<provider> 可覆盖）。
export const API_PROVIDERS = {
  zhipu:     { name: '智谱 GLM',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  deepseek:  { name: 'DeepSeek',       baseUrl: 'https://api.deepseek.com',             model: 'deepseek-chat' },
  dashscope: { name: '通义千问 API',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
};

// 从全局 cfg 解析某 provider 的有效配置（apiKey / baseUrl / model / temperature / maxTokens / timeoutMs / proxy）。
export function resolveProviderCfg(provider, cfg) {
  const p = API_PROVIDERS[provider];
  if (!p) throw new Error('未知 API 提供方：' + provider + '（可选 zhipu|deepseek|dashscope）');
  const a = (cfg && cfg.api) || {};
  const u = (a[provider]) || {};
  return {
    provider,
    name: p.name,
    apiKey: (u.apiKey || '').trim(),
    baseUrl: (u.baseUrl || p.baseUrl).replace(/\/+$/, ''),
    model: u.model || p.model,
    temperature: typeof a.temperature === 'number' ? a.temperature : 0.85,
    maxTokens: a.maxTokens || 8192,
    timeoutMs: a.timeoutMs || 300000,
    proxy: a.proxy || '',
  };
}

// 调一次对话补全，返回 { content, usage }。messages = [{role:'system'|'user'|'assistant', content}]。
// 失败抛错（含状态码与服务端信息）；apiKey 缺失/额度/鉴权错都有明确提示。
export async function chatComplete({ provider, cfg, messages, temperature, maxTokens, onLog = () => {} }) {
  const pc = resolveProviderCfg(provider, cfg);
  if (!pc.apiKey) {
    throw new Error(`未配置 ${pc.name} 的 API Key。请在「设置」里填入 api.${provider}.apiKey（`
      + (provider === 'zhipu' ? '智谱 open.bigmodel.cn → API Keys，形如 id.secret；glm-4-flash 免费' : provider === 'deepseek' ? 'platform.deepseek.com → API Keys' : 'dashscope.console.aliyun.com → API-KEY')
      + '）。');
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
    throw new Error(`${pc.name} 返回错误 ${resp.status}：${msg}`);
  }
  const content = data?.choices?.[0]?.message?.content
    || (Array.isArray(data?.choices?.[0]?.message?.content) ? data.choices[0].message.content.map(x => x.text || '').join('') : '')
    || '';
  if (!content || !String(content).trim()) throw new Error(`${pc.name} 返回空内容（choices 无正文）`);
  return { content: String(content), usage: data?.usage || null, model: pc.model };
}

// 探测某 provider 是否已配 key（供 UI/detectModel 用）。
export function providerConfigured(provider, cfg) {
  try { return !!resolveProviderCfg(provider, cfg).apiKey; } catch { return false; }
}
