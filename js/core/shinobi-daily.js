import { extractNarrativeInstructions } from './narrative-artifact.js';

export const SHINOBI_DAILY_SCHEMA = 'naruto.shinobi-daily/v1';
export const SHINOBI_DAILY_TAG = 'shinobi_daily';

const REQUIRED_WORLD_ITEMS = 4;
const REQUIRED_FLAVOR_ITEMS = 3;
const REQUIRED_MISSION_RANKS = Object.freeze(['D', 'C', 'B', 'A']);
const FORBIDDEN_TEXT_PATTERN = /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const SHINOBI_DAILY_EXAMPLE = Object.freeze({
  schema: SHINOBI_DAILY_SCHEMA,
  date: '木叶48年3月12日',
  issue: '第 48 号',
  headline: Object.freeze({
    title: '木叶任务发布所完成春季委托名录复核',
    body: '木叶任务发布所今日公布春季委托名录复核结果。值班人员确认，新登记委托均已完成来源核验、风险分级与报酬备案；涉及跨境行动的项目仍须取得对应通行文件后方可受理。',
    sig: '本报驻木叶记者 · 青叶 报道'
  }),
  world: Object.freeze([
    Object.freeze({ tag: '火之国', title: '东部驿道恢复常态通行', text: '据沿线驿站联合通告，东部驿道例行检修已经结束，商旅可按原定时刻通行；夜间车队仍须在关卡登记随行人数与货物清单。' }),
    Object.freeze({ tag: '风之国', title: '砂隐公布本月水源巡检安排', text: '砂隐村政务处发布公开告示，本月将分区检查蓄水设施。巡检期间不影响居民取水，商队补给须服从现场引导。' }),
    Object.freeze({ tag: '水之国', title: '近海客运增设雾天瞭望员', text: '水之国港务部门确认，主要客运航线已增设雾天瞭望岗位，并要求船只在能见度下降时降低航速、依次进港。' }),
    Object.freeze({ tag: '铁之国', title: '中立关卡重申兵器封存规则', text: '铁之国关卡署重申，外来队伍入境前须申报大型兵器。封存凭证由持有人自行保管，离境核验后原样返还。' })
  ]),
  flavor: Object.freeze([
    Object.freeze({ mark: '食', title: '早市推出便携饭团组合', text: '木叶东街早市新增适合短途任务携带的饭团组合，摊主按当日食材标注保存时限，并提醒忍者避免在高温环境久放。' }),
    Object.freeze({ mark: '学', title: '忍者学校开放基础结印复习课', text: '忍者学校本周开放基础结印复习课，由值班教师分组纠正常见手势错误；课程面向已登记学生，不计入正式考核。' }),
    Object.freeze({ mark: '候', title: '气象班提醒午后或有短时阵雨', text: '木叶气象班依据公开观测发布提示，午后可能出现短时阵雨。训练场使用者应提前检查卷轴与纸质任务文件的防水措施。' })
  ]),
  missions: Object.freeze([
    Object.freeze({ rank: 'D', task: '整理任务发布所旧档案并核对编号', pay: '三千两', status: '受理中' }),
    Object.freeze({ rank: 'C', task: '护送药材车队抵达火之国东部驿站', pay: '四万两', status: '受理中' }),
    Object.freeze({ rank: 'B', task: '调查边境补给路线连续失联原因', pay: '十八万两', status: '资格审查' }),
    Object.freeze({ rank: 'A', task: '机密委托，详情由任务发布所当面说明', pay: '面议', status: '限上忍' })
  ]),
  quote: Object.freeze({
    text: '执行任务之前，先确认情报来自何处。',
    who: '木叶任务发布所 · 值班守则'
  })
});

const EXACT_KEYS = Object.freeze({
  root: Object.freeze(['schema', 'date', 'issue', 'headline', 'world', 'flavor', 'missions', 'quote']),
  headline: Object.freeze(['title', 'body', 'sig']),
  world: Object.freeze(['tag', 'title', 'text']),
  flavor: Object.freeze(['mark', 'title', 'text']),
  mission: Object.freeze(['rank', 'task', 'pay', 'status']),
  quote: Object.freeze(['text', 'who'])
});

// Validation and model instructions must share the same delivery constraints.
// A schema example alone cannot disclose bounds such as an eight-character title.
export const SHINOBI_DAILY_RULES = Object.freeze({
  objects: EXACT_KEYS,
  collections: Object.freeze({
    world: Object.freeze({ count: REQUIRED_WORLD_ITEMS, object: 'world', label: '要闻' }),
    flavor: Object.freeze({ count: REQUIRED_FLAVOR_ITEMS, object: 'flavor', label: '逸闻' }),
    missions: Object.freeze({ count: REQUIRED_MISSION_RANKS.length, object: 'mission', label: '布告' })
  }),
  text: Object.freeze(Object.fromEntries(Object.entries({
    schema: { min: 10, max: 48, constant: SHINOBI_DAILY_SCHEMA },
    date: { min: 4, max: 40 },
    issue: { min: 3, max: 20, pattern: /^第\s*\d{1,8}\s*号$/u, format: '第 N 号，N 为 1-8 位阿拉伯数字，数字前后可有空格' },
    'headline.title': { min: 8, max: 64 },
    'headline.body': { min: 40, max: 420 },
    'headline.sig': { min: 4, max: 48 },
    'world[].tag': { min: 2, max: 12 },
    'world[].title': { min: 6, max: 42 },
    'world[].text': { min: 24, max: 240 },
    'flavor[].mark': { min: 1, max: 1, pattern: /^\p{Script=Han}$/u, format: '只能是一个汉字' },
    'flavor[].title': { min: 5, max: 42 },
    'flavor[].text': { min: 20, max: 220 },
    'missions[].rank': { min: 1, max: 1, orderedValues: REQUIRED_MISSION_RANKS },
    'missions[].task': { min: 6, max: 70 },
    'missions[].pay': { min: 2, max: 20 },
    'missions[].status': { min: 2, max: 16 },
    'quote.text': { min: 6, max: 100 },
    'quote.who': { min: 3, max: 48 }
  }).map(([field, rule]) => [field, Object.freeze(rule)])))
});

export function buildShinobiDailyRulesPrompt() {
  const collectionPaths = new Map(Object.entries(SHINOBI_DAILY_RULES.collections)
    .map(([path, rule]) => [rule.object, `${path}[]`]));
  const shape = Object.entries(SHINOBI_DAILY_RULES.objects).map(([object, keys]) => (
    `- ${collectionPaths.get(object) || object} 仅包含字段：${keys.join('、')}；全部必填，不得增删。`
  ));
  const counts = Object.entries(SHINOBI_DAILY_RULES.collections)
    .map(([path, rule]) => `${path} 恰好 ${rule.count} 条${rule.label}`).join('；');
  const fields = Object.entries(SHINOBI_DAILY_RULES.text).map(([path, rule]) => {
    const constraints = [
      `${path}：${rule.min}-${rule.max} 个字符`,
      rule.constant ? `固定值 ${rule.constant}` : '',
      rule.format || '',
      rule.orderedValues ? `依次只能为 ${rule.orderedValues.join('、')}，不得调整顺序` : ''
    ].filter(Boolean);
    return `- ${constraints.join('；')}。`;
  });
  return [
    '【日报字段规则 · 与本地校验共用】',
    ...shape,
    `- ${counts}。`,
    '- 所有叶子字段必须是非空字符串；禁止 HTML、XML 和控制字符。字符数按 Unicode 码点计算，先合并连续空白为一个空格并去掉首尾空白；[] 表示数组的每一项。',
    ...fields
  ].join('\n');
}

// Provider contracts derive from the same rules as validation and repair prompts.
export function buildShinobiDailyJsonSchema() {
  const textSchema = path => {
    const rule = SHINOBI_DAILY_RULES.text[path];
    return {
      type: 'string', minLength: rule.min, maxLength: rule.max,
      ...(rule.constant === undefined ? {} : { const: rule.constant }),
      ...(rule.pattern ? { pattern: rule.pattern.source } : {}),
      ...(rule.format ? { description: rule.format } : {})
    };
  };
  const objectSchema = (object, prefix = '') => ({
    type: 'object', additionalProperties: false,
    required: [...SHINOBI_DAILY_RULES.objects[object]],
    properties: Object.fromEntries(SHINOBI_DAILY_RULES.objects[object].map(key => {
      const collection = SHINOBI_DAILY_RULES.collections[key];
      if (object === 'root' && collection) {
        const item = objectSchema(collection.object, `${key}[].`);
        const orderedField = Object.keys(item.properties).find(field => (
          SHINOBI_DAILY_RULES.text[`${key}[].${field}`].orderedValues
        ));
        return [key, {
          type: 'array', minItems: collection.count, maxItems: collection.count,
          ...(orderedField ? {
            prefixItems: SHINOBI_DAILY_RULES.text[`${key}[].${orderedField}`].orderedValues
              .map(value => ({
                ...item,
                properties: { ...item.properties, [orderedField]: { ...item.properties[orderedField], const: value } }
              })),
            items: false
          } : { items: item })
        }];
      }
      return [key, object === 'root' && SHINOBI_DAILY_RULES.objects[key]
        ? objectSchema(key, `${key}.`)
        : textSchema(`${prefix}${key}`)];
    }))
  });
  return { $id: SHINOBI_DAILY_SCHEMA, ...objectSchema('root') };
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function checkExactKeys(value, expected, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} 必须是 JSON 对象`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path} 缺少字段 ${key}`);
  }
  for (const key of actual) {
    if (!required.includes(key)) errors.push(`${path} 包含未定义字段 ${key}`);
  }
  return true;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function readText(value, path, errors) {
  const field = path.replace(/^日报\./u, '').replace(/\[\d+\]/gu, '[]');
  const { min, max, pattern, constant, format } = SHINOBI_DAILY_RULES.text[field];
  const text = normalizeText(value);
  if (!text) {
    errors.push(`${path} 必须是非空字符串`);
    return '';
  }
  if (FORBIDDEN_TEXT_PATTERN.test(text)) errors.push(`${path} 不得包含 HTML、XML 或控制字符`);
  if ([...text].length < min || [...text].length > max) {
    errors.push(`${path} 长度必须为 ${min}-${max} 个字符`);
  }
  if (pattern && !pattern.test(text)) errors.push(`${path} 格式无效${format ? `：${format}` : ''}`);
  if (constant !== undefined && text !== constant) errors.push(`${path} 必须是 ${constant}`);
  return text;
}

function freezeDaily(value) {
  return Object.freeze({
    ...value,
    headline: Object.freeze({ ...value.headline }),
    world: Object.freeze(value.world.map(item => Object.freeze({ ...item }))),
    flavor: Object.freeze(value.flavor.map(item => Object.freeze({ ...item }))),
    missions: Object.freeze(value.missions.map(item => Object.freeze({ ...item }))),
    quote: Object.freeze({ ...value.quote })
  });
}

export function validateShinobiDaily(value) {
  const errors = [];
  if (!checkExactKeys(value, EXACT_KEYS.root, '日报', errors)) return { valid: false, errors, daily: null };

  const daily = {
    schema: readText(value.schema, '日报.schema', errors),
    date: readText(value.date, '日报.date', errors),
    issue: readText(value.issue, '日报.issue', errors),
    headline: {},
    world: [],
    flavor: [],
    missions: [],
    quote: {}
  };

  if (checkExactKeys(value.headline, EXACT_KEYS.headline, '日报.headline', errors)) {
    daily.headline = {
      title: readText(value.headline.title, '日报.headline.title', errors),
      body: readText(value.headline.body, '日报.headline.body', errors),
      sig: readText(value.headline.sig, '日报.headline.sig', errors)
    };
  }

  if (!Array.isArray(value.world) || value.world.length !== REQUIRED_WORLD_ITEMS) {
    errors.push(`日报.world 必须恰好包含 ${REQUIRED_WORLD_ITEMS} 条要闻`);
  } else {
    daily.world = value.world.map((item, index) => {
      const path = `日报.world[${index}]`;
      if (!checkExactKeys(item, EXACT_KEYS.world, path, errors)) return { tag: '', title: '', text: '' };
      return {
        tag: readText(item.tag, `${path}.tag`, errors),
        title: readText(item.title, `${path}.title`, errors),
        text: readText(item.text, `${path}.text`, errors)
      };
    });
  }

  if (!Array.isArray(value.flavor) || value.flavor.length !== REQUIRED_FLAVOR_ITEMS) {
    errors.push(`日报.flavor 必须恰好包含 ${REQUIRED_FLAVOR_ITEMS} 条逸闻`);
  } else {
    daily.flavor = value.flavor.map((item, index) => {
      const path = `日报.flavor[${index}]`;
      if (!checkExactKeys(item, EXACT_KEYS.flavor, path, errors)) return { mark: '', title: '', text: '' };
      return {
        mark: readText(item.mark, `${path}.mark`, errors),
        title: readText(item.title, `${path}.title`, errors),
        text: readText(item.text, `${path}.text`, errors)
      };
    });
  }

  if (!Array.isArray(value.missions) || value.missions.length !== REQUIRED_MISSION_RANKS.length) {
    errors.push(`日报.missions 必须按 D、C、B、A 顺序恰好包含 ${REQUIRED_MISSION_RANKS.length} 条布告`);
  } else {
    daily.missions = value.missions.map((item, index) => {
      const path = `日报.missions[${index}]`;
      if (!checkExactKeys(item, EXACT_KEYS.mission, path, errors)) return { rank: '', task: '', pay: '', status: '' };
      const rank = readText(item.rank, `${path}.rank`, errors);
      const expectedRank = SHINOBI_DAILY_RULES.text['missions[].rank'].orderedValues[index];
      if (rank !== expectedRank) {
        errors.push(`${path}.rank 必须是 ${expectedRank}`);
      }
      return {
        rank,
        task: readText(item.task, `${path}.task`, errors),
        pay: readText(item.pay, `${path}.pay`, errors),
        status: readText(item.status, `${path}.status`, errors)
      };
    });
  }

  if (checkExactKeys(value.quote, EXACT_KEYS.quote, '日报.quote', errors)) {
    daily.quote = {
      text: readText(value.quote.text, '日报.quote.text', errors),
      who: readText(value.quote.who, '日报.quote.who', errors)
    };
  }

  return errors.length
    ? { valid: false, errors: [...new Set(errors)], daily: null }
    : { valid: true, errors: [], daily: freezeDaily(daily) };
}

export function parseShinobiDailyContract(text, { required = false } = {}) {
  const source = String(text || '');
  const blocks = extractNarrativeInstructions(source)
    .filter(block => block.tag === SHINOBI_DAILY_TAG);
  if (blocks.length === 0) {
    return {
      valid: !required,
      errors: required ? ['缺少顶层 <shinobi_daily> 日报契约'] : [],
      daily: null,
      raw: null
    };
  }
  if (blocks.length !== 1) {
    return { valid: false, errors: ['每回合必须且只能输出一个顶层 <shinobi_daily> 日报契约'], daily: null, raw: null };
  }
  const block = blocks[0];
  const raw = block.raw;
  if (block.attributes || block.selfClosing) {
    return { valid: false, errors: ['<shinobi_daily> 不得包含标签属性，且必须使用完整闭合标签'], daily: null, raw };
  }
  let parsed;
  try {
    parsed = JSON.parse(block.content.trim());
  } catch (error) {
    return { valid: false, errors: [`<shinobi_daily> 必须包含严格 JSON：${error.message}`], daily: null, raw };
  }
  const result = validateShinobiDaily(parsed);
  return { ...result, raw };
}

export function buildShinobiDailyPrompt({ producer = 'main', includeExample = true } = {}) {
  const placement = producer === 'repair'
    ? '本次只输出日报契约；已暂存的变量与记忆由本地保留，不要重新生成。'
    : producer === 'secondary'
    ? '完成全部变量标签后，在输出末尾追加日报契约。'
    : '完成可见正文和变量、记忆标签后追加日报契约；若本回合另有 <image_contract>，只有绘图契约可以紧随日报之后。';
  return `【忍界日报结构契约 · 固定前端数据源】
${placement}
- 必须输出且只能输出一次 <shinobi_daily>严格 JSON</shinobi_daily>；禁止代码围栏、注释、HTML、Markdown 和标签属性。
${buildShinobiDailyRulesPrompt()}
- 日报是面向公众的报纸，不是全知旁白：不得泄露私密意图、秘密身份、未公开情报、内部推理、未来剧情或玩家尚未公开的行动。
- 头条和要闻只能陈述当前安全证据及最终正文已经公开成立的事实。证据不足时写克制的政务、交通、天气或民生通告，不得把传闻写成定论。
- 任务布告只是报纸公开栏，不得把它们写入玩家任务状态；等级、风险、报酬与受理状态必须相互合理。
- 引语必须有可核验公开来源；没有可靠人物原话时，使用明确署名的机构守则或无人物归属的忍者箴言，禁止伪造名人名言。
- date 必须符合当前游戏时间；issue 使用“第 N 号”的阿拉伯数字格式。所有文字应简洁、客观、无现代网络梗。${includeExample ? `

【规范示例 · 仅示范结构与写法，绝不可复制其中事实到当期】
<shinobi_daily>${JSON.stringify(SHINOBI_DAILY_EXAMPLE)}</shinobi_daily>` : ''}`;
}

export const SHINOBI_DAILY_DELEGATION_PROMPT = `【忍界日报职责边界】
本回合已启用二次变量模型，忍界日报由二次变量模型独立生成。主叙事模型不得输出 <shinobi_daily>、日报 JSON、日报标题或任务布告，只需完成正文。`;

export const SHINOBI_DAILY_REVIEW_PROMPT = `【忍界日报复检规则】
候选稿含 <shinobi_daily> 时，最终 <final> 中必须保留且只能保留一个完整日报契约。不得把它展开成正文或 HTML。若正文纠错影响公开事实，只修正对应日报内容；其余字段保持不变，并继续满足固定 schema、4 条要闻、3 条逸闻、D/C/B/A 四条任务布告及公开信息边界。`;
