// Grok 网页版适配器（grok.com）。
//
// 为什么走网页而不是 CLI：xAI 没有 claude code / codex 那样的本地 CLI，只有 API 和网页。
// 所以 Grok 只能像千问/豆包/ChatGPT 一样，驱动聊天框写作。
//
// ⚠️ 选择器【尚未对真实登录页校准】。校准时我这边打不开 grok.com——用没有正常浏览历史的
// 专属 profile 直连会被 Cloudflare 判为机器人（"Sorry, you have been blocked"）。所以：
//   1. 本文件的选择器是按 grok.com 现行 DOM 的合理猜测写的，且【每一项都给了多重回退】；
//   2. 回答抓取优先走 grabLatestAnswerText 哨兵（选择器无关），这条路子在豆包上实测最稳，
//      即使选择器全部失效也能拿到正文；
//   3. 真正跑通需要一个【已登录 Grok 且有正常浏览历史】的 Unzoo profile——Cloudflare 认的是
//      环境与行为，不是登录本身。用干净 profile 硬连大概率还是会被挑战。
//
// 校准方法：用那个 profile 打开 grok.com，在控制台跑
//   document.querySelectorAll('textarea, div[contenteditable="true"]')
//   document.querySelectorAll('button[type="submit"], button[aria-label*="Submit"]')
// 把命中的选择器填到下面，并把这段注释改成「已校准（日期/profile）」。

import { pollUntil, grabLatestAnswerText } from './adapter.mjs';

export const grokAdapter = {
  id: 'grok',
  name: 'Grok 网页版',
  url: 'https://grok.com/',
  host: 'grok.com',

  selectors: {
    // 输入框：Grok 用过 textarea，也出现过 contenteditable。两种都挂上，textarea 优先。
    input: 'textarea[aria-label*="Ask"], textarea[placeholder*="Ask"], textarea, div[contenteditable="true"]',
    // 发送键：常见是 type=submit 或 aria-label 含 Submit/Send。
    sendButton: 'button[type="submit"], button[aria-label*="Submit"], button[aria-label*="Send"], button[data-testid*="send"]',
    // 回答容器：message-bubble / assistant 标记。抓不到时由哨兵兜底。
    answer: '[class*="message-bubble"], [data-testid*="assistant"], [class*="response-content"], [class*="markdown"]',
    // 生成中：停止按钮存在 = 还在出字。
    generating: 'button[aria-label*="Stop"], button[data-testid*="stop"], button[class*="stop"]',
  },

  async send(client, promptText) {
    const sel = this.selectors;
    await client.focusElement(sel.input);
    // 输入框可能是受控 textarea（React），也可能是富文本，分别处理——跟豆包/ChatGPT 一个套路
    const isTextarea = await client.evaluate(`
      (function(){
        const el = document.querySelector(${JSON.stringify(sel.input)});
        return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
      })()
    `);
    if (isTextarea) {
      // React 受控 textarea：必须用对应原型的 nativeSetter + input 事件写入，
      // 否则 React 不认这次输入、发送键不会启用（豆包那边踩过这个坑）。
      const jsIn = JSON.stringify(sel.input), jsTxt = JSON.stringify(String(promptText));
      await client.evaluate(`
        (function(){
          const el = document.querySelector(${jsIn});
          if (!el) return false;
          el.focus();
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, ${jsTxt});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `);
    } else {
      await client.fillEditor(sel.input, promptText);
    }
    await client.humanDelay(300, 700);

    const clicked = await client.clickByLocator(`
      const btns = document.querySelectorAll(${JSON.stringify(sel.sendButton)});
      for (const b of btns) {
        if (b.offsetParent === null) continue;
        if (b.disabled) continue;
        if (b.getAttribute('aria-disabled') === 'true') continue;
        return b;
      }
      return null;
    `);
    if (!clicked) {
      // 回退：Grok 的输入框 Enter 发送、Shift+Enter 换行（与 ChatGPT 一致）
      await client.focusElement(sel.input);
      await client.pressKey('Enter');
    }
    await client.humanDelay(500, 1000);
  },

  // 等生成结束：停止按钮消失 且 正文长度连续两拍不再增长（跟 chatgpt/豆包同一套判定）。
  async waitDone(client, { timeoutMs = 480000, onLog } = {}) {
    const sel = this.selectors;
    let lastLen = -1, stableHits = 0;
    const done = await pollUntil(async () => {
      const generating = await client.evaluate(`
        (function(){
          const stop = document.querySelector(${JSON.stringify(sel.generating)});
          return !!(stop && stop.offsetParent !== null);
        })()
      `);
      const text = await grabLatestAnswerText(client, sel.answer);
      const len = (text || '').length;
      if (generating) { stableHits = 0; lastLen = len; return false; }
      if (len > 0 && len === lastLen) { stableHits++; } else { stableHits = 0; }
      lastLen = len;
      return stableHits >= 2;
    }, { timeoutMs, intervalMs: 1500, onLog });
    return !!done;
  },

  // 取最后一条回答：先按选择器，取不到就用哨兵（选择器无关，最稳的一条路）。
  async readLatest(client) {
    return await grabLatestAnswerText(client, this.selectors.answer);
  },
};

export default grokAdapter;
