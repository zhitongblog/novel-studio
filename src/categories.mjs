// 番茄「阅读标签 → 主分类」的真实清单。
//
// 为什么要有这个文件：新建书只收自由文本「题材/想法」和 9 选 1 的「文风」，
// 而番茄建作品要的是【固定选项里的主分类 + 男/女频】。两者之间原来一行映射代码都没有，
// 于是番茄那个下拉永远停在第一项「历史脑洞」——而页面自己写着【主分类签约后不可改】。
// 选错=不可逆。
//
// 清单来源：2026-09-17 从 fanqienovel.com/main/writer/create 的「阅读标签」弹窗实抓
// （.category-choose-item，只读，没有创建任何作品）。不是照着记忆敲的。
// 原来 UI 里硬编码的 14 条是【男频的一个子集且只有男频】：少了战神赘婿、动漫衍生、
// 游戏体育、传统玄幻、都市修真；女频一条都没有——切到女频后列表纹丝不动，
// 还杵着「男频衍生」，点创建必然撞「标签弹窗里没找到主分类」。
//
// ⚠️ 番茄会加分类。这份清单过期时的表现是【AI 推荐/下拉里少了新分类】，
// 不会让已有的书出错。重抓方法见 test/categories.test.mjs 顶部。

export const FANQIE_CATEGORIES = {
  男频: [
    '西方奇幻', '东方仙侠', '科幻末世', '男频衍生', '都市高武',
    '悬疑灵异', '悬疑脑洞', '抗战谍战', '历史古代', '历史脑洞',
    '都市种田', '都市脑洞', '都市日常', '玄幻脑洞', '战神赘婿',
    '动漫衍生', '游戏体育', '传统玄幻', '都市修真',
  ],
  女频: [
    '女频悬疑', '古风世情', '科幻末世', '女频衍生', '民国言情',
    '悬疑脑洞', '青春甜宠', '双男主', '古言脑洞', '现言脑洞',
    '玄幻言情', '宫斗宅斗', '豪门总裁', '动漫衍生', '星光璀璨',
    '游戏体育', '职场婚恋', '双女主', '年代', '种田', '快穿',
  ],
};

export const CHANNELS = Object.keys(FANQIE_CATEGORIES);

export function categoriesOf(channel) {
  return FANQIE_CATEGORIES[normalizeChannel(channel)] || [];
}

export function normalizeChannel(channel) {
  return channel === '女频' ? '女频' : '男频';
}

// 这个分类在这个频道下真实存在吗？
// 【必须校验】番茄的卡片是按频道渲染的：拿男频的名字去女频弹窗里找，
// 找不到就报"标签弹窗里没找到主分类"，而作者看到的只是创建失败，不知道是频道错了。
export function isValidCategory(channel, name) {
  return categoriesOf(channel).includes(String(name || '').trim());
}

// 某个分类属于哪个频道（同名跨频道的如"科幻末世/悬疑脑洞/动漫衍生/游戏体育"返回全部）。
export function channelsOf(name) {
  const n = String(name || '').trim();
  return CHANNELS.filter(ch => FANQIE_CATEGORIES[ch].includes(n));
}
