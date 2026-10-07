import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { formatGameTime } from '../utils/format.js';
import { WORLD_BOOK_ENTRIES } from '../data/worldbook/index.js';
import { KNOWLEDGE_BASE } from '../data/knowledge-base.js';
import { getMemoryConfig } from '../data/memory-config.js';
import { createContinuityCasToken, isContinuityCasCurrent } from '../core/continuity-ledger.js';
import { projectNarrativeForMemory } from '../core/narrative-memory.js';

const KEEP_TURN_SUMMARIES_AFTER_COMPRESSION = 3;
const TURN_SUMMARY_LIMIT = 900;
const ROLLING_SUMMARY_LIMIT = 4000;
const COMPRESSED_SUMMARY_LIMIT = 6000;

const VOLUME_CHAPTER_WINDOW = 10;
const CHAPTER_SUMMARY_LIMIT = 400;
const VOLUME_SUMMARY_LIMIT = 600;
const CHAPTER_INJECT_RECENT = 2;
const CHAPTER_INJECT_RETRIEVED = 1;
const MAX_CHAPTERS_INJECT = 3;
const FACTS_INJECT_LIMIT = 10;
const BUDGET_PER_SECTION = {
  pins:      300,
  volumes:   600,
  chapters:  1200,
  recent:    1200,
  facts:     1000,
  archived:   500,
  clues:      400,
  events:     300,
  npc:        300
};

const MEMORY_VERSION = 2;
const DEEP_INPUT_CHAR_LIMIT = 12000;
const DEEP_OUTPUT_MAX_TOKENS = 3000;
const COMPRESSION_INPUT_CHAR_LIMIT = 6000;
const NPC_NOTE_LIMIT_PER_NPC = 10;

class MemorySystem {
  constructor() {
    this._bound = false;
    this._aliasCache = null;
    this._aliasCacheVer = -1;
    this._pendingRecall = [];
    this._stateVersionCache = -2;
    this._lastStateVersion = null;
    this._lastComputeResult = null;
    this._compressionPromise = null;
    this._deepConsolidationPromise = null;
  }

  bindEvents() {
    if (this._bound) return;
    this._bound = true;
    eventBus.on('mission:added', mission => this.recordMissionAdded(mission));
    eventBus.on('mission:progress', mission => this.recordMissionProgress(mission));
    eventBus.on('mission:completed', mission => this.recordMissionCompleted(mission));
    eventBus.on('mission:abandoned', mission => this.recordMissionAbandoned(mission));
    eventBus.on('relationship:changed', data => this.recordRelationshipChange(data));
    eventBus.on('relationship:renamed', data => this.handleRelationshipRename(data));
  }

  /* ────────── 别名表 ────────── */

  _buildAliasTable() {
    const ver = stateManager.get('系统·回合数') || 0;
    if (this._aliasCache && this._aliasCacheVer === ver) return this._aliasCache;
    const map = new Map();
    const entries = (WORLD_BOOK_ENTRIES && WORLD_BOOK_ENTRIES.length)
      ? WORLD_BOOK_ENTRIES
      : (KNOWLEDGE_BASE.allEntries || KNOWLEDGE_BASE.entries || []);
    for (const e of entries) {
      const keys = Array.isArray(e.keys) ? e.keys : [];
      for (const k of keys) {
        const norm = k.trim();
        if (!norm) continue;
        if (!map.has(norm)) map.set(norm, e.title || norm);
      }
    }
    const rels = stateManager.getSub('_relationships') || {};
    for (const [name, rel] of Object.entries(rels)) {
      if (!map.has(name)) map.set(name, name);
      for (const alias of (Array.isArray(rel?.aliases) ? rel.aliases : [])) {
        const normalized = String(alias || '').trim();
        if (normalized && !map.has(normalized)) map.set(normalized, name);
      }
      const role = rel.role || rel.忍阶 || '';
      if (role && !map.has(role)) map.set(role, name);
    }
    const missions = stateManager.getSub('_missions') || {};
    for (const m of Object.values(missions.active || {})) {
      if (m.title && !map.has(m.title)) map.set(m.title, m.title);
      if (m.client && !map.has(m.client)) map.set(m.client, m.client);
    }
    this._aliasCache = map;
    this._aliasCacheVer = ver;
    return map;
  }

  _resolveAlias(name) {
    const table = this._buildAliasTable();
    return table.get(name) || name;
  }

  /* ────────── 指代消解 ────────── */

  _resolvePronouns(userInput, state) {
    const input = String(userInput || '');
    // 注意: \b 对中文无效(中文字符非 \w),直接用包含判断
    const hasPronoun = /(他|她|它|那里|这里|那个人|这个人)/.test(input);
    if (!hasPronoun) return input;
    let resolved = input;
    const mem = stateManager.getSub('_memory') || {};
    const turnLines = this._turnSummaryLines(mem.turn_summaries);
    const lastTurnText = turnLines.slice(-2).join(' ');
    // 闭集消解: 在已知 NPC 名单中找最近出现者,不用贪婪正则瞎猜
    const relNames = Object.keys(stateManager.getSub('_relationships') || {});
    let lastNPC = null, lastPos = -1;
    for (const name of relNames) {
      const pos = lastTurnText.lastIndexOf(name);
      if (pos > lastPos) { lastPos = pos; lastNPC = name; }
    }
    if (lastNPC && /(他|她)/.test(input)) {
      resolved = input.replace(/(他|她)/g, lastNPC);
    }
    const triggerMap = {
      '上次': '之前',
      '之前': '之前',
      '还记得': '之前',
      '当年': '之前',
      '那时候': '之前',
      '很久': '之前',
      '刚才': '最近'
    };
    for (const [kw, type] of Object.entries(triggerMap)) {
      if (input.includes(kw)) {
        resolved += ` [时间参照:${type}]`;
        break;
      }
    }
    return resolved;
  }

  /* ────────── <recall> 协议 ────────── */

  parseRecallTags(aiResponse) {
    if (!getMemoryConfig().recallEnabled || !aiResponse) return [];
    const results = [];
    const re = /<recall\s+entities="([^"]*)"\s*\/>/g;
    let m;
    while ((m = re.exec(aiResponse)) !== null) {
      const names = m[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean);
      for (const n of names) results.push(this._resolveAlias(n));
    }
    new Set(results).forEach(e => this._addRecallEntity(e));
    return results;
  }

  _addRecallEntity(entity) {
    const { recallEnabled, recallLifetime } = getMemoryConfig();
    if (!recallEnabled) return;
    const turn = Number(stateManager.get('系统·回合数')) || 0;
    this._pendingRecall = this._pendingRecall.filter(r => r.turn + recallLifetime > turn);
    this._pendingRecall.push({ entity, turn });
  }

  _drainRecallEntities() {
    const { recallEnabled, recallLifetime } = getMemoryConfig();
    if (!recallEnabled) {
      this._pendingRecall = [];
      return [];
    }
    const turn = Number(stateManager.get('系统·回合数')) || 0;
    this._pendingRecall = this._pendingRecall.filter(r => r.turn + recallLifetime > turn);
    return this._pendingRecall.map(r => r.entity);
  }

  /* ────────── 查询包构造 ────────── */

  _buildQueryPackage(state, userInput, memory) {
    // state 是 stateManager.get() 返回的普通对象,直接属性访问
    const turn = Number(state['系统·回合数']) || 0;
    const location = state['世界·地点'] || '';
    const rels = state._relationships || {};
    const missions = state._missions || {};
    const activeMissions = Object.values(missions.active || {});
    const alias = this._buildAliasTable();
    const turnLines = this._turnSummaryLines(memory.turn_summaries);
    const recentTurnText = turnLines.slice(-2).join(' ');

    const recallEntities = this._drainRecallEntities();
    const resolvedInput = this._resolvePronouns(userInput, state);
    const activeText = `${resolvedInput}\n${recentTurnText}`;
    const sceneNPCs = new Set();
    const npcCandidates = new Set(Object.keys(rels));
    for (const mission of activeMissions) {
      if (mission.client) npcCandidates.add(mission.client);
    }
    for (const name of npcCandidates) {
      const canonical = alias.get(name) || name;
      if (activeText.includes(name) || (canonical !== name && activeText.includes(canonical))) {
        sceneNPCs.add(canonical);
      }
    }
    const inputTokens = this._tokenize(resolvedInput);
    const contextTokens = this._tokenize(recentTurnText);

    const triggerWords = ['上次', '之前', '还记得', '当年', '那时候', '很久', '回忆', '往事', '从前'];
    const isRecallMode = triggerWords.some(w => resolvedInput.includes(w));

    return {
      sceneNPCs: [...sceneNPCs],
      location,
      recallEntities,
      inputTokens,
      contextTokens,
      isRecallMode,
      turn,
      activeMissionIds: new Set(activeMissions.map(m => m.id).filter(Boolean))
    };
  }

  /* ────────── 章节打分 ────────── */

  _scoreChapter(chapter, query) {
    let score = 0;
    const entities = new Set(query.sceneNPCs);
    if (query.location) entities.add(query.location);
    for (const e of query.recallEntities) entities.add(e);

    const chapEnts = new Set(chapter.entities || []);
    for (const e of entities) {
      if (!e) continue;
      if (chapEnts.has(e)) score += 3;
      else {
        const alias = this._resolveAlias(e);
        if (alias !== e && chapEnts.has(alias)) score += 2;
      }
    }

    const chapTokens = this._tokenize(chapter.summary || '');
    for (const t of query.inputTokens) {
      if (chapTokens.includes(t)) score += 1;
    }
    for (const t of query.contextTokens) {
      if (chapTokens.includes(t)) score += 1;
    }

    // 回忆模式: 结束于 30 回合前的旧章节加权(id 是章节序号,不能与回合数比较)
    if (query.isRecallMode && Number(chapter.to) < query.turn - 30) score *= 1.5;

    return score;
  }

  /* ────────── 注入构造 ────────── */

  buildPromptContext(memory, opts = {}) {
    if (!memory) memory = stateManager.getSub('_memory');
    if (!memory) return '';
    memory = projectCorrectedMemory(memory);
    const state = stateManager.get();
    const userInput = String(opts.userInput || '');
    const query = this._buildQueryPackage(state, userInput, memory);
    const isCombat  = !!state._combat?.is_active;
    const missionsActive = Object.keys(state._missions?.active || {}).length;
    const isQuiet   = !isCombat && !missionsActive;
    const configuredBudget = getMemoryConfig().promptBudget;
    const budget = isQuiet ? Math.floor(configuredBudget * 0.75) : configuredBudget;
    const parts = [];
    let used = 0;
    const push = (block) => { if (used + block.length > budget) return false; parts.push(block); used += block.length; return true; };
    const corrections = buildMemoryCorrectionContext({ _memory: memory }, { maxChars: Math.min(2000, Math.floor(budget * 0.3)) });
    if (corrections) push(corrections);
    const trimPush = (header, lines, limit) => {
      const body = lines.slice(0, limit).join('\n');
      if (body) push(`${header}\n${body}`);
    };

    // L0: 置顶
    const pinsLines = memory.pins ? memory.pins.split('\n').filter(Boolean) : [];
    if (pinsLines.length) trimPush('## 置顶提醒', pinsLines.slice(-5).map(item => `- ${item}`), 5);

    // L3: 卷摘要(压缩版)
    const volumes = this._parseChapterData(memory.volumes);
    if (volumes.length) {
      const body = volumes.slice(-3).map(v => `- [卷${v.id}] ${v.summary.slice(0, 150)}`).join('\n');
      if (body) push(`## 卷层摘要\n${body.slice(0, BUDGET_PER_SECTION.volumes)}`);
    }

    // L2: 章节
    const chapters = this._parseChapterData(memory.chapters);
    if (chapters.length) {
      const recent = chapters.slice(-CHAPTER_INJECT_RECENT);
      const recentIds = new Set(recent.map(c => c.id));
      const scored = chapters
        .filter(c => !recentIds.has(c.id))
        .map(c => ({ ch: c, score: this._scoreChapter(c, query) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, CHAPTER_INJECT_RETRIEVED)
        .map(s => s.ch);
      const injected = [...recent, ...scored].slice(-MAX_CHAPTERS_INJECT);
      const body = injected.map(c => `- [第${c.id}章] ${c.summary.slice(0, 120)}`).join('\n');
      if (body) push(`## 章节编年\n${body.slice(0, BUDGET_PER_SECTION.chapters)}`);
      if (memory.chapter_buffer) {
        push(`## 待归章剧情\n${memory.chapter_buffer.replace(/\s+/g, ' ').slice(-Math.min(600, budget - used - 100))}`);
      }
    } else if (memory.compressed_summary) {
      push(`## 前情提要\n${memory.compressed_summary.slice(-Math.min(800, budget - used - 100))}`);
    }

    // L1: 回合摘要
    if (memory.recent_summary) push(`## 最近剧情\n${memory.recent_summary.slice(-Math.min(BUDGET_PER_SECTION.recent, budget - used - 200))}`);

    // L4: 事实库
    const factsLines = memory.facts ? memory.facts.split('\n').filter(Boolean) : [];
    if (factsLines.length && used + 200 < budget) {
      const sceneEntities = [...query.sceneNPCs, ...query.recallEntities, query.location, ...query.inputTokens].filter(Boolean);
      const scored = factsLines.map(f => ({ fact: f, score: this._scoreFact(f, sceneEntities) }));
      const top = scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score || scored.indexOf(b) - scored.indexOf(a))
        .slice(0, FACTS_INJECT_LIMIT);
      if (top.length) trimPush('## 相关事实', top.map(s => `- ${s.fact}`), Math.min(top.length, 10));
    }

    // 归档记忆
    const archivedLines = memory.archived ? memory.archived.split('\n').filter(Boolean) : [];
    if (archivedLines.length && used + BUDGET_PER_SECTION.archived < budget) {
      const sceneEntities = [...query.sceneNPCs, ...query.recallEntities, query.location, ...query.inputTokens].filter(Boolean);
      const scored = archivedLines.map(f => ({ fact: f, score: this._scoreFact(f, sceneEntities) }));
      const rel = scored.filter(s => s.score > 1).sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.fact);
      if (rel.length) trimPush('## 归档回忆', rel.map(item => `- ${item}`), rel.length);
    }

    // 线索/事件 — 安静回合跳过
    if (!isQuiet || used + 300 < budget) {
      const cluesLines = memory.clues ? memory.clues.split('\n').filter(Boolean) : [];
      if (cluesLines.length) trimPush('## 未解线索', cluesLines.slice(-6).map(item => `- ${this.formatClueLine(item)}`), 6);
      const impLines = memory.important_events ? memory.important_events.split('\n').filter(Boolean) : [];
      if (impLines.length) trimPush('## 重要事件', impLines.slice(-5).map(item => `- ${item}`), 5);
    }

    // NPC 记忆
    const npcLines = memory.npc_notes ? memory.npc_notes.split('\n').filter(Boolean) : [];
    const npcMap = {};
    for (const line of npcLines) {
      const idx = line.indexOf(': ');
      if (idx > 0) { const name = line.slice(0, idx); const note = line.slice(idx + 2); if (!npcMap[name]) npcMap[name] = []; npcMap[name].push(note); }
    }
    const relevantNpcNames = new Set([...query.sceneNPCs, ...query.recallEntities].map(name => this._resolveAlias(name)));
    const npcEntries = Object.entries(npcMap)
      .filter(([name]) => relevantNpcNames.has(name) || relevantNpcNames.has(this._resolveAlias(name)))
      .slice(0, 4);
    if (npcEntries.length) {
      push(`## NPC记忆\n${npcEntries.map(([name, notes]) => `- ${name}: ${notes.slice(-2).join(' | ')}`).join('\n')}`);
    }

    // NPC 关系简史: 深度整理生成的持久化摘要,只注入在场NPC
    let relHistory = null;
    try { relHistory = JSON.parse(memory.relationship_history || '{}'); } catch {}
    const sceneNPCNames = query.sceneNPCs || [];
    const historyEntries = Object.entries(relHistory || {}).filter(([name]) =>
      sceneNPCNames.some(n => n === name || (this._resolveAlias(n) || n) === name)
    );
    if (historyEntries.length) {
      const histBudget = Math.min(800, budget - used - 100);
      if (histBudget > 0) {
        const body = historyEntries.slice(0, 3).map(([name, hist]) => {
          const summary = typeof hist === 'string' ? hist : (hist?.summary || '');
          return `- ${name}: ${summary}`;
        }).join('\n');
        if (body) push(`## NPC关系简史\n${body.slice(0, histBudget)}`);
      }
    }

    if (query.recallEntities.length) {
      push(`[系统提示] 本回合检索实体: ${query.recallEntities.join('、')}`);
    }

    this._aliasCache = null;
    return parts.length ? `[动态记忆 - 优先级高于世界书]\n${parts.join('\n\n')}` : '';
  }

  /* ────────── 章节固化 ────────── */

  compressTurnSummaries(memory) {
    this._refreshCorrectedSummaries(memory);
    const { chapterWindow } = getMemoryConfig();
    const lines = this._turnSummaryLines(memory.turn_summaries);
    const overflow = lines.slice(0, -KEEP_TURN_SUMMARIES_AFTER_COMPRESSION);
    const keep = lines.slice(-KEEP_TURN_SUMMARIES_AFTER_COMPRESSION);
    if (!overflow.length) return;
    const block = overflow.join('\n');
    const previous = memory.compressed_summary ? `${memory.compressed_summary}\n` : '';
    memory.compressed_summary = `${previous}[阶段摘要${(memory.compression_count || 0) + 1}]\n${block}`.slice(-COMPRESSED_SUMMARY_LIMIT);
    memory.turn_summaries = keep.join('\n');
    memory.compression_count = (memory.compression_count || 0) + 1;
    memory._pendingCompressionText = (memory._pendingCompressionText || '') + block + '\n';
    memory.chapter_buffer = (memory.chapter_buffer || '') + block + '\n';

    const turnsInBuffer = (memory.chapter_buffer.match(/#(\d+)/g) || []).length;
    if (turnsInBuffer >= chapterWindow) {
      const chapters = this._parseChapterData(memory.chapters);
      const state = stateManager.get();
      memory.chapters = JSON.stringify(this._consolidateChapterLocal(memory.chapter_buffer, chapters, state));
      memory.chapter_buffer = '';

      if (chapters.length % VOLUME_CHAPTER_WINDOW === 0 && chapters.length > 0) {
        const volumes = this._parseChapterData(memory.volumes);
        memory.volumes = JSON.stringify(this._consolidateVolumeLocal(chapters, volumes));
      }
    }
  }

  aiCompress(client) {
    if (this._compressionPromise) return this._compressionPromise;
    const task = this._runAiCompression(client).finally(() => {
      if (this._compressionPromise === task) this._compressionPromise = null;
    });
    this._compressionPromise = task;
    return task;
  }

  async _runAiCompression(client) {
    // 编排: 滚动压缩 → 章节升级 → 卷升级。各自独立版本防护,单次调用最多3个AI请求
    let did = false;
    try { did = (await this._aiCompressPending(client)) || did; } catch {}
    try { did = (await this._aiUpgradeChapter(client)) || did; } catch {}
    try { did = (await this._aiUpgradeVolume(client)) || did; } catch {}
    return did;
  }

  async _aiCompressPending(client) {
    const memory = this._loadMemory();
    const boundary = this._captureAsyncBoundary(memory);
    const pending = projectCorrectedMemory(memory)._pendingCompressionText || '';
    const chunk = pending.slice(0, COMPRESSION_INPUT_CHAR_LIMIT);
    if (chunk.trim().length < 200) return false;

    const prompt = [
      { role: 'system', content: '将以下回合小结压缩为密集摘要(≤500汉字)，保留: NPC姓名与态度变化、地点变换、关键决策与后果、新线索。只输出摘要，不加前缀。' },
      { role: 'user', content: chunk }
    ];

    try {
      const summary = await client.chat(prompt, { temperature: 0.3, max_tokens: 1024 });
      if (summary && summary.length > 40) {
        const current = this._loadMemory();
        if (!this._isAsyncBoundaryCurrent(boundary, current)) {
          console.warn('[MemorySystem] AI compression aborted: branch, node or memory changed during call');
          return false;
        }
        const previous = projectCorrectedMemory(current).compressed_summary || '';
        const cleanSummary = summary.trim().replace(/^[阶段摘要AI摘要]*[:：\s]*/, '');
        current.compressed_summary = `${previous}\n[AI摘要] ${cleanSummary}`.slice(-COMPRESSED_SUMMARY_LIMIT);
        current._pendingCompressionText = pending.slice(chunk.length);
        this._saveMemory(current);
        return true;
      }
    } catch (e) {
      console.warn('[MemorySystem] AI compression failed, keeping raw truncation:', e.message);
    }
    return false;
  }

  async _aiUpgradeChapter(client) {
    const memory = this._loadMemory();
    const chapters = this._parseChapterData(projectCorrectedMemory(memory).chapters);
    const target = chapters.find(c => c.raw);
    if (!target) return false;
    const boundary = this._captureAsyncBoundary(memory);

    const prompt = [
      { role: 'system', content: '你是剧情编年史官。为以下RPG剧情段落写标题和摘要。第一行输出标题(≤14字,不带引号和书名号),从第二行起输出摘要(≤380字),保留: 关键NPC及态度变化、地点变换、重要决策与后果、未解线索。不加其他前缀。' },
      { role: 'user', content: String(target.raw).slice(0, 6000) }
    ];

    try {
      const out = await client.chat(prompt, { temperature: 0.3, max_tokens: 800 });
      if (out && out.trim().length > 30) {
        const fresh = this._loadMemory();
        if (!this._isAsyncBoundaryCurrent(boundary, fresh)) return false;
        const freshChapters = this._parseChapterData(fresh.chapters);
        const ch = freshChapters.find(c => c.id === target.id);
        if (!ch || !ch.raw) return false;
        const lines = out.trim().split('\n').filter(Boolean);
        ch.title = lines[0].slice(0, 20);
        const aiSummary = lines.slice(1).join(' ').trim().slice(0, CHAPTER_SUMMARY_LIMIT);
        if (aiSummary) ch.summary = aiSummary;
        delete ch.raw;
        fresh.chapters = JSON.stringify(freshChapters);
        this._saveMemory(fresh);
        return true;
      }
    } catch (e) {
      console.warn('[MemorySystem] Chapter AI upgrade failed:', e.message);
    }
    return false;
  }

  async _aiUpgradeVolume(client) {
    const memory = this._loadMemory();
    const volumes = this._parseChapterData(projectCorrectedMemory(memory).volumes);
    const target = volumes.find(v => v.raw);
    if (!target) return false;
    const boundary = this._captureAsyncBoundary(memory);

    const prompt = [
      { role: 'system', content: '将以下多章剧情摘要浓缩为一段卷级总述(≤550字),保留: 主线推进脉络、关键NPC关系变化、重大转折、未解伏笔。只输出总述,不加前缀。' },
      { role: 'user', content: String(target.raw).slice(0, 5000) }
    ];

    try {
      const out = await client.chat(prompt, { temperature: 0.3, max_tokens: 900 });
      if (out && out.trim().length > 30) {
        const fresh = this._loadMemory();
        if (!this._isAsyncBoundaryCurrent(boundary, fresh)) return false;
        const freshVols = this._parseChapterData(fresh.volumes);
        const v = freshVols.find(x => x.id === target.id);
        if (!v || !v.raw) return false;
        v.summary = out.trim().slice(0, VOLUME_SUMMARY_LIMIT);
        delete v.raw;
        fresh.volumes = JSON.stringify(freshVols);
        this._saveMemory(fresh);
        return true;
      }
    } catch (e) {
      console.warn('[MemorySystem] Volume AI upgrade failed:', e.message);
    }
    return false;
  }

  _consolidateChapterLocal(bufferText, existingChapters, state) {
    // 章节区间从 buffer 内的 #回合号 标记推导,而非猜测
    const turnNums = (bufferText.match(/#(\d+)/g) || []).map(s => Number(s.slice(1))).filter(Number.isFinite);
    const from = turnNums.length ? Math.min(...turnNums) : (Number(state['系统·回合数']) || 0);
    const to = turnNums.length ? Math.max(...turnNums) : from;
    const now = state['世界·时间'] || '';
    const location = state['世界·地点'] || '';
    const rels = state._relationships || {};
    const entityNames = new Set();
    for (const name of Object.keys(rels)) {
      if (bufferText.includes(name)) entityNames.add(name);
    }
    if (location) entityNames.add(location);
    const missions = state._missions || {};
    for (const m of Object.values(missions.active || {})) {
      if (m.title && bufferText.includes(m.title)) entityNames.add(m.title);
      if (m.client && bufferText.includes(m.client)) entityNames.add(m.client);
    }
    const chapter = {
      id: existingChapters.length + 1,
      from,
      to,
      title: `${now} · ${location}`,
      summary: bufferText.replace(/\s+/g, ' ').slice(0, CHAPTER_SUMMARY_LIMIT),
      entities: [...entityNames].slice(0, 30),
      raw: bufferText.slice(0, 6000),
      ts: Date.now()
    };
    existingChapters.push(chapter);
    return existingChapters;
  }

  _consolidateVolumeLocal(chapters, existingVolumes) {
    const last10 = chapters.slice(-VOLUME_CHAPTER_WINDOW);
    const raw = last10.map(c => `[第${c.id}章] ${c.summary}`).join('\n').slice(0, 4000);
    const vols = existingVolumes || [];
    vols.push({
      id: vols.length + 1,
      from: last10[0].from,
      to: last10[last10.length - 1].to,
      summary: raw.slice(0, VOLUME_SUMMARY_LIMIT),
      raw,
      ts: Date.now()
    });
    return vols;
  }

  /* ────────── 深度整理 ────────── */

  shouldDeepConsolidate() {
    const cfg = getMemoryConfig();
    if (!cfg.deepEnabled) return false;
    const memory = this._loadMemory();
    const lastDeep = Number(memory.meta?.last_deep_turn) || 0;
    const turn = Number(stateManager.get('系统·回合数')) || 0;
    return turn - lastDeep >= cfg.deepCycle;
  }

  getMemoryStats() {
    const m = this._loadMemory();
    const count = (s) => s ? s.split('\n').filter(Boolean).length : 0;
    const chapters = this._parseChapterData(m.chapters);
    const volumes = this._parseChapterData(m.volumes);
    const npcLines = m.npc_notes ? m.npc_notes.split('\n').filter(Boolean) : [];
    const npcMap = {};
    for (const line of npcLines) {
      const idx = line.indexOf(': ');
      if (idx > 0) { const n = line.slice(0, idx); npcMap[n] = (npcMap[n] || 0) + 1; }
    }
    return {
      turn: Number(stateManager.get('系统·回合数')) || 0,
      lastDeepTurn: Number(m.meta?.last_deep_turn) || 0,
      factsCount: count(m.facts),
      archivedCount: count(m.archived),
      cluesCount: count(m.clues),
      pinsCount: count(m.pins),
      npcCount: Object.keys(npcMap).length,
      chapterCount: chapters.length,
      volumeCount: volumes.length,
      pendingBuffer: (m.chapter_buffer || '').length,
      chars: {
        facts: (m.facts || '').length,
        archived: (m.archived || '').length,
        compressed: (m.compressed_summary || '').length,
        recent: (m.recent_summary || '').length,
        chapters: (m.chapters || '').length,
        volumes: (m.volumes || '').length,
        npc_notes: (m.npc_notes || '').length
      }
    };
  }

  deepConsolidate(client, { force = false } = {}) {
    if (this._deepConsolidationPromise) return this._deepConsolidationPromise;
    const task = this._runDeepConsolidation(client, { force }).finally(() => {
      if (this._deepConsolidationPromise === task) this._deepConsolidationPromise = null;
    });
    this._deepConsolidationPromise = task;
    return task;
  }

  async _runDeepConsolidation(client, { force = false } = {}) {
    const cfg = getMemoryConfig();
    if (!force && !cfg.deepEnabled) return false;
    const memory = this._loadMemory();
    const boundary = this._captureAsyncBoundary(memory);
    const currentTurn = Number(stateManager.get('系统·回合数')) || 0;
    const lastDeep = Number(memory.meta?.last_deep_turn) || 0;
    if (!force && currentTurn - lastDeep < cfg.deepCycle) return false;

    const payloadStr = this._buildDeepConsolidationPayload(memory, lastDeep);
    if (payloadStr.length < 200) return false;

    const prompt = this._buildDeepConsolidatePrompt(payloadStr, currentTurn, lastDeep);

    let output;
    try {
      output = await client.chat(prompt, { temperature: 0.2, max_tokens: DEEP_OUTPUT_MAX_TOKENS });
    } catch (e) {
      console.warn('[MemorySystem] Deep consolidation call failed:', e.message);
      return false;
    }
    if (!output || output.trim().length < 30) return false;

    const parsed = this._parseDeepConsolidateOutput(output);
    if (!parsed) return false;

    const fresh = this._loadMemory();
    if (!this._isAsyncBoundaryCurrent(boundary, fresh)) {
      console.warn('[MemorySystem] Deep consolidation aborted: branch, node or memory changed during call');
      return false;
    }

    return this._applyDeepConsolidate(parsed, fresh, currentTurn, JSON.parse(payloadStr));
  }

  _buildDeepConsolidationPayload(memory, lastDeep) {
    memory = projectCorrectedMemory(memory);
    const takeRecent = (items, budget) => {
      const selected = [];
      let used = 2;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const cost = JSON.stringify(item).length + (selected.length ? 1 : 0);
        if (used + cost > budget) continue;
        selected.unshift(item);
        used += cost;
      }
      return selected;
    };
    const lines = (value) => value ? value.split('\n').filter(Boolean) : [];
    const chapters = this._parseChapterData(memory.chapters)
      .filter(c => Number(c.to) >= lastDeep)
      .map(c => ({ id: c.id, summary: c.summary, from: c.from, to: c.to }));
    const payload = {
      facts: takeRecent(lines(memory.facts), 3200),
      npc_notes: takeRecent(lines(memory.npc_notes), 2200),
      npc_history_buffer: takeRecent(lines(memory._relationship_buffer), 1600).join('\n'),
      clues: takeRecent(lines(memory.clues), 1200),
      pins: takeRecent(lines(memory.pins), 900),
      events: takeRecent(lines(memory.important_events), 1000),
      chapters: takeRecent(chapters, 1600)
    };
    let encoded = JSON.stringify(payload);
    const arrays = ['facts', 'npc_notes', 'clues', 'pins', 'events', 'chapters'];
    while (encoded.length > DEEP_INPUT_CHAR_LIMIT) {
      const field = arrays.sort((a, b) => JSON.stringify(payload[b]).length - JSON.stringify(payload[a]).length)
        .find(key => payload[key].length);
      if (field) payload[field].shift();
      else if (payload.npc_history_buffer) payload.npc_history_buffer = payload.npc_history_buffer.split('\n').slice(1).join('\n');
      else break;
      encoded = JSON.stringify(payload);
    }
    return encoded;
  }

  _buildDeepConsolidatePrompt(payloadStr, currentTurn, lastDeep) {
    return [
      {
        role: 'system',
        content: `你是火影忍者 RPG 的记忆编年史官,负责清洗积压记忆。

【任务】重组并精简以下 ${lastDeep}-${currentTurn} 回合的动态记忆,消除重复、合并碎片、结算已解线索,输出结构化 JSON。

【整理原则】
1. 零虚构: 只能重组/合并/删减输入中已有的条目,严禁添加任何输入未出现的 NPC 名、地点、数值、事件。
2. 保留回合锚点: 合并事实时,保留最早出现的 #回合号 前缀(如 "#42 卡卡西教我千鸟")。
3. 矛盾处理: 两条记录冲突时,保留回合号更大者;在该条目末尾附 " (曾记载: <旧条目摘要>)"。
4. 建议控制在 facts ≤ 40 条;npc_digest 每人 ≤ 80 字简史 + ≤ 40 字近况;resolved_clues 附结算依据。
5. 已解线索: clues 中 status=已解/已废弃 的,移入 resolved_clues 并附一句话结算说明。
6. pins 只保留仍有行动意义者(进行中任务、未解悬念),已完结任务相关 pin 删除。
7. 输入是按预算选取的部分记忆。只整理实际提供的条目；NPC 未提供可靠摘要时省略该角色，不清空它的历史。行动选项与未来计划不代表已经发生。

【输出协议 - 严格遵守】
只输出一个 JSON 对象,不加任何前后文字、解释、markdown 围栏。
字段:
{
  "facts": ["#回合号 精简后事实", ...],
  "npc_digest": {
    "NPC名": {"history": "≤80字关系走向简史", "recent": "≤40字本周期近况"}
  },
  "resolved_clues": [{"title": "线索名", "resolution": "结算依据"}],
  "pins": ["仍需置顶的项"],
  "era_note": "≤60字本周期主旋律概述"
}
未变动的字段也必须输出(原样回传)。`
      },
      { role: 'user', content: payloadStr }
    ];
  }

  _parseDeepConsolidateOutput(text) {
    if (!text) return null;
    // 花括号配对提取首个完整 JSON 对象
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') { depth--; if (depth === 0 && start >= 0) {
        const jsonStr = text.slice(start, i + 1);
        try { return JSON.parse(jsonStr); } catch { return null; }
      }}
    }
    return null;
  }

  _applyDeepConsolidate(parsed, memory, currentTurn, reviewed = {}) {
    let changed = false;
    const lines = value => String(value || '').split('\n').filter(Boolean);
    const replaceReviewed = (field, input, output) => {
      const seen = new Set(input || []);
      memory[field] = [...new Set([...lines(memory[field]).filter(line => !seen.has(line)), ...output])].join('\n');
    };
    if (Array.isArray(parsed.facts) && parsed.facts.length && parsed.facts.length <= 50) {
      replaceReviewed('facts', reviewed.facts, parsed.facts.slice(0, 40).map(s => this._singleLine(s).slice(0, 180)).filter(Boolean));
      this._syncLineMeta(memory, 'facts');
      changed = true;
    }
    const npcDigest = parsed.npc_digest || parsed.npc_notes;
    if (npcDigest && typeof npcDigest === 'object') {
      // 拆分: history 部分写入持久化的 relationship_history, recent 写入 npc_notes
      const npcLines = [];
      const relHist = {};
      const npcName = line => String(line).split(': ')[0];
      const reviewedNotes = reviewed.npc_notes || [];
      const reviewedBuffer = lines(reviewed.npc_history_buffer);
      const reviewedNames = new Set([...reviewedNotes, ...reviewedBuffer].map(npcName));
      const summarizedNames = new Set();
      for (const [name, data] of Object.entries(npcDigest)) {
        if (!reviewedNames.has(name)) continue;
        const hist = String(data?.history || '').slice(0, 120);
        const recent = String(data?.recent || '').slice(0, 40);
        if (hist) relHist[name] = { summary: hist, updated: Date.now() };
        if (hist || recent) {
          summarizedNames.add(name);
          npcLines.push(`${name}: ${[hist, recent].filter(Boolean).join(' | ')}`);
        }
      }
      if (npcLines.length) {
        replaceReviewed('npc_notes', reviewedNotes.filter(line => summarizedNames.has(npcName(line))), npcLines);
        changed = true;
      }
      if (Object.keys(relHist).length) {
        let existing = {};
        try { existing = JSON.parse(memory.relationship_history || '{}'); } catch {}
        for (const [name, entry] of Object.entries(relHist)) {
          const previous = existing[name]?.summary || '';
          // Earlier relationship histories were not included in this request.
          // Keep them when storing the newly summarized slice.
          existing[name] = { ...entry, summary: previous && !previous.includes(entry.summary)
            ? `${previous}\n${entry.summary}` : (previous || entry.summary) };
        }
        memory.relationship_history = JSON.stringify(existing);
        changed = true;
      }
      const consumedBuffer = new Set(reviewedBuffer.filter(line => relHist[npcName(line)]));
      if (consumedBuffer.size) {
        memory._relationship_buffer = lines(memory._relationship_buffer).filter(line => !consumedBuffer.has(line)).join('\n');
        changed = true;
      }
    }
    if (Array.isArray(parsed.resolved_clues) && parsed.resolved_clues.length) {
      const existingClues = memory.clues ? memory.clues.split('\n').filter(Boolean) : [];
      const reviewedClueTitles = new Set((reviewed.clues || []).flatMap(line => {
        try { return [JSON.parse(line).title]; } catch { return []; }
      }));
      const resolved = parsed.resolved_clues.filter(clue => reviewedClueTitles.has(clue?.title));
      const resolvedTitles = new Set(resolved.map(c => String(c?.title || '')));
      const kept = existingClues.filter(line => {
        try { const c = JSON.parse(line); return !resolvedTitles.has(c.title); } catch { return true; }
      });
      memory.clues = kept.join('\n');
      for (const c of resolved) {
        const title = String(c?.title || '线索');
        const resolution = String(c?.resolution || '');
        memory.important_events += `\n${this._timeLabel()} 线索结算: ${title}${resolution ? ' — ' + resolution : ''}`;
      }
      memory.important_events = memory.important_events.split('\n').filter(Boolean).slice(-30).join('\n');
      changed = true;
    }
    if (Array.isArray(parsed.pins) && parsed.pins.length <= 10) {
      const unseenPins = lines(memory.pins).filter(line => !(reviewed.pins || []).includes(line));
      replaceReviewed('pins', reviewed.pins, parsed.pins.slice(0, Math.max(0, 8 - unseenPins.length)).map(s => this._singleLine(s).slice(0, 180)).filter(Boolean));
      changed = true;
    }
    if (parsed.era_note) {
      memory.compressed_summary = `${memory.compressed_summary || ''}\n[时期小结 T${currentTurn}] ${String(parsed.era_note).slice(0, 80)}`.slice(-COMPRESSED_SUMMARY_LIMIT);
      changed = true;
    }
    if (changed) {
      memory.meta = memory.meta || { updated_at: null, sources: {} };
      memory.meta.updated_at = Date.now();
      memory.meta.last_deep_turn = currentTurn;
      memory.meta.sources = memory.meta.sources || {};
      memory.meta.sources.deep = (memory.meta.sources.deep || 0) + 1;
      this._saveMemory(memory);
      eventBus.emit('memory:deep-consolidated', { turn: currentTurn });
      console.log('[MemorySystem] Deep consolidation completed at turn', currentTurn);
    }
    return changed;
  }

  /* ────────── 存量方法(不变) ────────── */

  apply(update = {}, { source = 'ai', userInput = '', aiResponse = '' } = {}) {
    if (!update || typeof update !== 'object') {
      console.warn('[MemorySystem] apply called with non-object update:', typeof update);
      return stateManager.getSub('_memory') || {};
    }
    const memory = this._loadMemory();
    this._refreshCorrectedSummaries(memory);

    this._appendLines(memory, 'facts', Array.isArray(update.facts) ? update.facts : []);
    this._appendLines(memory, 'long_term', Array.isArray(update.add) ? update.add : [], 60);
    this._removePins(memory, Array.isArray(update.remove_pins) ? update.remove_pins : []);
    this._appendLines(memory, 'pins', Array.isArray(update.pins) ? update.pins : [], 8);
    this._appendClues(memory, Array.isArray(update.clues) ? update.clues : []);
    this._appendLines(memory, 'important_events', [...(Array.isArray(update.events) ? update.events : []), ...(Array.isArray(update.important_events) ? update.important_events : [])], 40);

    if (update.summary) memory.recent_summary = String(update.summary).trim().slice(0, TURN_SUMMARY_LIMIT);
    if (userInput || aiResponse || update.summary) {
      this.recordTurnSummary(memory, { userInput, aiResponse, summary: update.summary, source, tags: update.turn_tags || update.tags || [] });
    }
    if (!memory.recent_summary && (userInput || aiResponse)) memory.recent_summary = this.buildFallbackSummary(userInput, aiResponse);
    if (update.npc_notes && typeof update.npc_notes === 'object') {
      const turn = Number(stateManager.get('系统·回合数')) || 0;
      const lines = memory.npc_notes ? memory.npc_notes.split('\n').filter(Boolean) : [];
      for (const [npc, note] of Object.entries(update.npc_notes)) {
        const name = this._singleLine(npc).slice(0, 60);
        const text = this._singleLine(note).slice(0, 240);
        if (name && text) lines.push(`${name}: [T${turn}] ${text}`);
      }
      const perNpc = {};
      for (const l of lines) {
        const idx = l.indexOf(': ');
        if (idx > 0) {
          const name = l.slice(0, idx);
          const note = l.slice(idx + 2);
          if (!perNpc[name]) perNpc[name] = [];
          perNpc[name].push(note);
        }
      }
      memory.npc_notes = Object.entries(perNpc)
        .flatMap(([name, notes]) => notes.map(n => `${name}: ${n}`))
        .join('\n');
    }

    this._trim(memory);
    memory.meta = memory.meta || { updated_at: null, sources: {} };
    memory.meta.updated_at = Date.now();
    memory.meta.sources[source] = (memory.meta.sources[source] || 0) + 1;
    this._saveMemory(memory);
    eventBus.emit('memory:updated', { source, memory });
    return memory;
  }

  rememberRecentTurn(userInput, aiResponse) {
    const memory = this._loadMemory();
    this._refreshCorrectedSummaries(memory);
    const summary = this.buildFallbackSummary(userInput, aiResponse, { includePrevious: false });
    memory.recent_summary = this._appendRollingSummary(memory.recent_summary || '', summary);
    this.recordTurnSummary(memory, { userInput, aiResponse, summary, source: 'local' });
    this._trim(memory);
    memory.meta = memory.meta || { updated_at: null, sources: {} };
    memory.meta.updated_at = Date.now();
    memory.meta.sources.local = (memory.meta.sources.local || 0) + 1;
    this._saveMemory(memory);
    return summary;
  }

  buildFallbackSummary(userInput, aiResponse, { includePrevious = true } = {}) {
    const memory = projectCorrectedMemory(stateManager.getSub('_memory'));
    const previous = includePrevious ? (memory.recent_summary || '') : '';
    const clean = projectNarrativeForMemory(aiResponse).replace(/\s+/g, ' ').slice(0, 520);
    const input = String(userInput || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const turn = [
      `玩家意图（是否实现以剧情结果为准）: ${input || '本回合未记录明确输入'}`,
      `剧情结果: ${clean || 'AI回复未留下可提取正文'}`,
      '延续要点: 下回合必须承接玩家刚才的选择、现场人物态度、已经暴露或尚未确认的线索，不要把本回合结果重置或遗忘。'
    ].join(' ');
    return [previous, turn].filter(Boolean).join('\n').slice(-ROLLING_SUMMARY_LIMIT);
  }

  recordTurnSummary(memory, { userInput = '', aiResponse = '', summary = '', source = 'local', tags = [] } = {}) {
    this._refreshCorrectedSummaries(memory);
    const text = this._singleLine(projectNarrativeForMemory(summary) || this.buildFallbackSummary(userInput, aiResponse, { includePrevious: false }));
    if (!text) return;
    const turn = Number(stateManager.get('系统·回合数')) || 0;
    const entry = {
      turn,
      time: this._timeLabel(),
      summary: text.slice(0, TURN_SUMMARY_LIMIT),
      source,
      tags: Array.isArray(tags) ? tags.slice(0, 6) : []
    };
    const summaries = this._turnSummaryLines(memory.turn_summaries);
    const turnPrefix = `#${entry.turn} `;
    const existingIndex = summaries.findIndex(item => item.startsWith(turnPrefix));
    const line = `${turnPrefix}${entry.summary}`;
    if (existingIndex >= 0) summaries[existingIndex] = line;
    else summaries.push(line);
    memory.turn_summaries = summaries.join('\n');
    // recent_summary 只滚动回合小结;历史内容由章节/卷/前情提要分层注入,避免重复
    memory.recent_summary = (memory.turn_summaries || '').slice(-ROLLING_SUMMARY_LIMIT);
    if (summaries.length > getMemoryConfig().maxTurnSummaries) this.compressTurnSummaries(memory);
  }

  /* ────────── 事件记录 (不变) ────────── */

  recordMissionAdded(mission = {}) {
    if (!mission.title) return;
    this.apply({
      remove_pins: [mission.title],
      pins: [`当前任务: [${mission.rank || 'D'}级] ${mission.title}`],
      facts: [`接取任务「${mission.title}」${mission.location ? `，地点: ${mission.location}` : ''}`],
      clues: mission.clues || []
    }, { source: 'mission' });
  }

  recordMissionProgress(mission = {}) {
    const note = mission.progress?.note;
    this.apply({
      remove_pins: mission.title ? [mission.title] : [],
      pins: mission.title ? [`推进任务: ${mission.title}${note ? ` - ${note}` : ''}`] : [],
      facts: note && mission.title ? [`任务「${mission.title}」进展: ${note}`] : [],
      clues: mission.clues || []
    }, { source: 'mission' });
  }

  recordMissionCompleted(mission = {}) {
    if (!mission.title) return;
    this.apply({
      facts: [`完成任务「${mission.title}」，评价: ${mission.rating || '未评级'}`],
      events: [`${this._timeLabel()} 完成任务「${mission.title}」`],
      remove_pins: [mission.title]
    }, { source: 'mission' });
  }

  recordMissionAbandoned(mission = {}) {
    if (!mission.title) return;
    this.apply({
      facts: [`放弃任务「${mission.title}」`],
      events: [`${this._timeLabel()} 放弃任务「${mission.title}」`],
      remove_pins: [mission.title]
    }, { source: 'mission' });
  }

  recordRelationshipChange({ npc, relationship } = {}) {
    if (!npc || !relationship) return;
    const note = relationship.last_interaction || `${npc}当前好感${relationship.affection || 0}，信任${relationship.trust || 0}`;
    this.apply({
      npc_notes: { [npc]: note },
      facts: Math.abs(Number(relationship.affection) || 0) >= 60 ? [`${npc}与玩家关系显著: ${note}`] : []
    }, { source: 'relationship' });
  }

  handleRelationshipRename({ oldNpc, npc } = {}) {
    if (!oldNpc || !npc || oldNpc === npc) return;
    this._aliasCache = null;
    this._aliasCacheVer = -1;
    this._pendingRecall = this._pendingRecall.map(entry => (
      entry?.entity === oldNpc ? { ...entry, entity: npc } : entry
    ));
  }

  /* ────────── 格式工具 (不变) ────────── */

  formatClue(clue) {
    if (typeof clue === 'string') return clue;
    return `${clue.title || '线索'}${clue.status ? `(${clue.status})` : ''}: ${clue.detail || ''}`;
  }

  formatClueLine(line) {
    try { const clue = JSON.parse(line); return this.formatClue(clue); } catch { return line; }
  }

  /* ────────── 持久化 ────────── */

  _refreshCorrectedSummaries(memory) {
    if (!memory?.corrections?.length) return;
    const effective = projectCorrectedMemory(memory);
    // Never mix an invalidated derived summary into a new summary, which would
    // give the same stale story a new fingerprint. Raw facts remain undoable.
    for (const field of ['recent_summary', 'turn_summaries', 'compressed_summary', 'chapters', 'volumes',
      'chapter_buffer', '_relationship_buffer', 'relationship_history', '_pendingCompressionText']) {
      if (Object.hasOwn(effective, field)) memory[field] = effective[field];
    }
  }

  _loadMemory() {
    const raw = stateManager.getSub('_memory');
    if (!raw) return this._emptyMemory();
    return {
      ...(Array.isArray(raw.corrections) ? { corrections: raw.corrections } : {}),
      pins: raw.pins || '',
      facts: raw.facts || '',
      clues: raw.clues || '',
      long_term: raw.long_term || '',
      archived: raw.archived || '',
      recent_summary: raw.recent_summary || '',
      turn_summaries: raw.turn_summaries || '',
      compressed_summary: raw.compressed_summary || '',
      compression_count: Number(raw.compression_count) || 0,
      important_events: raw.important_events || '',
      npc_notes: raw.npc_notes || '',
      chapters: raw.chapters || '[]',
      volumes: raw.volumes || '[]',
      chapter_buffer: raw.chapter_buffer || '',
      _relationship_buffer: raw._relationship_buffer || '',
      relationship_history: raw.relationship_history || '{}',
      _facts_meta: raw._facts_meta || '[]',
      _long_term_meta: raw._long_term_meta || '[]',
      _pendingCompressionText: raw._pendingCompressionText || '',
      meta: {
        updated_at: raw.meta?.updated_at || null,
        sources: { ...(raw.meta?.sources || {}) },
        last_deep_turn: Number(raw.meta?.last_deep_turn) || 0
      }
    };
  }

  _emptyMemory() {
    return {
      pins: '', facts: '', clues: '', long_term: '', archived: '',
      recent_summary: '', turn_summaries: '', compressed_summary: '',
      compression_count: 0, important_events: '', npc_notes: '',
      chapters: '[]', volumes: '[]', chapter_buffer: '',
      _relationship_buffer: '', relationship_history: '{}',
      _facts_meta: '[]', _long_term_meta: '[]', _pendingCompressionText: '',
      meta: { updated_at: null, sources: {}, last_deep_turn: 0 }
    };
  }

  _saveMemory(memory) {
    stateManager.setSub('_memory', {
      ...(Array.isArray(memory.corrections) ? { corrections: memory.corrections } : {}),
      pins: memory.pins || '',
      facts: memory.facts || '',
      clues: memory.clues || '',
      long_term: memory.long_term || '',
      archived: memory.archived || '',
      recent_summary: memory.recent_summary || '',
      turn_summaries: memory.turn_summaries || '',
      compressed_summary: memory.compressed_summary || '',
      compression_count: memory.compression_count || 0,
      important_events: memory.important_events || '',
      npc_notes: memory.npc_notes || '',
      chapters: memory.chapters || '[]',
      volumes: memory.volumes || '[]',
      chapter_buffer: memory.chapter_buffer || '',
      _relationship_buffer: memory._relationship_buffer || '',
      relationship_history: memory.relationship_history || '{}',
      _facts_meta: memory._facts_meta || '[]',
      _long_term_meta: memory._long_term_meta || '[]',
      _pendingCompressionText: memory._pendingCompressionText || '',
      meta: {
        updated_at: memory.meta?.updated_at || null,
        sources: memory.meta?.sources || {},
        last_deep_turn: Number(memory.meta?.last_deep_turn) || 0
      }
    });
  }

  _parseChapterData(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch { return []; }
  }

  /* ────────── 内部工具 ────────── */

  _linesToObj(str) {
    if (!str) return {};
    const obj = {};
    for (const line of str.split('\n').filter(Boolean)) {
      const idx = line.indexOf(': ');
      if (idx > 0) obj[line.slice(0, idx)] = line.slice(idx + 2);
    }
    return obj;
  }

  _appendLines(memory, field, values, limit) {
    if (!Array.isArray(values)) return;
    const existing = memory[field] ? memory[field].split('\n').filter(Boolean) : [];
    for (const item of values) {
      const text = this._memoryText(item).trim();
      if (text && !existing.includes(text)) existing.push(text.slice(0, 180));
    }
    if (Number.isFinite(limit) && existing.length > limit) existing.splice(0, existing.length - limit);
    memory[field] = existing.join('\n');
    if (field === 'facts' || field === 'long_term') this._syncLineMeta(memory, field, existing);
  }

  _appendClues(memory, clues) {
    if (!Array.isArray(clues) || !clues.length) return;
    let existing = memory.clues ? memory.clues.split('\n').filter(Boolean) : [];
    const existingClueMap = new Map();
    for (const line of existing) {
      try { const c = JSON.parse(line); existingClueMap.set(c.title || line, line); } catch { existingClueMap.set(line, line); }
    }
    for (const clue of clues) {
      const item = typeof clue === 'string'
        ? { title: clue.slice(0, 40), detail: clue.slice(0, 180), status: '未解', source: 'ai' }
        : {
            title: String(clue?.title || clue?.id || '未命名线索').slice(0, 40),
            detail: String(clue?.detail || clue?.description || '').slice(0, 180),
            status: String(clue?.status || '未解').slice(0, 20),
            source: clue?.source || 'ai'
          };
      existingClueMap.set(item.title, JSON.stringify(item));
    }
    existing = [...existingClueMap.values()].slice(-40);
    memory.clues = existing.join('\n');
  }

  _trim(memory) {
    const cfg = getMemoryConfig();
    const archiveOlder = (field, limit) => {
      const lines = memory[field] ? memory[field].split('\n').filter(Boolean) : [];
      if (lines.length <= limit) return;
      let scored;
      if (field === 'facts' || field === 'long_term') {
        const meta = this._parseMeta(memory[this._metaField(field)]);
        const metaMap = new Map(meta.map(m => [m.k, m]));
        scored = lines.map((text, idx) => ({
          text, idx,
          importance: metaMap.get(text.slice(0, 40))?.i || 1
        }));
      } else { scored = lines.map((text, idx) => ({ text, idx, importance: 1 })); }
      scored.sort((a, b) => b.importance - a.importance || b.idx - a.idx);
      const keepSet = new Set(scored.slice(0, limit).map(s => s.idx));
      const kept = []; const overflow = [];
      for (let i = 0; i < lines.length; i++) {
        if (keepSet.has(i)) kept.push(lines[i]); else overflow.push(lines[i]);
      }
      memory[field] = kept.join('\n');
      if (field === 'facts' || field === 'long_term') this._syncLineMeta(memory, field, kept);
      const archived = memory.archived ? memory.archived.split('\n').filter(Boolean) : [];
      for (const item of overflow) {
        if (!archived.includes(item)) archived.push(item);
      }
      const chapterEnts = new Set();
      const chapters = this._parseChapterData(memory.chapters);
      for (const c of chapters) { for (const e of (c.entities || [])) chapterEnts.add(e); }
      // 稳定分区: 命中章节实体的优先保留,组内保持原有时间顺序(不用 unshift 以免每次重排反转)
      const entArr = [...chapterEnts].filter(Boolean);
      const matched = []; const rest = [];
      for (const item of archived) {
        if (entArr.some(e => item.includes(e))) matched.push(item);
        else rest.push(item);
      }
      memory.archived = [...matched, ...rest].slice(-cfg.archivedLimit).join('\n');
    };
    archiveOlder('facts', cfg.factsLimit);
    archiveOlder('long_term', 60);
    const pinsLines = memory.pins ? memory.pins.split('\n').filter(Boolean) : [];
    memory.pins = pinsLines.slice(-8).join('\n');
    const cluesLines = memory.clues ? memory.clues.split('\n').filter(Boolean) : [];
    memory.clues = cluesLines.slice(-40).join('\n');
    const tsLines = this._turnSummaryLines(memory.turn_summaries);
    memory.turn_summaries = tsLines.slice(-cfg.maxTurnSummaries).join('\n');
    const ieLines = memory.important_events ? memory.important_events.split('\n').filter(Boolean) : [];
    memory.important_events = ieLines.slice(-30).join('\n');

    // NPC 笔记溢出 → 累积到关系buffer,供深度整理生成简史
    const npcTrimLines = memory.npc_notes ? memory.npc_notes.split('\n').filter(Boolean) : [];
    const perNpcTrim = {};
    for (const l of npcTrimLines) {
      const idx = l.indexOf(': ');
      if (idx > 0) { const n = l.slice(0, idx); const note = l.slice(idx + 2); if (!perNpcTrim[n]) perNpcTrim[n] = []; perNpcTrim[n].push(note); }
    }
    const overflowLines = [];
    const keptNpcLines = [];
    for (const [npcName, notes] of Object.entries(perNpcTrim)) {
      if (notes.length > NPC_NOTE_LIMIT_PER_NPC) {
        overflowLines.push(npcName + ': ' + notes.slice(0, notes.length - NPC_NOTE_LIMIT_PER_NPC).join(' | '));
      }
      keptNpcLines.push(...notes.slice(-NPC_NOTE_LIMIT_PER_NPC).map(note => `${npcName}: ${note}`));
    }
    memory.npc_notes = keptNpcLines.join('\n');
    if (overflowLines.length) {
      memory._relationship_buffer = [memory._relationship_buffer, ...overflowLines]
        .filter(Boolean).join('\n').slice(-12000);
    }
  }

  _appendRollingSummary(prefix, text) {
    return [prefix, text].filter(Boolean).join('\n').slice(-ROLLING_SUMMARY_LIMIT);
  }

  _parseMeta(raw) {
    try { return JSON.parse(raw || '[]'); } catch { return []; }
  }

  _metaField(field) {
    return field === 'long_term' ? '_long_term_meta' : '_facts_meta';
  }

  _syncLineMeta(memory, field, lines) {
    const metaField = this._metaField(field);
    const values = lines || (memory[field] ? memory[field].split('\n').filter(Boolean) : []);
    const turn = Number(stateManager.get('系统·回合数')) || 0;
    const oldMap = new Map(this._parseMeta(memory[metaField]).map(item => [item.k, item]));
    memory[metaField] = JSON.stringify(values.map(text => {
      const key = text.slice(0, 40);
      const previous = oldMap.get(key);
      return { k: key, t: previous ? previous.t : turn, i: previous ? previous.i : 1 };
    }));
  }

  _removePins(memory, matchers) {
    const terms = matchers.map(item => this._singleLine(item)).filter(Boolean);
    if (!terms.length) return;
    const lines = memory.pins ? memory.pins.split('\n').filter(Boolean) : [];
    memory.pins = lines.filter(line => !terms.some(term => line.includes(term))).join('\n');
  }

  _turnSummaryLines(raw) {
    const result = [];
    for (const rawLine of String(raw || '').split('\n')) {
      const line = this._singleLine(rawLine);
      if (!line) continue;
      if (/^#\d+\s/.test(line) || !result.length) result.push(line);
      else result[result.length - 1] += ` ${line}`;
    }
    return result;
  }

  _singleLine(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  _memoryRevision(memory) {
    return JSON.stringify(memory || {});
  }

  _captureAsyncBoundary(memory) {
    const state = stateManager.get();
    return {
      memoryRevision: this._memoryRevision(memory),
      continuityToken: createContinuityCasToken({
        nodeId: state?._meta?.current_node_id || 'uncommitted-root',
        branchId: state?._meta?.active_branch || 'branch_main',
        ledger: state?._continuity
      })
    };
  }

  _isAsyncBoundaryCurrent(boundary, memory) {
    if (!boundary || this._memoryRevision(memory) !== boundary.memoryRevision) return false;
    const state = stateManager.get();
    return isContinuityCasCurrent(boundary.continuityToken, {
      nodeId: state?._meta?.current_node_id || 'uncommitted-root',
      branchId: state?._meta?.active_branch || 'branch_main',
      ledger: state?._continuity
    });
  }

  _tokenize(text) {
    const cleaned = String(text || '').replace(/[^\u4e00-\u9fff\w]/g, ' ').toLowerCase();
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const result = [...tokens];
    for (const token of tokens) {
      const chunks = token.match(/[\u4e00-\u9fff]+|[a-z0-9_]+/g) || [];
      for (const chunk of chunks) {
        if (/^[\u4e00-\u9fff]+$/.test(chunk) && chunk.length > 2) {
          for (let i = 0; i < chunk.length - 1; i++) result.push(chunk.slice(i, i + 2));
        }
        if (chunk !== token) result.push(chunk);
      }
    }
    for (let i = 0; i < tokens.length - 1; i++) result.push(tokens[i] + tokens[i + 1]);
    return [...new Set(result)];
  }

  _scoreFact(fact, entities) {
    if (!fact) return 0;
    let score = 0;
    const tokens = this._tokenize(fact);
    for (const entity of entities) {
      if (!entity) continue;
      if (fact.includes(entity)) { score += 3; continue; }
      const eTokens = this._tokenize(entity);
      for (const t of eTokens) { if (tokens.includes(t)) score += 1; }
    }
    return score;
  }

  _memoryText(item) {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'object') return item.text || item.detail || item.title || JSON.stringify(item);
    return String(item);
  }

  _timeLabel() {
    return formatGameTime(stateManager.get('世界·时间'));
  }
}

export const memorySystem = new MemorySystem();
export default memorySystem;
import { projectCorrectedMemory, buildMemoryCorrectionContext } from '../core/memory-corrections.js';
