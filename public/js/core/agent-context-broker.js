import { TurnEvidenceCompiler } from './turn-evidence.js';
import { projectNarrativeForMemory } from './narrative-memory.js';

function nodeNarrative(node) {
  const history = node.chat_history_delta || node.chat_history || [];
  const assistant = history.findLast(message => message?.role === 'assistant');
  return projectNarrativeForMemory(assistant?.content ?? node.ai_response ?? node.clean_response ?? node.ai_response_summary);
}

function historyContent(message) {
  return message?.role === 'assistant' ? projectNarrativeForMemory(message.content) : message?.content;
}

export const AGENT_CONTEXT_SCHEMA = 'naruto.agent-context/v1';
export const AGENT_CONTEXT_DOMAINS = Object.freeze([
  'character',
  'dialogue',
  'world',
  'worldbook',
  'all'
]);

const PRIVATE_KEYS = /^(?:private|inner[_-]?thoughts?|private[_-]?intent(?:history)?|privateGoals|agent_inner_thought)$/i;

function clone(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function text(value, max = 2000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function hash(value) {
  const source = stableStringify(value);
  let result = 2166136261;
  for (let index = 0; index < source.length; index++) {
    result ^= source.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function tokens(value) {
  const normalized = String(value || '').normalize('NFKC').toLowerCase();
  const words = normalized.match(/[\u3400-\u9fff]{2,}|[a-z0-9_]{2,}/g) || [];
  const result = new Set(words);
  for (const word of words) {
    if (/^[\u3400-\u9fff]+$/.test(word) && word.length > 2) {
      for (let index = 0; index < word.length - 1; index++) result.add(word.slice(index, index + 2));
    }
  }
  return [...result];
}

function score(value, queryTokens, names = []) {
  const body = typeof value === 'string' ? value : stableStringify(value);
  let result = 0;
  for (const name of names.filter(Boolean)) if (body.includes(name)) result += 8;
  const bodyTokens = new Set(tokens(body));
  for (const token of queryTokens) if (bodyTokens.has(token)) result += token.length > 2 ? 3 : 1;
  return result;
}

function redact(value, { allowPrivate = false } = {}) {
  if (Array.isArray(value)) return value.map(item => redact(item, { allowPrivate }));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!allowPrivate && PRIVATE_KEYS.test(key)) continue;
    result[key] = redact(nested, { allowPrivate });
  }
  return result;
}

function sourceRef(kind, id, extra = {}) {
  return Object.freeze({ kind, id: text(id, 240), ...clone(extra) });
}

function normalizeItem(item, index) {
  return Object.freeze({
    id: text(item?.id, 240) || `context:${index + 1}`,
    domain: text(item?.domain, 40),
    score: Number(item?.score) || 0,
    summary: text(item?.summary, 1800),
    data: clone(item?.data ?? null),
    source: clone(item?.source ?? null)
  });
}

function branchOf(state, options) {
  return text(options.branchId ?? state?._meta?.active_branch ?? state?.['系统·当前分支'], 160)
    || 'branch_main';
}

function nodeOf(state, options) {
  return text(options.nodeId ?? state?._meta?.current_node_id ?? state?.['系统·当前节点'], 160);
}

export class AgentContextBroker {
  constructor({
    pipeline = null,
    memorySystem = null,
    timelineSystem = null,
    evidenceCompiler = null,
    ttlMs = 120000,
    maxEntries = 96,
    now = () => Date.now()
  } = {}) {
    this.pipeline = pipeline;
    this.memorySystem = memorySystem;
    this.timelineSystem = timelineSystem;
    this.evidenceCompiler = evidenceCompiler || new TurnEvidenceCompiler();
    this.ttlMs = Math.max(1000, Number(ttlMs) || 120000);
    this.maxEntries = Math.max(8, Number(maxEntries) || 96);
    this.now = now;
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, invalidations: 0, searches: 0 };
  }

  configure({ pipeline, memorySystem, timelineSystem } = {}) {
    if (pipeline !== undefined) this.pipeline = pipeline;
    if (memorySystem !== undefined) this.memorySystem = memorySystem;
    if (timelineSystem !== undefined) this.timelineSystem = timelineSystem;
    return this;
  }

  async preflight(options = {}) {
    const base = { ...options, limit: options.limit ?? 10 };
    const startedAt = this.now();
    const [character, dialogue, world] = await Promise.all([
      this.searchContext({ ...base, domain: 'character' }),
      this.searchContext({ ...base, domain: 'dialogue' }),
      this.searchContext({ ...base, domain: 'world' })
    ]);
    const items = [...character.items, ...dialogue.items, ...world.items];
    const sources = [...character.sources, ...dialogue.sources, ...world.sources];
    return Object.freeze({
      schema: AGENT_CONTEXT_SCHEMA,
      kind: 'preflight',
      query: text(options.query ?? options.userInput, 2000),
      audience: text(options.audience, 40) || 'planner',
      branchId: character.branchId,
      nodeId: character.nodeId,
      domains: Object.freeze({ character, dialogue, world }),
      items: Object.freeze(items),
      sources: Object.freeze(sources),
      durationMs: Math.max(0, this.now() - startedAt),
      cache: Object.freeze(this.getCacheStats())
    });
  }

  async searchContext(options = {}) {
    const domain = AGENT_CONTEXT_DOMAINS.includes(options.domain) ? options.domain : 'all';
    if (domain === 'all') return this._searchAll(options);
    const state = options.state || this.pipeline?.getState?.() || {};
    const branchId = branchOf(state, options);
    const nodeId = nodeOf(state, options);
    const turn = Math.max(0, Number(options.turn ?? state?.['系统·回合数']) || 0);
    const audience = text(options.audience, 40) || 'planner';
    const npcName = text(options.npcName ?? options.npc, 80);
    const query = text(options.query ?? options.userInput, 2000);
    const limit = Math.min(40, Math.max(1, Number(options.limit) || 12));
    const cacheIdentity = { domain, query, audience, npcName, branchId, nodeId, turn, limit };
    const cacheKey = hash(cacheIdentity);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      this.stats.hits++;
      return Object.freeze({ ...cached.value, cache: Object.freeze({ hit: true, key: cacheKey }) });
    }
    if (cached) this.cache.delete(cacheKey);
    this.stats.misses++;
    this.stats.searches++;

    const context = { state, branchId, nodeId, turn, audience, npcName, query, limit };
    let raw;
    if (domain === 'character') raw = await this._searchCharacter(context);
    else if (domain === 'dialogue') raw = await this._searchDialogue(context);
    else if (domain === 'worldbook') raw = await this._searchWorldbook(context);
    else raw = await this._searchWorld(context);

    const value = this._result(domain, context, raw, cacheKey);
    this.cache.set(cacheKey, {
      value,
      expiresAt: this.now() + this.ttlMs,
      identity: cacheIdentity
    });
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  async _searchAll(options) {
    const results = await Promise.all(['character', 'dialogue', 'world', 'worldbook']
      .map(domain => this.searchContext({ ...options, domain })));
    const first = results[0];
    return Object.freeze({
      schema: AGENT_CONTEXT_SCHEMA,
      kind: 'search',
      domain: 'all',
      query: first.query,
      audience: first.audience,
      branchId: first.branchId,
      nodeId: first.nodeId,
      items: Object.freeze(results.flatMap(result => result.items)),
      sources: Object.freeze(results.flatMap(result => result.sources)),
      cache: Object.freeze(this.getCacheStats())
    });
  }

  _result(domain, context, raw, cacheKey) {
    const items = (Array.isArray(raw?.items) ? raw.items : [])
      .map(normalizeItem)
      .sort((left, right) => right.score - left.score)
      .slice(0, context.limit);
    return Object.freeze({
      schema: AGENT_CONTEXT_SCHEMA,
      kind: 'search',
      domain,
      query: context.query,
      audience: context.audience,
      branchId: context.branchId,
      nodeId: context.nodeId,
      turn: context.turn,
      items: Object.freeze(items),
      sources: Object.freeze((raw?.sources || []).map(item => Object.freeze(clone(item)))),
      cache: Object.freeze({ hit: false, key: cacheKey })
    });
  }

  async _timelineNodes(context) {
    let nodes = [];
    try { nodes = await this.timelineSystem?.getAllNodes?.() || []; } catch { nodes = []; }
    return nodes.filter(node => {
      if (!node || node.branch_id !== context.branchId) return false;
      const nodeTurn = Number(
        node.turn ?? node.turn_number ?? node.turn_count ?? node.state_snapshot?.['系统·回合数']
      ) || 0;
      return !context.turn || nodeTurn <= context.turn;
    }).sort((left, right) => (
      (Number(left.turn ?? left.turn_number ?? left.turn_count ?? left.state_snapshot?.['系统·回合数']) || 0)
      - (Number(right.turn ?? right.turn_number ?? right.turn_count ?? right.state_snapshot?.['系统·回合数']) || 0)
    ));
  }

  async _searchCharacter(context) {
    const queryTokens = tokens(context.query);
    const names = context.npcName ? [context.npcName] : [];
    const relationships = context.state?._relationships || {};
    const agentMemories = context.state?._agent_memories || {};
    const historyNames = context.npcName
      ? [context.npcName]
      : Object.keys(relationships).filter(name => context.query.includes(name));
    const items = [];
    const add = (name, data, kind, id) => {
      if (context.npcName && name !== context.npcName) return;
      const allowPrivate = context.audience === 'npc' && name === context.npcName;
      const safe = redact(data, { allowPrivate });
      const relevance = score(safe, queryTokens, [...names, name]);
      if (context.query && relevance <= 0 && name !== context.npcName) return;
      items.push({
        id: id || `character:${name}`,
        domain: 'character',
        score: relevance + (name === context.npcName ? 20 : 0),
        summary: `${name}: ${text(safe?.grand_summary || safe?.last_interaction || safe?.currentMood || '', 900)}`,
        data: safe,
        source: sourceRef(kind, id || name)
      });
    };
    for (const [name, relationship] of Object.entries(relationships)) {
      add(name, relationship, 'relationship-state', `relationship:${name}`);
    }
    for (const [name, memory] of Object.entries(agentMemories)) {
      add(name, memory, 'character-memory', `agent-memory:${name}`);
    }

    const memory = projectCorrectedMemory(context.state?._memory || {});
    for (const line of String(memory.npc_notes || '').split(/\r?\n/).filter(Boolean)) {
      const separator = line.indexOf(': ');
      const name = separator > 0 ? line.slice(0, separator) : '';
      if (!name || (context.npcName && name !== context.npcName)) continue;
      const relevance = score(line, queryTokens, [...names, name]);
      if (context.query && relevance <= 0 && name !== context.npcName) continue;
      items.push({
        id: `npc-note:${hash(line)}`,
        domain: 'character',
        score: relevance + 4,
        summary: text(line, 1000),
        data: { npc: name, note: text(line.slice(separator + 2), 900) },
        source: sourceRef('memory', `npc-note:${name}`)
      });
    }
    const nodes = await this._timelineNodes(context);
    for (const node of nodes.slice(-24)) {
      const visibleHistory = [node.player_input ? `玩家意图: ${node.player_input}` : '', nodeNarrative(node), projectNarrativeForMemory(node.memory_summary || node.summary)]
        .map(value => text(value, 2400)).filter(Boolean).join('\n');
      if (!visibleHistory || !historyNames
        .some(name => visibleHistory.includes(name))) continue;
      const relevance = score(visibleHistory, queryTokens, historyNames);
      items.push({
        id: `character-timeline:${node.id}`,
        domain: 'character',
        score: relevance + 2,
        summary: visibleHistory,
        data: {
          turn: Number(node.turn_number ?? node.turn ?? node.turn_count) || null,
          gameTime: node.game_time || node.timestamp_game || ''
        },
        source: sourceRef('timeline', node.id)
      });
    }
    return {
      items,
      sources: [
        sourceRef('state', context.nodeId || `turn:${context.turn}`),
        ...nodes.filter(node => items.some(item => item.id === `character-timeline:${node.id}`))
          .map(node => sourceRef('timeline', node.id))
      ]
    };
  }

  async _searchDialogue(context) {
    const queryTokens = tokens(context.query);
    const names = context.npcName ? [context.npcName] : [];
    const messages = [];
    const liveHistory = this.pipeline?.getHistory?.() || [];
    liveHistory.forEach((message, index) => messages.push({
      id: `chat:live:${index}`,
      role: message?.role,
      content: text(historyContent(message), 4000),
      turn: null,
      source: 'chat-history'
    }));
    if (!messages.length) {
      const nodes = await this._timelineNodes(context);
      for (const node of nodes) {
        const nodeMessages = node.chat_history_delta || node.chat_history || [];
        nodeMessages.forEach((message, index) => messages.push({
          id: `chat:${node.id}:${index}`,
          role: message?.role,
          content: text(historyContent(message), 4000),
          turn: Number(node.turn ?? node.turn_count ?? node.state_snapshot?.['系统·回合数']) || 0,
          source: `timeline:${node.id}`
        }));
      }
    }
    const items = messages.map((message, index) => ({
      id: message.id,
      domain: 'dialogue',
      score: score(message.content, queryTokens, names) + Math.max(0, messages.length - index) / 100,
      summary: message.content,
      data: { role: message.role, turn: message.turn },
      source: sourceRef(message.source.startsWith('timeline:') ? 'timeline' : 'chat-history', message.source)
    })).filter(item => !context.query || item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, context.limit);
    return {
      items,
      sources: [...new Set(messages.map(message => message.source))]
        .map(id => sourceRef(id.startsWith('timeline:') ? 'timeline' : 'chat-history', id))
    };
  }

  _evidenceView(context, audience = context.audience) {
    if (this.pipeline?.getTurnEvidenceView) {
      return this.pipeline.getTurnEvidenceView(audience, {
        state: context.state,
        userInput: context.query,
        npcName: context.npcName
      });
    }
    const packet = this.evidenceCompiler.compile({
      state: context.state,
      userInput: context.query,
      nodeId: context.nodeId,
      branchId: context.branchId
    });
    return this.evidenceCompiler.project(packet, {
      audience,
      npcName: context.npcName
    });
  }

  async _searchWorld(context) {
    const view = this._evidenceView(context);
    const queryTokens = tokens(context.query);
    const sections = [
      ['current-state', view.current_state],
      ['continuity', view.continuity_anchors],
      ['year-snapshot', view.year_snapshot],
      ['current-plot', view.current_plot],
      ['techniques', view.technique_definitions]
    ];
    const items = sections.filter(([, value]) => value != null).map(([kind, data]) => ({
      id: `world:${kind}:${context.nodeId || context.turn}`,
      domain: 'world',
      score: score(data, queryTokens, context.npcName ? [context.npcName] : []) + 1,
      summary: text(stableStringify(data), 1800),
      data: redact(data),
      source: sourceRef('turn-evidence', kind, { refs: clone(view.provenance || {}) })
    })).filter(item => !context.query || item.score > 1 || item.id.includes('current-state'));

    let memoryContext = '';
    try {
      memoryContext = projectNarrativeForMemory(this.memorySystem?.buildPromptContext?.(context.state?._memory, {
        userInput: context.query
      }) || '');
    } catch { memoryContext = ''; }
    if (memoryContext) items.push({
      id: `world:memory:${context.branchId}:${context.turn}`,
      domain: 'world',
      score: score(memoryContext, queryTokens) + 2,
      summary: text(memoryContext, 1800),
      data: null,
      source: sourceRef('memory', `branch:${context.branchId}`)
    });
    const nodes = await this._timelineNodes(context);
    for (const node of nodes.slice(-30)) {
      const summary = [node.player_input ? `玩家意图: ${node.player_input}` : '', nodeNarrative(node), projectNarrativeForMemory(node.memory_summary || node.summary)]
        .map(value => text(value, 2600)).filter(Boolean).join('\n');
      if (!summary) continue;
      const relevance = score(summary, queryTokens, context.npcName ? [context.npcName] : []);
      if (context.query && relevance <= 0 && node.id !== context.nodeId) continue;
      items.push({
        id: `world-timeline:${node.id}`,
        domain: 'world',
        score: relevance + (node.id === context.nodeId ? 8 : 0),
        summary,
        data: {
          turn: Number(node.turn_number ?? node.turn ?? node.turn_count) || null,
          gameTime: node.game_time || node.timestamp_game || '',
          location: node.location || node.state_snapshot?.['世界·地点'] || ''
        },
        source: sourceRef('timeline', node.id)
      });
    }
    return {
      items,
      sources: [
        sourceRef('turn-evidence', context.nodeId || `turn:${context.turn}`, {
          refs: clone(view.provenance || {})
        }),
        ...nodes.slice(-30).map(node => sourceRef('timeline', node.id))
      ]
    };
  }

  async _searchWorldbook(context) {
    const view = this._evidenceView(context);
    const queryTokens = tokens(context.query);
    const entries = Array.isArray(view.worldbook_entries) ? view.worldbook_entries : [];
    return {
      items: entries.map((entry, index) => ({
        id: `worldbook:${entry.id || hash(entry) || index}`,
        domain: 'worldbook',
        score: score(entry, queryTokens, context.npcName ? [context.npcName] : []) + 1,
        summary: text(entry.content || entry.summary || stableStringify(entry), 1800),
        data: redact(entry),
        source: sourceRef('worldbook', entry.id || entry.title || `entry:${index}`)
      })).filter(item => !context.query || item.score > 1),
      sources: entries.map((entry, index) => sourceRef(
        'worldbook',
        entry.id || entry.title || `entry:${index}`
      ))
    };
  }

  invalidate(criteria = null) {
    let removed = 0;
    for (const [key, entry] of this.cache) {
      const identity = entry.identity || {};
      const filters = criteria ? [
        ['branchId', criteria.branchId],
        ['nodeId', criteria.nodeId],
        ['turn', criteria.turn == null ? null : Number(criteria.turn)],
        ['domain', criteria.domain]
      ].filter(([, value]) => value != null) : [];
      const matches = !criteria || filters.every(([field, value]) => identity[field] === value);
      if (!matches) continue;
      this.cache.delete(key);
      removed++;
    }
    if (removed) this.stats.invalidations += removed;
    return removed;
  }

  getCacheStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      entries: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      searches: this.stats.searches,
      invalidations: this.stats.invalidations,
      hitRate: total ? Number((this.stats.hits / total).toFixed(3)) : 0
    };
  }
}

export const agentContextBroker = new AgentContextBroker();

export default agentContextBroker;
import { projectCorrectedMemory } from './memory-corrections.js';
