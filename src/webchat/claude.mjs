// Claude 网页版适配器（claude.ai）。
//
// ⚠️ 选择器为「最合理猜测」，需对着真实页面校准（见 // TODO）。claude.ai 用 ProseMirror
// 输入框、data-testid 属性；本文件尽量用较稳定的 hook，仍以真实页面为准。

import { pollUntil, grabLatestAnswerText } from './adapter.mjs';

export const claudeAdapter = {
  id: 'claude',
  name: 'Claude 网页版',
  url: 'https://claude.ai/new',
  host: 'claude.ai',

  selectors: {
    // 输入框：claude.ai 用 TipTap/ProseMirror contenteditable（已校准：class="tiptap ProseMirror"）。
    input: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"].tiptap, div[contenteditable="true"]',
    // 发送按钮：aria-label="Send message"（有字才出现，空框时不存在）；找不到则回车发送。
    sendButton: 'button[aria-label*="Send"], button[data-testid*="send"]',
    // 回答容器（已对真实页校准 2026-07）：.font-claude-response（外层，每条回答一个）/ .font-claude-response-body（内层）。
    // 旧的 font-claude-message / data-testid=assistant-message 已失效，保留作兜底。取最后一个=最新回答。
    answer: '.font-claude-response, [class*="font-claude-response"], [data-testid="assistant-message"], div[class*="font-claude-message"]',
    // 「生成中」标志：停止按钮 aria-label="Stop response"。存在 = 仍在生成。
    generating: 'button[aria-label*="Stop"], button[data-testid*="stop"]',
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
      await client.pressKey('Enter');       // claude.ai：Enter 发送、Shift+Enter 换行
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

export default claudeAdapter;
