// Claude 网页版适配器（claude.ai）。
//
// ⚠️ 选择器为「最合理猜测」，需对着真实页面校准（见 // TODO）。claude.ai 用 ProseMirror
// 输入框、data-testid 属性；本文件尽量用较稳定的 hook，仍以真实页面为准。

import { pollUntil } from './adapter.mjs';

export const claudeAdapter = {
  id: 'claude',
  name: 'Claude 网页版',
  url: 'https://claude.ai/new',                                   // TODO 需对着真实页面校准

  selectors: {
    // 输入框：claude.ai 用 ProseMirror contenteditable。
    input: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"]', // TODO 需对着真实页面校准
    // 发送按钮：aria-label="Send message"（较稳定）。
    sendButton: 'button[aria-label*="Send"], button[data-testid*="send"]', // TODO 需对着真实页面校准
    // 回答容器：claude.ai 回答块常带 data-testid 或 font-claude-message class。取最后一个。
    answer: '[data-testid="assistant-message"], div[class*="font-claude-message"], div[class*="assistant"]', // TODO 需对着真实页面校准
    // 「生成中」标志：停止按钮 aria-label="Stop response"。存在 = 仍在生成。
    generating: 'button[aria-label*="Stop"], button[data-testid*="stop"]', // TODO 需对着真实页面校准
  },

  async send(client, promptText) {
    const sel = this.selectors;
    await client.focusElement(sel.input);
    const jsIn = JSON.stringify(sel.input);
    const jsTxt = JSON.stringify(String(promptText));
    // ProseMirror（contenteditable）→ paste 事件原子写入、保留换行。
    await client.evaluate(`
      (function(){
        const el = document.querySelector(${jsIn});
        if (!el) return false;
        el.focus();
        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, ${jsTxt});
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.innerHTML = '';
          const dt = new DataTransfer();
          dt.setData('text/plain', ${jsTxt});
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()
    `);
    await client.humanDelay(300, 600);
    const clicked = await client.clickByLocator(`
      const btns = document.querySelectorAll(${JSON.stringify(sel.sendButton)});
      for (const b of btns) { if (b.offsetParent !== null && !b.disabled) return b; }
      return null;
    `);
    if (!clicked) {
      await client.focusElement(sel.input);
      await client.pressKey('Enter');       // claude.ai：Enter 发送、Shift+Enter 换行
    }
    await client.humanDelay(500, 1000);
  },

  async waitDone(client, { timeoutMs = 480000, onLog } = {}) {
    const sel = this.selectors;
    let lastLen = -1, stableHits = 0;
    const done = await pollUntil(async () => {
      const st = await client.evaluate(`
        (function(){
          const stop = document.querySelector(${JSON.stringify(sel.generating)});
          const nodes = document.querySelectorAll(${JSON.stringify(sel.answer)});
          const last = nodes.length ? nodes[nodes.length - 1] : null;
          const len = last ? (last.innerText || '').length : 0;
          return { generating: !!(stop && stop.offsetParent !== null), len };
        })()
      `);
      if (!st) return false;
      if (st.generating) { stableHits = 0; lastLen = st.len; return false; }
      if (st.len > 0 && st.len === lastLen) { stableHits++; } else { stableHits = 0; }
      lastLen = st.len;
      return stableHits >= 2;
    }, { timeoutMs, intervalMs: 1500, onLog });
    return !!done;
  },

  async readLatest(client) {
    const sel = this.selectors;
    return await client.evaluate(`
      (function(){
        const nodes = document.querySelectorAll(${JSON.stringify(sel.answer)});
        if (!nodes.length) return '';
        const last = nodes[nodes.length - 1];
        return (last.innerText || last.textContent || '');
      })()
    `);
  },
};

export default claudeAdapter;
