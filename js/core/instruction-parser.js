import {
  isKnownKey,
  coerceValue,
  resolveAlias,
  normalizeStructuredVariableUpdate,
  normalizeRelationshipInstruction
} from '../data/var-schema.js';
import {
  legacyReflectionBlock,
  extractNarrativeInstructions,
  sanitizeNarrativeDisplayText,
  sanitizeNarrativePartialText
} from './narrative-artifact.js';
import {
  extractImageContract as extractVisualImageContract,
  stripImageContracts as stripVisualImageContracts
} from './image-studio/contracts.js';
import { normalizeCombatState } from '../data/instruction-contract.js';

export class InstructionParser {
  parse(text) {
    if (!text) {
      return {
        variables: [],
        combat: null, combats: [],
        mission: null, missions: [],
        relationship: null, relationships: [],
        event: null, events: [],
        memory: null, memories: []
      };
    }
    // Validation and execution must agree about which tags are instructions.
    // Audits may quote tags as examples; those are never state changes.
    const blocks = extractNarrativeInstructions(text);
    const combats = this.extractCombatStates(text, blocks);
    const missions = this.extractMissionUpdates(text, blocks);
    const relationships = this.extractRelationshipChanges(text, blocks);
    const events = this.extractEventTriggers(text, blocks);
    const memories = this.extractMemoryUpdates(text, blocks);
    return {
      variables: this.extractVarUpdates(text, blocks),
      combat: combats[0] || null, combats,
      mission: missions[0] || null, missions,
      relationship: relationships[0] || null, relationships,
      event: events[0] || null, events,
      memory: memories[0] || null, memories
    };
  }

  extractVarUpdates(text, blocks = extractNarrativeInstructions(text)) {
    const updates = [];
    // Keep legacy <var> and structured <variable> in their original order.
    for (const block of blocks) {
      if (block.tag === 'var') {
        for (const line of block.content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/^(.+?)\s*([=+\-])\s*(.+)$/);
          if (!match) {
            console.warn('[InstructionParser] 无法解析变量行:', trimmed);
            continue;
          }
          this._pushParsedVariableUpdate(updates, { key: match[1].trim(), op: match[2], value: match[3].trim() });
        }
      } else if (block.tag === 'variable') {
        for (const json of this._extractJsonObjects(block.content) || [block.content]) {
          try {
            const data = JSON.parse(json);
            const batch = Array.isArray(data?.updates) ? data.updates : [data];
            for (const update of batch) this._pushParsedVariableUpdate(updates, update);
          } catch (error) {
            console.warn('[InstructionParser] 单个变量JSON解析错误:', error.message);
          }
        }
      }
    }
    return updates;
  }

  _pushParsedVariableUpdate(updates, raw) {
    if (!raw || typeof raw !== 'object') return;
    if (raw.key && raw.op && ['=', '+', '-'].includes(raw.op)) {
      const key = resolveAlias(raw.key);
      if (!isKnownKey(key)) {
        console.warn('[InstructionParser] 未知变量，跳过:', raw.key, '(resolved:', key, ')');
        return;
      }
      updates.push({ key, op: raw.op, value: coerceValue(key, raw.value) });
      return;
    }
    const normalized = normalizeStructuredVariableUpdate(raw);
    if (normalized?.key && ['=', '+', '-'].includes(normalized.op)) {
      const key = resolveAlias(normalized.key);
      if (!isKnownKey(key)) {
        console.warn('[InstructionParser] 未知变量，跳过:', normalized.key, '(resolved:', key, ')');
        return;
      }
      updates.push({
        key,
        op: normalized.op,
        value: coerceValue(key, normalized.value)
      });
      return;
    }
    if (normalized?.path && normalized?.op && ['set', 'add', 'sub', 'assign', 'push', 'remove'].includes(normalized.op)) {
      updates.push(normalized);
    }
  }

  extractCombatState(text) {
    return this.extractCombatStates(text)[0] || null;
  }

  extractCombatStates(text, blocks = extractNarrativeInstructions(text)) {
    const states = [];
    for (const block of blocks.filter(item => item.tag === 'combat')) {
      const match = block.attributes.match(/^state="([\w-]+)"$/i);
      if (!match) continue;
      try { states.push({ ...JSON.parse(block.content), state: normalizeCombatState(match[1]) }); }
      catch (error) { console.warn('[InstructionParser] 战斗解析错误:', error.message); }
    }
    return states;
  }

  extractMissionUpdate(text) { return this.extractMissionUpdates(text)[0] || null; }

  extractMissionUpdates(text, blocks) { return this.extractJsonTags(text, 'mission', '任务', blocks); }

  extractRelationshipChange(text) { return this.extractRelationshipChanges(text)[0] || null; }

  extractRelationshipChanges(text, blocks) {
    return this.extractJsonTags(text, 'relationship', '关系', blocks)
      .map(value => normalizeRelationshipInstruction(value))
      .filter(Boolean);
  }

  extractEventTrigger(text) { return this.extractEventTriggers(text)[0] || null; }

  extractEventTriggers(text, blocks) { return this.extractJsonTags(text, 'event', '事件', blocks); }

  extractMemoryUpdate(text) { return this.extractMemoryUpdates(text)[0] || null; }

  extractMemoryUpdates(text, blocks) { return this.extractJsonTags(text, 'memory', '记忆', blocks); }

  /**
   * 提取最终叙事模型附带的隐藏绘图契约。契约的完整校验由
   * image-studio 域负责；解析器只负责确保它不会进入正文或存档文本。
   */
  extractImageContract(text) {
    if (!text) return { contract: null, raw: null, error: null };
    const result = extractVisualImageContract(text);
    return { contract: result.contract, raw: result.rawContract, error: result.error };
  }

  stripImageContracts(text, { streaming = false } = {}) {
    return stripVisualImageContracts(text, { streaming });
  }

  extractJsonTags(text, tagName, label, blocks = extractNarrativeInstructions(text)) {
    const values = [];
    for (const block of blocks.filter(item => item.tag === tagName)) {
      const raw = block.content;
      // Try parsing as single JSON first
      try {
        values.push(JSON.parse(raw));
        continue;
      } catch { /* fall through to multi-object recovery */ }

      // Recovery: AI sometimes puts multiple JSON objects in one tag
      // or adds trailing text after the JSON
      const jsonObjects = this._extractJsonObjects(raw);
      if (jsonObjects) {
        for (const jsonStr of jsonObjects) {
          try {
            values.push(JSON.parse(jsonStr));
          } catch (e2) {
            console.warn(`[InstructionParser] ${label} 子对象解析错误:`, e2.message);
          }
        }
      } else {
        console.warn(`[InstructionParser] ${label} 解析错误: 无法从内容中提取JSON`);
      }
    }
    return values;
  }

  cleanupResponse(text) {
    if (!text) return '';
    return sanitizeNarrativeDisplayText(this.stripImageContracts(text))
      .trim();
  }

  extractThinkContent(text, preferredTags = []) {
    if (!text) return '';

    const extractFirst = tags => {
      const seen = new Set();
      for (const value of tags) {
        const tag = String(value || '').trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = String(text).match(new RegExp(
          `<\\s*${escaped}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${escaped}\\s*>`,
          'i'
        ));
        if (match) return { matched: true, content: match[1].trim() };
      }
      return { matched: false, content: '' };
    };

    const preferred = extractFirst(Array.isArray(preferredTags) ? preferredTags : []);
    if (preferred.matched) return preferred.content;

    const legacy = extractFirst([
      'think',
      'thinking',
      'reasoning',
      '思维链',
      'anthropic_thinking',
      'anthropic_think',
      'deepseek_thinking',
      'analysis'
    ]);
    if (legacy.matched) return legacy.content;

    return legacyReflectionBlock(text)?.content || '';
  }

  extractVarThinkContent(text) {
    if (!text) return '';
    const m = text.match(/<var(?:iable)?_thinking>([\s\S]*?)<\/var(?:iable)?_thinking>/i);
    return m ? m[1].trim() : '';
  }

  cleanupPartialResponse(text) {
    if (!text) return '';
    return sanitizeNarrativePartialText(this.stripImageContracts(text, { streaming: true }))
      .trim();
  }

  hasStatusQuery(text) {
    return text ? /<status_query\s*\/>/.test(text) : false;
  }

  _extractJsonObjects(str) {
    const results = [];
    let depth = 0, start = -1, inString = false, escaped = false;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && inString) { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (char === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          results.push(str.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return results.length ? results : null;
  }
}

export const instructionParser = new InstructionParser();
export default instructionParser;
