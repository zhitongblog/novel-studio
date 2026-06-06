// 模型 CLI 支持：codex / claude / gemini 的检测、启动命令、初始指令注入方式
import { spawnSync } from 'node:child_process';

export const MODELS = {
  codex: {
    id: 'codex',
    name: 'Codex (OpenAI)',
    bin: 'codex',
    untermAgentId: 'codex-cli',
    // codex 接受首个位置参数作为初始指令。Windows 下其内置沙箱常 "spawn setup refresh" 失败，
    // 导致无法读写文件 → 默认加 --dangerously-bypass-approvals-and-sandbox（书目录是独立 git 仓库，
    // 由 autopilot 驱动，可接受）。可用 config.codexBypassSandbox=false 关闭。
    seedArgs: (instruction, cfg) => {
      const args = [];
      if (!cfg || cfg.codexBypassSandbox !== false) args.push('--dangerously-bypass-approvals-and-sandbox');
      args.push(instruction);
      return args;
    },
    note: '原生支持 ~/.codex/skills 的 longform-webnovel-writer；本书目录另有 AGENTS.md 双保险。',
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    untermAgentId: 'claude-code',
    seedArgs: (instruction, _cfg) => [instruction],
    note: '读取本书目录 CLAUDE.md 作为写作规范。',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    untermAgentId: 'gemini-cli',
    // gemini 用 -i 进入交互并带初始 prompt
    seedArgs: (instruction, _cfg) => ['-i', instruction],
    note: '读取本书目录 GEMINI.md / AGENTS.md 作为写作规范。',
  },
};

export function getModel(id) {
  return MODELS[id] || MODELS[String(id || '').toLowerCase()];
}

// 检测某个 CLI 是否可用（在 PATH 中能解析到）
export function detectModel(id) {
  const m = getModel(id);
  if (!m) return { id, available: false, reason: '未知模型' };
  const isWin = process.platform === 'win32';
  const probe = isWin
    ? spawnSync('where', [m.bin], { encoding: 'utf8' })
    : spawnSync('which', [m.bin], { encoding: 'utf8' });
  const path = (probe.stdout || '').trim().split(/\r?\n/)[0] || '';
  const available = probe.status === 0 && !!path;
  return { id: m.id, name: m.name, bin: m.bin, available, path, note: m.note, untermAgentId: m.untermAgentId };
}

export function detectAll() {
  return Object.keys(MODELS).map(detectModel);
}
