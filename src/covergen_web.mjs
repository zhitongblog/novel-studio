// 网页版封面生成：驱动【已登录的 ChatGPT】(Pro，含生图) 出一张竖版封面插画，
// 下载存成 book.dir/cover_bg.png（前端 canvas 当背景叠字）。全程复用 UnzooClient（站点锁定 chatgpt.com）。
//
// 关键约束（用户明确要求「调用时注意节奏」）：
//   - 网页版生图慢（常 2~4 分钟），故用【大超时 + 温和轮询（8~9s 一次）】，绝不猛刷。
//   - ChatGPT 生图完成后前端有时卡在「预览」占位不渲染 → 用户实测【刷新页面】后完整图才出来，
//     故轮询里内置「过一会儿刷新一次取完整图」。
//   - 下载走【页面内 fetch(src,{credentials:'include'}) → base64】(带 ChatGPT 会话 cookie)，
//     用 window.__coverDL 轮询取回（避免 await_promise 在本环境返回空的坑）。
import fs from 'node:fs';
import path from 'node:path';
import { UnzooClient } from './fanqie.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从 novel_bible.md 抽时代/主角，拼一句【中文封面提示词】（不跑 CLI，快）。
function bibleBits(book) {
  let era = '', hero = '';
  try {
    const bible = fs.readFileSync(path.join(book.dir, 'novel_bible.md'), 'utf8');
    const em = bible.match(/时代\s*\/?\s*世界观[：:]\s*([^\n]+)/);
    if (em) era = em[1].replace(/[（(].*$/, '').trim().slice(0, 80);
    const hm = bible.match(/(?:^|\n)[-\s]*主角[：:]\s*([^\n]+)/);
    if (hm) hero = hm[1].replace(/[（(].*$/, '').trim().slice(0, 80);
  } catch {}
  return { era, hero };
}

// 组装发给 ChatGPT 的中文封面提示词。硬性要求：中国人/东亚面孔 + 该时代中国场景 + 无文字。
export function buildChatGptCoverPrompt(book) {
  const { era, hero } = bibleBits(book);
  const parts = [
    '请生成一张竖版书籍封面插画（3:4 竖图，画面里【不要任何文字、字母、书法、水印、签名】）。',
    book.genre ? ('题材：' + book.genre + '。') : '',
    era ? ('时代/场景：' + era + '。') : '',
    hero ? ('主角形象：' + hero + '。') : '主角是一位气质突出的中国人（东亚面孔）。',
    (book.style && book.style.name) ? ('画面气质贴合文风：' + book.style.name + '。') : '',
    '要求：人物必须是【中国人、东亚面孔】，服饰与场景符合该时代的中国，国风审美；电影级戏剧光影、写实厚重的数字绘画、画面精致、主角神态突出、有故事张力、构图适合做书籍封面。',
  ].filter(Boolean);
  return parts.join('');
}

// 找发送按钮的 JS 表达式（#prompt-textarea 有文字后才出现；ChatGPT 中文界面 aria-label="发送提示"）。
const SEND_BTN_JS = `document.querySelector('button[data-testid="send-button"]')` +
  `||[].slice.call(document.querySelectorAll('button[aria-label]')).find(function(x){return /发送|send/i.test(x.getAttribute('aria-label')||'');})` +
  `||document.querySelector('form button[type="submit"]:not([disabled])')`;
// 判定「提示词已真正提交」：出现用户消息 / URL 变成 /c/ 会话 / 正在生成（stop 按钮）。
const SUBMITTED_JS = `(function(){return document.querySelectorAll('[data-message-author-role="user"]').length>0` +
  `||/\\/c\\//.test(location.href)||!!document.querySelector('button[data-testid="stop-button"]');})()`;

// 在 ChatGPT 富文本框（ProseMirror #prompt-textarea）输入提示词并发送。
// 用 CDP 可信输入（trustedType）→ 后台安全、send 按钮会启用；delayMs=28 避免中文 IME 提交乱码。
// 【关键】发送后必须【校验真的提交了】，没提交就兜底回车 / 重来一轮——之前只 fire-and-forget 会静默失败。
async function sendPrompt(client, prompt, log) {
  const SEL = '#prompt-textarea';
  for (let i = 0; i < 15; i++) {   // 等编辑器出现
    const ok = await client.evaluate(`!!document.querySelector('${SEL}')||!!document.querySelector('div[contenteditable="true"]')`);
    if (ok) break;
    await sleep(1000);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await client.click(SEL); } catch {}
    await sleep(400);
    await client.trustedType(SEL, prompt, { delayMs: 28, clearFirst: true });
    await sleep(700);
    // 等发送按钮出现且可用（有文字后才渲染）
    for (let i = 0; i < 12; i++) {
      const ready = await client.evaluate(`(function(){var b=${SEND_BTN_JS};return !!(b&&!b.disabled);})()`);
      if (ready) break;
      await sleep(500);
    }
    await client.clickByLocator(`return ${SEND_BTN_JS};`);   // JS .click() 点发送
    // 校验是否真的提交（最多 ~10s）
    for (let i = 0; i < 16; i++) {
      await sleep(650);
      if (await client.evaluate(SUBMITTED_JS)) { log && log('已把封面描述发给 ChatGPT，开始生图…'); return; }
    }
    // 没提交 → 兜底回车再校验
    try { await client.pressKey('Enter'); } catch {}
    await sleep(1600);
    if (await client.evaluate(SUBMITTED_JS)) { log && log('已把封面描述发给 ChatGPT，开始生图…'); return; }
    await sleep(1000);   // 仍失败 → 重来一轮（页面可能还没就绪）
  }
  throw new Error('无法把提示词发给 ChatGPT（页面未就绪或未登录）。请确认该账号浏览器已登录 ChatGPT 后重试。');
}

// 找到「已生成的图片」的 src：竖版大图 + 属于 ChatGPT 图源(backend-api / oaiusercontent)，取最新一张。
async function findGeneratedImage(client) {
  const r = await client.evaluate(`(function(){
    var imgs=[].slice.call(document.querySelectorAll('img')).filter(function(i){
      return i.offsetParent && i.naturalWidth>=300 && /backend-api|oaiusercontent/.test(i.src||'')
        && !/h-6|w-6|avatar|个人资料/i.test((i.className||'')+' '+(i.alt||''));
    });
    if(!imgs.length) return '';
    return imgs[imgs.length-1].src;
  })()`);
  return (typeof r === 'string' && /^https?:/.test(r)) ? r : '';
}

// 等生图完成：温和轮询（9s 一次）。实测生图常已在服务端完成、只是前端卡在「预览」占位不渲染，
// 【刷新页面】即可取回完整图（刷新不会打断服务端生图）→ 过 ~30s 还没出就刷新一次，之后每 ~35s 再刷一次。
async function waitForImage(client, log, deadlineMs = 7 * 60 * 1000) {
  const t0 = Date.now();
  let lastReload = 0, polls = 0;
  while (Date.now() - t0 < deadlineMs) {
    await sleep(9000);
    polls++;
    let src = '';
    try { src = await findGeneratedImage(client); } catch {}
    if (src) return src;
    const el = Date.now() - t0;
    // 用户实测：超时/卡预览时，等半分钟去刷新一下 ChatGPT 页面就能拿到图。故 ~30s 起刷、每 ~35s 再刷。
    if (el > 30000 && Date.now() - lastReload > 35000) {
      log && log('生图较慢/卡在预览，刷新页面取完整图…');
      try { await client.reload(); } catch {}
      lastReload = Date.now();
    } else if (polls % 3 === 0) {
      log && log(`仍在等待 ChatGPT 出图…（已 ${Math.round(el / 1000)}s，网页生图偏慢属正常；卡预览会自动刷新取图）`);
    }
  }
  return '';
}

// 页面内 fetch(src) → dataURL（带会话 cookie），轮询 window.__coverDL 取回。
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

// 主流程：ChatGPT 网页版生成封面底图 → 存 book.dir/cover_bg.png。返回 {file, prompt, w, h, bytes}。
export async function generateCoverViaChatGPT(book, { prompt, profilePath, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!profilePath) throw new Error('缺少 profilePath（需绑定已登录 ChatGPT 的 Unzoo 账号）');
  const client = new UnzooClient(profilePath, onLog, 'chatgpt.com', 'ChatGPT');
  const art = (prompt && prompt.trim()) || buildChatGptCoverPrompt(book);

  // 1. 锁定该账号标签页 → 开新对话（避免上下文污染上一次的图）
  await client.getActiveTab();
  log('正在打开 ChatGPT 新对话…');
  await client.navigate('https://chatgpt.com/');
  await sleep(2600);

  // 2. 发送提示词
  await sendPrompt(client, art, log);

  // 3. 等成图（温和轮询 + 卡住时刷新）
  const src = await waitForImage(client, log);
  if (!src) throw new Error('ChatGPT 生图超时（>7 分钟未出图）。可能在排队，过一会儿重试即可。');

  // 4. 下载存盘
  log('图片已生成，正在下载存盘…');
  const dataUrl = await downloadImageDataUrl(client, src);
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 2000) throw new Error('下载到的图片异常（过小）');
  const file = path.join(book.dir, 'cover_bg.png');
  fs.mkdirSync(book.dir, { recursive: true });
  fs.writeFileSync(file, buf);
  // 读 PNG 宽高（若是 PNG）
  let w = 0, h = 0;
  try { if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); } } catch {}
  log('✅ 封面底图已保存');
  return { file, prompt: art, w, h, bytes: buf.length };
}

// 手动【抓取封面】：不发提示词、不新开对话——直接从当前 ChatGPT 页把【已生成好的图】抓下来存 cover_bg.png。
// 用于自动生成超时/漏检、但你在浏览器里已看到图成了的场景。抓不到先刷新一次再抓（图常已完成只卡预览）。
export async function grabCoverFromChatGPT(book, { profilePath, onLog } = {}) {
  const log = (msg, level = 'info') => { try { onLog && onLog({ level, msg }); } catch {} };
  if (!profilePath) throw new Error('缺少 profilePath（需绑定已登录 ChatGPT 的 Unzoo 账号）');
  const client = new UnzooClient(profilePath, onLog, 'chatgpt.com', 'ChatGPT');
  await client.getActiveTab();   // 锁定该账号 ChatGPT 页，不新开对话（保留你看到图的那一页）
  log('正在从当前 ChatGPT 页抓取已生成的图…');
  let src = '';
  try { src = await findGeneratedImage(client); } catch {}
  if (!src) {
    log('当前页没直接读到图，刷新一次再抓（图常已完成、只卡在预览）…');
    try { await client.reload(); } catch {}
    for (let i = 0; i < 5 && !src; i++) { await sleep(1500); try { src = await findGeneratedImage(client); } catch {} }
  }
  if (!src) throw new Error('没在当前 ChatGPT 页找到已生成的封面图。请确认那一页最后一条回复里确有大图，再刷新一下页面后重试。');
  log('找到图片，正在下载存盘…');
  const dataUrl = await downloadImageDataUrl(client, src);
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 2000) throw new Error('抓到的图片异常（过小），可能不是成品图');
  const file = path.join(book.dir, 'cover_bg.png');
  fs.mkdirSync(book.dir, { recursive: true });
  fs.writeFileSync(file, buf);
  let w = 0, h = 0;
  try { if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); } } catch {}
  log('✅ 已抓取封面底图并保存');
  return { file, w, h, bytes: buf.length };
}
