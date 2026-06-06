// 极简 ANSI 终端样式工具（零依赖）
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);

export const c = {
  dim: wrap('2'), bold: wrap('1'),
  cyan: wrap('36'), green: wrap('32'), yellow: wrap('33'),
  red: wrap('31'), magenta: wrap('35'), blue: wrap('34'), gray: wrap('90'),
};

export function banner() {
  return [
    c.cyan('╔══════════════════════════════════════════════╗'),
    c.cyan('║') + c.bold('   📚 Novel Studio · 网文工作室              ') + c.cyan('║'),
    c.cyan('║') + c.gray('   Unterm × Codex/Claude/Gemini · 自动续写   ') + c.cyan('║'),
    c.cyan('╚══════════════════════════════════════════════╝'),
  ].join('\n');
}

export function hr() { return c.gray('─'.repeat(50)); }

export function logLine(e) {
  const lv = e.level || e.source || 'info';
  const tag = {
    act: c.green('●'), warn: c.yellow('▲'), error: c.red('✖'),
    autopilot: c.magenta('◆'), info: c.blue('○'),
  }[e.level === 'act' ? 'act' : (e.source === 'autopilot' ? 'autopilot' : e.level)] || c.blue('○');
  const src = e.source === 'autopilot' ? c.magenta('[autopilot] ') : '';
  return `${tag} ${src}${e.msg || ''}`;
}
