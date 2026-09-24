// 网页版封面生成（Gemini）：驱动【已登录的 gemini.google.com】出一张竖版封面插画，
// 下载存成 book.dir/cover_bg.png（前端 canvas 当背景叠字）。与 covergen_web.mjs（ChatGPT 版）并列，
// 两条路只有「怎么把提示词送进去、怎么认出那张图」不同，其余流程一致。
//
// 这几条都是 2026-09-15 在 lxd220 账号上实测出来的，不是照 ChatGPT 那套猜的：
//   ① 输入框是 Quill：div.ql-editor[contenteditable]（aria-label「为 Gemini 输入提示」），
//      trustedType 打进去没问题。
//   ② 发送键 aria-label 恰好是「发送」（图标 mat-icon fonticon=arrow_upward），
//      ⚠️【绝不能用 aria 模糊匹配】——侧栏历史里有个对话叫「待发送的详细内容」，
//      它的"更多选项"按钮 aria 里也含"发送"，模糊匹配会点开那个菜单，然后什么都没发生
//      （我第一版就这么静默失败了 6 分钟）。故用【精确】选择器 button[aria-label="发送"]。
//   ③ 提交方式必须是【可信点击】(browser_click 选择器版)：el.click()、pressKey('Enter')、
//      按坐标 CDP 直投，三种都试过，都不提交——Angular Material 不认。
//   ④ 判定"真的提交了"看【输入框被清空】，这是最硬的信号（实测点完 1.5s 内清空）。
//   ⑤ 出的图 src 是 blob:https://gemini.google.com/...，不是 http 图床链接。
//      ChatGPT 那条用的 fetch(src) 在这里【行不通】——实测报 Failed to fetch
//      （blob 绑在创建它的那个文档上下文里，外面取不到）。改成把 <img> 画进 canvas 再 toDataURL：
//      像素已经渲染在页面上了，同源图不污染画布，导得出来。fetch 保留做兜底（将来若换成 http 图床）。
//      实测尺寸 765×1024（3:4 竖版），正是封面要的比例。
import fs from 'node:fs';
import path from 'node:path';
import { UnzooClient } from './fanqie.mjs';
import { buildChatGptCoverPrompt } from './covergen_web.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDITOR = '.ql-editor';
// 精确匹配，别用 *= （理由见文件头 ②）
const SEND_SELECTORS = ['button[aria-label="发送"]', 'button[aria-label="Send"]', 'button[aria-label="Send message"]'];
// 兜底：只在输入框那一栏里找 arrow_upward 图标的按钮（换语言/改文案时还能兜住）
const SEND_IN_BOX_JS = 'var ed=document.querySelector(".ql-editor");'
  + 'var box=ed?(ed.closest("input-area-v2, .input-area-container, form, footer")||ed.parentElement.parentElement.parentElement):null;'
  + 'var scope=box?box.querySelectorAll("button"):[];'
  + 'for(var i=0;i<scope.length;i++){var b=scope[i];var a=(b.getAttribute("aria-label")||"").trim();'
  + 'var mi=b.querySelector("mat-icon");var fi=mi?(mi.getAttribute("fonticon")||mi.textContent||"").trim():"";'
  + 'if((a==="发送"||/^send( message)?$/i.test(a)||/arrow_upward/i.test(fi))&&!b.disabled) return b;}'
  + 'return null;';

const editorTextJs = `(function(){var e=document.querySelector('${EDITOR}');return e?(e.innerText||'').trim():'';})()`;

// 页面上「已生成的图」：可见的大图，且来自 blob: 或 Google 图床；取最新一张。
// 头像/图标会被 naturalWidth>=200 与可见性挡掉。
const FIND_IMG_JS = '(function(){'
  + 'var im=document.querySelectorAll("img");var out=[];'
  + 'for(var k=0;k<im.length;k++){var g=im[k];'
  + 'if(!g.offsetParent||g.naturalWidth<200) continue;'
  + 'var s=String(g.src||"");'
  + 'if(!/^blob:|googleusercontent|gstatic/.test(s)) continue;'
  + 'out.push(s);}'
  + 'return out.length?out[out.length-1]:"";})()';

async function waitEditor(client) {
  for (let i = 0; i < 15; i++) {
    if (await client.evaluate(`!!document.querySelector('${EDITOR}')`)) return true;
    await sleep(1000);
  }
  return false;
}

// 等输入框里的字【不再增长】：连续两次读到同样的长度就算打完；
// 另加一条下限——至少要到提示词长度的 85%，免得刚敲两个字就误判"稳定了"。
// 超时上限 40s（两三百字 × 22ms ≈ 6s，留足富余）。
export async function waitTypingSettled(client, wantLen, { pollMs = 400, maxPolls = 100 } = {}) {
  let last = -1, stable = 0;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const cur = String(await client.evaluate(editorTextJs) || '');
    if (cur.length === last && cur.length > 0) {
      stable++;
      if (stable >= 2 && cur.length >= Math.floor(wantLen * 0.85)) return cur;
      if (stable >= 6) return cur;         // 长度不再变但没到 85%：可能有字符被合并，别死等
    } else { stable = 0; }
    last = cur.length;
  }
  return String(await client.evaluate(editorTextJs) || '');
}

// 输入提示词并提交；返回成功与否。提交判据 = 输入框被清空。
async function sendPrompt(client, prompt, log) {
  if (!(await waitEditor(client))) throw new Error('Gemini 输入框没出现（页面未就绪或未登录）');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await client.click(EDITOR); } catch {}
    await sleep(400);
    // ⚠️【trustedType 抛错也不能中断】2026-09-21 实测：Unzoo 的 browser_type 打完字会做一次
    // 状态校验，而 Gemini 的 Quill 富文本框不更新它检查的那个属性，于是回 not_verified 并抛异常——
    // 可字【其实已经进去了】（现场证据：typed_len=253、dom_changed=true、page_feedback=changed）。
    // 原来这行没包 try，一抛错整个封面流程就断在这儿，下面那道真正的判据（waitTypingSettled
    // 读框里实际字数）根本没机会跑。所以这里只记一笔，把判断权交给下一步。
    try {
      await client.trustedType(EDITOR, prompt, { delayMs: 22, clearFirst: true });
    } catch (e) {
      const msg = String(e && e.message || e);
      // 真正的硬失败（框找不到/页面没开）还是要抛；只放过"打了但没验证到"这一类。
      if (!/not_verified|verify|未观察到/i.test(msg)) throw e;
      log && log('输入框状态校验没通过（Gemini 富文本框的老毛病），改以框里实际字数为准…', 'warn');
    }
    // ⚠️【trustedType 返回 ≠ 字打完了】——它是一个字一个字敲的（delayMs=22），
    // 封面提示词有两三百字，敲完要五六秒，而调用早就返回了。
    // 第一版只等 1.2 秒就去点发送：发出去的是【半截提示词】，紧接着剩下的字继续往框里落，
    // 于是"输入框没清空"，判成没提交 → 重试 → 再打一遍 → 越积越乱
    //（实测现场：框里先是上一轮的尾巴"图适合做书籍封面。"，点完发送后又冒出"面装疯卖傻，实则冷静…"）。
    // 所以必须等【字数不再增长】才算打完。
    const typed = await waitTypingSettled(client, prompt.length);
    if (!typed) { await sleep(800); continue; }              // 字没进去 → 重来一轮

    // ⚠️【发送键是打完字才渲染出来的】空输入框时 button[aria-label="发送"] 压根不存在（实测）。
    // 第一版只等了 1.2 秒就去找，找不到就退回 el.click() 兜底——而 el.click() 对 Angular 无效，
    // 于是"点了没提交"。所以这里【必须等它出现】再点，最多等 8 秒。
    let sendSel = '';
    for (let i = 0; i < 16 && !sendSel; i++) {
      for (const sel of SEND_SELECTORS) {
        const ok = await client.evaluate(`(function(){var b=document.querySelector('${sel}');return !!(b&&!b.disabled&&b.offsetParent);})()`);
        if (ok) { sendSel = sel; break; }
      }
      if (!sendSel) await sleep(500);
    }
    let clicked = false;
    if (sendSel) { try { await client.click(sendSel); clicked = true; } catch {} }
    // 兜底：换了语言/改了文案时按图标找（这条走 el.click()，成功率低，只是聊胜于无）
    if (!clicked) { try { clicked = !!(await client.clickByLocator(SEND_IN_BOX_JS)); } catch {} }

    // 校验：输入框清空了才算真发出去
    for (let i = 0; i < 10; i++) {
      await sleep(900);
      const left = String(await client.evaluate(editorTextJs) || '');
      if (!left) { log && log('已把封面描述发给 Gemini，开始生图…'); return; }
    }
    log && log('发送键点了但输入框没清空，重试一次…', 'warn');
  }
  throw new Error('无法把提示词发给 Gemini（发送键点了但没提交）。请确认该账号浏览器已登录 Gemini 后重试。');
}

async function findGeneratedImage(client) {
  const r = await client.evaluate(FIND_IMG_JS);
  return (typeof r === 'string' && r) ? r : '';
}

// 等生图。实测 Gemini 比 ChatGPT 快得多（十几秒就出图），但排队时也可能久，
// 所以仍给到 7 分钟，轮询 6s 一次——比 ChatGPT 那条略快，因为它出图快、早拿到早收工。
async function waitForImage(client, log, deadlineMs = 7 * 60 * 1000) {
  const t0 = Date.now();
  let polls = 0;
  while (Date.now() - t0 < deadlineMs) {
    await sleep(6000);
    polls++;
    let src = '';
    try { src = await findGeneratedImage(client); } catch {}
    if (src) return src;
    if (polls % 5 === 0) {
      log && log(`仍在等 Gemini 出图…（已 ${Math.round((Date.now() - t0) / 1000)}s）`);
    }
  }
  return '';
}

// 【首选】把页面上那个 <img> 直接画进 canvas 再导出 dataURL。
// 为什么不像 ChatGPT 那条一样直接 fetch(src)：Gemini 的图是 blob:，实测 fetch 它会 Failed to fetch
//（blob 绑在创建它的那个文档上下文里，拿不到）。而 <img> 已经把像素渲染出来了，
// 同源图片画进 canvas 不会污染画布，toDataURL 照样能导出——绕开 blob 的取用限制。
async function grabViaCanvas(client, src) {
  const js = `(function(){
    try{
      var want=${JSON.stringify(src)};
      var im=document.querySelectorAll('img'), el=null;
      for(var i=im.length-1;i>=0;i--){ if(String(im[i].src||'')===want){ el=im[i]; break; } }
      if(!el) return 'ERR:没找到那个 img 元素';
      if(!el.naturalWidth) return 'ERR:图还没渲染完';
      var c=document.createElement('canvas');
      c.width=el.naturalWidth; c.height=el.naturalHeight;
      c.getContext('2d').drawImage(el,0,0);
      return c.toDataURL('image/png');
    }catch(e){ return 'ERR:'+((e&&e.message)||e); }
  })()`;
  const v = await client.evaluate(js);
  if (typeof v === 'string' && v.indexOf('data:image') === 0) return v;
  throw new Error(String(v || '').replace(/^ERR:/, '') || 'canvas 导出失败');
}

// 页面内 fetch(src) → dataURL（ChatGPT 那条走的就是这个；Gemini 这边作为兜底）。
async function downloadImageDataUrl(client, src) {
  await client.evaluate(`(function(){
    window.__coverDL=null;
    fetch(${JSON.stringify(src)},{credentials:'include'})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.blob(); })
      .then(function(b){ return new Promise(function(res){ var fr=new FileReader(); fr.onload=function(){res(String(fr.result));}; fr.readAsDataURL(b); }); })
      .then(function(d){ window.__coverDL=d; })
      .catch(function(e){ window.__coverDL='ERR:'+(e&&e.message||e); });
    return 'started';
  })()`);
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    const v = await client.evaluate('window.__coverDL');
    if (typeof v === 'string' && v.indexOf('data:image') === 0) return v;
    if (typeof v === 'string' && v.indexOf('ERR:') === 0) throw new Error('下载图片失败：' + v.slice(4));
  }
  throw new Error('下载图片超时');
}

// 取图：canvas 优先，拿不到再退回 fetch（http 图床的场景 fetch 反而更直接）。
async function fetchCover(client, src) {
  try { return await grabViaCanvas(client, src); }
  catch (e) {
    // canvas 这条走不通（图跨域污染了画布 / 元素已被替换）→ 退回 fetch
    return await downloadImageDataUrl(client, src);
  }
}

// 存盘 + 读 PNG 宽高
function saveCover(book, dataUrl, minBytes = 2000, outFile) {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < minBytes) throw new Error('图片异常（过小），可能不是成品图');
  // outFile：带字成品封面直接落 cover.png；不传仍是无字底图 cover_bg.png（老行为）
  const file = outFile || path.join(book.dir, 'cover_bg.png');
  fs.mkdirSync(book.dir, { recursive: true });
  fs.writeFileSync(file, buf);
  let w = 0, h = 0;
  try { if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); } } catch {}
  return { file, w, h, bytes: buf.length };
}

// 主流程：Gemini 网页版生成封面底图 → 存 book.dir/cover_bg.png
export async function generateCoverViaGemini(book, { prompt, profilePath, onLog, outFile } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!profilePath) throw new Error('缺少 profilePath（需绑定已登录 Gemini 的 Unzoo 账号）');
  const client = new UnzooClient(profilePath, onLog, 'gemini.google.com', 'Gemini');
  const art = (prompt && prompt.trim()) || buildChatGptCoverPrompt(book);   // 提示词与 ChatGPT 版共用一套

  await client.getActiveTab();
  log('正在打开 Gemini 新对话…');
  await client.navigate('https://gemini.google.com/app');
  await sleep(3000);

  await sendPrompt(client, art, log);

  const src = await waitForImage(client, log);
  if (!src) throw new Error('Gemini 生图超时（>7 分钟未出图）。可能在排队，过一会儿重试即可。');

  log('图片已生成，正在取像素存盘…');
  const r = saveCover(book, await fetchCover(client, src), 2000, outFile);
  log('✅ 封面底图已保存');
  return { ...r, prompt: art };
}

// 手动【抓取封面】：不发提示词——直接从当前 Gemini 页把已生成好的图抓下来。
// 用于自动流程超时/漏检、但你在浏览器里已看到图成了的场景。
export async function grabCoverFromGemini(book, { profilePath, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!profilePath) throw new Error('缺少 profilePath（需绑定已登录 Gemini 的 Unzoo 账号）');
  const client = new UnzooClient(profilePath, onLog, 'gemini.google.com', 'Gemini');
  await client.getActiveTab();   // 锁定该账号的 Gemini 页，不新开对话（保留你看到图的那一页）
  log('正在从当前 Gemini 页抓取已生成的图…');
  let src = '';
  try { src = await findGeneratedImage(client); } catch {}
  if (!src) {
    log('当前页没直接读到图，刷新一次再抓…');
    try { await client.reload(); } catch {}
    for (let i = 0; i < 6 && !src; i++) { await sleep(1500); try { src = await findGeneratedImage(client); } catch {} }
  }
  if (!src) throw new Error('没在当前 Gemini 页找到已生成的封面图。请确认那一页最后一条回复里确有大图，再刷新一下页面后重试。');
  log('找到图片，正在取像素存盘…');
  const r = saveCover(book, await fetchCover(client, src));
  log('✅ 已抓取封面底图并保存');
  return r;
}
