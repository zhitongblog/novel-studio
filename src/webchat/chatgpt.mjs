// ChatGPT 网页版适配器（chatgpt.com）。
//
// ⚠️ 选择器为「最合理猜测」，需对着真实页面校准（见 // TODO）。ChatGPT 有相对稳定的
// data-* 属性（如 data-message-author-role），本文件尽量用它们，但仍以真实页面为准。

import { pollUntil, grabLatestAnswerText } from './adapter.mjs';

export const chatgptAdapter = {
  id: 'chatgpt',
  name: 'ChatGPT 网页版',
  url: 'https://chatgpt.com/',
  host: 'chatgpt.com',

  selectors: {
    // 输入框：ChatGPT 用 ProseMirror contenteditable（历史上是 #prompt-textarea）。
    input: '#prompt-textarea, div[contenteditable="true"].ProseMirror, div[contenteditable="true"]',
    // 发送按钮：data-testid="send-button"（较稳定）。
    sendButton: 'button[data-testid="send-button"], button[aria-label*="Send"], button[class*="send"]',
    // 回答容器：data-message-author-role="assistant"（较稳定）。取最后一个。
    answer: '[data-message-author-role="assistant"]',
    // 「生成中」标志：停止按钮 data-testid="stop-button"。存在 = 仍在生成。
    generating: 'button[data-testid="stop-button"], button[aria-label*="Stop"]',
  },

  async send(client, promptText) {
    const sel = this.selectors;
    // ProseMirror（contenteditable）→ 粘贴写入长文 + 可信键盘触发，确保发送按钮启用
    await client.fillEditor(sel.input, promptText);
    await client.humanDelay(300, 600);
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
      await client.focusElement(sel.input);
      await client.pressKey('Enter');       // ChatGPT：Enter 发送、Shift+Enter 换行
    }
    await client.humanDelay(500, 1000);
  },

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

  async readLatest(client) {
    return await grabLatestAnswerText(client, this.selectors.answer);
  },
};

export default chatgptAdapter;
