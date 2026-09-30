import { WORLD_BOOK_ENTRIES } from './worldbook/index.js';
import { isWorldbookEntryEnabled, matchesWorldbookActivation } from './worldbook/activation.js';
import { CANON_DATABASE } from './canon-database.js';

export const KNOWLEDGE_BASE = {
  entries: [
    {
      keys: ['木叶', '木叶隐村', '火影岩', '一乐拉面', '火影', '三代目'],
      title: '木叶隐村',
      content: `[木叶隐村]
火之国五大忍村之首，由千手柱间和宇智波斑共同创立。
标志性建筑: 火影岩(四位火影头像)、一乐拉面店、忍者学校、历代火影办公楼。
当前火影: 三代目·猿飞日斩(重代)。
主要家族: 宇智波一族(警务部队)、日向一族(宗家·分家)、奈良一族、秋道一族、山中一族。
村内有著名的"一乐拉面"(手打大叔)、山中花店、犬冢兽医诊所。
第三训练场是下忍们常去的训练场所。`
    },
    {
      keys: ['卡卡西', '旗木卡卡西', '拷贝忍者', '写轮眼卡卡西'],
      title: '旗木卡卡西',
      content: `[旗木卡卡西]
木叶上忍，木叶白牙之子。12岁成为上忍的天才。
左眼移植了宇智波带土赠予的写轮眼，能复制上千种忍术。
性格慵懒，经常迟到，看《亲热天堂》，但实力强悍。
称号"拷贝忍者卡卡西"、"写轮眼的卡卡西"。
当前状态(木叶52年): 暗部成员，尚未成为第七班导师。`
    },
    {
      keys: ['鸣人', '漩涡鸣人', '九尾人柱力'],
      title: '漩涡鸣人',
      content: `[漩涡鸣人]
四代火影波风水门之子，九尾人柱力。
当前(木叶52年): 约1岁，尚在襁褓之中。
村民大多不知道他的真实身份，只知道他是九尾人柱力而远离他。
由三代火影安排照顾。`
    },
    {
      keys: ['佐助', '宇智波佐助'],
      title: '宇智波佐助',
      content: `[宇智波佐助]
宇智波一族族长宇智波富岳的次子，宇智波鼬的弟弟。
当前(木叶52年): 约1岁，尚在宇智波族地。`
    },
    {
      keys: ['自来也', '蛤蟆仙人', '亲热天堂'],
      title: '自来也',
      content: `[自来也]
传说中的三忍之一，三代火影的弟子。
妙木山的蛤蟆仙人，擅长仙术、螺旋丸、通灵术。
好色，喜欢偷窥女浴池，著有《亲热天堂》系列。
当前(木叶52年): 在外游历，监视大蛇丸和晓组织的动向。
不在木叶村内。`
    },
    {
      keys: ['纲手', '医疗圣手', '蛞蝓公主'],
      title: '纲手',
      content: `[纲手]
传说中的三忍之一，初代火影千手柱间的孙女。
忍界最强的医疗忍者，擅长怪力、创造再生。
患有恐血症(因弟弟绳树和爱人断的死亡)。
当前(木叶52年): 离开木叶在外游历，以赌博闻名。`
    },
    {
      keys: ['大蛇丸', '蛇之仙人'],
      title: '大蛇丸',
      content: `[大蛇丸]
传说中的三忍之一，天才科学家。
痴迷于忍术研究和长生不老，进行了大量人体实验。
当前(木叶52年): 已叛逃木叶，具体行踪不明；其人体实验和禁术研究可作为暗线威胁。
暗地里建立了音隐村，仍在进行各种禁术研究。`
    },
    {
      keys: ['中忍考试', '中忍选拔'],
      title: '中忍考试',
      content: `[中忍考试]
每年两次(通常在6月和12月)举办的忍者晋升考试。
分为笔试、森林生存、个人对战三阶段。
由各村轮流主办，本次由木叶隐村主办。
下忍三人组队在带队上忍推荐下报名参加。`
    },
    {
      keys: ['暗部', '暗杀战术特殊部队'],
      title: '暗部',
      content: `[暗部(暗杀战术特殊部队)]
直属火影的特殊部队，成员佩戴动物面具隐藏身份。
执行暗杀、侦查、护卫等高级任务。
分为多个分队，各分队有独立分工。
志村团藏领导的"根"是暗部的培训部门，行事更加极端。`
    },
    {
      keys: ['晓', '晓组织'],
      title: '晓组织',
      content: `[晓组织]
当前(木叶52年): 尚未正式浮出水面。
最初由弥彦、长门、小南三人创立，以和平为理念。
后来被带土和绝渗透，逐渐转变为收集尾兽的邪恶组织。
目前处于地下活动阶段，不为世人所知。`
    },
    {
      keys: ['忍术', '火遁', '水遁', '雷遁', '土遁', '风遁', '分身术', '替身术', '变身术'],
      title: '基础忍术体系',
      content: `[基础忍术体系]
三身术(E级): 分身术(制造幻影分身)、替身术(瞬间与物体交换位置)、变身术(改变外貌)
D级忍术示例: 瞬身术(高速移动)、奈落见之术(低级幻术)
C级忍术示例: 火遁·豪火球の術、水遁·水乱波、风遁·大突破
B级忍术示例: 火遁·火龙炎弹、水遁·水龙弹、雷遁·雷切
A级忍术示例: 螺旋丸、千鸟流、火遁·豪火灭却
查克拉基本属性: 火·风·水·雷·土 + 阴·阳
血继限界: 两种属性查克拉性质变化的结合(如冰遁=水+风)`
    },
    {
      keys: ['任务', 'D级任务', 'C级任务', 'B级任务', 'A级任务', 'S级任务'],
      title: '任务等级体系',
      content: `[任务等级体系]
D级任务: 除草、找宠物、捡垃圾等简单任务，无危险。报酬: 500-5000两。
C级任务: 护卫、物资护送、情报收集。可能遭遇一般忍兽或盗贼。报酬: 5000-30000两。
B级任务: 中忍级别战斗任务，可能遭遇敌方忍者。报酬: 30000-100000两。
A级任务: 上忍级别的危险任务，涉及大量战斗。报酬: 100000-500000两。
S级任务: 影级任务，涉及国家机密或超强敌人。报酬: 500000两以上。
下忍通常只能接D级和C级任务。`
    },
    {
      keys: ['沙隐', '砂隐', '砂隐村', '风之国', '我爱罗'],
      title: '砂隐村',
      content: `[砂隐村]
风之国的隐藏村落，位于沙漠之中。
五大忍村之一，但经济衰退严重，军备削减。
风影: 四代风影·罗砂(使用磁遁·砂金)。
我爱罗(一尾人柱力)当前约1岁。`
    }
  ],

  getDefaultEntries() {
    const worldTitles = new Set(WORLD_BOOK_ENTRIES.map(entry => entry.title));
    return [
      ...this.entries.filter(entry => !worldTitles.has(entry.title)),
      ...WORLD_BOOK_ENTRIES
    ];
  },

  get allEntries() {
    const builtin = this.getDefaultEntries();
    const custom = this._loadCustomEntries().filter(isWorldbookEntryEnabled).map(e => ({ ...e, source: 'custom' }));
    return [...builtin, ...custom];
  },

  _loadCustomEntries() {
    try {
      if (typeof localStorage === 'undefined') return [];
      let saved = localStorage.getItem('naruto_worldbook_custom');
      if (saved) {
        const entries = JSON.parse(saved);
        return Array.isArray(entries) ? entries : [];
      }
      const legacy = localStorage.getItem('naruto_worldbook');
      if (legacy) {
        const all = JSON.parse(legacy);
        const builtin = new Map(this.getDefaultEntries().map(e => [e.title, e]));
        const custom = all.filter(e => {
          const b = builtin.get(e.title);
          if (!b) return true;
          return JSON.stringify(e.keys) !== JSON.stringify(b.keys) || e.content !== b.content;
        }).map(e => ({ ...e, source: 'custom', enabled: isWorldbookEntryEnabled(e) }));
        if (custom.length) {
          localStorage.setItem('naruto_worldbook_custom', JSON.stringify(custom));
          console.log('[KnowledgeBase] Migrated', custom.length, 'custom entries from legacy worldbook');
        }
        return custom;
      }
    } catch { console.warn('[KnowledgeBase] Failed to load custom worldbook'); }
    return [];
  },

  saveCustomEntries(entries) {
    try { localStorage.setItem('naruto_worldbook_custom', JSON.stringify(entries)); } catch {}
    this.invalidateCache();
  },

  getCustomEntries() {
    return this._loadCustomEntries();
  },

  buildContext({ query = '', state = {}, memory = {}, maxEntries = 8, budget = 5600, includeCanon = true } = {}) {
    this._refreshWorldbookCache();
    // 增量检测: 场景未变时复用上次结果,跳过搜索+格式化开销
    const fp = `${CANON_DATABASE.revision}|${includeCanon ? 'canon' : 'worldbook'}|${maxEntries}|${budget}|${this._sceneFingerprint(state, memory, query)}`;
    if (this._sceneCacheKey === fp && this._sceneCacheOutput !== null) {
      return this._sceneCacheOutput;
    }
    this._sceneCacheKey = fp;
    const searchText = this._buildSearchText(query, state, memory);
    const baseline = this._getBaselineEntries(state, searchText);
    const eraFacts = this._getEraSensitiveFacts(state, searchText);
    const baselineTitles = new Set(baseline.map(entry => entry.title));
    const results = this.search(searchText, { state, memory })
      .filter(entry => !baselineTitles.has(entry.title))
      .filter(entry => this._isAllowedForCurrentEra(entry, searchText, state))
      .slice(0, maxEntries * 3);

    const selected = [];
    let used = 0;
    const addEntry = (entry, force = false) => {
      if (entry.source === 'custom') force = false;
      const block = this._formatEntry(entry);
      const cost = block.length;
      if (!force && selected.length >= maxEntries) return false;
      if (!force && used + cost > budget) return false;
      selected.push(block);
      used += cost;
      return true;
    };

    for (const entry of baseline) addEntry(entry, true);
    for (const entry of eraFacts) addEntry(entry, true);

    const categoryCounts = new Map();
    for (const entry of results) {
      const category = entry.category || this._inferCategory(entry);
      const currentCount = categoryCounts.get(category) || 0;
      const cap = this._categoryCap(category);
      if (currentCount >= cap) continue;
      if (addEntry(entry)) categoryCounts.set(category, currentCount + 1);
      if (selected.length >= maxEntries) break;
    }

    const canonContext = includeCanon ? CANON_DATABASE.buildContext({
      query, state, memory,
      maxTechniques: 6,
      budget: Math.max(1200, budget)
    }) : '';
    if (!selected.length && !canonContext) { this._sceneCacheOutput = ''; return ''; }
    const timelineLabel = this._currentTimelineLabel(state);
    this._sceneCacheOutput = [
      `[世界书检索结果 - 分层注入，必须优先采用]`,
      selected.join('\n\n'),
      `[世界书使用规则]`,
      `- 当前时代优先: ${timelineLabel}。`,
      `- 标记为秘密或幕后的条目只用于保持叙事一致性，不得自动转化为当前角色知识。`,
      `- “已灭亡/已死亡/已叛逃/已成立”等结论必须看当前年份；未来才发生的结果不能回写到早期时间线。`,
      `- 与玩家记忆、任务、当前位置冲突时，优先遵守动态状态。`,
      `- 回复中的地点、NPC年龄/状态、组织公开程度必须与上述条目保持一致。`,
      canonContext
    ].join('\n');
    return this._sceneCacheOutput;
  },

  buildCanonContext(options = {}) {
    return CANON_DATABASE.buildContext(options);
  },

  matchAndGetContent(text, maxResults = 3) {
    if (!text) return '';
    return this.search(text)
      .slice(0, maxResults)
      .map(e => e.content)
      .join('\n\n');
  },

  search(query, { state = {}, memory = {} } = {}) {
    this._refreshWorldbookCache();
    const searchText = this._buildSearchText(query, state, memory);
    const cacheKey = `${this._cacheKey(query, state, memory)}|${searchText}`;
    if (this._searchCache && this._searchCacheKey === cacheKey) {
      return this._searchCache;
    }
    const matched = new Map();
    const lowerQuery = String(query || '').toLowerCase();
    const stopTerms = new Set(['血继', '血继限界', '家族', '一族', '是否', '存在', '调查', '了解', '打听', '相关', '线索']);
    const terms = this._tokenize(lowerQuery);
    for (const entry of this.allEntries) {
      if (!lowerQuery && entry.source !== 'custom') continue;
      if (entry.source === 'custom' && !matchesWorldbookActivation(entry, searchText)) continue;
      let relevance = 0;
      if (entry.source === 'custom') relevance = 1000;
      const lowerTitle = String(entry.title || '').toLowerCase();
      const lowerContent = String(entry.content || '').toLowerCase();
      if (lowerQuery.includes(lowerTitle)) relevance += 18;
      for (const term of terms) {
        if (term.length < 2) continue;
        if (stopTerms.has(term)) continue;
        if (lowerTitle.includes(term)) relevance += 10;
        if (lowerContent.includes(term)) relevance += 1;
      }
      for (const key of entry.keys) {
        const lowerKey = key.toLowerCase();
        if (!lowerKey) continue;
        if (lowerKey.includes(lowerQuery)) relevance += 8;
        if (lowerQuery.includes(lowerKey)) relevance += Math.max(8, Math.min(24, lowerKey.length + 4));
        for (const term of terms) {
          if (stopTerms.has(term)) continue;
          if (term.length >= 2 && lowerKey.includes(term)) relevance += 6;
        }
      }
      const category = this._inferCategory(entry);
      const stateBoost = this._stateBoost(entry, category, state, memory, lowerQuery);
      if (relevance > 0 || stateBoost > 0) {
        relevance += stateBoost + this._basePriority(entry);
        matched.set(entry.title, { ...entry, category, relevance, directMatch: this._hasDirectMatch(entry, lowerQuery) });
      }
    }
    const result = [...matched.values()].sort((a, b) => b.relevance - a.relevance);
    this._searchCache = result;
    this._searchCacheKey = cacheKey;
    return result;
  },

  invalidateCache() {
    this._searchCache = null;
    this._searchCacheKey = null;
    this._sceneCacheKey = null;
    this._sceneCacheOutput = null;
  },

  _refreshWorldbookCache() {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem('naruto_worldbook_custom') ?? localStorage.getItem('naruto_worldbook');
    if (raw !== this._cachedWorldbookRaw) {
      this._cachedWorldbookRaw = raw;
      this.invalidateCache();
    }
  },

  _sceneFingerprint(state, memory, query = '') {
    const loc = state['世界·地点'] || '';
    const rels = state._relationships || {};
    const names = Object.keys(rels).sort().join(',');
    const missions = state._missions || {};
    const activeTitles = Object.values(missions.active || {}).map(m => m.title || '').sort().join(',');
    const memBrief = (memory?.recent_summary || '').slice(-100);
    const calendar = typeof state['世界·时间'] === 'string'
      ? state['世界·时间']
      : JSON.stringify(state['世界·时间'] || '');
    const branch = state?._meta?.active_branch || state?._timeline?.active_branch || state?.branch_id || 'branch_main';
    const timelineDecisions = String(state['世界·活跃事件'] || '');
    return `${query}|${calendar}|${loc}|${branch}|${names}|${activeTitles}|${timelineDecisions}|${memBrief}`;
  },

  _cacheKey(query, state, memory) {
    const missionId = state?._missions?.active ? (typeof state._missions.active === 'object' ? state._missions.active.id || '1' : '') : '';
    const calendar = typeof state?.['世界·时间'] === 'string'
      ? state['世界·时间']
      : JSON.stringify(state?.['世界·时间'] || '');
    const branch = state?._meta?.active_branch || state?._timeline?.active_branch || state?.branch_id || 'branch_main';
    const timelineDecisions = String(state?.['世界·活跃事件'] || '');
    return `${query}|${state?.['世界·地点'] || ''}|${calendar}|${branch}|${timelineDecisions}|${state?._combat?.is_active ? 'c' : ''}|${missionId}`;
  },

  getEntry(title) {
    return this.allEntries.find(e => e.title === title) || null;
  },

  getAllEntries() {
    return [...this.allEntries];
  },

  _buildSearchText(query, state, memory) {
    const parts = [query];
    const location = state['世界·地点'];
    if (location) parts.push(location);
    if (state['世界·活跃事件']) parts.push(String(state['世界·活跃事件']).replace(/\n/g, ' '));
    if (state['玩家·出身']) parts.push(state['玩家·出身']);
    if (state['玩家·查克拉属性']) parts.push(state['玩家·查克拉属性']);
    if (state['技能·血继限界']) parts.push(state['技能·血继限界']);
    if (state._combat?.is_active) parts.push(state._combat.enemy_name, state._combat.enemy_element, '战斗 忍术 体术');
    if (state._missions?.active) {
      const m = state._missions.active;
      if (typeof m === 'object') parts.push([m.title, m.description, m.location, m.rank].filter(Boolean).join(' '));
    }
    parts.push(...Object.keys(state._relationships || {}).slice(0, 8));
    parts.push(memory.recent_summary || '');
    const getMemoryLines = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') return val.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      return [];
    };
    parts.push(...getMemoryLines(memory.facts).slice(-8));
    parts.push(...getMemoryLines(memory.clues).slice(-8).map(c => typeof c === 'string' ? c : [c.title, c.detail, c.status].filter(Boolean).join(' ')));
    parts.push(...getMemoryLines(memory.long_term).slice(-6));
    return parts.filter(Boolean).join('\n');
  },

  _tokenize(text) {
    const rawTerms = String(text || '')
      .replace(/[\[\]【】()（）,，.。!！?？:：;；/\\|\n\r\t]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const terms = new Set(rawTerms);
    for (const raw of rawTerms) {
      const chineseRuns = raw.match(/[\u4e00-\u9fa5]{2,}/g) || [];
      for (const run of chineseRuns) {
        terms.add(run);
        if (run.length >= 3) {
          for (let size = 2; size <= Math.min(4, run.length); size++) {
            for (let i = 0; i <= run.length - size; i++) {
              terms.add(run.slice(i, i + size));
            }
          }
        }
      }
    }
    return [...terms];
  },

  _formatEntry(entry) {
    const tag = entry.category ? ` | ${entry.category}` : '';
    return `### ${entry.title}${tag}\n${entry.content}`;
  },

  _getBaselineEntries(state, searchText) {
    const entries = [];
    const add = (entry) => {
      if (entry && !entries.some(item => item.title === entry.title)) {
        entries.push({ ...entry, category: entry.category || this._inferCategory(entry), relevance: 999, directMatch: true });
      }
    };

    // 自动添加所有“蓝灯（常驻）”条目
    const all = this.allEntries;
    for (const entry of all) {
      // 玩家开局契约属于当前存档；旧版全局“玩家人设”不能污染其他角色。
      if (entry.title === '玩家人设' && state._opening_contract) continue;
      if (entry.source !== 'custom' && entry.isAlwaysOn) {
        add(entry);
      }
    }

    add(this.getEntry('火影时间线总览'));
    add(this.getEntry('九尾之乱与木叶52年'));
    add(this.getEntry('忍者能力分类') || this.getEntry('基础忍术体系'));

    const location = state['世界·地点'] || '';
    if (location) {
      const locationHit = this.search(location, { state, memory: {} })
        .filter(entry => (entry.category || this._inferCategory(entry)) === 'location_org')
        .find(entry => this._isAllowedForCurrentEra(entry, searchText, state));
      add(locationHit);
    }

    return entries;
  },

  _getEraSensitiveFacts(state, searchText) {
    const facts = [];
    const query = String(searchText || '');
    const year = this._currentKonohaYear(state, query);
    const add = (title, keys, content) => facts.push({ title, keys, content, category: 'timeline', relevance: 998, directMatch: true });

    if (/冰遁|雪之一族|水无月|白|血继迫害|血继限界/.test(query)) {
      add(
        '年代敏感事实: 冰遁与雪之一族',
        ['冰遁', '雪之一族', '水无月', '血继限界迫害', '白'],
        `[年代敏感事实: 冰遁与雪之一族]
当前判定年份: 木叶${year}年。
规则: 不得把疾风传或波之国篇时的结果倒灌到更早时间线。
木叶52年前后: 雾隐血雾政策和血继限界迫害正在造成雪之一族/冰遁血脉的衰落、隐匿和逃亡，但不能默认整个冰遁家族已经完全灭亡。可存在幸存分支、隐姓埋名者、流亡家庭、被雾隐追捕或被地方村落排斥的血继后裔。
波之国篇之前: 白可以仍年幼或处于被迫害/流亡/被再不斩收留前后，具体状态应由当前时间线和玩家行动决定。
波之国篇及之后: 才可引用“白与再不斩悲剧结局”等结果；在早期时间线只能作为未来可能性或伏笔。`
      );
    }

    if (/宇智波灭族|鼬|佐助|宇智波一族|写轮眼/.test(query) && year < 55) {
      add(
        '年代敏感事实: 宇智波灭族尚未发生',
        ['宇智波灭族', '宇智波一族', '鼬', '佐助'],
        `[年代敏感事实: 宇智波灭族尚未发生]
当前判定年份: 木叶${year}年。
木叶59年前，宇智波灭族尚未发生。佐助不应具有灭族后的复仇人格；鼬不应已经作为灭族叛忍加入晓。可以描写族内压力、政变倾向和高层监视作为伏笔。`
      );
    }

    if (/晓|佩恩|尾兽捕捉|晓组织/.test(query) && year < 60) {
      add(
        '年代敏感事实: 晓尚未公开捕捉尾兽',
        ['晓', '晓组织', '佩恩', '尾兽捕捉'],
        `[年代敏感事实: 晓尚未公开捕捉尾兽]
当前判定年份: 木叶${year}年。
晓可以作为雨隐、地下情报或幕后阴影存在，但不应在木叶52年前后公开以跨国恐怖组织姿态捕捉尾兽。普通NPC通常不知道晓的真实目的。`
      );
    }

    return facts;
  },

  _extractKonohaYear(text) {
    if (typeof text === 'number' && Number.isFinite(text)) return text;
    const match = String(text || '').match(/(?:木叶|Konoha)\s*(\d+)\s*年?/i);
    return match ? Number(match[1]) : null;
  },

  _currentKonohaYear(state, fallbackText = '') {
    const calendar = state['世界·时间'] || {};
    return this._extractKonohaYear(calendar.year)
      ?? this._extractKonohaYear(calendar.konoha_year)
      ?? this._extractKonohaYear(state['世界·年代'])
      ?? this._extractKonohaYear(fallbackText)
      ?? 48;
  },

  _currentTimelineLabel(state) {
    const calendar = state['世界·时间'];
    if (calendar?.era && calendar?.year) {
      const yearLabel = typeof calendar.year === 'number' ? `${calendar.era}${calendar.year}年` : String(calendar.year);
      const parts = [yearLabel];
      if (calendar.month) parts.push(`${calendar.month}月`);
      if (calendar.day) parts.push(`第${calendar.day}天`);
      if (calendar.time_of_day) parts.push(calendar.time_of_day);
      return parts.join('·');
    }
    if (calendar?.year) {
      const parts = [String(calendar.year)];
      if (calendar.month) parts.push(`${calendar.month}月${calendar.day || 1}日`);
      else if (calendar.day) parts.push(`第${calendar.day}天`);
      if (calendar.time_of_day) parts.push(calendar.time_of_day);
      return parts.join('');
    }
    return state['世界·年代'] || '木叶52年';
  },

  _categoryCap(category) {
    const caps = {
      character: 3,
      character_detail: 2,
      location_org: 2,
      rules: 2,
      timeline: 2,
      arc: 1
    };
    return caps[category] || 2;
  },

  _hasDirectMatch(entry, lowerQuery) {
    const title = String(entry.title || '').toLowerCase();
    if (title && lowerQuery.includes(title)) return true;
    return (entry.keys || []).some(key => {
      const lowerKey = String(key || '').toLowerCase().trim();
      return lowerKey && lowerQuery.includes(lowerKey);
    });
  },

  _isAllowedForCurrentEra(entry, searchText, state) {
    const year = this._currentKonohaYear(state, searchText);
    const content = entry.content || '';
    
    // 检查内容中是否有严格的年代限制标签
    const eraLimitMatch = content.match(/\[适用年代:\s*木叶(\d+)年(?:-|至)(\d+)年\]/);
    if (eraLimitMatch) {
      const startYear = parseInt(eraLimitMatch[1]);
      const endYear = parseInt(eraLimitMatch[2]);
      if (year < startYear || year > endYear) {
         // 如果不在适用年代，除非强制匹配了非常独特的全名，否则阻止触发
         return false; 
      }
    }

    if (year >= 60) return true;
    if (!this._isFutureEntry(entry)) return true;
    return this._hasDirectMatch(entry, String(searchText || '').toLowerCase());
  },

  _isFutureEntry(entry) {
    const text = `${entry.title || ''}\n${(entry.keys || []).join(' ')}\n${entry.content || ''}`;
    return /博人|新时代|七代火影|六代火影|疾风传|佩恩袭击|第四次忍界大战|五影会谈|全能事件|壳组织|大筒木|川木|佐良娜|向日葵|Two Blue Vortex/.test(text);
  },

  _inferCategory(entry) {
    const title = String(entry.title || '');
    const haystack = `${title} ${(entry.keys || []).join(' ')}`;
    if (/性格|细节|说话方式|行为边界|外貌|体态|服装|气质|动作习惯|眼神|表情/.test(haystack)) return 'character_detail';
    if (/任务模板/.test(title)) return 'rules';
    if (/篇$|篇章|外传|决战|会谈/.test(title)) return 'arc';
    if (/木叶\d+年|纪年|时间线|年代|时代总览|忍界大战|九尾之乱|灭族|疾风传|第一部|战后|历史事件|外交事件|全能事件|中忍考试.*袭击/.test(haystack)) return 'timeline';
    if (/体系|规则|分类|总览|基础|等级|任务难度|性质变化|形态变化|忍术|体术|幻术|查克拉|血继|封印术|通灵术|仙术|八门|医疗|傀儡术|咒印|忍具/.test(title)) return 'rules';
    if (/尾兽·性格|尾兽与人柱力体系|尾兽与人柱力|尾兽·|人柱力体系/.test(title)) return 'rules';
    if (/村|国|组织|一族|地点|训练场|体系|分类/.test(title) || /木叶|砂隐|雾隐|岩隐|云隐|雨隐|音隐|暗部|根|晓|警务部队/.test(title)) return 'location_org';
    return 'character';
  },

  _basePriority(entry) {
    const category = entry.category || this._inferCategory(entry);
    if (category === 'character_detail') return 3;
    if (category === 'arc') return 2.5;
    if (category === 'rules') return 2;
    if (category === 'location_org') return 1.5;
    if (category === 'timeline') return 1;
    return 0;
  },

  _stateBoost(entry, category, state, memory, lowerQuery) {
    let boost = 0;
    const title = String(entry.title || '').toLowerCase();
    const keys = (entry.keys || []).map(k => String(k).toLowerCase());
    const hasAny = (values) => values.some(v => {
      const lower = String(v || '').toLowerCase();
      return lower && (title.includes(lower) || keys.some(k => k.includes(lower) || lower.includes(k)) || lowerQuery.includes(lower));
    });

    if (hasAny([state['世界·地点']])) boost += category === 'location_org' ? 12 : 5;
    if (hasAny(Object.keys(state._relationships || {}))) boost += category === 'character' ? 10 : 4;
    if (state._missions?.active) {
      const m = state._missions.active;
      if (typeof m === 'object' && hasAny([m.title, m.location, m.description])) boost += 8;
    }
    if (state._combat?.is_active && hasAny([state._combat.enemy_name, state._combat.enemy_element])) boost += 10;
    if (hasAny([...(memory.pins || []), ...(memory.facts || []), ...(memory.long_term || [])])) boost += 4;
    return boost;
  }
};

export default KNOWLEDGE_BASE;
