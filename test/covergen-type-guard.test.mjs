// 网页版生图：输入框打完字后的"状态校验失败"不能中断流程。
//
// 2026-09-21 现场：用 Gemini 生封面，报
//   「Gemini 失败：调用 browser_type 失败: ... "error_code": "not_verified"」
// 而同一份日志里写着 typed_len=253、dom_changed=true、page_feedback=changed
// ——【字其实已经打进去了】，只是 Unzoo 的 browser_type 校验不到 Quill 富文本框
// 更新的那个属性，于是判成 not_verified 并抛异常。
//
// 代码里本来就有两道真判据（waitTypingSettled 读框里实际字数、提交后看框有没有清空），
// 但 trustedType 那一行没包 try，一抛错它们根本没机会跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readSrc = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

test('两个网页生图驱动的 trustedType 都必须被 try 包住', () => {
  for (const f of ['covergen_gemini.mjs', 'covergen_web.mjs']) {
    const src = readSrc(f);
    const i = src.indexOf('await client.trustedType');
    assert.ok(i > 0, f + ' 里应有 trustedType 调用');
    // 往前找最近的 try：必须在同一段逻辑里（200 字符内），否则就是裸调
    const before = src.slice(Math.max(0, i - 240), i);
    assert.ok(/try\s*\{[^}]*$/.test(before) || before.includes('try {'),
      f + ' 的 trustedType 是裸调的——一旦抛 not_verified，后面真正的判据就跑不到了');
  }
});

test('只放过"打了但没验证到"，硬失败仍要抛出去', () => {
  for (const f of ['covergen_gemini.mjs', 'covergen_web.mjs']) {
    const src = readSrc(f);
    assert.ok(/not_verified\|verify\|未观察到/.test(src),
      f + ' 应只吞掉校验类错误');
    assert.ok(/if \(!\/not_verified.*\.test\(msg\)\) throw e;/.test(src),
      f + ' 必须把非校验类的错误原样抛出（框找不到、页面没开这类是真失败）');
  }
});

test('容错之后，真正的判据仍然在：读实际字数 + 看提交后是否清空', () => {
  const g = readSrc('covergen_gemini.mjs');
  assert.ok(g.includes('waitTypingSettled'), 'Gemini 版要靠读框里实际字数来确认打完了');
  assert.ok(/输入框清空|left\b/.test(g), 'Gemini 版要靠输入框清空确认真的提交了');
  const w = readSrc('covergen_web.mjs');
  assert.ok(/SEND_BTN_JS/.test(w), 'ChatGPT 版要等发送键可用');
});
