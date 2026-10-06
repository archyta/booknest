'use strict';

/* 自动分类：内置分类 + 关键词打分规则（标题权重最高，其次简介/出版社分类） */

const CATEGORY_SEEDS = [
  {
    name: '计算机与技术',
    color: '#2563eb',
    keywords: ['计算机', '编程', '程序', '代码', '算法', '数据结构', 'python', 'java', 'javascript', 'typescript', 'c++', 'golang', 'rust', 'linux', 'unix', 'shell', '数据库', 'sql', '服务器', '运维', '架构', '重构', '软件工程', '前端', '后端', '全栈', '操作系统', '计算机网络', '网络安全', '信息安全', '人工智能', '机器学习', '深度学习', '神经网络', '大模型', '数据分析', '数据科学', '云计算', '容器', 'docker', 'kubernetes', 'git', '开发', '程序员', '黑客', '编程语言', 'web', 'app', 'vibe coding', '提示工程'],
  },
  {
    name: '文学与小说',
    color: '#db2777',
    keywords: ['小说', '文学', '散文', '诗歌', '诗集', '随笔', '杂文', '故事集', '短篇', '长篇', '中篇', '名著', '经典文学', '作家', '诺贝尔文学奖', '茅盾文学奖', '译文', '外国文学', '中国文学', '当代文学', '现代文学', 'fiction', 'novel', 'poetry', 'essay'],
  },
  {
    name: '历史与传记',
    color: '#b45309',
    keywords: ['历史', '史学', '史料', '通史', '断代史', '王朝', '帝国', '古代', '近代史', '现代史', '世界史', '中国史', '战争史', '文明史', '传记', '自传', '回忆录', '人物传记', '口述史', 'history', 'biography', 'memoir'],
  },
  {
    name: '哲学与思想',
    color: '#7c3aed',
    keywords: ['哲学', '思想家', '思想史', '伦理', '伦理学', '逻辑学', '宗教', '佛学', '道家', '儒家', '论语', '庄子', '存在主义', '形而上学', '美学', 'philosophy', 'ethics', 'logic'],
  },
  {
    name: '心理与成长',
    color: '#0d9488',
    keywords: ['心理学', '心理', '情绪', '认知', '人格', '焦虑', '抑郁', '疗愈', '自我', '成长', '习惯', '自控力', '意志力', '专注', '思维', '心智', '正念', '冥想', 'psychology', 'mindset', 'habit'],
  },
  {
    name: '经济与管理',
    color: '#ea580c',
    keywords: ['经济', '经济学', '金融', '投资', '理财', '股票', '基金', '货币', '商业', '管理', '管理学', '企业家', '创业', '营销', '品牌', '财务', '会计', '组织', '领导力', '战略', '供应链', 'business', 'management', 'economics', 'investing', 'finance'],
  },
  {
    name: '社会科学',
    color: '#4f46e5',
    keywords: ['社会学', '社会', '政治', '政治学', '人类学', '文化研究', '传播学', '新闻', '法律', '法学', '制度', '阶层', '城市化', '民族', '国际关系', 'social', 'sociology', 'politics', 'law'],
  },
  {
    name: '科普与科学',
    color: '#0891b2',
    keywords: ['科普', '科学', '物理学', '化学', '生物学', '数学', '几何', '代数', '统计', '天文', '宇宙', '量子', '相对论', '进化', '基因', '遗传', '医学', '神经科学', '科学史', 'science', 'physics', 'biology', 'math', 'astronomy'],
  },
  {
    name: '艺术与设计',
    color: '#c026d3',
    keywords: ['艺术', '艺术史', '设计', '平面设计', '交互设计', 'ui', 'ux', '摄影', '绘画', '美术', '书法', '音乐', '乐理', '电影', '影视', '戏剧', '建筑', '雕塑', 'art', 'design', 'music', 'photography'],
  },
  {
    name: '生活与健康',
    color: '#16a34a',
    keywords: ['生活', '健康', '养生', '健身', '运动', '跑步', '瑜伽', '饮食', '美食', '烹饪', '菜谱', '旅行', '游记', '家居', '收纳', '园艺', '宠物', '育儿', '手工', '效率', '时间管理', 'lifestyle', 'cooking', 'travel', 'health'],
  },
  {
    name: '教育与考试',
    color: '#0284c7',
    keywords: ['教育', '教学', '教材', '教辅', '课程', '课堂', '学习方法', '考试', '考研', '高考', '托福', '雅思', 'gre', '四六级', '英语', '单词', '语法', '口语', '作文', '练习册', '题集', 'education', 'textbook', 'study'],
  },
  {
    name: '童书与绘本',
    color: '#f59e0b',
    keywords: ['儿童', '童书', '绘本', '图画书', '童话', '寓言', '幼儿', '亲子', '小学', '少年', '卡通', '漫画', 'children', 'picture book', 'comic'],
  },
  {
    name: '工具与参考',
    color: '#64748b',
    keywords: ['词典', '字典', '手册', '百科全书', '年鉴', '指南', '规范', '标准', '地图册', '工具书', 'dictionary', 'handbook', 'reference', 'manual'],
  },
  {
    name: '人文与文化',
    color: '#9333ea',
    keywords: ['人文', '文化', '国学', '传统文化', '民俗', '地理', '方言', '饮食文化', '读书', '书评', '随笔集', 'humanities', 'culture'],
  },
];

const UNCATEGORIZED = { name: '未分类', color: '#94a3b8', keywords: [] };

const MIN_SCORE = 1.5;

function buildIndex() {
  return CATEGORY_SEEDS.map((seed) => ({
    ...seed,
    patterns: seed.keywords.map((k) => ({ raw: k, lower: k.toLowerCase() })),
  }));
}
const INDEX = buildIndex();

function countHits(text, lower) {
  if (!text) return 0;
  let hits = 0;
  for (const kw of lower) {
    if (!kw) continue;
    if (text.includes(kw)) hits += 1;
  }
  return hits;
}

/**
 * 依据书籍元数据推荐分类
 * @param {{title?:string, subtitle?:string, summary?:string, subjects?:string[], publisher?:string}} meta
 * @returns {{name:string, color:string, score:number, matched:string[]}}
 */
function suggestCategory(meta = {}) {
  const title = String(meta.title || '').toLowerCase();
  const subtitle = String(meta.subtitle || '').toLowerCase();
  const subjects = (meta.subjects || []).join(' ').toLowerCase();
  const summary = String(meta.summary || '').toLowerCase().slice(0, 1500);
  const original = String(meta.originalTitle || '').toLowerCase();

  let best = { name: UNCATEGORIZED.name, color: UNCATEGORIZED.color, score: 0, matched: [] };

  for (const cat of INDEX) {
    let score = 0;
    const matched = new Set();
    for (const kw of cat.patterns) {
      const k = kw.lower;
      if (title.includes(k) || original.includes(k)) { score += 3.5; matched.add(kw.raw); }
      else if (subtitle.includes(k)) { score += 2.5; matched.add(kw.raw); }
      else if (subjects.includes(k)) { score += 4; matched.add(kw.raw); }
      else if (summary.includes(k)) { score += 1; matched.add(kw.raw); }
    }
    // 命中关键词种类越多，略微加成，避免单一高频词决定分类
    score += Math.min(matched.size, 4) * 0.4;
    if (score > best.score) best = { name: cat.name, color: cat.color, score, matched: [...matched].slice(0, 6) };
  }

  if (best.score < MIN_SCORE) return { ...best, name: UNCATEGORIZED.name, color: UNCATEGORIZED.color, score: 0 };
  return best;
}

module.exports = { suggestCategory, CATEGORY_SEEDS, UNCATEGORIZED };
