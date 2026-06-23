// 交互式 TUI（数字菜单，零依赖，可被管道输入驱动 → 易自测）
import readline from 'node:readline';
import { loadConfig, updateConfig } from './config.mjs';
import { listBooksWithStats, createBook, getBook } from './books.mjs';
import { detectAll, getModel, MODELS } from './models.mjs';
import { findUntermExe, listInstances, readProxyConfig } from './unterm.mjs';
import { startWriting } from './writer.mjs';
import { listSessions, sendToBook, streamBook, stopBook, sampleTokens } from './attach.mjs';
import { loadUsage, bookUsage, fmtTokens } from './usage.mjs';
import { c, banner, hr, logLine } from './ui.mjs';

let rl;
function ask(q) {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

export async function runTui() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n' + banner() + '\n');
  if (!findUntermExe()) {
    console.log(c.red('⚠ 未检测到 Unterm（Windows: C:\\Program Files\\Unterm\\；macOS/Linux: ~/.local/bin/unterm 或 /Applications/Unterm.app）。写作功能需要它。\n'));
  }
  let alive = true;
  while (alive) {
    alive = await mainMenu();
  }
  rl.close();
  console.log(c.gray('\n再见 👋\n'));
}

async function mainMenu() {
  const cfg = loadConfig();
  const books = listBooksWithStats();
  console.log(c.bold('主菜单') + c.gray(`   书库:${cfg.workspace}  默认模型:${cfg.defaultModel}  代理:${cfg.enableProxy ? '开' : '关'}  autopilot:${cfg.autopilot.enabled ? '开' : '关'}`));
  console.log(hr());
  console.log(`  ${c.cyan('1')}  📚 我的书架  ${c.gray('(' + books.length + ' 本)')}`);
  console.log(`  ${c.cyan('2')}  ➕ 新建书`);
  console.log(`  ${c.cyan('3')}  ✍️  开始写作 ${c.gray('(选书 → 选模型 → 下指令 → 自动开窗+监控)')}`);
  const running = listSessions();
  console.log(`  ${c.cyan('4')}  🟢 运行中的写作 ${c.gray('(' + running.length + ' 个) — 穿插指令 / 实时镜像 / 停止')}`);
  console.log(`  ${c.cyan('5')}  📊 Token 用量统计`);
  console.log(`  ${c.cyan('6')}  ⚙️  设置`);
  console.log(`  ${c.cyan('7')}  🩺 环境自检 / 模型可用性`);
  console.log(`  ${c.cyan('8')}  🔌 实例 & 代理状态`);
  console.log(`  ${c.cyan('0')}  退出`);
  const sel = await ask('\n选择 > ');
  console.log('');
  switch (sel) {
    case '1': await shelf(); break;
    case '2': await createFlow(cfg); break;
    case '3': await writeFlow(cfg); break;
    case '4': await runningView(cfg); break;
    case '5': await usageView(); break;
    case '6': await settings(cfg); break;
    case '7': await doctorView(); break;
    case '8': await instancesView(); break;
    case '0': case 'q': case 'exit': return false;
    default: console.log(c.yellow('无效选择'));
  }
  return true;
}

async function runningView(cfg) {
  while (true) {
    const ss = listSessions();
    console.log(c.bold('🟢 运行中的写作') + '\n' + hr());
    if (!ss.length) { console.log(c.gray('  无运行中的会话。回主菜单选 3 开始写作。')); await ask(c.gray('\n回车返回…')); return; }
    ss.forEach((s, i) => console.log(`  ${c.cyan(String(i + 1))}. 《${s.title}》 ${c.gray('模型' + s.model + ' · 实例' + s.instanceId + ' · tokens≈' + fmtTokens(bookUsage(s.slug)))}`));
    console.log(c.gray('  0. 返回'));
    const pick = await ask('\n选会话 > ');
    if (pick === '0' || pick === '') return;
    const s = ss[Number(pick) - 1];
    if (!s) { console.log(c.yellow('无效选择')); continue; }
    await sessionActions(s, cfg);
  }
}

async function sessionActions(s, cfg) {
  console.log(c.bold(`\n《${s.title}》`) + '\n' + hr());
  console.log(`  ${c.cyan('1')} ✍️  穿插一条指令（注入到正在写作的窗口）`);
  console.log(`  ${c.cyan('2')} 📺 实时镜像窗口内容`);
  console.log(`  ${c.cyan('3')} ⏹️  停止并关闭该窗口`);
  console.log(`  ${c.cyan('0')} 返回`);
  const a = await ask('\n选择 > ');
  if (a === '1') {
    const text = await ask('穿插指令 > ');
    if (!text) { console.log(c.yellow('已取消')); return; }
    try { const r = await sendToBook(s.slug, text, cfg); console.log(c.green(`✔ 已注入到实例 ${r.instance} pane ${r.pane}`)); }
    catch (e) { console.log(c.red('✖ ' + e.message)); }
    await ask(c.gray('回车返回…'));
  } else if (a === '2') {
    await watchInTui(s, cfg);
  } else if (a === '3') {
    const r = stopBook(s.slug);
    console.log(r.ok ? c.green(`✔ 已停止并关闭窗口 (pid ${r.killed})`) : c.yellow('未找到会话'));
    await ask(c.gray('回车返回…'));
  }
}

async function watchInTui(s, cfg) {
  console.log(c.gray('正在镜像…（回车停止）'));
  rl.pause();
  let handle;
  try {
    handle = await streamBook(s.slug, cfg, (txt) => {
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(c.cyan(`── 《${s.title}》实时镜像 ` + new Date().toLocaleTimeString() + c.gray('  （回车停止）') + ' ──'));
      console.log(txt);
    }, { intervalMs: 1000 });
  } catch (e) { rl.resume(); console.log(c.red('✖ ' + e.message)); await ask(c.gray('回车…')); return; }
  await new Promise((resolve) => {
    const onData = (d) => {
      if (/[\r\n]/.test(String(d))) { process.stdin.removeListener('data', onData); resolve(); }
    };
    process.stdin.on('data', onData);
  });
  handle.stop();
  rl.resume();
  console.log(c.gray('\n已停止镜像。'));
}

async function shelf() {
  const books = listBooksWithStats();
  console.log(c.bold('📚 书架') + '\n' + hr());
  if (!books.length) { console.log(c.gray('  空。回主菜单选 2 新建。')); }
  books.forEach((b, i) => {
    console.log(`  ${c.cyan(String(i + 1))}. ${c.bold('《' + b.title + '》')} ${c.gray(b.genre || '')}`);
    console.log(`     ${c.gray('章节 ' + b.stats.chapters + ' · ' + b.stats.kb + 'KB · 模型 ' + b.model + ' · tokens≈' + fmtTokens(bookUsage(b.slug)))}`);
    console.log(`     ${c.gray(b.dir)}`);
  });
  await ask(c.gray('\n回车返回…'));
}

async function createFlow(cfg) {
  console.log(c.bold('➕ 新建书') + '\n' + hr());
  const title = await ask('书名 > ');
  if (!title) { console.log(c.yellow('已取消')); return; }
  const genre = await ask('一句话类型/卖点 (可空) > ');
  const totalWords = await ask('目标总字数 (可空，如 200万) > ');
  const volumes = await ask('计划卷数 (可空) > ');
  const cpv = await ask('每卷约章数 (可空) > ');
  const batch = await ask('每批写几章 (默认5) > ');
  const model = await pickModel(cfg, '默认写作模型');
  try {
    const book = createBook({
      title, genre, totalWords, volumes, chaptersPerVolume: cpv,
      batchSize: batch ? Number(batch) : 5, model,
    }, cfg);
    console.log(c.green(`\n✔ 《${book.title}》已创建`));
    console.log(c.gray('  目录: ' + book.dir));
    console.log(c.gray('  profile: ' + book.profile + ' · 已生成 bible/index/outline + 三模型上下文文件'));
  } catch (e) { console.log(c.red('✖ ' + e.message)); }
  await ask(c.gray('\n回车返回…'));
}

async function writeFlow(cfg) {
  const books = listBooksWithStats();
  if (!books.length) { console.log(c.yellow('还没有书，先新建。')); await ask(c.gray('回车…')); return; }
  console.log(c.bold('✍️  开始写作') + '\n' + hr());
  books.forEach((b, i) => console.log(`  ${c.cyan(String(i + 1))}. 《${b.title}》 ${c.gray('章节' + b.stats.chapters + ' · ' + b.model)}`));
  const pick = await ask('\n选哪本 > ');
  const book = books[Number(pick) - 1];
  if (!book) { console.log(c.yellow('无效选择')); return; }

  const model = await pickModel(cfg, '本次模型', book.model);
  const det = detectAll().find(m => m.id === model);
  if (!det?.available) {
    console.log(c.red(`✖ ${getModel(model).name} 不可用。先安装：unterm-cli agent install ${getModel(model).untermAgentId}`));
    await ask(c.gray('回车…')); return;
  }

  const def = `请阅读 AGENTS.md/CLAUDE.md 写作规范与 novel_bible.md，然后续写下一批 ${book.standards?.batchSize || 5} 章，写完自检。`;
  console.log(c.gray('\n写作指令（回车用默认）：\n  默认 = ' + def));
  const task = (await ask('指令 > ')) || def;

  console.log(c.bold(`\n启动中…  《${book.title}》 / ${getModel(model).name}`) + '\n' + hr());
  const onLog = (e) => console.log('  ' + logLine(e));
  try {
    const sess = await startWriting({ book, model, instruction: task, cfg, onLog });
    console.log(hr());
    console.log(c.green('✔ 已开窗，autopilot ' + (cfg.autopilot.enabled ? '运行中（自动应答+续写）' : '关闭')));
    console.log(c.gray('  实例 ' + sess.instance.id + ' · pane ' + sess.paneId + '。窗口里实时观看；本菜单可继续操作其它书。'));
    if (cfg.autopilot.enabled) {
      console.log(c.gray('  autopilot 在后台运行，下面是实时日志（回车返回主菜单，监控继续）：'));
      await ask('');
    } else {
      await ask(c.gray('回车返回…'));
    }
  } catch (e) {
    console.log(c.red('✖ ' + e.message));
    await ask(c.gray('回车…'));
  }
}

async function pickModel(cfg, label, dflt) {
  const ids = Object.keys(MODELS);
  const det = detectAll();
  console.log(c.gray('\n' + label + '：'));
  ids.forEach((id, i) => {
    const d = det.find(m => m.id === id);
    console.log(`  ${c.cyan(String(i + 1))}. ${getModel(id).name} ${d?.available ? c.green('✔可用') : c.red('✖未装')}${id === (dflt || cfg.defaultModel) ? c.gray(' (默认)') : ''}`);
  });
  const a = await ask('选模型 (回车=默认) > ');
  if (!a) return dflt || cfg.defaultModel;
  return ids[Number(a) - 1] || dflt || cfg.defaultModel;
}

async function settings(cfg) {
  console.log(c.bold('⚙️  设置') + '\n' + hr());
  console.log(`  ${c.cyan('1')} 书库目录   ${c.gray(cfg.workspace)}`);
  console.log(`  ${c.cyan('2')} 默认模型   ${c.gray(cfg.defaultModel)}`);
  console.log(`  ${c.cyan('3')} 代理       ${c.gray(cfg.enableProxy ? '开 (节点 ' + cfg.proxyNode + ')' : '关')}`);
  console.log(`  ${c.cyan('4')} autopilot  ${c.gray(cfg.autopilot.enabled ? '开' : '关')}  ${c.gray('每批上限 ' + cfg.autopilot.maxAutoContinue + ' · 轮询 ' + cfg.autopilot.pollMs + 'ms')}`);
  console.log(`  ${c.cyan('5')} 自动"继续"指令文案`);
  console.log(`  ${c.cyan('0')} 返回`);
  const s = await ask('\n选择 > ');
  if (s === '1') { const v = await ask('新书库目录 > '); if (v) updateConfig({ workspace: v }); }
  else if (s === '2') { const m = await pickModel(cfg, '默认模型'); updateConfig({ defaultModel: m }); }
  else if (s === '3') { const v = await ask('代理(auto/local/off) > '); updateConfig(v === 'off' ? { enableProxy: false } : { enableProxy: true, proxyNode: v || 'auto' }); }
  else if (s === '4') { const v = await ask('autopilot (on/off) > '); updateConfig({ autopilot: { enabled: v !== 'off' } }); }
  else if (s === '5') { const v = await ask('继续指令文案 > '); if (v) updateConfig({ autopilot: { continueText: v } }); }
  else return;
  console.log(c.green('✔ 已保存'));
  await ask(c.gray('回车返回…'));
}

async function usageView() {
  const u = loadUsage();
  console.log(c.bold('📊 Token 用量统计') + c.gray('  (来源：各 agent TUI 累计 token；约数)') + '\n' + hr());
  const slugs = Object.keys(u.books);
  if (!slugs.length) { console.log(c.gray('  暂无记录。开始写作后自动统计。')); await ask(c.gray('\n回车返回…')); return; }
  let grand = 0;
  const books = listBooksWithStats();
  for (const slug of slugs) {
    const b = u.books[slug]; grand += b.total;
    const title = books.find(x => x.slug === slug)?.title || slug;
    console.log(`  ${c.cyan('《' + title + '》')}  ${c.bold(fmtTokens(b.total))} ${c.gray('(' + b.total.toLocaleString() + ') · 会话 ' + Object.keys(b.sessions || {}).length)}`);
  }
  console.log(hr() + '  合计 ' + c.cyan(fmtTokens(grand)) + c.gray(' tokens'));
  await ask(c.gray('\n回车返回…'));
}

async function doctorView() {
  console.log(c.bold('🩺 环境 / 模型') + '\n' + hr());
  console.log('  Unterm: ' + (findUntermExe() ? c.green(findUntermExe()) : c.red('未找到')));
  for (const m of detectAll()) {
    console.log(`  ${m.available ? c.green('✔') : c.red('✖')} ${m.name} ${c.gray(m.available ? m.path : '未装: unterm-cli agent install ' + m.untermAgentId)}`);
  }
  await ask(c.gray('\n回车返回…'));
}

async function instancesView() {
  console.log(c.bold('🔌 运行中实例 & 代理') + '\n' + hr());
  const inst = listInstances();
  if (!inst.length) console.log(c.gray('  无运行中实例'));
  inst.forEach(i => console.log(`  ${c.cyan(i.id)}  v${i.version}  mcp:${i.mcp_port}  ${c.gray(i.cwd || '')}`));
  const p = readProxyConfig();
  console.log(hr());
  console.log('  代理: ' + (p ? c.gray((p.enabled ? '启用' : '禁用') + ' ' + (p.http_proxy || '') + ' 节点=' + p.current_node) : '无'));
  await ask(c.gray('\n回车返回…'));
}
