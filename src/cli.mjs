// 非交互式 CLI 命令
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig, updateConfig } from './config.mjs';
import { createBook, listBooksWithStats, getBook } from './books.mjs';
import { detectAll, getModel } from './models.mjs';
import { findUntermExe, findUntermCli, untermVersion, listInstances, readProxyConfig, resolveProxyNode, sharesGlobalPaneNamespace, versionMismatch } from './unterm.mjs';
import { startWriting } from './writer.mjs';
import { listSessions, sendToBook, streamBook, stopBook, attachAutopilot, sampleTokens } from './attach.mjs';
import { loadUsage, bookUsage, fmtTokens } from './usage.mjs';
import { localHealth, buildModelfile, resolveOllamaBin } from './localai.mjs';
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
    case 'models': return f.list ? listProviderModels(String(f.list)) : models();
    case 'book': return bookCmd(rest, cfg);
    case 'books': return bookList(cfg);
    case 'write': return writeCmd(f, cfg);
    case 'stateless': return statelessCmd(f, cfg);
    case 'ledger': return ledgerCmd(f, cfg);
    case 'sessions': return sessionsCmd(cfg);
    case 'send': return sendCmd(f, cfg);
    case 'watch': return watchCmd(f, cfg);
    case 'autopilot': return autopilotCmd(f, cfg);
    case 'usage': return usageCmd(f, cfg);
    case 'local': return localCmd(f, cfg);
    case 'stop': return stopCmd(f);
    case 'config': return configCmd(f, cfg);
    case 'reference': return reference();
    default:
      console.log('未知命令：' + cmd);
      console.log('可用：doctor | models | local [import] | book new|list | write | stateless | ledger | sessions | send | watch | stop | config | reference | mcp | tui');
      process.exitCode = 1;
  }
}

async function doctor() {
  console.log(c.bold('\n🩺 环境自检\n') + hr());
  const exe = findUntermExe(), cli = findUntermCli();
  const exeV = exe ? untermVersion(exe) : '';
  line('Unterm GUI', exe ? `${exe}  [${exeV || '?'}]` : '未找到', !!exe);
  line('Unterm CLI', cli || '未找到', !!cli);
  const inst = listInstances();
  line('运行中实例', inst.length ? inst.map(i => `${i.id}(v${i.version})`).join(', ') : '无', true);
  // Unterm ≥0.65：所有窗口共用一个 MCP 端口，pane 编号是全机器的 —— 出问题时这一行最能说明状况
  const shared = sharesGlobalPaneNamespace();
  if (shared !== null) line('pane 命名空间', shared ? '全机器共用（0.65+）：按 shell.cwd 认本书的 pane' : '按窗口独立（旧版）', true);
  // 版本错配：装了多份 Unterm 时，自动找到的可能不是你实际在用的那个
  const mm = versionMismatch();
  if (mm) {
    line('⚠ 版本错配', `将启动 ${mm.binVersion}（${mm.exe}），但运行中的实例是 ${mm.runningVersions.join('/')}`, false);
    console.log(c.gray('   开写作窗口会用上面那个旧二进制。若要改用你实际在跑的那份：'));
    console.log(c.gray('   novel config set --unterm-exe "<新版 unterm.exe 的完整路径>"'));
  }
  const proxy = readProxyConfig();
  line('代理配置', proxy ? `${proxy.enabled ? '启用' : '禁用'} ${proxy.http_proxy || ''} 节点=${proxy.current_node}` : '无', !!proxy);
  console.log(hr());
  for (const m of detectAll()) line('模型 ' + m.name, m.available ? m.path : `不可用（${m.bin} 不在 PATH）`, m.available);
  console.log(hr());
  // 本地模型：可用性不看 PATH、也不看 key，只看那两个本地服务在不在（起没起）。
  try {
    const h = await localHealth(loadConfig());
    line('显卡', h.gpu.ok ? `${h.gpu.name}  ${(h.gpu.totalMb / 1024).toFixed(0)}G 显存（已用 ${(h.gpu.usedMb / 1024).toFixed(1)}G）` : h.gpu.reason, h.gpu.ok);
    line('本地文本服务', h.text.ok
      ? `${h.text.kind === 'ollama' ? 'Ollama' + (h.text.version ? ' v' + h.text.version : '') : 'OpenAI 兼容'} @ ${h.text.baseUrl}｜已装 ${h.text.models.length} 个模型`
      : h.text.error, h.text.ok);
    line('本地出图服务', h.image.ok ? `${h.image.backend === 'a1111' ? 'SD WebUI' : 'ComfyUI'} @ ${h.image.baseUrl}｜${h.image.info}` : h.image.error, h.image.ok);
  } catch (e) { line('本地模型', '体检失败：' + e.message, false); }
  console.log(hr());
  const books = listBooksWithStats();
  line('已登记书目', books.length + ' 本', true);
  console.log('');
}

function localImport(f, cfg) {
  const file = f.file || f._[1];
  if (!file) {
    console.log(c.red('\n用法：') + 'novel local import --file <模型.gguf> [--name qwen3:14b] [--ctx 16384]\n');
    console.log(c.gray('  用途：Ollama 的模型放在 Cloudflare R2，国内常见直连被墙、走代理也持续 EOF，'));
    console.log(c.gray('        `ollama pull` 卡在某个百分比下不完。此时从魔搭下 GGUF 再用这条命令导入。'));
    console.log(c.gray('  魔搭：https://modelscope.cn/models/Qwen/Qwen3-14B-GGUF （选 Q4_K_M）\n'));
    process.exitCode = 1; return;
  }
  if (!fs.existsSync(file)) { console.log(c.red('找不到文件：') + file); process.exitCode = 1; return; }

  const name = f.name || (cfg.api?.local?.model) || 'qwen3:14b';
  const numCtx = Number(f.ctx) || cfg.api?.local?.numCtx || 16384;
  const content = buildModelfile({ ggufPath: path.resolve(file), name, numCtx });
  const mf = path.join(os.tmpdir(), 'novel-Modelfile-' + Date.now());
  fs.writeFileSync(mf, content, 'utf8');

  console.log(c.bold('\n生成的 Modelfile：\n') + hr());
  console.log(c.gray(content) + hr());
  console.log(`导入为 ${c.bold(name)}（要算一遍摘要，约 1–3 分钟）…\n`);

  // 不能只写 'ollama'——Windows 上装完 Ollama，已运行的进程拿不到新 PATH（见 resolveOllamaBin）
  const bin = resolveOllamaBin();
  if (!bin) {
    console.log(c.red('\n找不到 ollama。') + c.gray('先装：winget install Ollama.Ollama；装完若仍报此错，重开一个终端再试。\n'));
    try { fs.unlinkSync(mf); } catch {}
    process.exitCode = 1; return;
  }
  const r = spawnSync(bin, ['create', name, '-f', mf], { encoding: 'utf8', stdio: 'inherit', windowsHide: true });
  try { fs.unlinkSync(mf); } catch {}
  if (r.status !== 0) {
    console.log(c.red('\n导入失败。'));
    console.log(c.gray('  ① 确认 `ollama serve` 已启动（' + bin + '）；'));
    // GGUF 校验失败最常见的原因是【文件下坏了】，而下载工具的断点续传出错时
    // 文件大小往往【分毫不差】——只有逐字节的哈希能发现。所以这里直接给算哈希的命令。
    console.log(c.gray('  ② 若报 GGUF 校验/解析失败，多半是【文件下坏了】。'));
    console.log(c.gray('     ⚠️ 大小对不代表文件对——续传出错时大小常常正好凑对，只有哈希能发现：'));
    console.log('     ' + c.green(`certutil -hashfile "${path.resolve(file)}" SHA256`));
    console.log(c.gray('     跟模型页上的 SHA256 比对，不一致就重新下载。\n'));
    process.exitCode = 1; return;
  }
  console.log(c.green('\n✔ 导入完成。') + c.gray(' 跑 `novel local` 确认，然后在写作台选「本地模型」即可开写。\n'));
}

// novel local —— 本地模型体检 + 按你这块卡的选型建议 + 照着抄的安装命令。
// 存在的意义：本地部署最劝退的不是装，是「装哪个/装多大/为什么这么慢」。这条命令把它一次答完。
async function localCmd(f, cfg) {
  // novel local import --file <x.gguf> [--name qwen3:14b] —— 把手动下来的 GGUF 导进 Ollama。
  // 给「ollama pull 在国内拉不动」这个常见死局用：从魔搭下 GGUF，一条命令导入，效果与 pull 等价。
  if (f._[0] === 'import') return localImport(f, cfg);

  const h = await localHealth(cfg);
  console.log(c.bold('\n🖥️  本地模型体检\n') + hr());

  if (h.gpu.ok) {
    console.log(`${c.green('✔')} 显卡：${c.bold(h.gpu.name)}  ${(h.gpu.totalMb / 1024).toFixed(0)}G 显存（当前空闲 ${(h.gpu.freeMb / 1024).toFixed(1)}G）`);
  } else {
    console.log(`${c.red('✖')} 显卡：${h.gpu.reason}（无独显只能用 CPU 跑，长篇写作会慢到不可用）`);
  }

  const t = h.text;
  if (t.ok) {
    console.log(`${c.green('✔')} 文本服务：${t.kind === 'ollama' ? 'Ollama' + (t.version ? ' v' + t.version : '') : 'OpenAI 兼容服务'} @ ${t.baseUrl}`);
    if (t.models.length) {
      console.log('   已装模型：');
      for (const m of t.models.slice(0, 12)) console.log('     · ' + m.name + (m.sizeText ? c.gray('  ' + m.sizeText) : ''));
    } else console.log(c.gray('   （还没装任何模型）'));
  } else {
    console.log(`${c.red('✖')} 文本服务：${t.error}`);
  }

  const im = h.image;
  console.log(im.ok
    ? `${c.green('✔')} 出图服务：${im.backend === 'a1111' ? 'SD WebUI' : 'ComfyUI'} @ ${im.baseUrl}｜${im.info}`
    : `${c.red('✖')} 出图服务：${im.error}`);

  // —— 选型建议 ——
  console.log(hr());
  const rt = h.recommend.text, ri = h.recommend.image;
  console.log(c.bold('📝 写中文网文该用哪个模型'));
  console.log('   ' + c.gray('结论：选 Qwen 系，不要 Gemma。Gemma 中文有明显翻译腔（正是本项目 deslop 闸在治的东西），'));
  console.log('   ' + c.gray('且 Gemma 只能看图不能出图，出图那半边它根本接不上。'));
  console.log(`   ${c.bold('推荐')}：${c.green(rt.pick.model)}（${rt.pick.q}，${rt.pick.size}）`);
  console.log('   ' + c.gray(rt.pick.note));
  console.log('   ' + c.gray('装：') + `ollama pull ${rt.pick.model}`);
  console.log('');
  console.log(c.bold('🎨 出封面底图该用哪个模型'));
  console.log(`   ${c.bold('推荐')}：${c.green(ri.pick)}`);
  console.log('   ' + c.gray(ri.note));
  if (ri.alt) console.log('   ' + c.gray('备选：' + ri.alt));
  // —— 显存实测优先于估算 ——
  const ld = h.loaded;
  if (ld) {
    const tag = ld.verdict === 'full-gpu' ? c.green('全部在显存 ✔')
      : ld.verdict === 'mostly-gpu' ? c.yellow('大部分在显存')
      : c.red('已溢出到内存，会明显变慢');
    console.log(c.bold('⚡ 显存实测') + `（${ld.name} 已加载）`);
    console.log(`   ${ld.vramGb}G 在显存 / ${ld.cpuGb}G 在内存 = ${ld.gpuPct}% 上卡 —— ${tag}`);
    if (ld.verdict === 'spilled') {
      console.log('   ' + c.gray('处理：① setx OLLAMA_FLASH_ATTENTION 1 且 setx OLLAMA_KV_CACHE_TYPE q8_0；'));
      console.log('   ' + c.gray('      ② 或把「本地上下文长度」从 16384 降到 12288；③ 或换小一档模型'));
    }
    console.log('');
  }
  // —— 显存预算：本地写作最容易吃暗亏的地方（模型没加载时只能估算）——
  const tu = ld ? null : h.tuning;
  if (tu && tu.need) {
    console.log(c.bold('⚡ 显存调优（重要）'));
    console.log('   ' + c.red('⚠ ') + tu.why);
    console.log('   ' + c.gray('设这两个环境变量后重启 ollama serve：'));
    for (const [k, v] of tu.env) console.log('     ' + c.green(`setx ${k} ${v}`));
    if (tu.suggestCtx) {
      console.log('   ' + c.gray('开完 KV 量化后，能全量入显存的最大上下文长度：')
        + c.green(String(tu.suggestCtx)) + c.gray('（设置页「本地上下文长度」填这个）'));
    }
    console.log('');
  } else if (tu) {
    console.log(c.bold('⚡ 显存预算') + c.gray(`：权重+KV ≈ ${tu.f16.totalGb}G / 可用 ${tu.f16.usableGb}G —— 放得下，无需调优`));
    console.log('');
  }
  console.log(c.gray('详细部署步骤见 docs/本地模型.md；配好后在写作台选「本地模型（Ollama·免费·离线）」即可开写。'));
  console.log('');
}

// novel models --list <provider>：向该家的 /models 端点问一句"你有哪些模型"。
// 订阅制平台的模型名跟按量付费那套完全不同（qwen-plus vs qwen3.8-max），
// 没有这条命令，用户只能对着 404 Model not exist 猜。
async function listProviderModels(provider) {
  const { API_PROVIDERS, resolveProviderCfg } = await import('./apichat.mjs');
  if (!API_PROVIDERS[provider]) {
    console.log(c.red('未知提供方：') + provider);
    console.log(c.gray('可选：' + Object.keys(API_PROVIDERS).join(' / ')));
    process.exitCode = 1; return;
  }
  const pc = resolveProviderCfg(provider, loadConfig());
  if (!pc.keyless && !pc.apiKey) { console.log(c.red('还没配 ' + pc.name + ' 的 API Key')); process.exitCode = 1; return; }
  console.log(c.gray('  ' + pc.baseUrl + '/models'));
  try {
    const r = await fetch(pc.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + (pc.apiKey || 'local') },
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) { console.log(c.red('  HTTP ' + r.status + '：') + JSON.stringify(j?.error || j).slice(0, 200)); process.exitCode = 1; return; }
    const ids = (j?.data || j?.models || []).map(x => x.id || x.name).filter(Boolean);
    if (!ids.length) { console.log(c.gray('  （该端点没返回模型列表）')); return; }
    console.log(c.bold(`\n  ${pc.name} 可用模型 ${ids.length} 个：`));
    for (const id of ids) console.log('    ' + (id === pc.model ? c.green(id + '  ← 当前') : id));
    console.log(c.gray('\n  改用哪个：novel config set 里改 api.' + provider + '.model，或在设置页填\n'));
  } catch (e) { console.log(c.red('  请求失败：') + (e.message || e)); process.exitCode = 1; }
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
// novel ledger [--book 书名] [--migrate] [--model codex]
// 台账当前态快照的体检 / 迁移。没有快照结构的书，写作时每批只喂得进台账的一小截（且是最早那截），
// 这个命令让这件事看得见、也能当场补上，而不是只能等下一次写作时顺带跑。
async function ledgerCmd(f, cfg) {
  const { inspect: inspectLedger, needsSeed } = await import('./ledgersnap.mjs');
  const { bookStats } = await import('./books.mjs');
  const id = f.book || f._[0];

  const rows = id ? [getBook(id)].filter(Boolean) : listBooksWithStats(cfg).map(b => getBook(b.slug) || b);
  if (!rows.length) { console.log(c.red(id ? '找不到书：' + id : '还没有书')); process.exitCode = 1; return; }

  console.log(c.bold('\n📌 台账当前态快照体检\n') + hr());
  for (const b of rows) {
    const ins = inspectLedger(b.dir);
    const st = bookStats(b);
    if (!ins.exists) { console.log(`  ${c.gray('—')} ${b.title}：无台账文件`); continue; }
    const need = needsSeed(b.dir, st.maxChapter || 0);
    const tag = !need.need ? c.cyan('快照正常') : c.red('要补快照');
    console.log(`  ${tag}  ${c.bold(b.title)}  ${c.gray(`（已写 ${st.chapters || 0} 章）`)}`);
    console.log(`         台账 ${(ins.bytes / 1024).toFixed(0)}KB / ${ins.chars.toLocaleString()} 字符`);
    if (!ins.structured) {
      // 台账小到能整份喂进去时，"只喂得进 X%"没有意义——缺的只是结构本身
      console.log(c.red('         ⚠️ 没有快照结构' +
        (ins.fedRatio < 1 ? `，写作时只喂得进 ${(ins.fedRatio * 100).toFixed(1)}%，且是最早写的那一截` : '（台账还小，目前能整份喂入，但迟早会超）')));
    } else if (need.need) {
      // 「有结构但空」——模型照着提示词自己建了半个结构却没填，这比没结构更隐蔽也更糟
      console.log(c.red(`         ⚠️ 快照结构在、内容是空的（${ins.snapshotChars} 字符 / 实质 ${ins.substance} 字` +
        `${ins.progress < 0 ? '、无进度锚点' : ''}）——每批喂进去的等于一张空表`));
    } else {
      const behind = (st.maxChapter || 0) - ins.progress;
      console.log(`         快照 ${ins.snapshotChars} 字符、实质 ${ins.substance} 字、进度第 ${ins.progress} 章` +
        (behind > 0 ? c.red(`（落后实际 ${behind} 章，写后闸会在下批写完时补上）`) : c.gray('（已跟上）')));
    }
  }
  console.log(hr());

  if (!f.migrate) {
    console.log(c.gray('  补快照：novel ledger --book <书名> --migrate [--model codex]'));
    console.log(c.gray('  （下一次无状态写作也会自动补，这里只是让你能主动跑）\n'));
    return;
  }

  const targets = rows.filter(b => needsSeed(b.dir, bookStats(b).maxChapter || 0).need);
  if (!targets.length) { console.log(c.cyan('  所有目标书都已有快照结构，无需迁移\n')); return; }

  const { prepareLedger } = await import('./statelessWriter.mjs');
  for (const b of targets) {
    const model = f.model || b.model || cfg.defaultModel;
    console.log(c.bold(`\n▶ ${b.title}`) + c.gray(`（${model}）`));
    const r = await prepareLedger({ book: b, model, cfg, onLog: (e) => logLine(e) });
    console.log(r.ok ? c.cyan('  ✅ 快照已建立') : c.red('  ❌ 未建立（台账已还原原文，写作不受影响）'));
  }
  console.log('');
}

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
    console.log(`    连贯性台账     ${String(s.ledger).padStart(6)}` +
      (s.ledgerStale ? c.red('  ⚠️ 本书无当前态快照，这里只是台账尾部一截（novel ledger --migrate 可补）') : ''));
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
    // 手动指定 Unterm 二进制（机器上装了多份时用）。传 'auto' 清空、回到自动查找。
    for (const [flag, key] of [['unterm-exe', 'untermExe'], ['unterm-cli', 'untermCli']]) {
      const v = f[flag];
      if (!v || v === true) continue;
      if (v === 'auto') { patch[key] = ''; continue; }
      const abs = path.resolve(String(v));
      if (!fs.existsSync(abs)) { console.log(c.red('找不到文件：') + abs); process.exitCode = 1; return; }
      patch[key] = abs;
    }
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
