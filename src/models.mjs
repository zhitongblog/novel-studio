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
  qwen: {
    id: 'qwen',
    name: '通义 Qwen Code',
    bin: 'qwen',
    untermAgentId: 'qwen-code',
    // qwen-code 是 gemini-cli 分支，同样用 -i 进交互并带初始 prompt
    seedArgs: (instruction, _cfg) => ['-i', instruction],
    note: '阿里通义 Qwen Code（gemini-cli 分支）。首次跑 `qwen` 选 Qwen OAuth 登录即得每日免费额度（约 2000 次/日）。'
      + '读本书目录 QWEN.md / GEMINI.md / AGENTS.md 作为写作规范。',
  },
  trae: {
    id: 'trae',
    name: 'Trae（字节跳动）',
    bin: 'trae-cli',
    untermAgentId: 'trae-cli',
    // 字节开源 Trae Agent：单任务用 `trae-cli run "<task>"`（非交互、执行完即退出）。
    // 默认走 run，把整批写作指令一次性交给它执行；想用对话式可设 config.traeInteractive=true
    // 改走 `trae-cli interactive`（进 REPL 后由 autopilot 注入续写指令驱动下一批）。
    seedArgs: (instruction, cfg) =>
      cfg && cfg.traeInteractive ? ['interactive'] : ['run', instruction],
    note: '字节开源 Agent CLI（Claude Code/Gemini CLI 的国产平替）。读本书目录 AGENTS.md 作为写作规范。'
      + '需先装 trae-cli（pip install trae-agent / 见官方仓库）并配好 trae_config.json 或模型 API Key。'
      + '默认 run 模式写完一批即退出；要 autopilot 连续续写可设 traeInteractive=true。',
  },
  // —— 网页版写作模型（kind:'web'）——
  // 不跑本地 CLI，而是驱动 通义千问/ChatGPT/Claude 的网页聊天框写小说（白嫖各家免费额度）。
  // 由 webwriter.mjs 把上下文包送进聊天框、抓正文、自己解析落盘（模型只吐文字、不写文件）。
  // 「可用性」不靠 where 命令——detectModel 里对 kind:'web' 直接返回 available:true，
  // 真正的可用性取决于运行时是否配了已登录该站点的 Unzoo profile（在写作端校验）。
  'web-qwen': {
    id: 'web-qwen',
    name: '通义千问 网页版',
    kind: 'web',
    adapterId: 'qwen',
    note: '驱动 qianwen.com（千问）网页版写作，白嫖免费额度。需先在 Unzoo 里用一个已登录通义千问的账号（profilePath）。选择器已对真实登录页校准。',
  },
  'web-doubao': {
    id: 'web-doubao',
    name: '豆包 网页版',
    kind: 'web',
    adapterId: 'doubao',
    note: '驱动 doubao.com 网页版写作，白嫖免费额度。需先在 Unzoo 里用一个已登录豆包的账号（profilePath）。回答抓取以哨兵兜底、选择器无关，较稳。',
  },
  'web-chatgpt': {
    id: 'web-chatgpt',
    name: 'ChatGPT 网页版',
    kind: 'web',
    adapterId: 'chatgpt',
    note: '驱动 chatgpt.com 网页版写作。需先在 Unzoo 里用一个已登录 ChatGPT 的账号（profilePath），选择器待对真实页面校准。',
  },
  'web-claude': {
    id: 'web-claude',
    name: 'Claude 网页版',
    kind: 'web',
    adapterId: 'claude',
    note: '驱动 claude.ai 网页版写作。需先在 Unzoo 里用一个已登录 Claude 的账号（profilePath），选择器待对真实页面校准。',
  },
  'web-grok': {
    id: 'web-grok',
    name: 'Grok 网页版',
    kind: 'web',
    adapterId: 'grok',
    note: '驱动 grok.com 网页版写作（xAI 没有本地 CLI，只能走网页）。需先在 Unzoo 里用一个【已登录 Grok 且有正常浏览历史】的账号——干净 profile 直连 grok.com 会被 Cloudflare 判为机器人并拦截。选择器待对真实页面校准。',
  },
  // —— API 写作模型（kind:'api'）——
  // 直连中文大模型的 OpenAI 兼容接口写小说（apiwriter.mjs）：稳、能写文件、连续跑，不碰浏览器。
  // 「可用性」= 是否配了该家 API Key（detectModel 里对 kind:'api' 直接返回 available:true，真正校验在写作端/设置里）。
  // 给「国内、用不了 Claude、要省钱」的场景：智谱 glm-4-flash 免费；DeepSeek 极便宜；通义 API 有免费额度。
  'api-zhipu': {
    id: 'api-zhipu',
    name: '智谱 GLM（API·免费）',
    kind: 'api',
    provider: 'zhipu',
    note: '智谱 GLM API（open.bigmodel.cn）。推荐 glm-4.5-flash（免费且强，能写连贯长章）；glm-4-flash 会复读凑字勿用。在「设置 · API 模型」填 API Key 即用。',
  },
  'api-deepseek': {
    id: 'api-deepseek',
    name: 'DeepSeek（API·便宜）',
    kind: 'api',
    provider: 'deepseek',
    note: 'DeepSeek API（platform.deepseek.com）。写作强、价格极低。在「设置 · API 模型」填 API Key 即用。',
  },
  'api-dashscope': {
    id: 'api-dashscope',
    name: '通义千问（API·免费额度）',
    kind: 'api',
    provider: 'dashscope',
    note: '通义 DashScope API（阿里云）。qwen-plus/qwen-max，有免费额度。在「设置 · API 模型」填 API Key 即用。',
  },
};

export function getModel(id) {
  return MODELS[id] || MODELS[String(id || '').toLowerCase()];
}

// 检测某个 CLI 是否可用（在 PATH 中能解析到）
export function detectModel(id) {
  const m = getModel(id);
  if (!m) return { id, available: false, reason: '未知模型' };
  // 网页版模型：不靠 PATH 里的 CLI，可用性取决于运行时的 Unzoo profile（写作端校验）。
  // 这里直接判为 available，避免 where/which 把它误判为不可用。
  if (m.kind === 'web') {
    return { id: m.id, name: m.name, kind: 'web', adapterId: m.adapterId, bin: null, available: true, path: '', note: m.note };
  }
  // API 模型：可用性取决于是否配了该家 API Key（真正校验在写作端/设置里）。这里直接判 available，避免误判不可用。
  if (m.kind === 'api') {
    return { id: m.id, name: m.name, kind: 'api', provider: m.provider, bin: null, available: true, path: '', note: m.note };
  }
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
