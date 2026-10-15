import '../vendor/save-codec.js';

const CHUNK_CHARACTERS = 64 * 1024;
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function jsonValue(value, key) {
  if (value && (typeof value === 'object' || typeof value === 'bigint') && typeof value.toJSON === 'function') value = value.toJSON(key);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  return value;
}

function omitted(value) {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function* quotedString(value) {
  if (value.length <= CHUNK_CHARACTERS) { yield JSON.stringify(value); return; }
  yield '"';
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + CHUNK_CHARACTERS, value.length);
    // Match JSON.stringify's Unicode/escape bytes across chunk boundaries.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
    offset = end;
  }
  yield '"';
}

function* jsonTokens(value, visiting, canonical = false) {
  if (typeof value === 'string') { yield* quotedString(value); return; }
  if (!value || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('存档没有可序列化的内容');
    yield text; return;
  }
  if (visiting.has(value)) throw new Error('存档包含循环引用，无法保存');
  visiting.add(value);
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      if (index) yield ',';
      const item = jsonValue(value[index], String(index));
      if (omitted(item)) yield 'null';
      else yield* jsonTokens(item, visiting, canonical);
    }
    yield ']';
  } else {
    yield '{';
    let comma = false;
    for (const key of (canonical ? Object.keys(value).sort() : Object.keys(value))) {
      const item = jsonValue(value[key], key);
      if (omitted(item)) continue;
      if (comma) yield ',';
      comma = true;
      yield* quotedString(key); yield ':';
      yield* jsonTokens(item, visiting, canonical);
    }
    yield '}';
  }
  visiting.delete(value);
}

// Byte-for-byte equivalent to JSON.stringify for JSON save data, without
// ever materializing the complete document in a JavaScript string.
export function createSaveJsonByteStream(data, { canonical = false } = {}) {
  const tokens = jsonTokens(jsonValue(data, ''), new WeakSet(), canonical);
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      const parts = [];
      let length = 0;
      while (length < CHUNK_CHARACTERS) {
        const token = tokens.next();
        if (token.done) {
          if (parts.length) controller.enqueue(encoder.encode(parts.join('')));
          controller.close(); return;
        }
        parts.push(token.value); length += token.value.length;
      }
      controller.enqueue(encoder.encode(parts.join('')));
    },
    cancel() { tokens.return?.(); }
  });
}

export function saveJsonContainsText(data, needles) {
  if (!needles.length) return false;
  if (needles.some(text => text === '')) return true;
  const overlap = Math.max(...needles.map(text => text.length)) - 1;
  let tail = '';
  for (const chunk of jsonTokens(jsonValue(data, ''), new WeakSet())) {
    const text = tail + chunk;
    if (needles.some(needle => text.includes(needle))) return true;
    tail = overlap ? text.slice(-overlap) : '';
  }
  return false;
}

export async function checksumSaveJson(data, { canonical = false } = {}) {
  const digest = globalThis.NarutoSaveCodec.sha256.create();
  const reader = createSaveJsonByteStream(data, { canonical }).getReader();
  let yieldedAt = performance.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      digest.update(value);
      if (performance.now() - yieldedAt > 16) {
        await new Promise(resolve => setTimeout(resolve, 0));
        yieldedAt = performance.now();
      }
    }
    return Array.from(digest.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { digest.destroy(); reader.releaseLock(); }
}

// Parse individual scalar tokens with the browser's JSON parser. This keeps
// exact legacy string semantics (including escaped lone UTF-16 surrogates),
// while TokenParser assembles the document without a whole-document string.
function createJsonTokenWriter(parser, TokenType) {
  const punctuation = { '{': TokenType.LEFT_BRACE, '}': TokenType.RIGHT_BRACE, '[': TokenType.LEFT_BRACKET, ']': TokenType.RIGHT_BRACKET, ':': TokenType.COLON, ',': TokenType.COMMA };
  const boundary = /[ \t\r\n{}\[\],:"]/g;
  const stringBoundary = /["\\]/g;
  let parts = [], kind = '', escaped = false;
  function emitScalar() {
    const value = JSON.parse(parts.join(''));
    const token = kind === 'string' ? TokenType.STRING : value === null ? TokenType.NULL : value === true ? TokenType.TRUE : value === false ? TokenType.FALSE : TokenType.NUMBER;
    parts = []; kind = '';
    parser.write({ token, value });
  }
  return {
    write(text) {
      let index = 0;
      while (index < text.length) {
        if (kind === 'string') {
          const start = index;
          let closed = false;
          while (index < text.length) {
            if (escaped) { index++; escaped = false; continue; }
            stringBoundary.lastIndex = index;
            const match = stringBoundary.exec(text);
            if (!match) { index = text.length; break; }
            index = match.index + 1;
            if (match[0] === '\\') escaped = true;
            else { closed = true; break; }
          }
          parts.push(text.slice(start, index));
          if (closed) emitScalar();
        } else if (kind === 'literal') {
          boundary.lastIndex = index;
          const match = boundary.exec(text);
          const end = match ? match.index : text.length;
          parts.push(text.slice(index, end)); index = end;
          if (match) emitScalar();
        } else {
          const char = text[index];
          if (' \t\r\n'.includes(char)) { index++; continue; }
          if (char === '"') { kind = 'string'; parts = ['"']; index++; continue; }
          if (Object.prototype.hasOwnProperty.call(punctuation, char)) {
            if (char === ':' && UNSAFE_JSON_KEYS.has(parser.key)) throw new Error('存档包含不安全字段');
            parser.write({ token: punctuation[char], value: char }); index++; continue;
          }
          kind = 'literal'; parts = [];
        }
      }
    },
    end() {
      if (kind) emitScalar();
      if (!parser.isEnded) parser.end();
    }
  };
}

export async function parseSaveJsonByteStream(stream, { maxBytes = Infinity, limitError = () => new Error('存档超过读取上限') } = {}) {
  const { TokenParser, TokenType } = globalThis.NarutoSaveCodec;
  const parser = new TokenParser({ paths: ['$'], keepStack: true });
  const tokens = createJsonTokenWriter(parser, TokenType);
  let result, complete = false, totalBytes = 0;
  parser.onValue = ({ value }) => { result = value; complete = true; };
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let yieldedAt = performance.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) throw limitError();
      const text = decoder.decode(value, { stream: true });
      if (text) tokens.write(text);
      if (performance.now() - yieldedAt > 16) {
        await new Promise(resolve => setTimeout(resolve, 0));
        yieldedAt = performance.now();
      }
    }
    const tail = decoder.decode();
    if (tail) tokens.write(tail);
    tokens.end();
    if (!complete) throw new Error('文件没有完整的 JSON 内容');
    return result;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
