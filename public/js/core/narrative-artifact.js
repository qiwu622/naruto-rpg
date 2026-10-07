/**
 * A NarrativeArtifact is the only supported boundary between a model response
 * and the visible/persisted story.  It deliberately does not retain the raw
 * response: display text, machine instructions, private audit text and
 * evidence references are split at creation time.
 */

import { stripImageContracts } from './image-studio/contracts.js';

export const NARRATIVE_ARTIFACT_KIND = 'NarrativeArtifact';
export const NARRATIVE_ARTIFACT_VERSION = 1;

export const NARRATIVE_INSTRUCTION_TAGS = Object.freeze([
  'var',
  'variable',
  'combat',
  'mission',
  'relationship',
  'event',
  'memory',
  'update_manifest',
  'state_update',
  'status_query',
  'recall',
  'image_contract',
  'shinobi_daily'
]);

export const NARRATIVE_INTERNAL_TAGS = Object.freeze([
  'think',
  'thinking',
  'reasoning',
  'analysis',
  '思维链',
  'anthropic_thinking',
  'anthropic_think',
  'deepseek_thinking',
  'var_thinking',
  'variable_thinking',
  'audit',
  'audit_internal',
  'review_audit',
  'review_notes',
  'critique',
  'critic',
  'private',
  'private_intent',
  'private_context',
  'npc_private',
  'npc_intent',
  'npc_memory',
  'hidden',
  'hidden_intent',
  'secret',
  'backstage',
  'planner_private',
  'internal',
  'internal_notes',
  'scratchpad',
  'system_info',
  'tool',
  'tool_call',
  'function_call',
  'style',
  'script',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'link',
  'meta'
]);

const EVIDENCE_TAGS = Object.freeze(['evidence_refs', 'evidence_ref']);
const DISPLAY_WRAPPER_TAGS = Object.freeze([
  'final',
  'final_answer',
  'narrative',
  'story',
  'response',
  '正文'
]);

const SENSITIVE_NAME_PATTERN = /(?:think|reason|analysis|planning|audit|review[_-]?note|critic|critique|private|secret|hidden|internal|scratch|backstage|planner[_-]?private|(?:^|[_:-])driver(?:$|[_:-]))/i;
const PRIVATE_ATTRIBUTE_PATTERN = /\b(?:visibility|audience|scope|access)\s*=\s*(?:["']\s*)?(?:private|secret|hidden|internal|backstage)\b/i;
const EVIDENCE_ID_PATTERN = /\b(?:E\d+|(?:EV|SCN|DAY)-(?:HIST|P\d+|BOR|[A-Z0-9]+)(?:-[A-Z0-9]+)*|(?:WB|JT|MEM|NODE)-[A-Z0-9._:/-]+)\b/gi;
const GENERIC_PAIRED_TAG_PATTERN = /<([A-Za-z_][\w.\-:]*~?)([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.rawResponse === 'string') return value.rawResponse;
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.displayText === 'string') return value.displayText;
  }
  return String(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagAlternation(tags) {
  return tags.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
}

function collectKnownBlocks(text, tags, { selfClosing = true } = {}) {
  if (!text || !tags.length) return [];
  const names = tagAlternation(tags);
  const blocks = [];
  const paired = new RegExp(`<(${names})(?=[\\s>])([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
  let match;
  while ((match = paired.exec(text)) !== null) {
    blocks.push({
      tag: match[1].toLowerCase(),
      attributes: String(match[2] || '').trim(),
      content: String(match[3] || '').trim(),
      raw: match[0],
      start: match.index,
      end: paired.lastIndex,
      selfClosing: false
    });
  }
  if (selfClosing) {
    const singleton = new RegExp(`<(${names})(?=[\\s/>])([^>]*?)\\/\\s*>`, 'gi');
    while ((match = singleton.exec(text)) !== null) {
      blocks.push({
        tag: match[1].toLowerCase(),
        attributes: String(match[2] || '').trim(),
        content: '',
        raw: match[0],
        start: match.index,
        end: singleton.lastIndex,
        selfClosing: true
      });
    }
  }
  return blocks.sort((a, b) => a.start - b.start || b.end - a.end);
}

function collectSensitiveBlocks(text) {
  const blocks = collectKnownBlocks(text, NARRATIVE_INTERNAL_TAGS, { selfClosing: false });
  GENERIC_PAIRED_TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = GENERIC_PAIRED_TAG_PATTERN.exec(text)) !== null) {
    if (!SENSITIVE_NAME_PATTERN.test(match[1]) && !PRIVATE_ATTRIBUTE_PATTERN.test(match[2] || '')) continue;
    blocks.push({
      tag: match[1].toLowerCase(),
      attributes: String(match[2] || '').trim(),
      content: String(match[3] || '').trim(),
      raw: match[0],
      start: match.index,
      end: GENERIC_PAIRED_TAG_PATTERN.lastIndex,
      selfClosing: false
    });
  }

  // A truncated sensitive wrapper hides the remainder of the response. Track
  // unmatched openings here as well as in the display sanitizer so nested
  // machine instructions cannot escape through a malformed private tail.
  const sensitiveStack = [];
  const tagToken = /<(\/)?([A-Za-z_][\w.\-:]*~?)([^>]*)>/g;
  while ((match = tagToken.exec(text)) !== null) {
    const closing = Boolean(match[1]);
    const tag = match[2].toLowerCase();
    const attributes = String(match[3] || '').trim();
    if (closing) {
      const openIndex = sensitiveStack.map(item => item.tag).lastIndexOf(tag);
      if (openIndex >= 0) sensitiveStack.splice(openIndex, 1);
      continue;
    }
    if (/\/\s*$/.test(attributes)) continue;
    if (!SENSITIVE_NAME_PATTERN.test(tag) && !PRIVATE_ATTRIBUTE_PATTERN.test(attributes)) continue;
    sensitiveStack.push({
      tag,
      attributes,
      contentStart: tagToken.lastIndex,
      start: match.index
    });
  }
  for (const block of sensitiveStack) {
    blocks.push({
      tag: block.tag,
      attributes: block.attributes,
      content: text.slice(block.contentStart).trim(),
      raw: text.slice(block.start),
      start: block.start,
      end: text.length,
      selfClosing: false
    });
  }

  if (text.includes('[回映结束]')) {
    const end = text.indexOf('[回映结束]');
    const content = text.slice(0, end).trim();
    if (content) {
      blocks.push({
        tag: '回映',
        attributes: '',
        content,
        raw: text.slice(0, end + '[回映结束]'.length),
        start: 0,
        end: end + '[回映结束]'.length,
        selfClosing: false
      });
    }
  }

  const seen = new Set();
  return blocks
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter(block => {
      const key = `${block.start}:${block.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isInsideAnyRange(block, ranges) {
  return ranges.some(range => block.start >= range.start && block.end <= range.end);
}

function overlapsAnyRange(block, ranges) {
  return ranges.some(range => block.start < range.end && range.start < block.end);
}

function containsSensitiveMarkup(value) {
  const text = String(value || '');
  if (!text) return false;
  if (collectSensitiveBlocks(text).length) return true;
  const openTag = /<([A-Za-z_][\w.\-:]*~?)([^>]*)>/g;
  let match;
  while ((match = openTag.exec(text)) !== null) {
    if (SENSITIVE_NAME_PATTERN.test(match[1]) || PRIVATE_ATTRIBUTE_PATTERN.test(match[2] || '')) return true;
  }
  return false;
}

function stripKnownTags(text, tags, { streaming = false } = {}) {
  let value = text;
  for (const rawTag of tags) {
    const tag = escapeRegExp(rawTag);
    value = value
      .replace(new RegExp(`<${tag}(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
      .replace(new RegExp(`<${tag}(?=[\\s/>])[^>]*?\\/\\s*>`, 'gi'), '');
    // A malformed/unclosed hidden block is still hidden.  Cutting the tail is
    // safer than allowing reasoning or JSON to enter a save.
    value = value.replace(new RegExp(`<${tag}(?=[\\s>])[^>]*>[\\s\\S]*$`, 'gi'), '');
  }
  if (streaming) {
    const lastOpen = value.lastIndexOf('<');
    if (lastOpen >= 0) {
      const tail = value.slice(lastOpen).toLowerCase();
      const allNames = [...tags, ...NARRATIVE_INTERNAL_TAGS, ...NARRATIVE_INSTRUCTION_TAGS, ...EVIDENCE_TAGS];
      if (allNames.some(name => {
        const prefix = `<${String(name).toLowerCase()}`;
        return prefix.startsWith(tail) || tail.startsWith(prefix);
      })) {
        value = value.slice(0, lastOpen);
      }
    }
  }
  return value;
}

function stripSensitiveGenericTags(text, { streaming = false } = {}) {
  let value = text;
  let changed = true;
  let pass = 0;
  while (changed && pass < 8) {
    changed = false;
    GENERIC_PAIRED_TAG_PATTERN.lastIndex = 0;
    value = value.replace(GENERIC_PAIRED_TAG_PATTERN, (full, name, attributes) => {
      if (!SENSITIVE_NAME_PATTERN.test(name) && !PRIVATE_ATTRIBUTE_PATTERN.test(attributes || '')) return full;
      changed = true;
      return '';
    });
    pass++;
  }
  const open = /<([A-Za-z_][\w.\-:]*~?)([^>]*)>/g;
  let match;
  let cutoff = -1;
  while ((match = open.exec(value)) !== null) {
    if (SENSITIVE_NAME_PATTERN.test(match[1]) || PRIVATE_ATTRIBUTE_PATTERN.test(match[2] || '')) cutoff = match.index;
  }
  if (cutoff >= 0) value = value.slice(0, cutoff);
  return value;
}

function unwrapDisplayTags(text) {
  let value = text;
  for (const rawTag of DISPLAY_WRAPPER_TAGS) {
    const tag = escapeRegExp(rawTag);
    value = value
      .replace(new RegExp(`<${tag}(?=[\\s>])[^>]*>`, 'gi'), '')
      .replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), '');
  }
  return value;
}

function cleanWhitespace(text) {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip internal and machine content while retaining presentation boundaries.
 * This intermediate source is data for projections, not HTML to render directly.
 */
export function sanitizeNarrativeSourceText(input, { streaming = false } = {}) {
  let value = asText(input).replace(/\r\n?/g, '\n');
  if (!value) return '';

  // Defence in depth: every visible/persisted narrative projection must hide
  // both tagged contracts and schema-identified bare JSON contracts.
  value = stripImageContracts(value, { streaming });

  const reflectionEnd = value.indexOf('[回映结束]');
  if (reflectionEnd >= 0) value = value.slice(reflectionEnd + '[回映结束]'.length);

  value = value.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  value = stripKnownTags(value, NARRATIVE_INTERNAL_TAGS, { streaming });
  value = stripSensitiveGenericTags(value, { streaming });
  value = stripKnownTags(value, NARRATIVE_INSTRUCTION_TAGS, { streaming });
  value = stripKnownTags(value, EVIDENCE_TAGS, { streaming });
  return cleanWhitespace(value);
}

/** Return plain display text with unknown presentation wrappers unwrapped. */
export function sanitizeNarrativeDisplayText(input, { streaming = false } = {}) {
  let value = sanitizeNarrativeSourceText(input, { streaming });
  value = unwrapDisplayTags(value);

  // Drop any remaining XML-like wrappers while retaining ordinary prose.
  value = value
    .replace(/<\/?[A-Za-z_][\w.\-:]*~?(?:\s+[^>]*)?\s*\/?>/g, '')
    .replace(/<\/?正文(?:\s+[^>]*)?\s*>/g, '');
  return cleanWhitespace(value);
}

export function sanitizeNarrativePartialText(input) {
  return sanitizeNarrativeDisplayText(input, { streaming: true });
}

function normaliseEvidenceRef(value) {
  const ref = String(value || '').trim();
  if (!ref || ref.length > 128) return null;
  return /^(?:E\d+|(?:EV|SCN|DAY)-[A-Z0-9][A-Z0-9-]*|(?:WB|JT|MEM|NODE)-[A-Z0-9][A-Z0-9._:/-]*)$/i.test(ref)
    ? ref
    : null;
}

function refsFromEvidenceTag(block) {
  const values = [];
  const raw = block.content.trim();
  if (!raw) return values;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) values.push(...parsed);
    else if (Array.isArray(parsed?.refs)) values.push(...parsed.refs);
    else if (typeof parsed?.ref === 'string') values.push(parsed.ref);
  } catch {
    values.push(...raw.split(/[\s,，;；]+/));
  }
  return values;
}

export function extractNarrativeEvidenceRefs(input, suppliedRefs = []) {
  const text = asText(input);
  const refs = [];
  const add = value => {
    const ref = normaliseEvidenceRef(value);
    if (ref && !refs.includes(ref) && refs.length < 256) refs.push(ref);
  };
  for (const value of Array.isArray(suppliedRefs) ? suppliedRefs : [suppliedRefs]) add(value);
  const privateRanges = collectSensitiveBlocks(text);
  for (const block of collectKnownBlocks(text, EVIDENCE_TAGS).filter(block => !isInsideAnyRange(block, privateRanges))) {
    for (const value of refsFromEvidenceTag(block)) add(value);
  }
  // Never derive references from raw audit/private content.  Visible prose has
  // already passed the privacy sanitizer; explicit caller refs are expected to
  // come from the audience-filtered TurnEvidence view.
  const displayText = sanitizeNarrativeDisplayText(text);
  for (const match of displayText.match(EVIDENCE_ID_PATTERN) || []) add(match);
  return Object.freeze(refs);
}

export function extractNarrativeInstructions(input) {
  const text = asText(input);
  const privateRanges = collectSensitiveBlocks(text);
  const blocks = collectKnownBlocks(text, NARRATIVE_INSTRUCTION_TAGS)
    .filter(block => !isInsideAnyRange(block, privateRanges))
    // A legal machine tag containing a private/audit child is tainted as a
    // whole. Keeping the outer JSON would otherwise smuggle hidden text into
    // memory, variables or the timeline.
    .filter(block => !overlapsAnyRange(block, privateRanges) && !containsSensitiveMarkup(block.content))
    .map(block => Object.freeze({
      tag: block.tag,
      attributes: block.attributes,
      content: block.content,
      raw: block.raw,
      selfClosing: block.selfClosing
    }));
  return Object.freeze(blocks);
}

export function renderNarrativeInstructions(value) {
  const instructions = Array.isArray(value) ? value : value?.instructions;
  if (!Array.isArray(instructions)) return '';
  return instructions.map(block => String(block?.raw || '')).filter(Boolean).join('\n');
}

export function extractNarrativeAudit(input) {
  return collectSensitiveBlocks(asText(input))
    .map(block => block.content)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function isNarrativeArtifact(value) {
  return Boolean(
    value
    && value.kind === NARRATIVE_ARTIFACT_KIND
    && value.version === NARRATIVE_ARTIFACT_VERSION
    && typeof value.displayText === 'string'
    && Array.isArray(value.instructions)
    && typeof value.auditInternal === 'string'
    && Array.isArray(value.evidenceRefs)
  );
}

export function createNarrativeArtifact(input, { evidenceRefs = [] } = {}) {
  if (isNarrativeArtifact(input)) {
    if (!evidenceRefs || evidenceRefs.length === 0) return input;
    const mergedRefs = [...input.evidenceRefs];
    for (const value of Array.isArray(evidenceRefs) ? evidenceRefs : [evidenceRefs]) {
      const ref = normaliseEvidenceRef(value);
      if (ref && !mergedRefs.includes(ref) && mergedRefs.length < 256) mergedRefs.push(ref);
    }
    return Object.freeze({ ...input, evidenceRefs: Object.freeze(mergedRefs) });
  }
  const text = asText(input);
  return Object.freeze({
    kind: NARRATIVE_ARTIFACT_KIND,
    version: NARRATIVE_ARTIFACT_VERSION,
    displayText: sanitizeNarrativeDisplayText(text),
    // Kept only inside the artifact so review/accept can retain choice boundaries.
    // Persistence still uses the narrow plain display projection below.
    presentationText: sanitizeNarrativeSourceText(text),
    instructions: extractNarrativeInstructions(text),
    auditInternal: extractNarrativeAudit(text),
    evidenceRefs: extractNarrativeEvidenceRefs(text, evidenceRefs)
  });
}

/**
 * Deliberately narrow persistence projection.  Callers must never serialize a
 * whole artifact into chat history or a timeline node.
 */
export function toPersistedNarrative(artifact) {
  if (!isNarrativeArtifact(artifact)) throw new TypeError('Expected a NarrativeArtifact');
  return artifact.displayText;
}

export function toNarrativeDisplayRecord(artifact) {
  return Object.freeze({ displayText: toPersistedNarrative(artifact) });
}
