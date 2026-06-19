// 全局配置读写
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, LOG_DIR, DEFAULT_WORKSPACE } from './paths.mjs';

const DEFAULTS = {
  workspace: DEFAULT_WORKSPACE,      // 书库根目录
  defaultModel: 'codex',             // codex | claude | gemini
  proxyNode: 'auto',                 // unterm 代理节点名；'auto' = 用 proxy.json 里的 current_node
  enableProxy: true,                 // 启动实例时是否开代理
  untermAgentName: 'claude-code',    // 连 MCP 时自报的受信 agent 名（解锁 session.input 写操作）
  codexBypassSandbox: true,          // codex Windows 沙箱常失败 → 默认绕过（书目录是独立 git 仓库）
  gemini: {                          // Google Gemini / Imagen（用于 AI 生成封面底图、把中文题材翻成英文画面提示）
    apiKey: '',                      // Google AI Studio API key（AIza...）。存在用户配置文件里，不写进源码
    proxy: 'http://127.0.0.1:7897',  // 访问 generativelanguage.googleapis.com 走的代理（国内必需）；'' = 直连
    imageModel: 'imagen-4.0-fast-generate-001',
    textModel: 'gemini-2.5-flash',   // promptModel='gemini' 时用它（API）写出图提示词
    promptModel: 'codex',            // 写"英文出图提示词"用哪个模型：codex/claude=CLI无头(更会描述画面)；gemini=旧的API
  },
  // 大纲编辑审核：作者写完大纲(立项/每卷)→换另一个模型当主编无头审稿→作者按意见修订再开写。
  editorReview: {
    enabled: true,                   // 关闭则作者写完大纲直接开写(autopilot 续写哨兵会自动放行)
    model: 'auto',                   // 'auto'=自动选一个与作者不同的可用模型；也可指定 codex|claude|gemini
    timeoutMs: 180000,               // 单次审稿超时
    maxRenudge: 2,                   // 修订验证：文件没动/复审没过时最多重催几次，超过则放行(避免死循环)
    recheck: true,                   // C：作者改完后由主编二次复审，确认【硬伤】真改对了才放行(每轮多一次模型调用)
    requireApproval: true,           // 全局确认门：审稿出意见后【暂停】，等你点"应用修订/跳过"才动 bible/大纲(不再自动改你的内容)
  },
  // 完本策略：写到最后一卷(或手动触发)进入"收尾冲刺"，发收束令逼向大高潮+结局+回收伏笔；
  // 作者输出「【完本待审】」后由主编核对完本清单，过了才标"已完本"并干净停止，不过则退回补写。
  finale: {
    enabled: true,
    autoEnterLastVolume: true,       // 写到 (目标章数 - 一卷) 时自动进入收尾(需设了 targetChapters)
    reviewEnding: true,              // 完本前由主编(换模型)核对完本清单
    maxRenudge: 2,                   // 完本审稿未过时最多退回补写几次，超过则放行标完本(避免死循环)
    maxFinaleBatches: 30,            // 收尾阶段最多冲刺多少批，超了强制要求立即收束(防注水写不完)
    // —— 完结收口（内部完本 → 番茄平台完结）——
    minWords: 200000,                // 番茄完结字数门槛(参考值)：低于此「完结就绪报告」给⚠️提醒(不硬卡)
    autoClosure: true,               // 标"已完本"后自动跑一次"完结收口"(把尾声/完本感言发齐到番茄并对账)
    closureDelayMs: 120000,          // 自动收口延迟(ms)：留时间让作者把"完本感言/尾声"那一章写完再发
  },
  autopilot: {
    enabled: true,                   // 是否自动监控应答
    pollMs: 3000,                    // 轮询间隔
    idleConfirms: 2,                 // 连续 N 次空闲才判定"等待输入"
    maxAutoContinue: 40,             // 最多自动"继续"多少次（防失控）
    // 续写纪律：强制"先读后写、写完更新台账与索引"——这是对抗长篇漂移的关键。
    // 一个只收到"继续"二字的 agent 会跳过重建上下文，直接写 → 人物/伤势/时间线慢慢漂。
    continueText: '继续下一批。动笔前先重建上下文：读 continuity_ledger.md，再读最近 2 章正文与本卷 outlines/ 中对应章号段的分章大纲；据此确认当前最新章号、主角处境、未回收伏笔、欠债与伤势。然后严格按 longform-webnovel-writer 标准写下一批正文（仅正文、单章字数达标）。给每章取章名前，必须在 chapter_index.md 全表里检索，确保新章名【不与全书任何已有章名重复】（连意思高度相近的也错开），重复就换一个再用。写完务必：①把新章登记进 chapter_index.md；②更新 continuity_ledger.md（人物现状/已知信息、未回收伏笔、欠债与承诺、伤势、关键物件去向、时间线锚点）；③做常规批次自检。',
    fullCheckEvery: 5,               // 每 N 次续写插入一次"全文逻辑自检"（0=关闭）
    fullCheckText: '现在做一次【全文逻辑自检】，不要只看最近一批：通读 novel_bible.md、全部 outlines/、chapter_index.md 与 continuity_ledger.md（若无则新建），并抽查关键章节，核查全书的——时间线先后、人物弧光与性格一致性、力量/设定体系规则是否自洽、伏笔的铺设与回收、未决线索与“待查”项、事实/关系/伤势/物件/欠债的前后矛盾、与各卷大纲的偏离，以及【全书章名是否有重复】（逐一比对所有章名，发现重名就把较晚那一章改成唯一新名、同步重命名文件并更新 index）。把发现按【硬伤/隐患/待办】三档写入 reviews/全文逻辑自检-至<最新全局章号>.md，并更新 continuity_ledger.md。就地修正“硬伤”级矛盾（保持已写剧情框架与结局，只改必要处），无法当场修的明确记录为待办。完成后再继续按 longform-webnovel-writer 标准写下一批并做常规批次自检。',
    // 周期性"阅读性/反AI味润色扫描"：与逻辑自检错开节奏（逻辑自检优先）。
    // 自检只查逻辑、不查阅读性 → 文字的 AI 腔（句长均匀、套话、段尾升华）没有自动回路去清，这一道补上。
    styleCheckEvery: 8,              // 每 N 次续写插入一次"阅读性润色扫描"（0=关闭）
    styleCheckText: '现在做一次【阅读性 / 反AI味润色扫描】，本轮不写新章，只润色最近一段已写正文：按反AI味硬标准逐项核查并就地修改——①句长与段落是否过于均匀（打散，长短交错，紧张处短句短段）；②删解释性套话（“这不是…而是”“这意味着”“换句话说”“总而言之”“仿佛在说”）与翻译腔现代词（进行/基于/针对/通过……的方式）；③补实锚（每 250–400 字至少一个可见物件、身体感觉或具体动作，用专有名词与数目）；④段尾别总点题升华，停在动作或物件上；⑤消除同一章里的重复词与重复句式；⑥确认不同人物的口吻确有区别。只润色文字、严禁改动剧情走向与结局，把处理记录追加写入 reviews/阅读性润色-至<最新全局章号>.md。完成后再继续按 longform-webnovel-writer 标准写下一批。',
    // 周期性"节奏/格局体检"：站在读者视角查【推不推进、有没有沦为流水账、爽点够不够、格局有没有升级】。
    // 这是对“自检只查账目自洽、反而奖励流水账”的纠偏——逻辑自检>节奏体检>阅读性扫描，三者错峰。
    paceCheckEvery: 12,             // 每 N 次续写插入一次"节奏/格局体检"（0=关闭）
    paceCheckText: '现在做一次【节奏 / 格局体检】，站在读者视角，不只看账目对不对、而看“好不好看、推没推进”：①最近这一二十章，主角的处境（地点、权力层级、实力、人脉、对手量级、格局）有没有【可感地升级】，还是长期停在同一地点/同一层级/同一桩小事上打转？②是否出现了【连续多章以办牌/验册/对账/盘点/抄报/走流程为主线】的事务流水账？③隔几章有没有给读者一次【可感的进展或爽点】（赢一场、收一人、揭一层真相、上一个台阶、打脸一次），还是全程压抑无回报？④对照本卷阶段目标，进度是太慢、刚好、还是跑偏？把判断与【提速/收束方案】写入 reviews/节奏体检-至<最新全局章号>.md。若确属节奏事故：在不否定已写关键事实的前提下，给出“接下来如何提速、把舞台推大、压缩事务、补爽点”的具体安排，并在随后的续写里立即执行；若是 novel_bible.md 里某条口吻基线/限制（如“一切扩权都要逐一办牌验册、不许顺滑”）在逼出流水账，就把该条改成“几章一个里程碑”的写法并更新 bible。完成后按新节奏继续写下一批。',
    affirmativeText: 'y',            // y/n 类提问的肯定答复
    preferRecommended: true,         // 选择型菜单优先按回车接受高亮的推荐项
    stopOnPhrases: ['全部完成', '已完成全部', '没有更多', 'all done', 'nothing left to write'],
  },
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override || {})) {
    if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

export function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function loadConfig() {
  ensureDirs();
  let stored = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { stored = {}; }
  }
  const cfg = deepMerge(DEFAULTS, stored);
  // 确保书库目录存在
  fs.mkdirSync(cfg.workspace, { recursive: true });
  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

export function updateConfig(patch) {
  const cfg = deepMerge(loadConfig(), patch);
  return saveConfig(cfg);
}
