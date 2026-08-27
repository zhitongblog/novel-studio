// 番茄章节表「翻页判据」自测。
//
// 病根(《重生美利坚》真实踩到)：编辑模式要覆盖第1章，但章节列表按章号【倒序】、共5页，
// 第1章在最后一页。翻页判据原来只看两件事：页码变了 + 页面上还有章节行。
// 而番茄点"下一页"后【页码立刻变、表格数据 400~800ms 后才换】——实测抓到过：
//   点下一页 → page=2 / 首行仍是 73,72（上一页的行），~500ms 后才变成 58,57。
// 于是每次翻页都在读【上一页】的内容，整轮遍历错位一页 → 末页那 13 章永远读不到 →
// "本卷共 5 页，没有 第1章" → 连续3次 notFound → 编辑模式停 → 表现为「找不到章节」。
//
// 判据必须再加一条：行内容(sig=条数+前三个章号)真的换了。
import assert from 'node:assert';
import { chapterRowsReady } from '../src/fanqie.mjs';

const P1 = { currentPage: 1, sig: '15:73,72,71', hasRows: true, empty: false };
const P2 = { currentPage: 2, sig: '15:58,57,56', hasRows: true, empty: false };

// ① 老病根：页码已经变成第2页，但行还是第1页的 → 绝不能算渲染完
{
  const stale = { currentPage: 2, sig: P1.sig, hasRows: true, empty: false };
  assert.strictEqual(chapterRowsReady(stale, { prevPage: 1, prevSig: P1.sig }), false,
    '页码变了但行没换，被判成渲染完 → 会把上一页当这一页读，末页的章永远找不到');
  console.log('OK 页码变、行没换 → 不算渲染完');
}

// ② 行真的换了才算好
{
  assert.strictEqual(chapterRowsReady(P2, { prevPage: 1, prevSig: P1.sig }), true);
  console.log('OK 页码变且行换了 → 渲染完');
}

// ③ 行换了但页码没变(误点/没翻动) → 不算
{
  const same = { currentPage: 1, sig: P2.sig, hasRows: true, empty: false };
  assert.strictEqual(chapterRowsReady(same, { prevPage: 1, prevSig: P1.sig }), false);
  console.log('OK 页码没变 → 不算渲染完');
}

// ④ 首次加载(没有基准) → 有行就算好
{
  assert.strictEqual(chapterRowsReady(P1, {}), true);
  assert.strictEqual(chapterRowsReady({ currentPage: 1, sig: '0:', hasRows: false, empty: false }, {}), false);
  console.log('OK 首次加载只看有没有行');
}

// ⑤ 番茄的合法空态(空卷)也算"确定结果"，不该一直空等
{
  assert.strictEqual(chapterRowsReady({ currentPage: 1, sig: '0:', hasRows: false, empty: true }, {}), true);
  console.log('OK 空态算确定结果');
}

// ⑥ 读不到状态 → 不算
{
  assert.strictEqual(chapterRowsReady(null, { prevPage: 1 }), false);
  console.log('OK 读不到状态 → 不算');
}

console.log('全部通过 [OK]  翻页必须等行内容真的换掉');
