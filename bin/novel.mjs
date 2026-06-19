#!/usr/bin/env node
// Novel Studio 入口：无参数 → TUI；有参数 → CLI / MCP
import { runTui } from '../src/tui.mjs';
import { runCli } from '../src/cli.mjs';
import { runMcpServer } from '../src/mcpserver.mjs';
import { runServer } from '../src/server.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flagVal(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

if (!cmd || cmd === 'tui') {
  runTui();
} else if (cmd === 'serve' || cmd === 'gui') {
  runServer(Number(flagVal('port', 8787)));
} else if (cmd === 'mcp' || cmd === 'mcp-stdio') {
  runMcpServer();
} else if (cmd === '--version' || cmd === '-v') {
  console.log('novel-studio 1.1.0');
} else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  printHelp();
} else {
  runCli(argv).catch((e) => { console.error(e?.message || e); process.exit(1); });
}

function printHelp() {
  console.log(`
Novel Studio · 网文工作室  (Unterm × Codex/Claude/Gemini)

用法:
  novel                       启动交互式 TUI（默认）
  novel doctor                环境自检（Unterm / 模型 / 实例 / 代理）
  novel models                查看 codex/claude/gemini 可用性
  novel book new --title 书名 [--genre .. --model codex --words .. --volumes .. --cpv .. --batch 5]
  novel book list             列出所有书
  novel write --book 书名 [--model codex] [--task "续写5章并自检"] [--dry]
                              开新实例+开代理+启动模型+注入指令+autopilot 监控应答
  novel sessions              列出运行中的写作会话
  novel send --book 书名 --task "穿插的指令"   中途插入一条指令到正在写作的窗口
  novel watch --book 书名      实时镜像该窗口内容到本终端（Ctrl+C 退出）
  novel stop --book 书名        停止并关闭该书的 Unterm 窗口
  novel autopilot --book 书名   给已运行的会话挂上自动监控应答
  novel usage [--book 书名]     Token 用量统计（每本书累计，来自 agent TUI）
  novel config [set ...]      查看/修改配置（workspace/model/proxy/autopilot）
  novel reference             透传 unterm-cli reference（MCP方法/CLI/键位清单）
  novel mcp                   以 MCP stdio server 运行（供 Claude Code 调用）

示例:
  novel book new --title "灯下记" --genre "民国国术·以武正道" --words 200万 --batch 5
  novel write --book 灯下记 --model codex --task "开写第一卷前5章，写完自检"
`);
}
