import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanArticleText,
  classifyRuleArticle,
  isRelevantRuleTitle,
  extractRuleTakeaways,
  buildRulesDigest,
  fanqieRulesPromptSection,
} from '../src/fanqie_rules.mjs';
import { scanFanqieRedlines } from '../src/chapgate.mjs';
import { cleanAiTraces } from '../src/deslop.mjs';

test('fanqie_rules: 标题过滤准确区分官方规则/课堂与征文广告', () => {
  assert.equal(isRelevantRuleTitle('番茄小说低质治理公告（10月）'), true);
  assert.equal(isRelevantRuleTitle('投稿前必查：告别“文风呆板”和“错误排版”'), true);
  assert.equal(isRelevantRuleTitle('番茄平台内容发布规范'), true);
  assert.equal(isRelevantRuleTitle('番茄小说完本签约作品章节发布节奏调整通知'), true);
  assert.equal(isRelevantRuleTitle('2026年10月平台福利活动拟获奖作品公示'), false);
  assert.equal(isRelevantRuleTitle('金番作家如火如荼专访丨边沉淀，边前行'), false);
});

test('fanqie_rules: 文章清洗剥离页头页脚并正确提取日期与要点', () => {
  const raw = [
    '作家福利', '作家课堂', '分享',
    '番茄小说低质治理公告（10月）',
    '番茄小说网2026-11-1815:11:22阅读量：5.0w',
    '',
    '10月以来，平台依据AI粗制滥造、格式混乱、结构失常、空洞水文等低质治理规则，已拒绝签约低质书籍11万本，处置低质违规书籍1.5万本。',
    '存在叙事未完等烂尾问题，不予推荐。',
    '评论',
    '0/300评论',
    '《番茄小说网用户协议》',
  ].join('\n');
  const cleaned = cleanArticleText(raw, '番茄小说低质治理公告（10月）');
  assert.equal(cleaned.publishedAt, '2026-11-18');
  assert.ok(cleaned.body.includes('拒绝签约低质书籍11万本'));
  assert.ok(!cleaned.body.includes('用户协议'));
  assert.equal(classifyRuleArticle(cleaned.title, cleaned.body), 'governance');
  const pts = extractRuleTakeaways(cleaned.title, cleaned.body);
  assert.ok(pts.some(p => p.includes('11万本')));
  assert.ok(pts.some(p => p.includes('不予推荐')));
});

test('fanqie_rules: buildRulesDigest 与提示词注入正常生成', () => {
  const digest = buildRulesDigest({
    updatedAt: '2026-11-27T21:55:00Z',
    articles: {
      '7709405659476803608': {
        id: '7709405659476803608',
        title: '番茄小说低质治理公告（10月）',
        url: 'https://fanqienovel.com/writer/zone/article/7709405659476803608',
        category: 'governance',
        publishedAt: '2026-11-18',
        takeaways: ['拒绝签约低质书籍11万本，处置低质违规书籍1.5万本。'],
      },
    },
  });
  assert.ok(digest.includes('番茄小说低质治理公告（10月）'));
  assert.ok(digest.includes('11万本'));
  const sec = fanqieRulesPromptSection();
  assert.ok(sec.includes('番茄官方防低质与审稿红线'));
  assert.ok(sec.includes('不是……而是……'));
});

test('scanFanqieRedlines: 精准拦截 10 月治理公告点名的全部 AI 低质模式', () => {
  const bad = [
    '他不是在生气，而是在冷笑。这不是普通的刀，而是祖传的剑。那不是风声，是脚步声。他不是退缩，而是蓄力。',
    '“你来了。”',
    '“我来了。”',
    '“你确定？”',
    '“我确定。”',
    '“那就走吧。”',
    '炉径：五寸三分',
    '炉壁：一寸一分',
    '炉高：七寸五分',
    '炉底：弧形内凹',
    '一方身穿金色战甲，为首老者杀气腾腾。',
    '一方身穿血色长袍，为首男子目露凶光。',
    '一方身穿青色长袍，为首中年面色平静。',
    '他嘴角上扬，露出弧度为2mm的微笑★。',
    '他明白，强者之路注定是孤独的，或许这就是命运的磨砺，',
  ].join('\n');
  const r = scanFanqieRedlines(bad);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => p.includes('不是…而是')));
  assert.ok(r.problems.some(p => p.includes('纯台词短对话')));
  assert.ok(r.problems.some(p => p.includes('参数清单')));
  assert.ok(r.problems.some(p => p.includes('同句首排比')));
  assert.ok(r.problems.some(p => p.includes('装饰符号')));
  assert.ok(r.problems.some(p => p.includes('假精确比喻')));
  assert.ok(r.problems.some(p => p.includes('哲理升华')));
  assert.ok(r.problems.some(p => p.includes('半句截断')));
});

test('scanFanqieRedlines: 正常人类好文不得误伤', () => {
  const good = [
    '雨丝砸在滚烫的乌金甲叶上，滋滋腾起一缕缕白烟。',
    '“你踩裂了我家三百年的门槛。”李向东单手扣住戟杆，往下一拧。',
    '他不是怕死，只是咽不下这口气。',
    '巷口老兵攥着砍刀站在雨里，眼眶发红，半天没吭声。',
    '风把残纸卷进泥水，街尾那盏破灯晃了两下，彻底熄了。',
  ].join('\n');
  const r = scanFanqieRedlines(good);
  assert.equal(r.ok, true, `不应误伤：${r.problems.join('；')}`);
});

test('deslop cleanAiTraces: 自动剥除番茄禁用的非常规装饰符', () => {
  const res = cleanAiTraces('他冷笑一声★△，转身离开。');
  assert.equal(res.changed, true);
  assert.equal(res.text.trim(), '他冷笑一声，转身离开。');
});
