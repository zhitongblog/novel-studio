// Unzoo 调用层自测：钉住「只走官方 MCP 端点」这条线不被兼容层污染。
//
// 背景：Unzoo 2.5.28 实测——同一个工具经统一分发端点 /api/v1/tools/call 与 CLI 会报
// `Unknown command: browser.set_input_files`，走官方 /api/v1/mcp/tools/call 才正常；
// 扁平端点 /api/v1/<动作> 又是第三套语义（例：/api/v1/set_input_files 直接塞文件，
// 而同名 MCP 工具 browser_set_input_files 是"预备拦截下一个文件对话框"）。
// 我们统一只用官方 MCP，本测试防止有人手滑把兼容层写回来。
//
// 分两段：
//   A. 纯静态（无需 Unzoo 在跑）——解包逻辑 + 源码里不许出现兼容层端点
//   B. 联机（Unzoo 没跑就自动跳过）——在本地 file:// 测试页上验 isTrusted
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// ===== A. 静态：源码里不许再出现兼容通道 =====
{
  // 只允许 unzoo.mjs 自己在注释里提这些名字（它要解释为什么弃用）
  const banned = [
    ['/api/v1/tools/call', '统一分发端点（覆盖不全）'],
    ['/api/v1/set_input_files', '扁平上传端点'],
    ['/api/v1/click', '扁平坐标点击'],
    ['/api/v1/type', '扁平键盘'],
    ['/api/v1/dialog/handle', '扁平弹窗'],
    ['/api/v1/profiles/launch', '扁平 profile 启动'],
    ['/api/v1/screenshot', '扁平截图'],
    ['/api/v1/navigate', '扁平导航'],
    ['/api/v1/tabs', '扁平标签页'],
  ];
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.mjs') && f !== 'unzoo.mjs');
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const line of src.split(/\r?\n/)) {
      const code = line.replace(/\/\/.*$/, '');          // 注释里提到不算（历史说明）
      if (/^\s*\/\//.test(line)) continue;
      for (const [ep, why] of banned) {
        if (code.includes(`'${ep}'`) || code.includes(`"${ep}"`) || code.includes('`' + ep)) {
          hits.push(`${f}: ${ep}（${why}）`);
        }
      }
    }
  }
  assert.deepStrictEqual(hits, [], '业务代码里不许直连 Unzoo 兼容层端点，一律走 src/unzoo.mjs：\n' + hits.join('\n'));
  console.log(`✓ ${files.length} 个源文件里没有兼容层端点直连`);
}

// ===== A2. 解包逻辑：三种响应形状 =====
{
  const { mcpCall } = await import('../src/unzoo.mjs');
  const real = globalThis.fetch;
  const mock = (payload, ok = true) => {
    globalThis.fetch = async () => ({ ok, status: ok ? 200 : 500, json: async () => payload });
  };
  try {
    // ① 文本 JSON
    mock({ content: [{ type: 'text', text: '{\n "result": 2\n}' }] });
    assert.deepStrictEqual(await mcpCall('browser_evaluate', {}), { result: 2 }, 'JSON 文本要 parse 出来');

    // ① 纯文本（a11y 快照那类）
    mock({ content: [{ type: 'text', text: 'Page: 标题\n- button "提交"' }] });
    assert.match(await mcpCall('browser_a11y_snapshot', {}), /^Page: /, '非 JSON 文本原样返回');

    // ② 图片
    mock({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: '' }] });
    assert.deepStrictEqual(await mcpCall('browser_screenshot', {}), { image_base64: 'AAAA', mimeType: 'image/png' });

    // ③ 工具错 → 抛异常，且剥掉 "Error: " 前缀
    mock({ content: [{ type: 'text', text: "Error: press_key: missing 'key'" }], isError: true });
    await assert.rejects(() => mcpCall('browser_press_key', {}), /missing 'key'/);

    // ④ 网关错（非 lease）→ 抛异常
    mock({ error: 'Unknown command: browser.set_input_files', success: false });
    await assert.rejects(() => mcpCall('browser_set_input_files', {}), /Unknown command/);

    // 空载荷 → null
    mock({ content: [{ type: 'text', text: '' }] });
    assert.strictEqual(await mcpCall('page_click', {}), null);
  } finally { globalThis.fetch = real; }
  console.log('✓ 四种响应形状（文本/图片/工具错/网关错）解包正确');
}

// ===== A3. lease 自动续租：报错文案是帕斯卡、API 只认蛇形，转换不能错 =====
{
  const { mcpCall } = await import('../src/unzoo.mjs');
  const real = globalThis.fetch;
  const seen = [];
  let firstCall = true;
  globalThis.fetch = async (url, opt) => {
    const u = String(url);
    const body = opt?.body ? JSON.parse(opt.body) : {};
    seen.push({ u, body });
    if (u.includes('/lease/request')) return { ok: true, status: 200, json: async () => ({ data: { id: 'L1' }, success: true }) };
    if (u.includes('/lease/grant')) return { ok: true, status: 200, json: async () => ({ data: { state: 'granted' }, success: true }) };
    if (firstCall) {
      firstCall = false;
      return { ok: true, status: 200, json: async () => ({ success: false, error: "capability lease required for 'browser_screenshot' (channel=mcp): no valid lease for capability=DesktopObserve holder=mcp" }) };
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'image', data: 'ZZ', mimeType: 'image/png' }] }) };
  };
  try {
    const r = await mcpCall('browser_screenshot', {});
    assert.strictEqual(r.image_base64, 'ZZ', '取到租约后要自动重试并成功');
    const req = seen.find(s => s.u.includes('/lease/request'));
    assert.ok(req, '必须发起过 lease/request');
    assert.strictEqual(req.body.capability, 'desktop_observe',
      '报错文案给的是 DesktopObserve，但 API 只认 desktop_observe——必须转蛇形，照抄会被拒');
  } finally { globalThis.fetch = real; }
  console.log('✓ lease 被拒时自动 request+grant 重试，能力名帕斯卡→蛇形转换正确');
}

// ===== B. 联机：本地测试页验 isTrusted（Unzoo 没跑就跳过）=====
const BASE = process.env.UNZOO_BASE || 'http://127.0.0.1:9399';
let online = false;
try {
  const r = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(2500) });
  online = r.ok;
} catch {}

if (!online) {
  console.log('⏭  Unzoo 未运行，跳过联机验证（isTrusted 实测）');
} else {
  const { mcpCall, evaluate, clickAt, inputText, createTab } = await import('../src/unzoo.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns_unzoo_'));
  const page = path.join(dir, 'probe.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>probe</title>
<button id="b" style="position:absolute;left:100px;top:200px;width:200px;height:60px">t</button>
<div id="e" contenteditable style="position:absolute;left:100px;top:300px;width:300px;height:60px;border:1px solid #999"></div>
<script>window.__ev={c:[],i:[]};
document.getElementById('b').addEventListener('click',e=>__ev.c.push({t:e.isTrusted,x:e.clientX,y:e.clientY}));
document.getElementById('e').addEventListener('input',e=>__ev.i.push({t:e.isTrusted,v:document.getElementById('e').textContent}));
</script>`, 'utf8');

  let tab = null;
  try {
    tab = await createTab('file:///' + page.replace(/\\/g, '/'));
    assert.ok(tab, '应能新建标签页');
    await new Promise(r => setTimeout(r, 2000));

    // ⚠️page_click / browser_press_key 是 OS 级输入：浏览器窗口不在前台时【静默无操作】
    //（返回 null、不报错、一个事件都不产生）。生产代码里由 UnzooClient.ensureForeground() 保证，
    // 这里必须照做，否则本用例会随"当前哪个窗口在前台"随机红/绿。
    await mcpCall('tab_activate', { tab_id: String(tab) });
    await new Promise(r => setTimeout(r, 800));

    const box = await evaluate(tab, `(function(){var r=document.getElementById('b').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    await clickAt(tab, box.x, box.y);
    await new Promise(r => setTimeout(r, 700));
    const clicks = await evaluate(tab, `window.__ev.c`);
    assert.ok(clicks?.[0]?.t === true, 'page_click 必须产出 isTrusted=true 的点击（替代已弃用的 /api/v1/click）');
    assert.strictEqual(clicks[0].x, box.x, '点击坐标要精确命中');

    await evaluate(tab, `(function(){document.getElementById('e').focus();return 1;})()`);
    await inputText(tab, '可信输入');
    await new Promise(r => setTimeout(r, 700));
    const inputs = await evaluate(tab, `window.__ev.i`);
    assert.ok(inputs?.[0]?.t === true, 'browser_input_text 必须产出 isTrusted=true 的输入（替代已弃用的 /api/v1/type）');
    assert.strictEqual(inputs[inputs.length - 1].v, '可信输入', '文本要真的落进编辑器');

    // browser_input_text 是标签页定向的，不需要前台——这正是它比 press_key 可靠的地方
    console.log('✓ 联机：page_click / browser_input_text 均 isTrusted=true 且落点正确');
  } finally {
    if (tab != null) { try { await mcpCall('tab_close', { tab_id: tab }); } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

console.log('\n全部通过 ✅  Unzoo 调用层只走官方 MCP');
