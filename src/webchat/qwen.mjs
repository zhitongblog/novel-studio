// 通义千问网页版适配器（chat.qwen.ai）。
//
// ⚠️ 选择器均为「最合理猜测」，需对着真实页面校准（见每个 // TODO）。结构写对即可，
// 后续校准只需改 selectors 与少量判定逻辑。驱动流程复用 ./adapter.mjs 的 chatOnce。

import { pollUntil } from './adapter.mjs';

export const qwenAdapter = {
  id: 'qwen',
  name: '通义千问 网页版',
  url: 'https://chat.qwen.ai/',      // TODO 需对着真实页面校准（也可能是 https://tongyi.aliyun.com/qianwen/）

  selectors: {
    // 输入框：通义用富文本/textarea。优先 textarea，退回 contenteditable。
    input: 'textarea, div[contenteditable="true"]',                 // TODO 需对着真实页面校准
    // 发送按钮：一般是输入框旁的箭头按钮。
    sendButton: 'button[type="submit"], button[aria-label*="发送"], button[class*="send"]', // TODO 需对着真实页面校准
    // 回答气泡容器：每条 AI 回答的最外层。取最后一个作为「最新回答」。
    answer: '[class*="assistant"], [data-role="assistant"], [class*="answer-item"], [class*="response"]', // TODO 需对着真实页面校准
    // 「生成中」的标志：停止按钮存在 or 有 loading 光标。存在 = 仍在生成。
    generating: 'button[aria-label*="停止"], button[class*="stop"], [class*="typing"], [class*="loading"]', // TODO 需对着真实页面校准
  },

  async send(client, promptText) {
    const sel = this.selectors;
    // 聚焦输入框（真实点击 + focus），再用可信键盘不适合长文——改用 execCommand/paste 填入，
    // 最后触发 input 事件让发送按钮从禁用变可用。
    await client.focusElement(sel.input);
    const jsIn = JSON.stringify(sel.input);
    const jsTxt = JSON.stringify(String(promptText));
    await client.evaluate(`
      (function(){
        const el = document.querySelector(${jsIn});
        if (!el) return false;
        el.focus();
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, ${jsTxt});
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // contenteditable：清空后插入
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
    // 优先点发送按钮；点不到则回车发送（通义 Enter 发送、Shift+Enter 换行）。
    const clicked = await client.clickByLocator(`
      const btns = document.querySelectorAll(${JSON.stringify(sel.sendButton)});
      for (const b of btns) { if (b.offsetParent !== null && !b.disabled) return b; }
      return null;
    `);
    if (!clicked) {
      await client.focusElement(sel.input);
      await client.pressKey('Enter');       // TODO 若通义是 Ctrl+Enter/其他，需校准
    }
    await client.humanDelay(500, 1000);
  },

  async waitDone(client, { timeoutMs = 480000, onLog } = {}) {
    const sel = this.selectors;
    // 判定「生成完成」：连续 2 次探测都「不在生成中」（generating 选择器无命中）且回答文本长度稳定。
    let lastLen = -1, stableHits = 0;
    const done = await pollUntil(async () => {
      const st = await client.evaluate(`
        (function(){
          const gen = document.querySelector(${JSON.stringify(sel.generating)});
          const nodes = document.querySelectorAll(${JSON.stringify(sel.answer)});
          const last = nodes.length ? nodes[nodes.length - 1] : null;
          const len = last ? (last.innerText || '').length : 0;
          return { generating: !!(gen && gen.offsetParent !== null), len };
        })()
      `);
      if (!st) return false;
      if (st.generating) { stableHits = 0; lastLen = st.len; return false; }
      // 不在生成中 + 文本长度稳定两轮 → 判定完成
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

export default qwenAdapter;
