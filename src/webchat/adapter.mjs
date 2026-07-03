// 网页聊天适配器接口 + 通用驱动流程。
//
// 「网页版写作」是第三种写作引擎：不跑本地 CLI，而是驱动 通义千问/ChatGPT/Claude 的
// 网页聊天框来产文字（白嫖各家免费额度）。模型只吐文字、不能写文件——所以落盘/解析/更新
// 索引台账全部由 Novel Studio 自己做（见 ../webwriter.mjs）。
//
// 一个「站点适配器」需要提供：
//   - id / name / url：站点标识与聊天页地址（如 chat.qwen.ai / chatgpt.com / claude.ai）
//   - selectors：输入框、发送按钮、最新回答容器、生成中/完成判定、（可选）继续生成按钮
//   - send(client, promptText)：把 prompt 填进输入框并发送
//   - waitDone(client, {timeoutMs})：轮询直到本轮回答流式结束
//   - readLatest(client)：抓最新一条回答的纯文本
// client = 从 ../fanqie.mjs 复用的 UnzooClient（走 Unzoo REST 驱动浏览器）。
//
// 三个具体站点适配器实现见 ./qwen.mjs / ./chatgpt.mjs / ./claude.mjs。
// 由于无法联网实测真实 DOM，选择器均为「最合理猜测 + // TODO 校准」，后续对着真实页面改选择器即可。

// 命中这些关键词判定为「不可继续」（额度/登录/人机验证），上层应优雅停并提示。
export const BLOCK_KEYWORDS = [
  '已达上限', '达到上限', '额度已用', '免费额度', '本次对话已达',
  '请登录', '登录后', '重新登录', '登录以继续', '会话已过期',
  '人机验证', '安全验证', '验证码', '请稍后再试', '访问过于频繁',
  'usage limit', 'rate limit', 'you\'ve reached', 'please log in', 'sign in to continue',
  'verify you are human', 'too many requests',
];

// 通用超时轮询工具：反复跑 fn()，直到它返回真值或超时。返回最后一次结果（超时则返回 null）。
export async function pollUntil(fn, { timeoutMs = 300000, intervalMs = 1500, onLog } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await fn(); } catch (e) { if (onLog) onLog({ level: 'warn', msg: '轮询出错（继续重试）：' + (e.message || e) }); }
    if (last) return last;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// 检测整页是否命中「不可继续」关键词（额度/登录/验证）。返回命中的关键词或 null。
export async function detectBlocked(client) {
  try {
    const hit = await client.evaluate(`
      (function(){
        const text = (document.body && document.body.innerText || '').toLowerCase();
        const kws = ${JSON.stringify(BLOCK_KEYWORDS.map(k => k.toLowerCase()))};
        for (const kw of kws) { if (text.includes(kw)) return kw; }
        return null;
      })()
    `);
    return hit || null;
  } catch { return null; }
}

// ===== 通用驱动流程 =====
// send → waitDone → readLatest，返回本轮回答纯文本。
// 任一步命中「不可继续」关键词则抛错（含 BLOCKED 前缀），上层据此优雅停。
export async function chatOnce(client, adapter, promptText, { onLog = () => {}, timeoutMs = 480000 } = {}) {
  // 0) 先确保浏览器标签页就绪并停在目标聊天页
  await ensureOnSite(client, adapter, { onLog });

  // 1) 发送前先探一下有没有被拦（额度/登录/验证）
  let blk = await detectBlocked(client);
  if (blk) throw new Error('BLOCKED：页面提示「' + blk + '」→ 无法继续（请检查登录/额度/人机验证）');

  onLog({ level: 'act', msg: `网页版[${adapter.name}]：发送上下文包（${Math.round(promptText.length / 1000)}K 字）…` });
  await adapter.send(client, promptText);

  // 2) 等待本轮流式回答结束
  onLog({ level: 'info', msg: `网页版[${adapter.name}]：等待模型生成…` });
  const done = await adapter.waitDone(client, { timeoutMs, onLog });
  if (!done) {
    // 超时——仍尝试读一次已生成的部分（可能只是判定不准），但标注超时
    blk = await detectBlocked(client);
    if (blk) throw new Error('BLOCKED：等待中页面提示「' + blk + '」');
    onLog({ level: 'warn', msg: `网页版[${adapter.name}]：等待生成超时，尝试读取已生成内容` });
  }

  // 3) 读取最新一条回答
  const text = await adapter.readLatest(client);
  if (!text || !text.trim()) {
    blk = await detectBlocked(client);
    if (blk) throw new Error('BLOCKED：读取回答为空且页面提示「' + blk + '」');
    throw new Error('网页版：未读到模型回答（选择器可能需校准，或本轮未生成）');
  }
  return text;
}

// 确保 client 已锁定一个标签页并停在 adapter.url 对应的聊天页。
// 复用 UnzooClient.getActiveTab / navigate（它按 profilePath 锁定账号标签页）。
export async function ensureOnSite(client, adapter, { onLog = () => {} } = {}) {
  await client.getActiveTab();          // 锁定/自启该账号标签页
  let href = '';
  try { href = await client.evaluate('location.href'); } catch {}
  const host = adapterHost(adapter.url);
  if (!href || !String(href).includes(host)) {
    onLog({ level: 'info', msg: `网页版[${adapter.name}]：导航到 ${adapter.url}` });
    await client.navigate(adapter.url);
    await client.sleep(2500);
  }
}

function adapterHost(url) {
  try { return new URL(url).host; } catch { return url; }
}
