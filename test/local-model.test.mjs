// 本地模型链路的端到端验证：起两个【假服务】（Ollama / ComfyUI），跑真实代码打过去。
//
// 为什么值得单测：本地这条链路上有三个「不报错但会静默做错」的坑，靠肉眼 review 抓不住——
//   ① Ollama 的 num_ctx 没传过去 → 上下文被静默截断，表现是"写着写着跑题"，没有任何错误信息；
//   ② 走了 OpenAI 兼容端点而不是原生 /api/chat → 同上，且更隐蔽（能出文，只是喂料被砍了）；
//   ③ 本地请求被全局代理带走 → 127.0.0.1 经 Clash 变 502。
// 所以这里断言的不只是"能出结果"，而是【请求体里到底带了什么】。
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import { chatComplete, resolveProviderCfg, providerConfigured, isKeylessProvider, stripThink } from '../src/apichat.mjs';
import { probeText, probeImage, recommendText, recommendImage } from '../src/localai.mjs';
import { generateLocalImage } from '../src/imagelocal.mjs';

// 1×1 透明 PNG，当作 ComfyUI 出的图
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
const close = (s) => new Promise((r) => s.close(r));

function readBody(req) {
  return new Promise((res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { res(JSON.parse(b)); } catch { res({}); } });
  });
}

// —— 假 Ollama ——
function fakeOllama({ models = ['qwen3:14b'], onChat = () => {} } = {}) {
  const seen = { chatBody: null, hitOpenAiEndpoint: false };
  const server = http.createServer(async (req, res) => {
    const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/version') return j(200, { version: '0.12.0' });
    if (req.url === '/api/tags') return j(200, { models: models.map((n) => ({ name: n, size: 9.3e9 })) });
    if (req.url === '/api/chat') {
      seen.chatBody = await readBody(req);
      onChat(seen.chatBody);
      return j(200, {
        message: { role: 'assistant', content: '<think>盘算一下</think>第一章正文……' },
        prompt_eval_count: 1234, eval_count: 567, done: true,
      });
    }
    // 兼容端点：本地路径【不应该】走这里
    if (req.url === '/v1/chat/completions') {
      seen.hitOpenAiEndpoint = true;
      return j(200, { choices: [{ message: { content: 'WRONG ENDPOINT' } }] });
    }
    j(404, { error: 'nope' });
  });
  return { server, seen };
}

// —— 假 ComfyUI ——
function fakeComfy() {
  const seen = { workflow: null };
  const server = http.createServer(async (req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/system_stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ devices: [{ name: 'FakeGPU', vram_total: 12e9, vram_free: 10e9 }] }));
    }
    if (u === '/prompt') {
      const b = await readBody(req);
      seen.workflow = b.prompt;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ prompt_id: 'abc123def' }));
    }
    if (u.startsWith('/history/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        abc123def: { status: { status_str: 'success' }, outputs: { 10: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } },
      }));
    }
    if (u === '/view') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404); res.end();
  });
  return { server, seen };
}

// ============ 文本侧 ============

test('本地 provider：不需要 key 也算配置就绪，且强制不走代理', () => {
  assert.ok(isKeylessProvider('local'));
  assert.ok(!isKeylessProvider('zhipu'));
  // 就算全局配了代理，本地也必须直连——127.0.0.1 经代理会被吞成 502
  const pc = resolveProviderCfg('local', { api: { proxy: 'http://127.0.0.1:7897', local: {} } });
  assert.strictEqual(pc.proxy, '', '本地 provider 不得继承全局代理');
  assert.strictEqual(pc.keyless, true);
  assert.ok(pc.timeoutMs >= 900000, '本地超时要远大于云端的 5 分钟，否则长章会被误杀');
  // 没填 key 也应判为"已配置"（否则 UI 会拦住不让写）
  assert.ok(providerConfigured('local', { api: { local: {} } }));
  assert.ok(!providerConfigured('zhipu', { api: { zhipu: {} } }));
});

test('本地写作：走 Ollama 原生 /api/chat 并显式传 num_ctx（这是防静默截断的关键）', async () => {
  const { server, seen } = fakeOllama();
  const port = await listen(server);
  const cfg = { api: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen3:14b', numCtx: 16384 } } };

  const r = await chatComplete({ provider: 'local', cfg, messages: [{ role: 'user', content: '写第一章' }] });

  assert.strictEqual(seen.hitOpenAiEndpoint, false, '认出 Ollama 后不该再走 /v1 兼容端点（它不透传 num_ctx）');
  assert.ok(seen.chatBody, '应打到 /api/chat');
  assert.strictEqual(seen.chatBody.options.num_ctx, 16384, 'num_ctx 必须显式传，否则 Ollama 默认 4096 会静默砍掉上下文包');
  assert.strictEqual(seen.chatBody.stream, false);
  assert.ok(seen.chatBody.keep_alive, '要带 keep_alive，否则每章都重新加载模型');
  // usage 要对齐 OpenAI 字段名，记账那套才能原样复用
  assert.strictEqual(r.usage.prompt_tokens, 1234);
  assert.strictEqual(r.usage.completion_tokens, 567);
  assert.ok(r.content.includes('第一章正文'));

  await close(server);
});

test('本地写作：服务没起时报错要能照做，而不是 fetch failed', async () => {
  const cfg = { api: { local: { baseUrl: 'http://127.0.0.1:1/v1', model: 'qwen3:14b' } } };
  await assert.rejects(
    () => chatComplete({ provider: 'local', cfg, messages: [{ role: 'user', content: 'hi' }] }),
    (e) => /ollama serve|服务没启动|连不上/.test(e.message),
  );
});

test('本地写作：模型没拉时，报错要点名该跑哪条 pull', async () => {
  const { server } = fakeOllama();
  const port = await listen(server);
  // 让 /api/chat 返回 ollama 的 "model not found"
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.writeHead(req.url === '/api/version' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/version' ? { version: '0.12.0' } : { error: 'model "qwen3:99b" not found, try pulling it first' }));
  });
  const cfg = { api: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen3:99b' } } };
  await assert.rejects(
    () => chatComplete({ provider: 'local', cfg, messages: [{ role: 'user', content: 'hi' }] }),
    (e) => /ollama pull qwen3:99b/.test(e.message),
  );
  await close(server);
});

test('探测：认得出 Ollama 并列出已装模型', async () => {
  const { server } = fakeOllama({ models: ['qwen3:14b', 'qwen3:8b'] });
  const port = await listen(server);
  const r = await probeText(`http://127.0.0.1:${port}/v1`);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'ollama');
  assert.deepStrictEqual(r.models.map((m) => m.name), ['qwen3:14b', 'qwen3:8b']);
  await close(server);
});

// ============ 出图侧 ============

test('本地出图：ComfyUI 全流程（排队→轮询→取图）拿回真 PNG', async () => {
  const { server, seen } = fakeComfy();
  const port = await listen(server);
  const cfg = { image: { localBackend: 'comfy', comfy: { baseUrl: `http://127.0.0.1:${port}`, preset: 'sdxl', ckpt: 'guofeng.safetensors' } } };

  const buf = await generateLocalImage({ prompt: 'a Chinese swordsman', cfg });

  assert.ok(Buffer.isBuffer(buf) && buf.subarray(1, 4).toString() === 'PNG', '应拿回 PNG 二进制');
  const wf = seen.workflow;
  assert.strictEqual(wf['1'].inputs.ckpt_name, 'guofeng.safetensors', '大模型文件名要照配置传');
  assert.strictEqual(wf['2'].inputs.text, 'a Chinese swordsman');
  // 底图必须干净无字：书名是后期 canvas 叠的，模型自己画的字必糊
  assert.match(wf['3'].inputs.text, /text|watermark/, '负向提示必须摁住文字/水印');
  assert.strictEqual(wf['4'].inputs.height > wf['4'].inputs.width, true, '封面要竖版');
  await close(server);
});

test('本地出图：Qwen-Image preset 用 GGUF 加载器 + qwen_image 类型的 CLIP', async () => {
  const { server, seen } = fakeComfy();
  const port = await listen(server);
  const cfg = { image: { localBackend: 'comfy', comfy: { baseUrl: `http://127.0.0.1:${port}`, preset: 'qwen-image' } } };

  await generateLocalImage({ prompt: '一位提刀的少年，民国街巷', cfg });

  const wf = seen.workflow;
  assert.strictEqual(wf['1'].class_type, 'UnetLoaderGGUF');
  assert.strictEqual(wf['2'].inputs.type, 'qwen_image', 'CLIPLoader 类型填错会直接出废图');
  assert.strictEqual(wf['4'].inputs.text, '一位提刀的少年，民国街巷', 'Qwen-Image 原生懂中文，不该被翻成英文');
  await close(server);
});

test('本地出图：ComfyUI 拒绝工作流时，把 node_errors 摊开给用户', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid prompt' }, node_errors: { 1: 'ckpt_name not in list' } }));
  });
  const port = await listen(server);
  const cfg = { image: { localBackend: 'comfy', comfy: { baseUrl: `http://127.0.0.1:${port}` } } };
  await assert.rejects(
    () => generateLocalImage({ prompt: 'x', cfg }),
    (e) => /ckpt_name not in list/.test(e.message) && /文件名/.test(e.message),
  );
  await close(server);
});

test('探测：认得出 ComfyUI 并报显存', async () => {
  const { server } = fakeComfy();
  const port = await listen(server);
  const r = await probeImage('comfy', `http://127.0.0.1:${port}`);
  assert.strictEqual(r.ok, true);
  assert.match(r.info, /FakeGPU/);
  await close(server);
});

// ============ 选型建议 ============

test('选型建议：按显存分档，12G 卡给到 14B 而不是塞不下的 27B', () => {
  assert.strictEqual(recommendText(12288).pick.model, 'qwen3:14b');
  assert.strictEqual(recommendText(8192).pick.model, 'qwen3:8b');
  assert.strictEqual(recommendText(24576).pick.model, 'qwen3.8:27b');
  // 全部建议都应落在 Qwen 系——中文网文这条路上 Gemma 有翻译腔且不能出图
  for (const t of recommendText(12288).tiers) assert.match(t.model, /^qwen/);
  assert.ok(recommendImage(12288).pick === 'qwen-image');
  assert.ok(recommendImage(8192).pick === 'sdxl');
});

// ============ 混合推理模型的 <think> 段 ============
// Qwen3 默认先吐一段思考再写正文。这段思考会实打实吃掉 num_predict 预算——
// 思考花 3K token，正文就少 3K，表现是「章节写到一半没了、没有 <<<END>>>」，而且不报错。

test('本地写作：默认关掉 think，别让思考吃掉正文的输出预算', async () => {
  const { server, seen } = fakeOllama();
  const port = await listen(server);
  const cfg = { api: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qwen3:14b' } } };

  const r = await chatComplete({ provider: 'local', cfg, messages: [{ role: 'user', content: '写一章' }] });

  assert.strictEqual(seen.chatBody.think, false, '写网文不需要思考链，开着会截断正文');
  // 假服务回的内容带 <think>，下游不该看见它
  assert.ok(!r.content.includes('<think>'), '思考段必须剥干净');
  assert.ok(!r.content.includes('盘算一下'));
  assert.ok(r.content.startsWith('第一章正文'));
  await close(server);
});

test('本地写作：模型不支持 think 字段时，去掉重试而不是把错误甩给用户', async () => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/version') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ version: '0.12.0' })); }
    if (req.url === '/api/chat') {
      const body = await readBody(req);
      calls++;
      if ('think' in body) {   // 第一次带 think → 报错
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'model does not support thinking' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });   // 第二次不带 → 成功
      return res.end(JSON.stringify({ message: { content: '正文' }, prompt_eval_count: 10, eval_count: 5 }));
    }
    res.writeHead(404); res.end();
  });
  const port = await listen(server);
  const cfg = { api: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'llama3' } } };

  const r = await chatComplete({ provider: 'local', cfg, messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(calls, 2, '应自动去掉 think 重试一次');
  assert.strictEqual(r.content, '正文');
  await close(server);
});

test('stripThink：闭合 / 只有闭标签 / 被截断没闭合 三种都处理', () => {
  assert.strictEqual(stripThink('<think>盘算</think>正文A'), '正文A');
  assert.strictEqual(stripThink('没有思考段'), '没有思考段');
  assert.strictEqual(stripThink('一堆思考</think>正文B'), '正文B');
  // 被 num_predict 截断只剩开标签：剥完为空，上游会抛「返回空内容」——
  // 这比把思考当正文落盘好得多（后者会静默污染稿件）
  assert.strictEqual(stripThink('<think>被截断了没闭合'), '');
});

// ============ GGUF 手动导入（ollama pull 在国内拉不动时的退路）============
// Ollama 的 blob 在 Cloudflare R2，国内常见直连被墙、走代理也持续 EOF，pull 卡住下不完。
// 退路是从魔搭下 GGUF 再导入——但 GGUF 裸文件【不带 chat 模板】，
// 不补 TEMPLATE 就导入的话，模型会把整段对话当续写，输出驴唇不对马嘴【且不报错】。

test('导入 GGUF：Qwen 系必须补上 ChatML 模板和 stop 词', async () => {
  const { buildModelfile } = await import('../src/localai.mjs');
  const mf = buildModelfile({ ggufPath: String.raw`D:\AI\Qwen3-14B-Q4_K_M.gguf`, name: 'qwen3:14b', numCtx: 16384 });

  // Windows 反斜杠要转成正斜杠，否则 Modelfile 里会被当转义
  assert.match(mf, /^FROM D:\/AI\/Qwen3-14B-Q4_K_M\.gguf$/m);
  assert.match(mf, /TEMPLATE """/, '不补模板会让模型把对话当续写');
  assert.match(mf, /<\|im_start\|>system/);
  assert.match(mf, /PARAMETER stop "<\|im_end\|>"/, '缺 stop 词会一直往下吐到 num_predict 上限');
  assert.match(mf, /PARAMETER num_ctx 16384/);
});

test('导入 GGUF：不认识的模型族不硬塞模板（交给 Ollama 从元数据推）', async () => {
  const { buildModelfile } = await import('../src/localai.mjs');
  const mf = buildModelfile({ ggufPath: '/x/llama3.gguf', name: 'llama3:8b' });
  assert.ok(!mf.includes('TEMPLATE'), '猜错模板比不写模板更糟');
  assert.match(mf, /^FROM \/x\/llama3\.gguf$/m);
  assert.match(mf, /PARAMETER num_ctx/);
});

// ============ ComfyUI 报错翻译 ============
// ComfyUI 抛的是底层异常字符串，直译给用户等于没说。最坑的是 hostbuf_file_reader_read failed：
// 长得像 IO 错误，实际是【主机内存提交量不够】——报错里一个字都不提内存。
test('ComfyUI 报错要翻成能照做的处理办法', async () => {
  const { explainComfyError } = await import('../src/imagelocal.mjs');

  const mem = explainComfyError('[["execution_error",{"exception_message":"hostbuf_file_reader_read failed"}]]');
  assert.match(mem, /内存/, 'hostbuf 类错误必须点明是内存问题，而不是原样抛 IO 异常');
  assert.match(mem, /--cache-none/, '要给出可直接照抄的处理办法');

  const vram = explainComfyError('CUDA out of memory');
  assert.match(vram, /显存/);

  const name = explainComfyError('value not in list: ckpt_name');
  assert.match(name, /文件名/);

  // 认不出的错误原样透出，不要吞掉
  assert.match(explainComfyError('some brand new failure'), /some brand new failure/);
});

// ============ 模型类型走错路径 ============
// server.mjs 里有十几处「重写/续写/收尾/重建大纲」直接把 book.model 传给 startWriting，
// 没有一处校验类型。书的模型若是 api-*/web-*，全都会崩在 `m.seedArgs is not a function` ——
// 一句纯技术报错，用户完全看不懂发生了什么。入口拦一次，把话说清楚。
test('CLI 专用路径拿到 api/web 模型时，要给人话而不是 TypeError', async () => {
  const { writeLaunchScript } = await import('../src/writer.mjs');
  const book = { dir: 'D:/nonexistent', title: 't' };

  for (const id of ['api-local', 'api-zhipu', 'web-qwen']) {
    let err = null;
    try { writeLaunchScript(book, id, '写一章', {}); } catch (e) { err = e; }
    assert.ok(err, `${id} 应该被拦住`);
    assert.ok(!/seedArgs is not a function/.test(err.message),
      `${id}: 不能把 TypeError 原样抛给用户`);
    assert.match(err.message, /CLI 模型/, `${id}: 要说清楚这个功能需要什么`);
    assert.match(err.message, /怎么办/, `${id}: 要给出下一步`);
  }

  // CLI 模型不受影响（这里只验证没被这道闸拦掉；真正能不能跑由 detectModel 判断）
  let cliErr = null;
  try { writeLaunchScript(book, 'codex', '写一章', {}); } catch (e) { cliErr = e; }
  if (cliErr) assert.ok(!/CLI 模型/.test(cliErr.message), 'CLI 模型不该被这道闸拦住');
});

// ============ 共创模式的模型能力分类 ============
// 共创里有两类活，对模型要求完全不同：
//   · 出主意 / 写一章 —— 只要「喂 prompt 拿文本」，任何能对话的模型都行；
//   · 窗口模式        —— 要开可见 Unterm 窗口让 AI 自己写文件，非 CLI 不可。
// 原本一个 isCowriteModel 把两类一刀切成「必须 CLI」，导致本地模型连"出主意"都用不了，
// 而那一步根本不需要窗口。
test('共创：文本能力与开窗能力要分开判定', async () => {
  const { isCowriteTextModel, isCowriteWindowModel } = await import('../src/cowrite.mjs');

  // CLI 模型两样都行
  for (const id of ['claude', 'codex', 'gemini', 'qwen']) {
    assert.ok(isCowriteTextModel(id), `${id} 应能出文本`);
    assert.ok(isCowriteWindowModel(id), `${id} 应能开窗口`);
  }
  // API 模型（含本地）能出文本，但开不了窗口
  for (const id of ['api-local', 'api-zhipu', 'api-deepseek', 'api-dashscope']) {
    assert.ok(isCowriteTextModel(id), `${id} 应能出文本——这正是之前被误拦的`);
    assert.ok(!isCowriteWindowModel(id), `${id} 没有可执行文件，开不了窗口`);
  }
  // 网页版两样都不行（要驱动浏览器，不是这条路）
  assert.ok(!isCowriteTextModel('web-qwen'));
  assert.ok(!isCowriteWindowModel('web-qwen'));
});

// ============ 小模型「摆模板」的解析容错 ============
// 实测本地 qwen3:14b 会把两个分隔符当"框架"连着吐出来、正文写在 <<<END>>> 之后：
//     <<<CHAPTER 章号=2 标题=旧人重逢>>>\n<<<END>>>\n沈砚秋站在拳馆外……
// 死守"END 之前"会把整章判成空、报「AI 未按格式产出本章」，而正文其实好好地躺在下面。
test('解析：模型把 <<<END>>> 提前吐了、正文在其后，也要能救回来', async () => {
  const { parseChapters } = await import('../src/webwriter.mjs');
  const body = '沈砚秋站在拳馆外，望着那熟悉的街景。'.repeat(8);

  // ① 病例：END 紧跟在头部之后，正文在下面
  const bad = `<<<CHAPTER 章号=2 标题=旧人重逢>>>\n<<<END>>>\n${body}`;
  const r1 = parseChapters(bad);
  assert.strictEqual(r1.length, 1, '应该救回这一章而不是判成空');
  assert.strictEqual(r1[0].num, 2);
  assert.strictEqual(r1[0].title, '旧人重逢');
  assert.ok(r1[0].body.includes('沈砚秋站在拳馆外'));
  assert.ok(!r1[0].body.includes('<<<END>>>'), '救回时要把残留的 END 标记清掉');

  // ② 正常情况不受影响：正文在 END 之前
  const good = `<<<CHAPTER 章号=3 标题=正常>>>\n${body}\n<<<END>>>\n这是模型多嘴的收尾话，不该进正文。`;
  const r2 = parseChapters(good);
  assert.strictEqual(r2.length, 1);
  assert.ok(r2[0].body.includes('沈砚秋站在拳馆外'));
  assert.ok(!r2[0].body.includes('多嘴的收尾话'), 'END 之后的话仍应被丢掉');

  // ③ 真的被截断（前后都没正文）仍要判为失败，别把噪音当正文
  assert.strictEqual(parseChapters('<<<CHAPTER 章号=4 标题=空>>>\n<<<END>>>\n').length, 0);
});

// ============ API Key 不得明文回传前端 ============
// 【真实缺口】GET /api/config 一直走 maskConfig，但 POST /api/config（设置页保存走的就是它）
// 直接把 updateConfig 的结果原样返回 —— 于是每次点保存，所有 API key 都明文回到前端。
// 而且遮蔽名单原来是手写的三家，加 provider 时必漏。两条都锁住。
test('配置回传：所有需要 key 的 provider 都必须被遮蔽，且名单跟着 API_PROVIDERS 走', async () => {
  const { API_PROVIDERS } = await import('../src/apichat.mjs');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');

  // 遮蔽名单必须从 API_PROVIDERS 推导，不能是硬编码的几家
  assert.match(src, /Object\.keys\(API_PROVIDERS\)[\s\S]{0,80}maskApi|for \(const prov of Object\.keys\(API_PROVIDERS\)/,
    'maskConfig 的名单要从 API_PROVIDERS 推导，硬编码迟早漏');

  // GET 和 POST 两条 /api/config 都要经过 maskConfig
  const lines = src.split('\n').filter(l => l.includes("'/api/config'"));
  assert.ok(lines.length >= 2, '应有 GET 和 POST 两条 /api/config');
  for (const l of lines) {
    assert.match(l, /maskConfig/, `这条 /api/config 没走 maskConfig，key 会明文回传：${l.trim()}`);
  }

  // local 是唯一不需要 key 的，不该被要求遮蔽
  assert.ok(!API_PROVIDERS.local || API_PROVIDERS.local.local === true);
});

// ============ 段落呼吸闸 ============
// 【真实教训】提示词里写"段落要短、超 5 行增加跳出"，模型把它当指标最大化：
// 实测 155 段 / 3307 字、46% 的段落不到 10 字，一行一顿连一百多次，读起来像机关枪。
// 而且每加一轮规则它就更碎（96 → 126 → 155 段）。单向指标必然被推到极端，
// 所以不能只靠提示词，得真的量一遍。
test('段落呼吸：能抓出"机关枪体"，正常起伏的不误伤', async () => {
  const { paragraphHealth } = await import('../src/craft.mjs');

  // 病例：全是一行一顿（真实故障的形态）
  const machineGun = Array.from({ length: 40 }, (_, i) => `他看了一眼${i}。`).join('\n');
  const bad = paragraphHealth(machineGun);
  assert.strictEqual(bad.ok, false, '机关枪体必须被抓出来');
  assert.ok(bad.problems.length >= 2, '应同时报出短段占比和平均段长');
  assert.ok(bad.maxRun >= 8, '要能识别"连续多段都只有一行"');

  // 健康：2–5 句的段落为主，间或一句重锤
  const long = '沈砚秋把箱子换到左手，指腹擦过藤条上那圈旧布。布洗得发硬，边上有两针补痕。他没有回头，只把脚步放慢了半分，让身后那串脚步声先撞上来。';
  const healthy = Array.from({ length: 12 }, () => long).join('\n')
    + '\n他停住了。\n' + Array.from({ length: 10 }, () => long).join('\n');
  const good = paragraphHealth(healthy);
  assert.strictEqual(good.ok, true, `正常起伏不该被拦：${JSON.stringify(good.problems)}`);

  // 太短的文本不做判断，避免误伤片段
  assert.strictEqual(paragraphHealth('就一句话。').ok, true);
});
