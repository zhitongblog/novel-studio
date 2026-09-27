// 断更闸：一本书的命，是更新连续性给的，不是字数给的。
//
// 2026-09-26 把书架上七本书的「在读人数」拉齐看，结论刺眼：
//   重生三国·吕布   139 章 /  51.9 万   在读 669   稳更
//   重生岳雷        358 章 / 122.0 万   在读 193   09-19 起没更（当天正好第 7 天）
//   崇祯            296 章 / 111.5 万   在读  36   当天有更
//   国术            446 章 / 118.6 万   在读  13   07-28 起断了 60 天
//   被圣女试药后    499 章 / 167.0 万   在读 **1**  09-15 断过一次
// 【最小的书 669，最大的书 1】。圣女 167 万字内容是全书复检过的，没有质量问题，
// 就是 09-15 那一次断更把推荐掐死，之后再没回来。
//
// 番茄规则：以【读者能读到】为准，连续 7 天没有新章 → 暂停推荐，恢复更新后才恢复。
// 所以这里的判据必须是「读者最后能读到的那一天」，而不是「我们最后一次点发布的时间」——
// 排期发布时这两者能差出一星期，用后者会把排得好好的书报成断更。
//
// 这个模块只做算术，不碰网络、不碰文件，好让书架列表、体检、UI 都能白嫖它。

export const 断更天数 = 7;   // 番茄的红线：满 7 天停推荐
export const 库存红线 = 6;   // 已写未发 < 6 章（按 2 章/天 = 3 天）时，下一次卡顿就会踩线

const 一天 = 86400000;

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function fmtMD(t) { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// 'YYYY-MM-DD' → 那一天的 23:59:59（排期章当天发出去，整天都算「读者读得到」）
function endOfDateStr(s) {
  if (!s) return 0;
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d.getTime())) return 0;
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// 读者最后能读到新章的时刻。
// scheduledThrough 是发布器排完一轮后回写的「这轮最后一章落在哪天」，它可能在未来；
// lastPublishAt 是我们点发布的时刻。两者取晚的那个。
export function readableThrough(book) {
  const pc = book?.publish || {};
  return Math.max(endOfDateStr(pc.scheduledThrough), Number(pc.lastPublishAt) || 0);
}

// 返回 {level, daysSince, runway, stock, through, text}
//   level: 'none' 没发过 | 'ok' | 'thin' 库存见底 | 'warn' | 'danger' 快踩线 | 'dead' 已断更
//   daysSince: 读者已经多少天没看到新章（排期到未来时为 0）
//   runway: 排期还能顶几天（今天算 0）
//   stock:  已写未发的章数
export function updateCadence(book, { now = Date.now(), maxChapter = 0 } = {}) {
  const pc = book?.publish || {};
  const through = readableThrough(book);
  // 库存 = 已写未发。没有 publishedMax（导入的老书从没在这里记过账）时它【算不出来】，
  // 只能记 null——不许拿 0 当线上章号，那会把"全书 446 章早发完了"报成"库存 446 章待发"。
  const 高水位 = Number(pc.publishedMax) || 0;
  const stock = 高水位 > 0 ? Math.max(0, (Number(maxChapter) || 0) - 高水位) : null;
  const 库存文 = stock === null ? '库存未知' : `库存 ${stock} 章`;
  const 库存告急 = stock !== null && stock < 库存红线;   // null < 6 在 JS 里是 true，必须显式挡掉

  if (!through) {
    return { level: 'none', daysSince: 0, runway: 0, stock, through: 0, text: '还没发布过' };
  }

  const today = startOfDay(now);
  const lastDay = startOfDay(through);
  const daysSince = Math.max(0, Math.round((today - lastDay) / 一天));
  const runway = Math.max(0, Math.round((lastDay - today) / 一天));

  // 排期还没走完 → 不算断更，但要看排期走完之后接不接得上
  if (runway > 0) {
    // 排期还长但库存见底：不必拉警报，但得说明白"排期走完之前要把稿补上"，
    // 否则作者看见一行绿的，会以为这本书这阵子不用管。
    const level = (runway <= 2 && 库存告急) ? 'thin' : 'ok';
    const tail = !库存告急 ? `，${库存文}`
      : (level === 'thin' ? `，库存只剩 ${stock} 章` : `，库存 ${stock} 章（${runway} 天内要补上）`);
    return { level, daysSince: 0, runway, stock, through, text: `已排到 ${fmtMD(through)}（还够 ${runway} 天）${tail}` };
  }

  const remain = 断更天数 - daysSince;
  if (daysSince >= 断更天数) {
    return { level: 'dead', daysSince, runway, stock, through,
      text: `已断更 ${daysSince} 天，推荐大概率已停（${库存文}）` };
  }
  if (remain <= 2) {
    return { level: 'danger', daysSince, runway, stock, through,
      text: `${daysSince} 天没更，距断更只剩 ${remain} 天（${库存文}）` };
  }
  if (daysSince >= 3) {
    return { level: 'warn', daysSince, runway, stock, through,
      text: `${daysSince} 天没更，距断更 ${remain} 天（${库存文}）` };
  }
  if (库存告急) {
    return { level: 'thin', daysSince, runway, stock, through,
      text: `更新正常，但库存只剩 ${stock} 章——低于 ${库存红线} 章，一卡顿就踩线` };
  }
  return { level: 'ok', daysSince, runway, stock, through, text: `更新正常（${库存文}）` };
}

// 这一批稿子能买几天「不断更」的保护。
// 13 章一次倒完只买 1 天；按 2 章/天铺开买 7 天——同样的稿子，差出一条 7 天红线。
export function coverDays(count, chaptersPerDay) {
  if (!(count > 0)) return 0;
  const perDay = (chaptersPerDay && chaptersPerDay !== 'max') ? (parseInt(chaptersPerDay, 10) || 0) : 0;
  return perDay > 0 ? Math.ceil(count / perDay) : 1;
}

// 这轮排期最后一章落在哪天：起始日 + ceil(章数 / 每日章数) - 1。
// 立即发布（chaptersPerDay='max' 或没排期）时就是起始日当天。
export function scheduleThroughDate(startYMD, count, chaptersPerDay) {
  if (!startYMD || !(count > 0)) return '';
  const days = coverDays(count, chaptersPerDay);
  const d = new Date(String(startYMD).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
