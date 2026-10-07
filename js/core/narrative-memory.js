import { sanitizeNarrativeDisplayText, sanitizeNarrativeSourceText } from './narrative-artifact.js';

const ACTION_PARTS = new Set(['option', 'options', 'choice', 'choices', 'selection', 'selections', 'selc', 'action', 'actions']);
const PROTOCOL_PARTS = new Set(['format', 'protocol', 'schema', 'template', 'guideline', 'guidelines', 'instruction', 'instructions', 'engine']);

export const FACTUAL_MEMORY_GUIDANCE = '记忆与变量只记录正文已经发生的结果。行动选项是尚未执行的建议，玩家输入是本轮意图；选项、计划、假设和意图本身都不代表成功发生。根据正文实际结果延续剧情、更新人物与记忆，不把未选择的分支写成既成事实。';

export function isNarrativeChoiceTag(tag) {
  const parts = String(tag || '').toLowerCase().split(/[_.:\-]+/).filter(Boolean);
  return !parts.some(part => PROTOCOL_PARTS.has(part)) && parts.some(part => ACTION_PARTS.has(part));
}

// This is an evidence projection, never the UI text. Strip choice wrappers before
// the display sanitizer unwraps them, otherwise imported presets lose the boundary.
export function projectNarrativeForMemory(input) {
  const raw = sanitizeNarrativeSourceText(input);
  const tokens = /<(\/?)([a-z_][\w.:-]*)(\s[^<>]*?)?\s*(\/?)>/gi;
  const stack = [];
  const ranges = [];
  for (const match of raw.matchAll(tokens)) {
    const tag = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.findLastIndex(entry => entry.tag === tag);
      if (index < 0) continue;
      for (const entry of stack.splice(index)) {
        if (entry.choice) ranges.push([entry.start, match.index + match[0].length]);
      }
    } else {
      const attrs = match[3] || '';
      const choice = isNarrativeChoiceTag(tag) || tag === 'button'
        || /\bdata-(?:option|option-text|choice|action)(?:\s|=)/i.test(attrs)
        || /\brole\s*=\s*["']?button\b/i.test(attrs)
        || /\bonclick\s*=[\s\S]*?(?:sendMessage|sendToChat|triggerSlash)/i.test(attrs);
      if (match[4] || ['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr'].includes(tag)) {
        if (choice) ranges.push([match.index, match.index + match[0].length]);
      } else stack.push({ tag, choice, start: match.index });
    }
  }
  for (const entry of stack) if (entry.choice) ranges.push([entry.start, raw.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  let text = '';
  for (const [start, end] of ranges) {
    if (start >= cursor) text += raw.slice(cursor, start) + '\n';
    cursor = Math.max(cursor, end);
  }
  text += raw.slice(cursor);
  text = sanitizeNarrativeDisplayText(text.replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n'));
  const lines = text.split('\n');
  const kept = [];
  let inChoices = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const normalized = line.trim().replace(/^[#>*\s]+/, '').replace(/\*\*/g, '').trim();
    if (/^(?:【|\[)?(?:行动选项|可选行动|可选选项|可选项|选项|行动选择)(?:】|\])?\s*[:：]?$/u.test(normalized)) {
      inChoices = true;
      continue;
    }
    const actionLabel = /\[\s*行动(?:选项)?(?:\s*\d+)?\s*\]|【\s*行动(?:选项)?(?:\s*\d+)?\s*】/u.exec(line);
    if (actionLabel) {
      const prefix = line.slice(0, actionLabel.index).replace(/^\s*(?:[-*•]|\d+[.、)])\s*$/, '').trim();
      if (prefix) kept.push(prefix);
      inChoices = !line.slice(actionLabel.index + actionLabel[0].length).trim();
      continue;
    }
    if (inChoices) {
      if (!normalized || /^(?:[-*•]|\d+[.、)]|[A-D][.、)]|「|\[)/u.test(line.trim())) continue;
      inChoices = false;
    }
    // A legacy quoted list needs explicit numbering/bullets. Unmarked 「...」
    // lines can also be real dialogue, even when several appear together.
    const isQuotedChoice = value => /^\s*(?:[-*•]|\d+[.、)])\s*「[^「」\n]+」[。.!！?？]?\s*$/u.test(value || '');
    if (isQuotedChoice(line)) {
      let end = index + 1;
      let count = 1;
      while (end < lines.length && (!lines[end].trim() || isQuotedChoice(lines[end]))) {
        if (lines[end].trim()) count++;
        end++;
      }
      if (count >= 2) { index = end - 1; continue; }
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
