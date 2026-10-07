import {
  NARRATIVE_INSTRUCTION_TAGS,
  NARRATIVE_INTERNAL_TAGS,
  sanitizeNarrativeDisplayText
} from './narrative-artifact.js';
import { isNarrativeChoiceTag } from './narrative-memory.js';

const DEFAULT_MAX_INPUT_LENGTH = 1_500_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 2_500_000;
const DEFAULT_MAX_SCRIPTS = 256;
const DEFAULT_MAX_ACTIONS = 64;
const DEFAULT_MAX_ACTION_LENGTH = 1000;
// Deliberately limited to real HTML elements. Preset protocol wrappers such as
// <content>, <story_scene> and <options> must remain XML-like regex triggers.
const HTML_REPLACEMENT_PATTERN = /```\s*html\b|<!doctype\s+html|<html\b|<style\b|<script\b|<(?:a|abbr|address|article|aside|audio|b|blockquote|br|button|canvas|code|col|colgroup|data|datalist|dd|del|details|dialog|div|dl|dt|em|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|i|iframe|img|input|ins|kbd|label|legend|li|main|mark|meter|nav|ol|optgroup|option|output|p|picture|pre|progress|q|s|samp|section|select|slot|small|source|span|strong|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|tr|track|u|ul|video|wbr)\b/i;
const PROJECT_MACHINE_TAGS = Object.freeze([
  ...NARRATIVE_INSTRUCTION_TAGS,
  'var_thinking',
  'variable_thinking'
]);
const PROJECT_MACHINE_TAG_NAMES = new Set(PROJECT_MACHINE_TAGS.map(tag => String(tag).toLowerCase()));
const RAW_INTERNAL_TAG_NAMES = new Set(NARRATIVE_INTERNAL_TAGS.map(tag => String(tag).toLowerCase()));
const PRIVATE_PRESENTATION_TAG_PARTS = new Set([
  'think',
  'thinking',
  'thought',
  'thoughts',
  'reason',
  'reasoning',
  'analysis',
  'planning',
  'audit',
  'critic',
  'critique',
  'private',
  'secret',
  'secure',
  'hidden',
  'internal',
  'scratch',
  'scratchpad',
  'backstage',
  'deliberation',
  'driver'
]);
const PRIVATE_PRESENTATION_TAGS = new Set([
  'cot',
  'chain_of_thought',
  'review_note',
  'review_notes',
  'npc_intent',
  'npc_private',
  'npc_memory',
  'system_info',
  'tool',
  'tool_call',
  'function_call',
  '思维链',
  '思考',
  '推理'
]);
const PRIVATE_PRESENTATION_ATTRIBUTE_PATTERN = /\b(?:visibility|audience|scope|access)\s*=\s*(?:["']\s*)?(?:private|secret|hidden|internal|backstage)\b/i;
const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function finiteDepth(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= -1 ? number : null;
}

function parseRegexLiteral(value) {
  const source = String(value || '');
  if (!source.startsWith('/')) return null;
  const match = source.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
  if (!match) return null;
  return { source: match[1], flags: match[2] };
}

export function compilePresetRegex(value) {
  const text = String(value || '');
  if (!text) return null;
  const literal = parseRegexLiteral(text);
  const source = literal?.source ?? text;
  const flags = literal?.flags ?? '';
  if (!source) return null;
  return new RegExp(source, flags);
}

function channelEnabled(script, channel) {
  const markdownOnly = Boolean(script?.markdownOnly);
  const promptOnly = Boolean(script?.promptOnly);
  if (!markdownOnly && !promptOnly) return channel === 'source';
  if (channel === 'source') return false;
  return channel === 'display' ? markdownOnly : promptOnly;
}

function depthEnabled(script, depth) {
  const currentDepth = Number.isInteger(Number(depth)) && Number(depth) >= 0 ? Number(depth) : 0;
  const minDepth = finiteDepth(script?.minDepth);
  const maxDepth = finiteDepth(script?.maxDepth);
  if (minDepth !== null && minDepth >= -1 && currentDepth < minDepth) return false;
  if (maxDepth !== null && maxDepth >= 0 && currentDepth > maxDepth) return false;
  return true;
}

function placementEnabled(script, placement) {
  const placements = Array.isArray(script?.placement) ? script.placement : [script?.placement ?? 2];
  return placements.map(Number).includes(Number(placement));
}

function resolveRegexMacros(value, context = {}, escapeValues = false) {
  const playerName = String(context.playerName || context.user || '玩家');
  const charName = String(context.charName || context.char || playerName);
  const lastUserMessage = String(context.lastUserMessage || '');
  const replace = replacement => escapeValues ? escapeRegExp(replacement) : replacement;
  return String(value || '')
    .replace(/\{\{\s*user\s*\}\}/gi, () => replace(playerName))
    .replace(/\{\{\s*char(?:IfNotGroup)?\s*\}\}/gi, () => replace(charName))
    .replace(/\{\{\s*lastUserMessage\s*\}\}/gi, () => replace(lastUserMessage));
}

function replaceWithTavernGroups(text, regex, script, macroContext) {
  const template = String(script?.replaceString || '').replace(/\{\{match\}\}/gi, '$0');
  const trimStrings = Array.isArray(script?.trimStrings) ? script.trimStrings : [];
  return text.replace(regex, function () {
    const args = [...arguments];
    const expanded = template.replace(/\$(\d+)/g, (_, number) => {
      const captured = args[Number(number)];
      if (!captured) return '';
      let filtered = String(captured);
      for (const rawTrimString of trimStrings) {
        const trimString = resolveRegexMacros(rawTrimString, macroContext);
        if (trimString) filtered = filtered.split(trimString).join('');
      }
      return filtered;
    });
    return resolveRegexMacros(expanded, macroContext);
  });
}

function normalizePrivateTagName(value) {
  return String(value || '').toLowerCase().replace(/~+$/, '');
}

function isPrivatePresentationTag(name, attributes = '') {
  const normalized = normalizePrivateTagName(name);
  if (PRIVATE_PRESENTATION_ATTRIBUTE_PATTERN.test(attributes)) return true;
  if (PRIVATE_PRESENTATION_TAGS.has(normalized)) return true;
  return normalized
    .split(/[_.:\-]+/)
    .filter(Boolean)
    .some(part => PRIVATE_PRESENTATION_TAG_PARTS.has(part));
}

function isHiddenPresentationTag(name, attributes = '') {
  const normalized = normalizePrivateTagName(name);
  return PROJECT_MACHINE_TAG_NAMES.has(normalized)
    || isPrivatePresentationTag(normalized, attributes);
}

function createXmlishTagTokenPattern() {
  return /<!--[\s\S]*?(?:-->|$)|<\s*(\/?)\s*([A-Za-z_\u3400-\u9fff][\w.\-:\u3400-\u9fff]*~?)([^<>]*?)>/g;
}

/**
 * Build the only source that an imported display regex may inspect. Unknown
 * presentation wrappers are retained verbatim so presets can still trigger
 * on tags such as <content>, <story_scene> and <options>. Private, driver and
 * project-machine scopes are removed with their contents. An unclosed private
 * scope hides the remainder of the response.
 */
function stripProjectMachineBlocks(value, {
  stripRawHtmlInternals = false,
  preserveComments = false
} = {}) {
  const text = String(value || '');
  const pattern = createXmlishTagTokenPattern();
  const hiddenStack = [];
  let output = '';
  let cursor = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (hiddenStack.length === 0) output += text.slice(cursor, match.index);
    cursor = pattern.lastIndex;

    const token = match[0];
    if (token.startsWith('<!--')) {
      // Model comments are not a display channel. Dropping them also prevents
      // an imported regex from turning hidden comment text into visible HTML.
      // Izumi's dedicated adapter opts in only for its narrowly extracted
      // `Technical Footer` danmu segment; arbitrary response comments remain
      // private everywhere else.
      if (preserveComments && hiddenStack.length === 0) output += token;
      continue;
    }

    const closing = Boolean(match[1]);
    const tag = String(match[2] || '').toLowerCase();
    const attributes = String(match[3] || '');
    const selfClosing = !closing && (/\/\s*$/.test(attributes) || HTML_VOID_TAGS.has(tag));
    const hiddenTag = isHiddenPresentationTag(tag, attributes)
      || (stripRawHtmlInternals && RAW_INTERNAL_TAG_NAMES.has(normalizePrivateTagName(tag)));

    if (hiddenStack.length > 0) {
      if (!closing && !selfClosing) {
        hiddenStack.push({ tag, sensitive: hiddenTag });
      } else if (closing) {
        const top = hiddenStack.at(-1);
        if (top?.tag === tag) {
          hiddenStack.pop();
        } else {
          let openIndex = -1;
          for (let index = hiddenStack.length - 1; index >= 0; index--) {
            if (hiddenStack[index].tag === tag) {
              openIndex = index;
              break;
            }
          }
          const nestedSensitiveScope = openIndex >= 0
            && hiddenStack.slice(openIndex + 1).some(frame => frame.sensitive);
          if (openIndex >= 0 && !nestedSensitiveScope) hiddenStack.splice(openIndex);
        }
      }
      continue;
    }

    if (hiddenTag) {
      if (!closing && !selfClosing) hiddenStack.push({ tag, sensitive: true });
      continue;
    }
    output += token;
  }

  if (hiddenStack.length === 0) output += text.slice(cursor);
  return output;
}

function capText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function applyPresetRegexScripts(input, scripts, {
  channel = 'display',
  placement = 2,
  depth = 0,
  runOnEdit = false,
  macroContext = {},
  stripProjectMachines = channel === 'display',
  stripRawHtmlInternals = stripProjectMachines,
  preserveComments = false,
  maxInputLength = DEFAULT_MAX_INPUT_LENGTH,
  maxOutputLength = DEFAULT_MAX_OUTPUT_LENGTH,
  maxScripts = DEFAULT_MAX_SCRIPTS
} = {}) {
  const warnings = [];
  const appliedScripts = [];
  const scriptTrace = [];
  let text = capText(input, maxInputLength);
  if (stripProjectMachines) text = stripProjectMachineBlocks(text, {
    stripRawHtmlInternals,
    preserveComments
  });

  const candidates = (Array.isArray(scripts) ? scripts : []).slice(0, maxScripts);
  if (Array.isArray(scripts) && scripts.length > maxScripts) {
    warnings.push(`正则脚本超过 ${maxScripts} 条，已忽略其余脚本`);
  }

  let hasHtml = false;
  for (let index = 0; index < candidates.length; index++) {
    const script = candidates[index];
    const traceBase = {
      index,
      id: String(script?.id || script?.name || script?.scriptName || index),
      name: String(script?.name || script?.scriptName || `正则 ${index + 1}`),
      channel,
      placement: Number(placement),
      depth: Number(depth) || 0
    };
    const trace = (status, reason) => scriptTrace.push(Object.freeze({ ...traceBase, status, reason }));
    if (!script) {
      trace('skipped', 'invalid_script');
      continue;
    }
    if (script.enabled === false || script.disabled === true) {
      trace('skipped', 'disabled');
      continue;
    }
    if (!placementEnabled(script, placement)) {
      trace('skipped', 'placement');
      continue;
    }
    if (!channelEnabled(script, channel)) {
      trace('skipped', 'channel');
      continue;
    }
    if (!depthEnabled(script, depth)) {
      trace('skipped', 'depth');
      continue;
    }
    if (runOnEdit && script.runOnEdit === false) {
      trace('skipped', 'run_on_edit');
      continue;
    }

    const substitutionMode = Number(script.substituteRegex) || 0;
    const rawPattern = substitutionMode === 1
      ? resolveRegexMacros(script.findRegex, macroContext)
      : substitutionMode === 2
        ? resolveRegexMacros(script.findRegex, macroContext, true)
        : String(script.findRegex || '');
    if (!rawPattern) {
      trace('skipped', 'empty_pattern');
      continue;
    }

    let regex;
    try {
      regex = compilePresetRegex(rawPattern);
    } catch (error) {
      warnings.push(`${script.name || script.scriptName || `正则 ${index + 1}`}：${error.message}`);
      trace('error', 'compile_error');
      continue;
    }
    if (!regex) {
      trace('skipped', 'empty_pattern');
      continue;
    }

    regex.lastIndex = 0;
    let matched = false;
    try {
      matched = regex.test(text);
      regex.lastIndex = 0;
      if (!matched) {
        trace('skipped', 'no_match');
        continue;
      }
      const replacement = String(script.replaceString || '');
      text = replaceWithTavernGroups(text, regex, script, macroContext);
      if (stripProjectMachines) text = stripProjectMachineBlocks(text);
      if (text.length > maxOutputLength) {
        text = text.slice(0, maxOutputLength);
        warnings.push(`${script.name || script.scriptName || `正则 ${index + 1}`}：输出超过安全上限，已截断`);
      }
      appliedScripts.push(String(script.id || script.name || script.scriptName || index));
      if (HTML_REPLACEMENT_PATTERN.test(replacement)) hasHtml = true;
      trace('applied', 'matched');
    } catch (error) {
      warnings.push(`${script.name || script.scriptName || `正则 ${index + 1}`}：执行失败（${error.message}）`);
      trace('error', 'execution_error');
    }
  }

  return Object.freeze({
    text,
    appliedScripts: Object.freeze(appliedScripts),
    warnings: Object.freeze(warnings),
    scriptTrace: Object.freeze(scriptTrace),
    hasHtml
  });
}

function unwrapHtmlCodeFences(value) {
  return String(value || '').replace(/```\s*(?:html)?\s*\n?([\s\S]*?)```/gi, (full, body) => (
    HTML_REPLACEMENT_PATTERN.test(body)
      ? body
      : full
  ));
}

function removeDocumentShell(value) {
  return String(value || '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html(?:\s[^>]*)?>/gi, '')
    .replace(/<\/?head(?:\s[^>]*)?>/gi, '')
    .replace(/<\/?body(?:\s[^>]*)?>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:content-security-policy|refresh)[^>]*>/gi, '');
}

const STRUCTURED_MAIN_TAG_PRIORITY = Object.freeze([
  'story_scene', 'content', 'dream_body', 'narrative', 'story', 'response',
  'final_answer', 'final', '正文'
]);
const STRUCTURED_MAIN_TAGS = new Set(STRUCTURED_MAIN_TAG_PRIORITY);
const STRUCTURED_EXTRA_LABELS = Object.freeze({
  memory_log: '记忆记录',
  npc_log: '人物记录',
  status: '状态',
  affinity: '关系变化',
  wlog: '世界记录',
  parallel_line: '平行事件',
  selection: '行动选项',
  dream_summary: '剧情摘要',
  dream_discuss: '说书记录',
  current_event: '当前事件',
  progress: '进度',
  options: '行动选项',
  option: '行动选项',
  choices: '行动选项',
  inventory: '物品状态',
  quest_log: '任务记录',
  event_log: '事件记录',
  statusblock: '状态'
});
const STRUCTURED_STATUS_PARTS = new Set([
  'status', 'state', 'memory', 'log', 'affinity', 'relationship', 'progress',
  'option', 'options', 'choice', 'choices', 'selection', 'summary', 'event',
  'timeline', 'inventory', 'quest', 'selc', 'action', 'actions'
]);
const NON_PRESENTATION_TAG_PARTS = new Set([
  'format', 'protocol', 'schema', 'template', 'guideline', 'guidelines',
  'instruction', 'instructions', 'engine'
]);
function isActionWrapperTag(tag) {
  return isNarrativeChoiceTag(tag);
}

function isStructuredStatusTag(tag) {
  if (Object.prototype.hasOwnProperty.call(STRUCTURED_EXTRA_LABELS, tag)) return true;
  const parts = String(tag || '').split(/[_.:\-]+/).filter(Boolean);
  return isActionWrapperTag(tag)
    || (!parts.some(part => NON_PRESENTATION_TAG_PARTS.has(part))
      && parts.some(part => STRUCTURED_STATUS_PARTS.has(part)));
}

function statusLabel(tag) {
  if (Object.prototype.hasOwnProperty.call(STRUCTURED_EXTRA_LABELS, tag)) {
    return STRUCTURED_EXTRA_LABELS[tag];
  }
  if (isActionWrapperTag(tag)) return '行动选项';
  return String(tag || '').replace(/[_.:\-]+/g, ' ');
}

function collectStructuredBlocks(value) {
  const text = String(value || '');
  const pattern = createXmlishTagTokenPattern();
  const stack = [];
  const blocks = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match[0].startsWith('<!--')) continue;
    const closing = Boolean(match[1]);
    const tag = String(match[2] || '').toLowerCase();
    const attributes = String(match[3] || '');
    const selfClosing = !closing && (/\/\s*$/.test(attributes) || HTML_VOID_TAGS.has(tag));
    if (!closing) {
      if (!selfClosing) stack.push({ tag, start: match.index, contentStart: pattern.lastIndex });
      continue;
    }

    let openIndex = -1;
    for (let index = stack.length - 1; index >= 0; index--) {
      if (stack[index].tag === tag) {
        openIndex = index;
        break;
      }
    }
    if (openIndex < 0) continue;
    const open = stack[openIndex];
    stack.splice(openIndex);
    if (STRUCTURED_MAIN_TAGS.has(tag) || tag === 'htmlcontent' || isStructuredStatusTag(tag)) {
      blocks.push({
        tag,
        content: text.slice(open.contentStart, match.index),
        start: open.start
      });
    }
  }
  return blocks.sort((left, right) => left.start - right.start);
}

function splitActionCandidates(value) {
  const raw = String(value || '').replace(/<br\s*\/?>/gi, '\n');
  const nested = [];
  const nestedPattern = /<(option|li|button|a)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let match;
  while ((match = nestedPattern.exec(raw)) !== null) nested.push(match[2]);
  if (nested.length > 1) return nested;
  if (/[|｜]/.test(raw)) return raw.split(/[|｜]/);

  const labelled = raw.match(/>\s*(?:选项|行动)\s*(?:[一二三四五六七八九十百\dA-Za-z]+)?\s*[:：]/g) || [];
  if (labelled.length > 1) {
    return raw.split(/(?=>\s*(?:选项|行动)\s*(?:[一二三四五六七八九十百\dA-Za-z]+)?\s*[:：])/g);
  }
  return raw.split(/\r?\n/);
}

function normalizeActionText(value) {
  let raw = stripProjectMachineBlocks(value, { stripRawHtmlInternals: true });
  const font = raw.match(/<font\b[^>]*>([\s\S]*?)<\/font\s*>/i);
  if (font?.[1]) raw = font[1];
  let text = sanitizeNarrativeDisplayText(raw)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  text = text
    .replace(/^>\s*/, '')
    .replace(/^(?:选项|行动)\s*(?:[一二三四五六七八九十百\dA-Za-z]+)?\s*[:：.)、-]\s*/i, '')
    .replace(/^(?:\d+|[A-Za-z]|[一二三四五六七八九十百]+)\s*[.)、:：-]\s*/, '')
    .replace(/^[-*•·]\s*/, '')
    .replace(/^[【[][^】\]\n]{1,24}[】\]]\s*/, '')
    .trim();
  const markdownEmphasis = text.match(/^(?:\*\*|__)([\s\S]*?)(?:\*\*|__)$/);
  if (markdownEmphasis?.[1]) text = markdownEmphasis[1].trim();
  const placeholderBrackets = text.match(/^\[([^\]\n]+)\]$/);
  if (placeholderBrackets?.[1]) text = placeholderBrackets[1].trim();
  if (!text || /^(?:无|none|null)$/i.test(text)) return '';
  return text.slice(0, DEFAULT_MAX_ACTION_LENGTH);
}

function extractPresentationActions(safeResponse) {
  const actions = [];
  for (const block of collectStructuredBlocks(safeResponse)) {
    if (!isActionWrapperTag(block.tag)) continue;
    for (const candidate of splitActionCandidates(block.content)) {
      const action = normalizeActionText(candidate);
      if (!action || actions.includes(action)) continue;
      actions.push(action);
      if (actions.length >= DEFAULT_MAX_ACTIONS) return Object.freeze(actions);
    }
  }
  return Object.freeze(actions);
}

function structuredFallback(safeResponse, fallbackText) {
  const collected = collectStructuredBlocks(safeResponse);
  let mainText = '';
  for (const tag of STRUCTURED_MAIN_TAG_PRIORITY) {
    const candidates = collected
      .filter(block => block.tag === tag)
      .map(block => sanitizeNarrativeDisplayText(block.content))
      .filter(Boolean);
    if (candidates.length > 0) {
      mainText = candidates.join('\n\n');
      break;
    }
  }

  const presentationBlocks = collected
    .filter(block => block.tag === 'htmlcontent' || isStructuredStatusTag(block.tag))
    .map(block => {
      if (block.tag === 'htmlcontent') {
        const source = removeDocumentShell(unwrapHtmlCodeFences(block.content)).trim();
        if (!source) return null;
        return Object.freeze({
          kind: 'sandbox',
          tag: block.tag,
          source,
          fallbackText: sanitizeNarrativeDisplayText(block.content)
        });
      }
      const text = sanitizeNarrativeDisplayText(block.content);
      if (!text) return null;
      return Object.freeze({
        kind: 'status',
        tag: block.tag,
        label: statusLabel(block.tag),
        text
      });
    })
    .filter(Boolean);

  if (!mainText && presentationBlocks.length === 0) return null;
  return Object.freeze({
    text: mainText || String(fallbackText || ''),
    blocks: Object.freeze(presentationBlocks)
  });
}

function safeFallbackText(cleanResponse, safeResponse) {
  const clean = sanitizeNarrativeDisplayText(stripProjectMachineBlocks(cleanResponse, {
    stripRawHtmlInternals: true
  }));
  return clean || sanitizeNarrativeDisplayText(safeResponse);
}

function collectExactTagBlocks(value, tagName) {
  const text = String(value || '');
  const target = String(tagName || '').toLowerCase();
  const pattern = createXmlishTagTokenPattern();
  const stack = [];
  const blocks = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].startsWith('<!--')) continue;
    const closing = Boolean(match[1]);
    const tag = String(match[2] || '').toLowerCase();
    const attributes = String(match[3] || '');
    const selfClosing = !closing && (/\/\s*$/.test(attributes) || HTML_VOID_TAGS.has(tag));
    if (tag !== target || selfClosing) continue;
    if (!closing) {
      stack.push({
        start: match.index,
        contentStart: pattern.lastIndex,
        attributes: attributes.replace(/\/\s*$/, '').trim()
      });
      continue;
    }
    const opening = stack.pop();
    if (!opening) continue;
    blocks.push({
      tag: target,
      attributes: opening.attributes,
      start: opening.start,
      end: pattern.lastIndex,
      contentStart: opening.contentStart,
      contentEnd: match.index,
      raw: text.slice(opening.start, pattern.lastIndex),
      content: text.slice(opening.contentStart, match.index)
    });
  }
  return blocks.sort((left, right) => left.start - right.start);
}

function firstExactTagBlock(value, tagName) {
  return collectExactTagBlocks(value, tagName)[0] || null;
}

function removeLocalRanges(value, ranges) {
  const text = String(value || '');
  const normalized = ranges
    .filter(range => range && range.start >= 0 && range.end <= text.length && range.end > range.start)
    .sort((left, right) => left.start - right.start);
  let output = '';
  let cursor = 0;
  for (const range of normalized) {
    if (range.start < cursor) continue;
    output += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return output + text.slice(cursor);
}

function blockSource(raw, { keepWrapper = true } = {}) {
  const value = keepWrapper ? raw?.raw : raw?.content;
  return stripProjectMachineBlocks(String(value || ''), { stripRawHtmlInternals: true });
}

function segmentFromBlock(block, {
  role = 'status',
  label = '',
  tag = '',
  keepWrapper = true,
  source = null,
  fallback = null,
  start = null,
  prefix = '',
  preserveComments = false
} = {}) {
  if (!block && source == null) return null;
  const safeSource = source == null ? blockSource(block, { keepWrapper }) : String(source || '');
  const fallbackText = fallback == null
    ? sanitizeNarrativeDisplayText(blockSource(block, { keepWrapper: false }))
    : sanitizeNarrativeDisplayText(fallback);
  if (!safeSource.trim() && !fallbackText) return null;
  return {
    role,
    label,
    tag: block?.tag || String(tag || ''),
    start: start !== null && start !== undefined && Number.isFinite(Number(start))
      ? Number(start)
      : Number(block?.start || 0),
    source: safeSource,
    fallbackText,
    prefix: sanitizeNarrativeDisplayText(prefix).slice(0, 200),
    preserveComments: preserveComments === true
  };
}

function foxPresentationSegments(rawResponse) {
  return [
    segmentFromBlock(firstExactTagBlock(rawResponse, 'content'), { role: 'main' }),
    segmentFromBlock(firstExactTagBlock(rawResponse, 'fox_selc'), { role: 'actions', label: '行动选项' }),
    segmentFromBlock(firstExactTagBlock(rawResponse, 'fox_tip'), { role: 'status', label: '狐神留言' })
  ].filter(Boolean);
}

function izumiPresentationSegments(rawResponse) {
  const text = String(rawResponse || '');
  const planning = firstExactTagBlock(text, 'konatan_planning~');
  const currentEvent = firstExactTagBlock(text, 'current_event');
  const progress = firstExactTagBlock(text, 'progress');
  const tucao = firstExactTagBlock(text, 'tucao');
  const tail = [currentEvent, progress, tucao].filter(Boolean).sort((a, b) => a.start - b.start);
  const bodyStart = planning?.end || 0;
  const bodyEnd = tail[0]?.start ?? text.length;
  const body = stripProjectMachineBlocks(text.slice(bodyStart, bodyEnd), { stripRawHtmlInternals: true });
  const segments = [];
  if (sanitizeNarrativeDisplayText(body)) {
    segments.push(segmentFromBlock(null, {
      role: 'main',
      source: body,
      fallback: body,
      start: bodyStart
    }));
  }
  if (currentEvent || progress) {
    const start = Math.min(currentEvent?.start ?? Infinity, progress?.start ?? Infinity);
    const end = Math.max(currentEvent?.end ?? -1, progress?.end ?? -1);
    const source = stripProjectMachineBlocks(text.slice(start, end), { stripRawHtmlInternals: true });
    segments.push(segmentFromBlock(null, {
      role: 'status',
      label: '事件与进度',
      source,
      fallback: source,
      start
    }));
  }
  if (tucao) segments.push(segmentFromBlock(tucao, { role: 'status', label: '小此吐槽' }));
  const danmuPattern = /<!--\s*Technical\b[\s\S]*?<danmu\b[^>]*>([\s\S]*?)<\/danmu\s*>[\s\S]*?-->/gi;
  let danmuMatch;
  while ((danmuMatch = danmuPattern.exec(text)) !== null) {
    if (danmuMatch.index < bodyStart) continue;
    segments.push(segmentFromBlock(null, {
      role: 'status',
      label: '弹幕',
      tag: 'danmu',
      source: danmuMatch[0],
      fallback: danmuMatch[1],
      start: danmuMatch.index,
      preserveComments: true
    }));
  }
  for (const tag of ['options', 'konatan_options']) {
    for (const block of collectExactTagBlocks(text, tag)) {
      segments.push(segmentFromBlock(block, { role: 'actions', label: '行动选项' }));
    }
  }
  return segments.filter(Boolean).sort((a, b) => a.start - b.start);
}

function dreamPresentationSegments(rawResponse) {
  const text = String(rawResponse || '');
  const segments = [];
  const body = firstExactTagBlock(text, 'dream_body');
  const scene = firstExactTagBlock(text, 'dream_scene');
  if (scene) segments.push(segmentFromBlock(scene, { role: 'status', label: '场景' }));
  if (body) {
    const nested = [scene]
      .filter(block => block && block.start >= body.contentStart && block.end <= body.contentEnd)
      .map(block => ({
        start: block.start - body.contentStart,
        end: block.end - body.contentStart
      }));
    for (const tag of ['dream_option', 'dream_options', 'options']) {
      for (const option of collectExactTagBlocks(text, tag)) {
        if (option.start >= body.contentStart && option.end <= body.contentEnd) {
          nested.push({ start: option.start - body.contentStart, end: option.end - body.contentStart });
        }
      }
    }
    const bodyContent = removeLocalRanges(body.content, nested);
    const source = stripProjectMachineBlocks(`<dream_body>${bodyContent}</dream_body>`, {
      stripRawHtmlInternals: true
    });
    if (sanitizeNarrativeDisplayText(source)) {
      segments.push(segmentFromBlock(null, {
        role: 'main',
        source,
        fallback: bodyContent,
        start: scene?.end || body.contentStart
      }));
    }
  }
  for (const parallel of collectExactTagBlocks(text, 'dream_parallel_event')) {
    segments.push(segmentFromBlock(parallel, { role: 'status', label: '平行事件' }));
  }
  for (const tag of ['dream_option', 'dream_options', 'options']) {
    for (const option of collectExactTagBlocks(text, tag)) {
      segments.push(segmentFromBlock(option, { role: 'actions', label: '行动选项' }));
    }
  }
  const extraLabels = {
    dream_summary: '剧情摘要',
    dream_discuss: '思客说书',
    dream_answer: '思客回答',
    dream_big_discuss: '思客大调查'
  };
  for (const [tag, label] of Object.entries(extraLabels)) {
    for (const block of collectExactTagBlocks(text, tag)) {
      segments.push(segmentFromBlock(block, { role: 'status', label }));
    }
  }
  const seen = new Set();
  return segments
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .filter(segment => {
      const key = `${segment.start}:${segment.tag}:${segment.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function miemiePresentationSegments(rawResponse) {
  const text = String(rawResponse || '');
  const segments = [];
  const scene = firstExactTagBlock(text, 'story_scene');
  if (scene) {
    const hidden = [
      ...collectExactTagBlocks(text, 'parallel_line_drive'),
      ...collectExactTagBlocks(text, 'parallel_line')
    ].filter(block => block.start >= scene.contentStart && block.end <= scene.contentEnd)
      .map(block => ({ start: block.start - scene.contentStart, end: block.end - scene.contentStart }));
    const mainContent = removeLocalRanges(scene.content, hidden);
    if (sanitizeNarrativeDisplayText(mainContent)) {
      segments.push(segmentFromBlock(null, {
        role: 'main',
        source: `<story_scene>${mainContent}</story_scene>`,
        fallback: mainContent,
        start: scene.contentStart
      }));
    }
  }
  const labels = {
    parallel_line: '平行事件',
    memory_log: '记忆记录',
    wlog: '世界记录',
    status: '状态',
    affinity: '关系变化',
    htmlcontent: ''
  };
  for (const [tag, label] of Object.entries(labels)) {
    for (const block of collectExactTagBlocks(text, tag)) {
      const time = tag === 'wlog'
        ? String(block.attributes.match(/\btime\s*=\s*(["'])(.*?)\1/iu)?.[2] || '').trim().slice(0, 200)
        : '';
      segments.push(segmentFromBlock(block, {
        role: tag === 'htmlcontent' ? 'sandbox' : 'status',
        label,
        source: tag === 'htmlcontent'
          ? stripProjectMachineBlocks(block.content, { stripRawHtmlInternals: false })
          : null,
        fallback: block.content,
        prefix: time
      }));
    }
  }
  return segments.filter(Boolean).sort((a, b) => a.start - b.start);
}

function escapePresentationHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function classOpeningPattern(className, flags = 'i') {
  const escaped = escapeRegExp(className);
  return new RegExp(
    `<([A-Za-z][\\w:-]*)\\b(?=[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'])[^>]*>`,
    flags
  );
}

function findClassOpening(value, className, occurrence = 0) {
  const source = String(value || '');
  const pattern = classOpeningPattern(className, 'gi');
  let match;
  let index = 0;
  while ((match = pattern.exec(source)) !== null) {
    if (index === occurrence) return { match, pattern };
    index++;
  }
  return null;
}

function replaceClassElementContent(value, className, content, occurrence = 0) {
  const source = String(value || '');
  const found = findClassOpening(source, className, occurrence);
  if (!found) return source;
  const opening = found.match[0];
  const tag = found.match[1];
  const contentStart = found.match.index + opening.length;
  const closingMatch = new RegExp(`<\\/${escapeRegExp(tag)}\\s*>`, 'i').exec(source.slice(contentStart));
  if (!closingMatch) return source;
  const contentEnd = contentStart + closingMatch.index;
  return source.slice(0, contentStart) + String(content || '') + source.slice(contentEnd);
}

function removeClassElement(value, className) {
  const source = String(value || '');
  const found = findClassOpening(source, className);
  if (!found) return source;
  const opening = found.match[0];
  const tag = found.match[1];
  const contentStart = found.match.index + opening.length;
  const closingMatch = new RegExp(`<\\/${escapeRegExp(tag)}\\s*>`, 'i').exec(source.slice(contentStart));
  if (!closingMatch) return source;
  const end = contentStart + closingMatch.index + closingMatch[0].length;
  return source.slice(0, found.match.index) + source.slice(end);
}

function addClassToElement(value, className, extraClass) {
  const source = String(value || '');
  const found = findClassOpening(source, className);
  if (!found) return source;
  const opening = found.match[0].replace(
    /\bclass\s*=\s*(["'])([^"']*)\1/i,
    (full, quote, classes) => {
      const values = String(classes || '').split(/\s+/).filter(Boolean);
      if (!values.includes(extraClass)) values.push(extraClass);
      return `class=${quote}${values.join(' ')}${quote}`;
    }
  );
  return source.slice(0, found.match.index) + opening + source.slice(found.match.index + found.match[0].length);
}

function unhideClassElement(value, className) {
  const source = String(value || '');
  const found = findClassOpening(source, className);
  if (!found) return source;
  const opening = found.match[0].replace(/\s+hidden(?:\s*=\s*(?:["'][^"']*["']|[^\s>]+))?/i, '');
  return source.slice(0, found.match.index) + opening + source.slice(found.match.index + found.match[0].length);
}

function appendCompatibilityStyle(value, cssText) {
  return `${String(value || '')}\n<style data-naruto-preset-static-adapter>${String(cssText || '')}</style>`;
}

function attributeText(attributes, name) {
  const escaped = escapeRegExp(name);
  const match = String(attributes || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return sanitizeNarrativeDisplayText(match?.[2] || '').slice(0, 1000);
}

function normalizedActionCandidates(value) {
  const actions = [];
  for (const candidate of splitActionCandidates(value)) {
    const action = normalizeActionText(candidate);
    if (action && !actions.includes(action)) actions.push(action);
  }
  return actions;
}

function actionCandidatesFromBlockSource(source, tagNames, fallbackText = '') {
  for (const tag of tagNames) {
    const block = firstExactTagBlock(source, tag);
    if (!block) continue;
    const actions = normalizedActionCandidates(block.content);
    if (actions.length) return actions;
  }
  return normalizedActionCandidates(fallbackText);
}

function foxStaticActionSource(source, segmentSource) {
  if (!/\brim-collapsible\b/i.test(source) || !/\bactionsContainer\b/i.test(source)) return null;
  const foxBlock = firstExactTagBlock(segmentSource, 'fox_selc');
  if (!foxBlock) return null;
  const rows = [];
  let lastGroup = '';
  for (const line of String(foxBlock.content || '').split(/\r?\n/)) {
    const raw = String(line || '').trim();
    if (!raw) continue;
    const groupMatch = raw.match(/^\s*[【[]([^】\]]{1,40})[】\]]\s*/u);
    const group = sanitizeNarrativeDisplayText(groupMatch?.[1] || '').slice(0, 80);
    const action = normalizeActionText(raw);
    if (!action) continue;
    const display = sanitizeNarrativeDisplayText(raw.replace(/^\s*[【[][^】\]]{1,40}[】\]]\s*/u, '')) || action;
    if (group && group !== lastGroup) {
      rows.push(`<div class="fox-group-title">${escapePresentationHtml(group)}</div>`);
      lastGroup = group;
    }
    rows.push(`<button type="button" class="action-card" data-option-text="${escapePresentationHtml(action)}">${escapePresentationHtml(display)}</button>`);
  }
  if (!rows.length) return null;
  let output = replaceClassElementContent(source, 'rim-content-inner', rows.join('\n'));
  output = addClassToElement(output, 'rim-collapsible', 'expanded');
  output = output.replace(/aria-expanded\s*=\s*(["'])false\1/i, 'aria-expanded="true"');
  output = appendCompatibilityStyle(output, `
    .rim-content { max-height: none !important; overflow: visible !important; }
    .fox-tip-area:empty, .mode-toggle-btn, .append-toggle-btn, .theme-toggle-btn,
    .rim-footer-toggle, .status-feedback { display: none !important; }
    .rim-content-inner { display: grid !important; }
    .action-card { width: 100%; font: inherit; text-align: inherit; cursor: pointer; }
  `);
  return output;
}

function izumiStaticOptionsSource(source, segmentSource, fallbackText) {
  if (!/\boption-panel-container\b/i.test(source) || !/\boption-list\b/i.test(source)) return null;
  const actions = actionCandidatesFromBlockSource(segmentSource, ['options', 'konatan_options'], fallbackText);
  if (!actions.length) return null;
  const icons = ['🧐', '🚀', '💬', '😈'];
  const rows = actions.map((action, index) => `
    <li class="option-item">
      <button type="button" class="option-link" data-option-text="${escapePresentationHtml(action)}">
        <span class="option-icon">${icons[index % icons.length]}</span>
        <span>${escapePresentationHtml(action)}</span>
      </button>
    </li>`).join('');
  return appendCompatibilityStyle(
    replaceClassElementContent(source, 'option-list', rows),
    '.option-link { width: 100%; border: 0; background: transparent; font: inherit; text-align: left; }'
  );
}

function izumiStaticDanmuSource(source, fallbackText) {
  if (!/\bdanmaku-super-container-rgb\b/i.test(source)) return null;
  const rows = String(fallbackText || '')
    .split(/\r?\n|[|｜]/)
    .map(row => sanitizeNarrativeDisplayText(row))
    .filter(Boolean)
    .slice(0, 24);
  if (!rows.length) return null;
  const items = rows
    .map(row => `<span class="danmaku-content-multicolor-rgb">${escapePresentationHtml(row)}</span>`)
    .join('\n');
  let output = replaceClassElementContent(source, 'danmaku-super-container-rgb', items);
  const dataSource = findClassOpening(output, 'danmaku-data-source');
  if (dataSource) output = removeClassElement(output, 'danmaku-data-source');
  output = output.replace(/<div\b[^>]*\bid\s*=\s*(["'])danmaku-data-source\1[^>]*>[\s\S]*?<\/div\s*>/i, '');
  return appendCompatibilityStyle(output, `
    .danmaku-super-container-rgb {
      height: auto !important; min-height: 0 !important; display: flex !important;
      flex-wrap: wrap !important; gap: .45rem .7rem !important; padding: .65rem !important;
      overflow: visible !important;
    }
    .danmaku-content-multicolor-rgb {
      position: static !important; display: inline-block !important; width: auto !important;
      animation: none !important; transform: none !important; white-space: normal !important;
    }
  `);
}

function dreamSceneStaticSource(source, segmentSource) {
  if (!/\bdream-scene-bar\b/i.test(source)) return null;
  const values = ['date', 'time', 'location'].map(tag => (
    sanitizeNarrativeDisplayText(firstExactTagBlock(segmentSource, tag)?.content || '')
  ));
  let output = source;
  values.forEach((value, index) => {
    output = replaceClassElementContent(output, 'dream-scene-bar__value', escapePresentationHtml(value || '未注明'), index);
  });
  return output;
}

function dreamParallelEvents(segmentSource) {
  const block = firstExactTagBlock(segmentSource, 'dream_parallel_event');
  if (!block) return [];
  const marker = '\uE000';
  const lines = String(block.content || '')
    .replace(/<br\s*\/?>/gi, marker)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const events = [];
  for (const line of lines) {
    const separator = line.search(/[|｜]/);
    if (separator < 0) {
      const continuation = sanitizeNarrativeDisplayText(line.replaceAll(marker, '\n'));
      if (!continuation) continue;
      if (events.length) events.at(-1).description += `\n${continuation}`;
      else events.push({ location: '地点未标注', description: continuation });
      continue;
    }
    const location = sanitizeNarrativeDisplayText(line.slice(0, separator)) || '地点未标注';
    const description = sanitizeNarrativeDisplayText(line.slice(separator + 1).replaceAll(marker, '\n'));
    if (description) events.push({ location, description });
  }
  return events;
}

function dreamStaticParallelSource(source, segmentSource) {
  if (!/\bdream-paraller-event-ui\b/i.test(source)) return null;
  const events = dreamParallelEvents(segmentSource);
  if (!events.length) return null;
  const rows = events.map((event, index) => {
    const parts = String(event.description || '').split('\n').filter(Boolean);
    return `<article class="dream-paraller-event-ui__event">
      <div class="dream-paraller-event-ui__event-heading">
        <span class="dream-paraller-event-ui__event-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="dream-paraller-event-ui__location">${escapePresentationHtml(event.location)}</span>
      </div>
      <p class="dream-paraller-event-ui__description">${parts.map(part => `<span class="dream-paraller-event-ui__description-part">${escapePresentationHtml(part)}</span>`).join('')}</p>
    </article>`;
  }).join('\n');
  let output = replaceClassElementContent(source, 'dream-paraller-event-ui__events', rows);
  output = replaceClassElementContent(output, 'dream-paraller-event-ui__meta', `${events.length} 则`);
  output = removeClassElement(output, 'dream-paraller-event-ui__source');
  return output;
}

function dreamStaticOptionSource(source, segmentSource, fallbackText) {
  if (!/\bdream-option-ui\b/i.test(source) || !/\bdream-option-ui__list\b/i.test(source)) return null;
  const actions = actionCandidatesFromBlockSource(
    segmentSource,
    ['dream_option', 'dream_options', 'options'],
    fallbackText
  );
  if (!actions.length) return null;
  const rows = actions.map((action, index) => `<button type="button" class="dream-option-ui__option" role="listitem" data-option-text="${escapePresentationHtml(action)}">
    <span class="dream-option-ui__option-index">${index + 1}</span>
    <span class="dream-option-ui__option-text">${escapePresentationHtml(action)}</span>
  </button>`).join('\n');
  let output = replaceClassElementContent(source, 'dream-option-ui__list', rows);
  output = replaceClassElementContent(output, 'dream-option-ui__count', `${actions.length} 项`);
  output = removeClassElement(output, 'dream-option-ui__source');
  output = appendCompatibilityStyle(output, `
    .dream-option-ui__settings-toggle, .dream-option-ui__settings { display: none !important; }
  `);
  return output;
}

function dreamAnswerAction(question, answer = '') {
  const escapedQuestion = String(question || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<dream_answer q="${escapedQuestion}">\n${String(answer || '').trim()}\n</dream_answer>`;
}

function dreamStaticDiscussSource(source, segmentSource) {
  if (!/\bdream-big-discuss-ui\b/i.test(source) || !/\bdream-big-discuss-ui__grid\b/i.test(source)) return null;
  const block = firstExactTagBlock(segmentSource, 'dream_big_discuss');
  if (!block) return null;
  const questions = collectExactTagBlocks(block.content, 'q').map((questionBlock, index) => {
    const question = attributeText(questionBlock.attributes, 'content') || `问题 ${index + 1}`;
    const answers = collectExactTagBlocks(questionBlock.content, 'a')
      .map(answer => sanitizeNarrativeDisplayText(answer.content))
      .filter(Boolean);
    return { ...questionBlock, question, answers };
  });
  const note = sanitizeNarrativeDisplayText(removeLocalRanges(block.content, questions));
  if (!questions.length && !note) return null;
  const cards = questions.map(({ question, answers }) => `<section class="dream-big-discuss-ui__card">
    <button type="button" class="dream-big-discuss-ui__question" data-action="${escapePresentationHtml(dreamAnswerAction(question))}">${escapePresentationHtml(question)}</button>
    <div class="dream-big-discuss-ui__answers">${answers.map((answer, index) => `<button type="button" class="dream-big-discuss-ui__answer" data-action="${escapePresentationHtml(dreamAnswerAction(question, answer))}">
      <span class="dream-big-discuss-ui__answer-index">${index + 1}</span>
      <span class="dream-big-discuss-ui__answer-text">${escapePresentationHtml(answer)}</span>
    </button>`).join('')}</div>
  </section>`).join('\n');
  let output = replaceClassElementContent(source, 'dream-big-discuss-ui__grid', cards);
  output = replaceClassElementContent(output, 'dream-big-discuss-ui__summary-meta', `${questions.length} 问`);
  if (note) {
    output = replaceClassElementContent(output, 'dream-big-discuss-ui__note', escapePresentationHtml(note));
    output = unhideClassElement(output, 'dream-big-discuss-ui__note');
  }
  output = removeClassElement(output, 'dream-big-discuss-ui__source');
  return output;
}

function adaptDedicatedSandboxSource(adapterId, segment, source) {
  const id = String(adapterId || '');
  if (id === 'fox-v18' && segment.role === 'actions') {
    if (!/\brim-collapsible\b/i.test(source)) return { source };
    const hydrated = foxStaticActionSource(source, segment.source);
    return hydrated ? { source: hydrated } : { fallback: true };
  }
  if (id === 'izumi-0707') {
    if (segment.tag === 'danmu') {
      if (!/\bdanmaku-super-container-rgb\b/i.test(source)) return { source };
      const hydrated = izumiStaticDanmuSource(source, segment.fallbackText);
      return hydrated ? { source: hydrated } : { omit: !segment.fallbackText };
    }
    if (segment.role === 'actions') {
      if (!/\boption-panel-container\b/i.test(source)) return { source };
      const hydrated = izumiStaticOptionsSource(source, segment.source, segment.fallbackText);
      return hydrated ? { source: hydrated } : { fallback: true };
    }
  }
  if (id === 'dream-whale-v4') {
    if (segment.tag === 'dream_scene') {
      if (!/\bdream-scene-bar\b/i.test(source)) return { source };
      const hydrated = dreamSceneStaticSource(source, segment.source);
      return hydrated ? { source: hydrated } : { fallback: true };
    }
    if (segment.tag === 'dream_parallel_event') {
      if (!/\bdream-paraller-event-ui\b/i.test(source)) {
        return segment.fallbackText ? { source } : { omit: true };
      }
      const hydrated = dreamStaticParallelSource(source, segment.source);
      return hydrated ? { source: hydrated } : { omit: true };
    }
    if (['dream_option', 'dream_options', 'options'].includes(segment.tag)) {
      if (!/\bdream-option-ui\b/i.test(source)) return { source };
      const hydrated = dreamStaticOptionSource(source, segment.source, segment.fallbackText);
      return hydrated ? { source: hydrated } : { fallback: true };
    }
    if (segment.tag === 'dream_big_discuss') {
      if (!/\bdream-big-discuss-ui\b/i.test(source)) {
        return segment.fallbackText ? { source } : { omit: true };
      }
      const hydrated = dreamStaticDiscussSource(source, segment.source);
      return hydrated ? { source: hydrated } : { omit: true };
    }
  }
  return { source };
}

function sandboxSourceHasVisibleContent(value) {
  const source = String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '')
    .replace(/<\/?(?:meta|link|base)\b[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  if (/<(?:img|svg|canvas|video|audio|hr)\b/i.test(source)) return true;
  return Boolean(sanitizeNarrativeDisplayText(source));
}

function dedicatedPresentationSegments(rawResponse, adapterId) {
  switch (String(adapterId || '')) {
    case 'fox-v18': return foxPresentationSegments(rawResponse);
    case 'izumi-0707': return izumiPresentationSegments(rawResponse);
    case 'dream-whale-v4': return dreamPresentationSegments(rawResponse);
    case 'miemie-v5': return miemiePresentationSegments(rawResponse);
    default: return [];
  }
}

function buildDedicatedPresetPresentation(rawResponse, cleanResponse, scripts, options) {
  const segments = dedicatedPresentationSegments(rawResponse, options.adapterId);
  if (!segments.length) return null;
  const blocks = [];
  const appliedScripts = [];
  const warnings = [];
  const scriptTrace = [];
  for (const segment of segments) {
    const sourceResult = applyPresetRegexScripts(segment.source, scripts, {
      ...options,
      channel: 'source',
      placement: 2,
      stripProjectMachines: true,
      stripRawHtmlInternals: false,
      preserveComments: segment.preserveComments
    });
    const displayResult = applyPresetRegexScripts(sourceResult.text, scripts, {
      ...options,
      channel: 'display',
      placement: 2,
      stripProjectMachines: true,
      stripRawHtmlInternals: false,
      preserveComments: segment.preserveComments
    });
    appliedScripts.push(...sourceResult.appliedScripts, ...displayResult.appliedScripts);
    warnings.push(...sourceResult.warnings, ...displayResult.warnings);
    scriptTrace.push(...sourceResult.scriptTrace, ...displayResult.scriptTrace);
    const displayText = stripProjectMachineBlocks(displayResult.text);
    const hasHtml = segment.role === 'sandbox' || sourceResult.hasHtml || displayResult.hasHtml;
    const appliedTrace = [...sourceResult.scriptTrace, ...displayResult.scriptTrace]
      .filter(trace => trace.status === 'applied');
    const explicitlyHidden = appliedTrace.some(trace => (
      String(scripts?.[trace.index]?.replaceString || '').trim() === ''
    ));
    if (hasHtml) {
      let source = removeDocumentShell(unwrapHtmlCodeFences(displayText)).trim();
      const adapted = adaptDedicatedSandboxSource(options.adapterId, segment, source);
      if (adapted.omit) continue;
      if (adapted.source !== undefined) source = String(adapted.source || '').trim();
      if (!adapted.fallback && source && sandboxSourceHasVisibleContent(source)) {
        blocks.push(Object.freeze({
          kind: 'sandbox',
          tag: segment.tag,
          label: segment.label,
          source,
          fallbackText: segment.fallbackText
        }));
        continue;
      }
      if (explicitlyHidden) continue;
      const fallbackText = segment.fallbackText;
      if (!fallbackText) continue;
      blocks.push(Object.freeze({
        kind: segment.role === 'main' ? 'markdown' : 'status',
        tag: segment.tag,
        label: segment.label,
        text: segment.prefix ? `${segment.prefix}\n${fallbackText}` : fallbackText
      }));
      continue;
    }
    let text = sanitizeNarrativeDisplayText(displayText);
    if (!text && !appliedTrace.length) text = segment.fallbackText;
    if (!text && explicitlyHidden) continue;
    if (!text) text = segment.fallbackText;
    if (segment.prefix && text) text = `${segment.prefix}\n${text}`;
    if (!text) continue;
    blocks.push(Object.freeze({
      kind: segment.role === 'main' ? 'markdown' : 'status',
      tag: segment.tag,
      label: segment.label,
      text
    }));
  }
  if (!blocks.length) return null;
  const safeWhole = stripProjectMachineBlocks(rawResponse, { stripRawHtmlInternals: true });
  return Object.freeze({
    kind: 'structured',
    adapterId: options.adapterId,
    text: '',
    blocks: Object.freeze(blocks),
    actions: extractPresentationActions(safeWhole),
    appliedScripts: Object.freeze(appliedScripts),
    warnings: Object.freeze(warnings),
    scriptTrace: Object.freeze(scriptTrace),
    fallbackText: safeFallbackText(cleanResponse, safeWhole)
  });
}

export function buildPresetPresentation(rawResponse, cleanResponse, scripts, options = {}) {
  const configuredInputLimit = Number(options.maxInputLength);
  const inputLimit = Number.isFinite(configuredInputLimit) && configuredInputLimit >= 0
    ? configuredInputLimit
    : DEFAULT_MAX_INPUT_LENGTH;
  const safeResponse = stripProjectMachineBlocks(capText(rawResponse, inputLimit), {
    stripRawHtmlInternals: true
  });
  const fallbackText = safeFallbackText(capText(cleanResponse, inputLimit), safeResponse);
  if (options.adapterId) {
    const dedicated = buildDedicatedPresetPresentation(
      capText(rawResponse, inputLimit),
      capText(cleanResponse, inputLimit),
      scripts,
      options
    );
    if (dedicated) return dedicated;
  }
  const actions = extractPresentationActions(safeResponse);
  const sourceResult = applyPresetRegexScripts(safeResponse, scripts, {
    ...options,
    channel: 'source',
    placement: 2,
    stripProjectMachines: true,
    stripRawHtmlInternals: false
  });
  const displayResult = applyPresetRegexScripts(sourceResult.text, scripts, {
    ...options,
    channel: 'display',
    placement: 2,
    stripProjectMachines: true,
    stripRawHtmlInternals: false
  });
  const appliedScripts = Object.freeze([...sourceResult.appliedScripts, ...displayResult.appliedScripts]);
  const warnings = Object.freeze([...sourceResult.warnings, ...displayResult.warnings]);
  const scriptTrace = Object.freeze([...sourceResult.scriptTrace, ...displayResult.scriptTrace]);
  const safeDisplayText = stripProjectMachineBlocks(displayResult.text);
  if (appliedScripts.length === 0) {
    const structured = structuredFallback(safeDisplayText, fallbackText);
    if (structured) {
      return Object.freeze({
        kind: 'structured',
        text: structured.text,
        blocks: structured.blocks,
        actions,
        appliedScripts,
        warnings,
        scriptTrace
      });
    }
    return Object.freeze({
      kind: 'markdown',
      text: fallbackText,
      fallbackText,
      actions,
      appliedScripts,
      warnings,
      scriptTrace
    });
  }

  if (sourceResult.hasHtml || displayResult.hasHtml) {
    return Object.freeze({
      kind: 'sandbox',
      source: removeDocumentShell(unwrapHtmlCodeFences(safeDisplayText)),
      fallbackText,
      actions,
      appliedScripts,
      warnings,
      scriptTrace
    });
  }

  return Object.freeze({
    kind: 'markdown',
    // A matched display script can erase the body or wrap it in tags removed
    // by sanitization. Finalizing that presentation must retain safe prose.
    text: sanitizeNarrativeDisplayText(safeDisplayText) || fallbackText,
    fallbackText,
    actions,
    appliedScripts,
    warnings,
    scriptTrace
  });
}

export function applyPresetPromptRegex(input, scripts, options = {}) {
  const sourceResult = applyPresetRegexScripts(input, scripts, {
    ...options,
    channel: 'source',
    stripProjectMachines: false
  });
  const promptResult = applyPresetRegexScripts(sourceResult.text, scripts, {
    ...options,
    channel: 'prompt',
    stripProjectMachines: false
  });
  return Object.freeze({
    text: promptResult.text,
    appliedScripts: Object.freeze([...sourceResult.appliedScripts, ...promptResult.appliedScripts]),
    warnings: Object.freeze([...sourceResult.warnings, ...promptResult.warnings]),
    scriptTrace: Object.freeze([...sourceResult.scriptTrace, ...promptResult.scriptTrace]),
    hasHtml: sourceResult.hasHtml || promptResult.hasHtml
  });
}
