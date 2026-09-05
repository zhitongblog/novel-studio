// 全局配置读写
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, LOG_DIR, DEFAULT_WORKSPACE } from './paths.mjs';

const DEFAULTS = {
  workspace: DEFAULT_WORKSPACE,      // 书库根目录
  defaultModel: 'codex',             // codex | claude | gemini | trae
  proxyNode: 'auto',                 // unterm 代理节点名；'auto' = 用 proxy.json 里的 current_node
  enableProxy: true,                 // 启动实例时是否开代理
  untermAgentName: 'claude-code',    // 连 MCP 时自报的受信 agent 名（解锁 session.input 写操作）
  // 手动指定 Unterm 可执行文件（留空=自动找 C:\Program Files\Unterm\ 与 PATH）。
  // ⚠️ 为什么需要：装了多份 Unterm（正式版 + 自己编的开发版）时，自动查找只会看标准位置，
  // 很容易出现【程序启动的是 Program Files 里的旧版，而你实际在用的是别处的新版】。
  // 两个版本的 pane 命名空间语义在 0.65 前后不同（见 sharesGlobalPaneNamespace），混用会出怪事。
  // doctor 会主动比对"找到的二进制版本"与"运行中实例的版本"，不一致就报警。
  untermExe: '',
  untermCli: '',
  codexBypassSandbox: true,          // codex Windows 沙箱常失败 → 默认绕过（书目录是独立 git 仓库）
  // claude 启动带 --dangerously-skip-permissions：不弹审批框，autopilot 就不必靠"认屏幕"去点同意。
  // 理由与边界见 models.mjs 里 claude.seedArgs 上方的长注释。设 false 恢复弹窗（届时靠 autopilot 识别）。
  claudeSkipPermissions: true,
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
  // 无状态分章写作：每批全新无头进程 + 精准重喂上下文包（治长篇"慢+费token"的平方级根因）。
  // 是长驻 autopilot 模式之外的可选模式；写作台勾选"无状态省钱模式"启用。
  stateless: {
    checkEvery: 5,                   // 每 N 批插一次"全文逻辑自检"（0=关）；对齐长驻模式 autopilot.fullCheckEvery
    batchTimeoutMs: 900000,          // 单批无头调用超时（写多章 + 自检可能数分钟）
    outlineReview: true,             // 卷边界【大纲审稿门】：开新卷补大纲后，先让主编审该卷分章大纲、按意见改再写正文（对齐长驻的审稿门，只在卷边界触发、不拖速度）。false=关，退回"补大纲直接写"的自愈。
  },
  // API 写作引擎：直连中文大模型的 OpenAI 兼容接口写小说（比驱动网页框稳一个数量级、能写文件）。
  // 给「国内、用不了 Claude、要省钱」的场景：智谱 GLM-4-Flash 免费；DeepSeek 极便宜；通义 DashScope 有免费额度。
  // API Key 存用户配置文件、不写进源码。模型选「XX API」即走本引擎（apiwriter.mjs）。
  api: {
    // 各家配置：apiKey 填自己的；baseUrl/model 已给默认值（都 OpenAI 兼容：/chat/completions）。
    zhipu:     { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-flash' },    // 智谱：glm-4.5-flash 免费且明显更强（glm-4-flash 会复读凑字，弃用）
    deepseek:  { apiKey: '', baseUrl: 'https://api.deepseek.com',            model: 'deepseek-chat' },     // DeepSeek：极便宜、写作强
    dashscope: { apiKey: '', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' }, // 通义千问 API（有免费额度）
    // 百炼订阅（Token Plan / Coding Plan）：sk-sp- 开头的 key，订阅制不按 token 计费。
    // 一个 key 拿到多家旗舰（qwen3.8-max / glm-5.2 / deepseek-v4-pro …），实测 deepseek-v4-pro 文笔最好。
    // ⚠️ 端点和模型名都与按量付费的 dashscope 不同，两者不能混用。
    bailian:   { apiKey: '', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'deepseek-v4-pro' },
    // 豆包：中文语境/网络梗最熟，网文语感对路。⚠️ model 填【接入点 ID】(ep-xxxx) 不是模型名。
    doubao:    { apiKey: '', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
    // Kimi：长文本强，适合当"挑刺/润色"那一轮。
    moonshot:  { apiKey: '', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
    // 文心：中式表达自然，对文言/网络梗理解到位。
    ernie:     { apiKey: '', baseUrl: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.5-turbo-128k' },
    // 【本地模型】跑在本机的 Ollama / LM Studio / llama.cpp，零成本、零额度、断网可写、内容不出本机。
    // 中文网文首选 Qwen 系（Gemma 中文有明显翻译腔，正是本项目 deslop 闸在治的东西）。
    // 显存分档：12G→qwen3:14b（甜点）｜8G→qwen3:8b｜24G+→qwen3.8:27b。`novel local` 会按你的显卡给建议。
    local: {
      baseUrl: 'http://127.0.0.1:11434/v1',   // Ollama。LM Studio 改 :1234/v1，llama.cpp server 改 :8080/v1
      model: 'qwen3:14b',
      apiKey: '',                             // 本地不需要；vLLM 等设了鉴权才填
      flavor: 'auto',                         // auto|ollama|openai —— auto 会探一次 /api/version 认出 Ollama
      // ⚠️ Ollama 默认 num_ctx 只有 4096，而本项目一次喂进去的上下文包有 8–15K token。
      // 走 OpenAI 兼容端点会被【静默截断】（设定/大纲/上一章被悄悄砍掉→跑题复读且不报错），
      // 所以认出 Ollama 后改走原生 /api/chat 并显式传这个值。16384 是 12G 卡跑 14B 的稳妥上限。
      numCtx: 16384,
      keepAlive: '30m',                       // 模型常驻显存，免得每章重新加载（14B 加载一次要十几秒）
      // 输出上限单独给本地设，不跟云端共用 8192——num_ctx 是【喂料+输出】共享的一个窗口，
      // 给输出留 8192 就等于把上下文包压到 8K 以内，设定圣经/大纲会被挤掉。
      // 中文约 1.5 字/token，5120 token ≈ 7600 字，写 3000–3600 字的单章有两倍余量，够用且不浪费窗口。
      maxTokens: 5120,
      // Qwen3 等混合推理模型默认先吐 <think>…</think>。写网文不需要这段思考，而它会实打实吃掉
      // 输出预算——思考花 3K token，正文就少 3K，表现是「写到一半没了」且不报错。故默认关。
      think: false,
      timeoutMs: 1800000,                     // 本地出 3000 字单章约 2–4 分钟，云端那个 5 分钟超时会误杀
    },
    temperature: 0.85,               // 网文写作略高一点更有文采
    maxTokens: 8192,                 // 一批多章，给足输出上限
    timeoutMs: 300000,               // 单批 API 调用超时
    proxy: '',                       // 需要走代理才能访问时填（国内直连智谱/DeepSeek/通义都不用代理，留空）
  },
  // 出图后端：'gemini'=Google Imagen（要 key/代理/按张计费）｜'local'=本机 ComfyUI / SD WebUI（零成本、断网可用）。
  // 本项目封面的书名是后期 canvas 叠上去的、底图要求【干净无字】，所以本地用 SDXL 系就够，
  // 不非得上 20B 的 Qwen-Image（它最强的中文文字渲染在这里恰好用不到，却要多占十几 G 磁盘）。
  image: {
    backend: 'gemini',               // 'gemini' | 'local'
    localBackend: 'comfy',           // 'comfy'（推荐）| 'a1111'（SD WebUI/Forge，启动要带 --api）
    timeoutMs: 900000,               // 本地出一张：SDXL 约 30–60 秒；Qwen-Image 20B 在 12G 卡上约 5 分钟
    // 12G 卡上文本模型(10G)和出图模型(12G)【放不下同时在显存里】，会 OOM 或疯狂换页。
    // 故本地出图前自动把 Ollama 的文本模型请出去，写下一章时它会自己重载（14B 约 15 秒）。
    // 显存 ≥20G 的机器不触发；也可设 false 手动管理。
    autoUnloadText: true,
    negative: '',                    // 留空=用 imagelocal.LOCAL_NEGATIVE（已摁死文字/水印/西方面孔）
    comfy: {
      baseUrl: 'http://127.0.0.1:8188',
      preset: 'sdxl',                // 'sdxl' | 'qwen-image'；也可用 workflowFile 完全接管
      workflowFile: '',              // 填了就用你自己在 ComfyUI「导出(API)」的工作流 JSON，
                                     // 里面用 %prompt% %negative% %seed% %width% %height% 占位
      ckpt: 'sd_xl_base_1.0.safetensors',   // preset=sdxl 时的大模型文件名（要与 models/checkpoints 下一致）
      // preset=qwen-image 时这三个（要与 ComfyUI models/unet|text_encoders|vae 下的实际文件名一致）
      unet: 'qwen-image-2512-Q4_K_M.gguf',
      clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
      vae: 'qwen_image_vae.safetensors',
      gguf: true,                    // unet 是 .gguf 走 UnetLoaderGGUF（需装 ComfyUI-GGUF 节点）
      clipGguf: false,               // 文本编码器也用 GGUF（12G 卡显存吃紧时可减少换页；理解力略降）
      steps: 0, cfgScale: 0, width: 0, height: 0,   // 0=按 preset 取默认值
    },
    a1111: {
      baseUrl: 'http://127.0.0.1:7860',
      ckpt: '',                      // 留空=用 WebUI 当前已加载的模型
      steps: 28, cfgScale: 6, width: 896, height: 1152, sampler: 'DPM++ 2M Karras',
    },
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
    // 【已关闭】原来每 8 批自动发一次「阅读性/反AI味润色扫描」，去改【已经写好的正文】。
    // 那条文案是纯文学审美的集中体现：句长别均匀、补实锚（每 250–400 字一个）、
    // 段尾别点题升华、删套话。作者认可的网文样章按这几条会被逐条判废。
    // 文风该由本书的 style_refs/ 范本决定，不该由一段死文案定期覆盖。
    // 想要润色时，用「♻️ 重写本章」或范本里加一章更对味的，别让它自动跑。
    styleCheckEvery: 0,              // 每 N 次续写插入一次"阅读性润色扫描"（0=关闭）
    styleCheckText: '现在做一次【阅读性 / 反AI味润色扫描】，本轮不写新章，只润色最近一段已写正文：按反AI味硬标准逐项核查并就地修改——①句长与段落是否过于均匀（打散，长短交错，紧张处短句短段）；②删解释性套话（“这不是…而是”“这意味着”“换句话说”“总而言之”“仿佛在说”）与翻译腔现代词（进行/基于/针对/通过……的方式）；③补实锚（每 250–400 字至少一个可见物件、身体感觉或具体动作，用专有名词与数目）；④段尾别总点题升华，停在动作或物件上；⑤消除同一章里的重复词与重复句式；⑥确认不同人物的口吻确有区别。只润色文字、严禁改动剧情走向与结局，把处理记录追加写入 reviews/阅读性润色-至<最新全局章号>.md。完成后再继续按 longform-webnovel-writer 标准写下一批。',
    // 周期性"节奏/格局体检"：站在读者视角查【推不推进、有没有沦为流水账、爽点够不够、格局有没有升级】。
    // 这是对“自检只查账目自洽、反而奖励流水账”的纠偏——逻辑自检>节奏体检>阅读性扫描，三者错峰。
    paceCheckEvery: 12,             // 每 N 次续写插入一次"节奏/格局体检"（0=关闭）
    paceCheckText: '现在做一次【节奏 / 格局体检】，站在读者视角，不只看账目对不对、而看“好不好看、推没推进”：①最近这一二十章，主角的处境（地点、权力层级、实力、人脉、对手量级、格局）有没有【可感地升级】，还是长期停在同一地点/同一层级/同一桩小事上打转？②是否出现了【连续多章以办牌/验册/对账/盘点/抄报/走流程为主线】的事务流水账？③隔几章有没有给读者一次【可感的进展或爽点】（赢一场、收一人、揭一层真相、上一个台阶、打脸一次），还是全程压抑无回报？④对照本卷阶段目标，进度是太慢、刚好、还是跑偏？把判断与【提速/收束方案】写入 reviews/节奏体检-至<最新全局章号>.md。若确属节奏事故：在不否定已写关键事实的前提下，给出“接下来如何提速、把舞台推大、压缩事务、补爽点”的具体安排，并在随后的续写里立即执行；若是 novel_bible.md 里某条口吻基线/限制（如“一切扩权都要逐一办牌验册、不许顺滑”）在逼出流水账，就把该条改成“几章一个里程碑”的写法并更新 bible。完成后按新节奏继续写下一批。',
    // 省 token：连续写时同一 agent 会话上下文会越堆越大、每批都被重发（缓存还会过期→全价重发）。
    // 到阈值就【停掉旧会话、重开新窗口】，靠 continuity_ledger.md 重建最小上下文续写。
    // freshContextLimit：当前上下文占用(token)≥它就重开（claude 从会话日志精确读；0=关闭）。
    // freshFallbackBatches：读不到上下文大小的模型(gemini 等)的兜底——每写够 N 批重开一次（0=关闭）。
    freshContextLimit: 180000,
    freshFallbackBatches: 0,
    // 卡住告警：屏幕不变 + 输出字节不涨【连续这么久】就在日志里报一次警（之后每满一个周期再报一次）。
    // 由来：窗口在、进程在、autopilot 也挂着，就是什么都不发生，日志一片空白，只能靠人去翻现场。
    // 0=关闭。confirmOnly（复检/立项/改名）不报——那类任务干完本来就该静止。
    stallAlarmMs: 1200000,           // 20 分钟
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
