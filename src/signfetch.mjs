// 从番茄后台【只读】取签约诊断要用的两样东西：签约进度、章节定时表。
// 绝不点任何会改动的按钮（申请签约、确认发布、修改定时……一律不碰）。
//
// 这两段读法是 2026-09-19 查《穿成王莽后》签约被拒时现场摸出来的：
//   · 签约管理不是独立 URL，是书卡上的按钮，点开后跳到
//     /main/writer/book-info/<bookId>?…&type=2，时间线就在页面正文里；
//   · 章节管理 /main/writer/chapter-manage/<bookId>&1 是分页表，每行
//     「第N章 章名｜字数｜错别字｜审核状态｜发布时间」，要翻页读全。

import { UnzooClient } from './fanqie.mjs';
import { parseSignTimeline } from './signdiag.mjs';

const FIRE = `function __f(e){['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));});}`;

export async function fetchSignStatus({ profilePath, bookId, title, onLog = () => {} }) {
  const c = new UnzooClient(profilePath, onLog, 'fanqienovel.com', '番茄');
  await c.ensureTabId();
  // 直接去签约页（type=2）；拿不到时间线再退回"从书卡点签约管理"
  await c.navigate(`https://fanqienovel.com/main/writer/book-info/${bookId}?type=2`);
  await c.sleep(6000);
  let text = await c.evaluate("(document.body.innerText||'')");
  if (!/签约流程|签约评估|申请提交/.test(text || '')) {
    await c.navigate('https://fanqienovel.com/main/writer/book-manage');
    await c.sleep(6000);
    const r = await c.evaluate(`(function(){${FIRE}
      var t=${JSON.stringify(String(title || ''))};
      var cards=[].slice.call(document.querySelectorAll('div')).filter(function(d){var s=d.innerText||'';return s.indexOf(t)>=0 && /签约管理/.test(s) && s.length<600;});
      cards.sort(function(a,b){return (a.innerText||'').length-(b.innerText||'').length;});
      var card=cards[0]; if(!card) return 'no-card';
      var b=[].slice.call(card.querySelectorAll('button,span,a')).find(function(e){return (e.innerText||'').trim()==='签约管理';});
      if(!b) return 'signed-or-no-btn'; __f(b); return 'ok';
    })()`);
    if (r === 'signed-or-no-btn') return { signed: true, steps: [], note: '书卡上没有「签约管理」按钮——多半已经签约' };
    if (r !== 'ok') return { error: '番茄作品列表里没找到这本书（账号选对了吗？）' };
    await c.sleep(4500);
    text = await c.evaluate("(document.body.innerText||'')");
  }
  const tl = parseSignTimeline(text);
  // 书卡上的公开字数/章数——签约评估看的就是这个数，不是本地写了多少
  await c.navigate('https://fanqienovel.com/main/writer/book-manage');
  await c.sleep(5000);
  const card = await c.evaluate(`(function(){
    var t=${JSON.stringify(String(title || ''))};
    var s=(document.body.innerText||'');
    var i=s.indexOf(t); if(i<0) return '';
    return s.slice(i, i+160).replace(/\\n+/g,' ｜ ');
  })()`);
  const ch = (String(card).match(/(\d+)\s*章/) || [])[1];
  const wan = (String(card).match(/([\d.]+)\s*万字/) || [])[1];
  return { ...tl, publicChapters: ch ? parseInt(ch, 10) : null, publicChars: wan ? Math.round(parseFloat(wan) * 10000) : null, card: String(card).slice(0, 160) };
}

export async function fetchChapterSchedule({ profilePath, bookId, onLog = () => {} }) {
  const c = new UnzooClient(profilePath, onLog, 'fanqienovel.com', '番茄');
  await c.ensureTabId();
  await c.navigate(`https://fanqienovel.com/main/writer/chapter-manage/${bookId}&1`);
  await c.sleep(8000);
  const all = new Map();
  for (let page = 1; page <= 20; page++) {
    const rows = await c.evaluate(`(function(){
      var L=(document.body.innerText||'').split(/\\n/).map(function(s){return s.trim();}).filter(Boolean);
      var out=[];
      for(var i=0;i<L.length;i++){ if(/^第\\d+章/.test(L[i])) out.push([L[i], L[i+1], L[i+3], L[i+4]||''].join('\\u0001')); }
      return out.join('\\u0002');
    })()`);
    let fresh = 0;
    for (const r of String(rows || '').split('\u0002').filter(Boolean)) {
      const [title, words, status, time] = r.split('\u0001');
      const num = parseInt((title.match(/第(\d+)章/) || [])[1], 10);
      if (!num || all.has(num)) continue;
      all.set(num, { num, title, words: parseInt(words, 10) || 0, status, time: /\d{4}-\d{2}-\d{2}/.test(time) ? time : '' });
      fresh++;
    }
    if (!fresh) break;
    const next = await c.evaluate(`(function(){${FIRE}
      var n=document.querySelector('.arco-pagination-item-next:not(.arco-pagination-item-disabled)');
      if(!n) return 'none'; __f(n); return 'ok';
    })()`);
    if (next !== 'ok') break;
    await c.sleep(3500);
  }
  return [...all.values()].sort((a, b) => a.num - b.num);
}
