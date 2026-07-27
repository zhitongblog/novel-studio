// 豆包网页版适配器（doubao.com/chat）。
//
// 已对真实登录页校准（2026-07，Profile lixd220）：
//   输入框：textarea.semi-input-textarea（Semi Design，占位「发消息或按住空格说话...」）——是 textarea 不是富文本
//   发送键：#flow-end-msg-send（输入框有字才出现；空框时不存在）
//   停止键：生成中出现的停止按钮
// 关键：Semi 是 React 受控 textarea，必须用 HTMLTextAreaElement 的 nativeSetter + input 事件写入
//       （用 HTMLInputElement 的 setter 会 Illegal invocation / 不生效）；实测这样写完发送键即出现。
// 回答抓取不依赖脆弱 class：优先容器选择器，命中不足则用 grabLatestAnswerText 哨兵兜底（选择器无关）。
// 注意：豆包对非中国大陆出口 IP 有区域封禁（doubao-region-ban），需用能正常打开豆包的账号/网络。

import { pollUntil, grabLatestAnswerText } from './adapter.mjs';

export const doubaoAdapter = {
  id: 'doubao',
  name: '豆包 网页版',
  url: 'https://www.doubao.com/chat/',
  host: 'doubao.com',

  selectors: {
    input: 'textarea.semi-input-textarea, textarea[data-testid="chat_input_input"], textarea, div[contenteditable="true"]',
    sendButton: '#flow-end-msg-send, button[data-testid="chat_input_send_button"], button[aria-label*="发送"], button[class*="send"]',
    // 回答容器：每条回答是一个 .md-box-root（markdown 盒）。container-xxx 是每次构建变化的哈希 class，只认 .md-box-root。
    answer: '.md-box-root, [class*="md-box"], [data-testid*="message"], [class*="message-content"]',
    generating: 'button[data-testid="chat_input_stop_button"], button[aria-label*="停止"], button[class*="stop"]',
  },

  async send(client, promptText) {
    const sel = this.selectors;
    await client.focusElement(sel.input);
    // 判断输入框是 textarea/input 还是 contenteditable，分别用受控写入 / 模拟粘贴
    const isTextarea = await client.evaluate(`
      (function(){
        const el = document.querySelector(${JSON.stringify(sel.input)});
        return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
      })()
    `);
    if (isTextarea) {
      // Semi/React 受控 textarea：用对应原型的 nativeSetter + input 事件原子写入（保留换行）。发送键随即出现。
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
          // 光标移到末尾，避免后续按键落在中间
          try { el.selectionStart = el.selectionEnd = el.value.length; } catch (e) {}
          return true;
        })()
      `);
    } else {
      await client.fillEditor(sel.input, promptText);
    }
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
      await client.pressKey('Enter');   // 豆包 Enter 发送、Shift+Enter 换行
    }
    await client.humanDelay(500, 1000);
  },

  async waitDone(client, { timeoutMs = 480000, onLog } = {}) {
    const sel = this.selectors;
    let lastLen = -1, stableHits = 0;
    const done = await pollUntil(async () => {
      const generating = await client.evaluate(`
        (function(){
          const g = document.querySelector(${JSON.stringify(sel.generating)});
          return !!(g && g.offsetParent !== null);
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

export default doubaoAdapter;
