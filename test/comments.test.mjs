// 评论解析自测。抓取那半边要真浏览器，解析这半边必须能离线测——
// 用的全是 2026-09-05 从 lxd220 账号《岳飞：这一世，我不做忠臣》(3440 条) 页面上原样抄下来的文本。
import assert from 'node:assert';
import { parseCommentItem, commentId, COMMENT_TABS } from '../src/comments.mjs';

console.log('— 真实条目 —');
// 现场原文（.comment-item 的 innerText，换行照抄）
const REAL = [
  '李沧的修罗天尊打赏第十四名评论了第290章 完本感言：写给岳飞，也写给你们 01-19',
  '感谢作者写出了我的心声，我的意难平',
  '0',
  '0条回复',
  '禁言',
  '举报删除',
].join('\n');
const c = parseCommentItem(REAL);
assert.ok(c, '这条必须解析得出来');
assert.strictEqual(c.num, 290, '章号是把评论挂回正文的唯一锚点');
assert.strictEqual(c.chapterTitle, '完本感言：写给岳飞，也写给你们');
assert.strictEqual(c.at, '01-19');
assert.strictEqual(c.body, '感谢作者写出了我的心声，我的意难平');
assert.deepStrictEqual(c.tags, ['打赏第十四名'], '粉丝/打赏标签要从用户名里摘出来');
assert.strictEqual(c.user, '李沧的修罗天尊', '摘掉标签后才是用户名');
console.log(`✓ 第${c.num}章 · ${c.user}【${c.tags.join('')}】· ${c.at} · ${c.body}`);

console.log('— 计数与相对时间 —');
const HOT = ['某读者真爱粉评论了第12章 雷劫将至 3小时前', '这段太水了，又在算数据', '37', '5条回复', '禁言', '举报删除'].join('\n');
const h = parseCommentItem(HOT);
assert.strictEqual(h.num, 12);
assert.strictEqual(h.at, '3小时前', '相对时间也要认');
assert.strictEqual(h.likes, 37, '点赞数用来排「哪条最扎心」');
assert.strictEqual(h.replies, 5);
assert.strictEqual(h.body, '这段太水了，又在算数据');
assert.deepStrictEqual(h.tags, ['真爱粉']);
console.log(`✓ 赞 ${h.likes} · 回复 ${h.replies} · ${h.body}`);

console.log('— 书评/书圈：没有章号也要能收 —');
const NOCHAP = ['路人甲', '整体节奏还行，就是女主戏太少', '2', '0条回复'].join('\n');
const n = parseCommentItem(NOCHAP);
assert.ok(n, '没有「评论了第N章」也不能丢');
assert.strictEqual(n.num, null, '没章号就是 null，别瞎猜');
assert.strictEqual(n.user, '路人甲', '没有章号锚点时，短的首行按用户名处理');
assert.strictEqual(n.body, '整体节奏还行，就是女主戏太少', '用户名不能混进正文');
console.log(`✓ 无章号条目仍收下：${n.user} · ${n.body}`);

console.log('— 空白与噪声 —');
assert.strictEqual(parseCommentItem(''), null);
assert.strictEqual(parseCommentItem('   \n  \n '), null);
assert.strictEqual(parseCommentItem('0\n0条回复\n禁言\n举报删除'), null, '只剩操作区的空壳不算一条评论');
console.log('✓ 空白/纯操作区不会被当成评论');

console.log('— 去重指纹 —');
const a = commentId({ user: '张三', num: 12, at: '01-19', body: '好看' });
const b = commentId({ user: '张三', num: 12, at: '01-19', body: '好看' });
const d = commentId({ user: '张三', num: 12, at: '01-19', body: '难看' });
assert.strictEqual(a, b, '重复抓同一条 → 同一个 id');
assert.notStrictEqual(a, d, '同人同章同天说了不同的话 → 两条');
console.log(`✓ 同条同 id(${a})，不同内容不同 id`);

console.log('— 页签清单 —');
assert.deepStrictEqual(COMMENT_TABS, ['章末讨论', '段评', '书圈', '书评'], '实地勘察到的就是这四个');
console.log('✓ 章末讨论 / 段评 / 书圈 / 书评');

console.log('\n全部通过 ✅  评论解析对得上真实页面');
