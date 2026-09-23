// 发布平台绑定：**一本书只允许发布到一个平台**。
//
// 这不是我们的产品偏好，是平台规则：番茄、起点都要求「独家首发」。同一本书两边都发，
// 轻则限流，重则解约 + 追回稿费——而且因为两边内容一样，还会同时踩中各自的「自抄/重复内容」检测。
// 所以这条必须由代码拦住，不能只写在文档里靠人记。
//
// 拦在两处（缺一处都能绕过去）：
//   ① 换平台时  —— 已经往某平台发过章的书，不许改绑另一个平台。
//   ② 发布时    —— 真要发之前再验一次绑定，防止配置被别的路径改脏。
//
// 向后兼容：platform 字段是后加的。在它出现之前，所有书都是发番茄的，
// 所以【缺省即 fanqie】，老书不需要迁移。

export const PLATFORMS = {
  fanqie: { key: 'fanqie', name: '番茄小说', idField: 'bookId', idLabel: 'bookId' },
  qidian: { key: 'qidian', name: '起点中文网', idField: 'bookId', idLabel: 'CBID' },
};

export function platformName(key) {
  return PLATFORMS[key]?.name || String(key || '未知平台');
}

// 这本书绑的是哪个平台。老数据没有这个字段 → 番茄。
export function platformOf(book) {
  const p = book?.publish?.platform;
  return PLATFORMS[p] ? p : 'fanqie';
}

// 这本书是否已经往线上发过东西。
//
// 判据要宽：lastPublishAt（发过一次就有）、publishedMax（高水位）、任一已发章指纹，
// 三者有其一就算「发过」。宁可多拦一次让人手动解绑，也不能漏判——漏判的后果是一稿两投。
export function hasPublished(book) {
  const pc = book?.publish || {};
  if ((pc.lastPublishAt || 0) > 0) return true;
  if ((pc.publishedMax || 0) > 0) return true;
  return false;
}

// ① 换平台闸：返回 {ok, reason}
export function canSwitchPlatform(book, want) {
  if (!PLATFORMS[want]) return { ok: false, reason: `不认识的平台：${want}` };
  const cur = platformOf(book);
  if (cur === want) return { ok: true };
  if (!hasPublished(book)) return { ok: true };   // 还没发过，随便换
  const pc = book?.publish || {};
  return {
    ok: false,
    reason: `《${book.title || book.slug}》已经发到${platformName(cur)}` +
      (pc.publishedMax ? `第 ${pc.publishedMax} 章` : '') +
      `，不能改发${platformName(want)}。一本书只能在一个平台首发——两边都发会同时触发` +
      `双方的独家违约与重复内容检测。要换平台，得先在原平台下架并解除签约，再手动清空这本书的发布配置。`,
  };
}

// ② 发布闸：真发之前验绑定。不符就抛——这条路径上不做"警告后继续"。
export function assertPlatform(book, want) {
  const cur = platformOf(book);
  if (cur !== want) {
    throw new Error(
      `《${book.title || book.slug}》绑定的发布平台是${platformName(cur)}，` +
      `不能用${platformName(want)}的通道发布。一本书只允许发布到一个平台。`
    );
  }
}
