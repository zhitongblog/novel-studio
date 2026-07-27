// 非交互式 CLI 命令
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, updateConfig } from './config.mjs';
import { createBook, listBooksWithStats, getBook } from './books.mjs';
import { detectAll, getModel } from './models.mjs';
import { findUntermExe, findUntermCli, untermVersion, listInstances, readProxyConfig, resolveProxyNode } from './unterm.mjs';
import { startWriting } from './writer.mjs';
import { listSessions, sendToBook, streamBook, stopBook, attachAutopilot, sampleTokens } from './attach.mjs';
import { loadUsage, bookUsage, fmtTokens } from './usage.mjs';
import { c, logLine, hr } from './ui.mjs';

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
  const f = parseFlags(rest);
  const cfg = loadConfig();

  switch (cmd) {
    case 'doctor': return doctor();
    case 'models': return models();
    case 'book': return bookCmd(rest, cfg);
    case 'books': return bookList(cfg);
    case 'write': return writeCmd(f, cfg);
    case 'stateless': return statelessCmd(f, cfg);
    case 'sessions': return sessionsCmd(cfg);
    case 'send': return sendCmd(f, cfg);
    case 'watch': return watchCmd(f, cfg);
    case 'autopilot': return autopilotCmd(f, cfg);
    case 'usage': return usageCmd(f, cfg);
    case 'stop': return stopCmd(f);
    case 'config': return configCmd(f, cfg);
    case 'reference': return reference();
    default:
      console.log('未知命令：' + cmd);
      console.log('可用：doctor | models | book new|list | write | stateless | sessions | send | watch | stop | config | reference | mcp | tui');
      process.exitCode = 1;
  }
}

function doctor() {
  console.log(c.bold('\n🩺 环境自检\n') + hr());
  const exe = findUntermExe(), cli = findUntermCli();
  const exeV = exe ? untermVersion(exe) : '';
  line('Unterm GUI', exe ? `${exe}  [${exeV || '?'}]` : '未找到', !!exe);
  line('Unterm CLI', cli || '未找到', !!cli);
  const inst = listInstances();
  line('运行中实例', inst.length ? inst.map(i => `${i.id}(v${i.version})`).join(', ') : '无', true);
  const proxy = readProxyConfig();
  line('代理配置', proxy ? `${proxy.enabled ? '启用' : '禁用'} ${proxy.http_proxy || ''} 节点=${proxy.current_node}` : '无', !!proxy);
  console.log(hr());
  for (const m of detectAll()) line('模型 ' + m.name, m.available ? m.path : `不可用（${m.bin} 不在 PATH）`, m.available);
  console.log(hr());
  const books = listBooksWithStats();
  line('已登记书目', books.length + ' 本', true);
  console.log('');
}

function models() {
  console.log(c.bold('\n模型 CLI 可用性\n') + hr());
  for (const m of detectAll()) {
    console.log(`${m.available ? c.green('✔') : c.red('✖')} ${c.bold(m.name)}  (${m.bin})`);
    console.log('   ' + c.gray(m.available ? m.path : '不可用：unterm-cli agent install ' + m.untermAgentId));
    console.log('   ' + c.gray(m.note));
  }
  console.log('');
}

function bookCmd(rest, cfg) {
  const [sub, ...r] = rest;
  const f = parseFlags(r);
  if (sub === 'new') {
    const book = createBook({
      title: f.title || f._[0],
      genre: f.genre, model: f.model,
      totalWords: f.words, volumes: f.volumes, chaptersPerVolume: f.cpv,
      batchSize: f.batch ? Number(f.batch) : undefined,
    }, cfg);
    console.log(c.green('\n✔ 已创建《' + book.title + '》'));
    console.log('   目录：' + book.dir);
    console.log('   profile：' + book.profile);
    console.log('   默认模型：' + book.model);
    console.log(c.gray('   已生成 novel_bible.md / chapter_index.md / outlines / AGENTS.md / CLAUDE.md / GEMINI.md\n'));
    return;
  }
  if (sub === 'list' || !sub) return bookList(cfg);
  console.log('book 子命令：new | list');
}

function bookList(cfg) {
  const books = listBooksWithStats();
  console.log(c.bold('\n📚 书架') + c.gray(`  (书库：${cfg.workspace})\n`) + hr());
  if (!books.length) { console.log(c.gray('  还没有书。用 `novel book new --title "书名"` 新建。\n')); return; }
  for (const b of books) {
    console.log(`${c.cyan('《' + b.title + '》')}  ${c.gray(b.genre || '')}`);
    console.log(`   ${c.gray('profile=' + b.profile + '  模型=' + b.model + '  章节=' + b.stats.chapters + '  ' + b.stats.kb + 'KB  tokens≈' + fmtTokens(bookUsage(b.slug)))}`);
    console.log(`   ${c.gray(b.dir)}`);
  }
  console.log('');
}

async function writeCmd(f, cfg) {
  const id = f.book || f._[0];
  if (!id) { console.log('用法：novel write --book "书名" --model codex --task "续写5章并自检"'); process.exitCode = 1; return; }
  const book = getBook(id);
  if (!book) { console.log(c.red('找不到书：' + id)); process.exitCode = 1; return; }
  const model = f.model || book.model || cfg.defaultModel;
  const instruction = f.task || f.instruction ||
    `请阅读本项目的 AGENTS.md/CLAUDE.md 写作规范与 novel_bible.md，然后续写下一批 ${book.standards?.batchSize || 5} 章并在结束后自检。`;

  if (f.dry) {
    const { writeLaunchScript } = await import('./writer.mjs');
    const p = writeLaunchScript(book, model, instruction, cfg);
    console.log(c.yellow('\n[dry-run] 已生成 launch.ps1，但不启动窗口：') + '\n' + p);
    const { winShell } = await import('./unterm.mjs');
    console.log(c.gray('\n将会执行：') + `\n  unterm.exe --profile ${book.profile} start --always-new-process --cwd "${book.dir}" -e ${winShell()} -NoExit -File "${p}"`);
    console.log(c.gray('  模型：') + getModel(model).name + c.gray('  指令：') + instruction + '\n');
    return;
  }

  console.log(c.bold(`\n✍️  开始写作《${book.title}》  模型=${getModel(model).name}`));
  console.log(c.gray('   指令：' + instruction) + '\n' + hr());
  const onLog = (e) => console.log('  ' + logLine(e));
  try {
    const sess = await startWriting({ book, model, instruction, cfg, onLog });
    console.log(hr());
    console.log(c.green(`✔ 已在新窗口启动，autopilot ${cfg.autopilot.enabled ? '运行中' : '已关闭'}。实例=${sess.instance.id} pane=${sess.paneId}`));
    console.log(c.gray('  在弹出的 Unterm 窗口里实时观看写作；Ctrl+C 退出本监控（窗口继续运行）。\n'));
    // 保持进程存活以维持 autopilot
    if (cfg.autopilot.enabled) {
      process.stdin.resume();
      await new Promise(() => {});
    }
  } catch (e) {
    console.log(c.red('✖ ' + e.message));
    process.exitCode = 1;
  }
}

// 无状态分章写作：每批全新无头进程 + 精准重喂上下文包（省 token、防漂移）。
// 用法：novel stateless --book 书名 [--model codex] [--n 批数] [--batch 每批章数] [--dry]
async function statelessCmd(f, cfg) {
  const id = f.book || f._[0];
  if (!id) { console.log('用法：novel stateless --book 书名 [--model codex] [--n 1] [--batch 3] [--dry]'); process.exitCode = 1; return; }
  const book = getBook(id);
  if (!book) { console.log(c.red('找不到书：' + id)); process.exitCode = 1; return; }
  const model = f.model || book.model || cfg.defaultModel;
  const batches = Math.max(1, parseInt(f.n, 10) || 1);
  const batchSize = f.batch ? Math.max(1, parseInt(f.batch, 10)) : (book.standards?.batchSize || 3);
  const { runStateless, writeBatchStateless } = await import('./statelessWriter.mjs');

  if (f.dry) {
    const pack = await writeBatchStateless({ book, model, cfg, count: batchSize, dryRun: true });
    const s = pack.sizes, mt = pack.meta;
    console.log(c.bold(`\n🧪 [dry-run] 《${book.title}》无状态上下文包（不调模型、不写文件）\n`) + hr());
    console.log(`  续写区间：第 ${c.cyan(String(mt.nextNum).padStart(3, '0'))}–${c.cyan(String(mt.lastNum).padStart(3, '0'))} 章（共 ${mt.count} 章，当前卷${mt.volNum}，已写 ${mt.totalChapters} 章）`);
    console.log(hr());
    console.log('  上下文包各部分体积（字符数）：');
    console.log(`    设定圣经摘录   ${String(s.bible).padStart(6)}`);
    console.log(`    本卷分章大纲   ${String(s.outline).padStart(6)}`);
    console.log(`    主线伏笔表     ${String(s.foreshadow).padStart(6)}`);
    console.log(`    连贯性台账     ${String(s.ledger).padStart(6)}`);
    console.log(`    上一章结尾     ${String(s.lastTail).padStart(6)}`);
    console.log(`    近期章名表     ${String(s.names).padStart(6)}`);
    console.log(`    最近自检未决   ${String(s.review).padStart(6)}`);
    console.log(hr());
    console.log(`  ${c.bold('整包合计')}：${c.cyan(s.promptChars.toLocaleString())} 字符 ≈ ${c.cyan(s.estTokens.toLocaleString())} tokens ${c.gray('（每批固定，不随已写章数增长）')}`);
    console.log(c.gray('\n  ── 完整 prompt 预览（前 1600 字）──'));
    console.log(pack.prompt.slice(0, 1600) + c.gray('\n  …（略）\n'));
    return;
  }

  console.log(c.bold(`\n✍️  无状态写作《${book.title}》  模型=${getModel(model).name}  ${batches} 批 × ${batchSize} 章`));
  console.log(c.gray('  每批全新进程，写完即弃会话；上下文由精准上下文包重喂。\n') + hr());
  try {
    const r = await runStateless({ book, model, cfg, batches, batchSize, onLog: (e) => console.log('  ' + logLine(e)) });
    console.log(hr());
    console.log(c.green(`✔ 完成：${r.batches} 批，新增 ${r.totalWrote} 章。`) + c.gray('  用 `novel usage --book ' + id + '` 看 token。\n'));
  } catch (e) { console.log(c.red('✖ ' + e.message)); process.exitCode = 1; }
}

async function sessionsCmd(cfg) {
  const ss = listSessions();
  console.log(c.bold('\n🟢 运行中的写作会话\n') + hr());
  if (!ss.length) { console.log(c.gray('  无。用 `novel write --book 书名` 启动。\n')); return; }
  for (const s of ss) {
    const tk = await sampleTokens(s.slug, cfg).catch(() => null);  // 实时采样当前 token
    const tkStr = tk ? '  tokens(本会话)≈' + fmtTokens(tk) : '';
    console.log(`${c.cyan('《' + s.title + '》')}  ${c.gray('模型=' + s.model + ' · 实例=' + s.instanceId + ' · pane=' + s.pane + ' · pid=' + s.pid + tkStr)}`);
    console.log(c.gray('   起于 ' + s.startedAt + '  累计 tokens≈' + fmtTokens(bookUsage(s.slug))));
  }
  console.log(c.gray('\n  穿插指令: novel send --book 书名 --task "..."   实时镜像: novel watch --book 书名\n'));
}

function usageCmd(f, cfg) {
  const u = loadUsage();
  const id = f.book || f._[0];
  console.log(c.bold('\n📊 Token 用量统计') + c.gray('  (来源：各 agent TUI 的累计 token；约数)\n') + hr());
  const slugs = id ? [resolveSlug(id)] : Object.keys(u.books);
  if (!slugs.length) { console.log(c.gray('  暂无用量记录。开始写作后自动统计。\n')); return; }
  let grand = 0;
  for (const slug of slugs) {
    const b = u.books[slug];
    if (!b) { console.log(c.gray('  ' + slug + '：无记录')); continue; }
    grand += b.total;
    const book = listBooksWithStats().find(x => x.slug === slug);
    console.log(`${c.cyan('《' + (book?.title || slug) + '》')}  ${c.bold(fmtTokens(b.total))} tokens  ${c.gray('(' + b.total.toLocaleString() + ')')}`);
    const sk = Object.keys(b.sessions || {});
    console.log(c.gray('   写作会话数 ' + sk.length + ' · 最近更新 ' + (b.updatedAt || '-')));
  }
  if (slugs.length > 1) console.log(hr() + '\n' + c.bold('合计：') + c.cyan(fmtTokens(grand)) + c.gray(' tokens (' + grand.toLocaleString() + ')'));
  console.log('');
}

async function sendCmd(f, cfg) {
  const id = f.book || f._[0];
  const text = f.task || f.instruction || f._.slice(1).join(' ');
  if (!id || !text) { console.log('用法：novel send --book 书名 --task "穿插的指令"'); process.exitCode = 1; return; }
  const slug = resolveSlug(id);
  try {
    const r = await sendToBook(slug, text, cfg);
    console.log(c.green(`✔ 已穿插指令到《${id}》(实例 ${r.instance}, pane ${r.pane})`));
    console.log(c.gray('  内容：' + text));
  } catch (e) { console.log(c.red('✖ ' + e.message)); process.exitCode = 1; }
}

async function watchCmd(f, cfg) {
  const id = f.book || f._[0];
  if (!id) { console.log('用法：novel watch --book 书名   (Ctrl+C 退出)'); process.exitCode = 1; return; }
  const slug = resolveSlug(id);
  console.log(c.gray(`镜像《${id}》的窗口实时内容（Ctrl+C 退出）…`));
  let handle;
  try {
    handle = await streamBook(slug, cfg, (txt) => {
      process.stdout.write('\x1b[2J\x1b[H');  // 清屏到左上
      console.log(c.cyan(`── 《${id}》实时镜像 ` + new Date().toLocaleTimeString() + ' ──'));
      console.log(txt);
    }, { intervalMs: 1000 });
  } catch (e) { console.log(c.red('✖ ' + e.message)); process.exitCode = 1; return; }
  process.on('SIGINT', () => { handle.stop(); console.log(c.gray('\n已停止镜像。')); process.exit(0); });
  await new Promise(() => {});  // 保持运行直到 Ctrl+C
}

async function autopilotCmd(f, cfg) {
  const id = f.book || f._[0];
  if (!id) { console.log('用法：novel autopilot --book 书名   (给已运行的会话挂上自动监控，Ctrl+C 退出)'); process.exitCode = 1; return; }
  const slug = resolveSlug(id);
  console.log(c.gray(`给《${id}》挂上 autopilot 自动监控应答（Ctrl+C 退出）…`));
  try {
    const h = await attachAutopilot(slug, cfg, (e) => console.log('  ' + logLine(e)));
    process.on('SIGINT', () => { h.stop(); console.log(c.gray('\n已分离 autopilot。')); process.exit(0); });
    await new Promise(() => {});
  } catch (e) { console.log(c.red('✖ ' + e.message)); process.exitCode = 1; }
}

function stopCmd(f) {
  const id = f.book || f._[0];
  if (!id) { console.log('用法：novel stop --book 书名'); process.exitCode = 1; return; }
  const r = stopBook(resolveSlug(id));
  if (r.ok) console.log(c.green(`✔ 已停止《${id}》并关闭其 Unterm 窗口 (pid ${r.killed})`));
  else console.log(c.yellow('未找到运行中会话：' + id));
}

function resolveSlug(id) {
  const b = getBook(id);
  if (b) return b.slug;
  // 可能直接给的就是 slug
  return id;
}

function configCmd(f, cfg) {
  if (f._[0] === 'set' || f.set) {
    const patch = {};
    if (f.workspace) patch.workspace = path.resolve(f.workspace);
    if (f.model) patch.defaultModel = f.model;
    if (f.proxy === 'off') patch.enableProxy = false;
    if (f.proxy && f.proxy !== 'off') { patch.enableProxy = true; patch.proxyNode = f.proxy; }
    if (f.autopilot === 'off') patch.autopilot = { enabled: false };
    if (f.autopilot === 'on') patch.autopilot = { enabled: true };
    const out = updateConfig(patch);
    console.log(c.green('✔ 已更新配置'));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(c.bold('\n当前配置\n') + hr());
  console.log(JSON.stringify(cfg, null, 2) + '\n');
  console.log(c.gray('修改：novel config set --workspace D:\\path --model codex --proxy auto --autopilot on'));
}

function reference() {
  const cli = findUntermCli();
  if (!cli) { console.log(c.red('unterm-cli 未找到')); return; }
  const r = spawnSync(cli, ['reference'], { encoding: 'utf8', stdio: 'inherit' });
  if (r.status !== 0) console.log(c.gray('（reference 需连接到 0.22+ 实例；可改用 doctor 查看本机状态）'));
}

function line(label, val, ok) {
  const mark = ok ? c.green('✔') : c.red('✖');
  console.log(`${mark} ${c.bold(label.padEnd(14))} ${c.gray(val)}`);
}
