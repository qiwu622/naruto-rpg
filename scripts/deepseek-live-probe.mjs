// Opt-in, paid smoke test. Read the key from stdin; never save it or add this to npm test.
// Peak CNY prices verified against the official pricing page on 2026-10-01.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AIClient, normalizeOpenAIMessageOrder } from '../js/core/ai-client.js';
import { eventBus } from '../js/core/event-bus.js';
import { markTurnContext, readTokenUsage } from '../js/core/deepseek-mode.js';
import { runAgent } from './vendor/agent-sdk-entry.js';

const MODEL = 'deepseek-flash';
const LIMIT_CNY = 2;
const MAX_REQUESTS = 16;
const MAX_OUTPUT = 4096;
const RATE = { hit: 0.04, miss: 2, output: 8 }; // CNY per million, peak rate.
const directory = fileURLToPath(new URL('../reports/deepseek-mode/', import.meta.url));
const ledgerPath = `${directory}/live-budget.json`;
const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Number(value.toFixed(8));

function reserveRequest(ledger, body, label) {
  assert.equal(body.model, MODEL, 'Probe only permits Flash');
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= MAX_OUTPUT);
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(bytes <= 120000, 'Synthetic input exceeds the probe limit');
  assert.ok(ledger.requests.length < MAX_REQUESTS, 'Probe request limit reached');
  const digest = hash(JSON.stringify(body));
  assert.ok(!ledger.requests.some(r => r.label === label && r.digest === digest), 'Automatic paid retry blocked');
  // UTF-8 bytes plus a deliberately generous chat/tool framing allowance.
  const inputUpperBound = bytes + 2048 + (body.messages?.length || 0) * 64;
  const worstCny = round((inputUpperBound * RATE.miss + body.max_tokens * RATE.output) / 1e6);
  assert.ok(ledger.reservedCny + worstCny <= LIMIT_CNY, 'Probe money limit reached');
  const row = { label, digest, startedAt: new Date().toISOString(), inputUpperBound,
    maxOutput: body.max_tokens, worstCny, stream: body.stream === true,
    thinking: body.thinking?.type || 'provider-default', effort: body.reasoning_effort || null };
  ledger.reservedCny = round(ledger.reservedCny + worstCny);
  ledger.requests.push(row); // Never release a reservation, even after errors or process restarts.
  return row;
}

if (process.argv.includes('--self-test')) {
  const fresh = () => ({ requests: [], reservedCny: 0 });
  const body = { model: MODEL, max_tokens: 128, messages: [{ role: 'user', content: '预算测试' }] };
  const ledger = fresh();
  reserveRequest(ledger, body, 'one');
  assert.throws(() => reserveRequest(ledger, body, 'one'), /retry blocked/);
  assert.throws(() => reserveRequest(fresh(), { ...body, model: 'deepseek-v4-pro' }, 'one'));
  assert.throws(() => reserveRequest(fresh(), { ...body, max_tokens: 99999 }, 'one'));
  assert.throws(() => reserveRequest(fresh(), { ...body, messages: [{ role: 'user', content: 'x'.repeat(120001) }] }, 'one'), /input exceeds/);
  assert.throws(() => reserveRequest({ requests: [], reservedCny: 1.999 }, body, 'one'), /money limit/);
  assert.throws(() => reserveRequest({ requests: Array(16).fill({}), reservedCny: 0 }, body, 'one'), /request limit/);
  console.log('PASS budget guards: model, output, input estimate, duplicate, money and count limits');
  process.exit(0);
}

if (process.argv.includes('--verify-report')) {
  const report = JSON.parse(await readFile(ledgerPath, 'utf8'));
  assert.ok(report.requests.length <= MAX_REQUESTS);
  assert.ok(report.reservedCny <= LIMIT_CNY);
  assert.equal(round(report.requests.reduce((sum, row) => sum + row.worstCny, 0)), report.reservedCny);
  for (const row of report.requests) {
    assert.equal(row.httpStatus, 200);
    assert.equal(row.captureError, undefined);
    assert.ok(['stop', 'tool_calls'].includes(row.finishReason));
    assert.ok(row.usage.cacheKnown && row.usage.input === row.usage.hit + row.usage.miss);
    assert.ok(row.estimatedPeakCny <= row.worstCny);
  }
  assert.ok(report.cases.every(item => item.passed));
  const prefixes = report.cases.map(item => item.stablePrefixSha256).filter(Boolean);
  assert.ok(prefixes.length >= 3 && new Set(prefixes).size === 1);
  assert.ok(!/sk-[A-Za-z0-9_-]{12,}/.test(JSON.stringify(report)), 'Report contains a key');
  console.log(`PASS saved live report: ${report.cases.length} cases, ${report.requests.length} calls, budget and usage reconciled`);
  process.exit(0);
}

const key = readFileSync(0, 'utf8').trim();
assert.ok(/^sk-[A-Za-z0-9_-]+$/.test(key), 'Provide the authorized key on stdin');
const redact = value => String(value).replaceAll(key, '[redacted]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]');
const realFetch = globalThis.fetch;
const officialGet = async path => {
  const response = await realFetch(`https://api.deepseek.com${path}`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(25000), redirect: 'error'
  });
  assert.ok(response.ok, `Official preflight HTTP ${response.status}`);
  return response.json();
};
const balanceValue = balance => {
  assert.equal(balance.balance_infos?.length, 1, 'Probe requires a single CNY balance');
  assert.equal(balance.balance_infos[0].currency, 'CNY');
  return Number(balance.balance_infos[0].total_balance);
};
const initialBalance = await officialGet('/user/balance');
assert.equal(initialBalance.is_available, true);
const balanceBefore = balanceValue(initialBalance);
assert.ok(balanceBefore > LIMIT_CNY, 'Insufficient balance for this conservative probe cap');
const models = await officialGet('/models');
assert.ok(models.data.some(item => item.id === MODEL), 'Official account has no Flash model');
await mkdir(directory, { recursive: true });
let ledger;
try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
ledger ||= { version: 1, startedAt: new Date().toISOString(), model: MODEL, limitCny: LIMIT_CNY,
  ratesPeakCnyPerMillion: RATE, reservedCny: 0, requests: [], cases: [], runs: [] };
assert.equal(ledger.limitCny, LIMIT_CNY);
const flush = () => writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
let currentCase;
const captures = [];
const wireBodies = new Map();
const runStart = ledger.requests.length;

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async (input, init = {}) => {
  assert.ok(currentCase, 'No paid request outside an explicit test case');
  const sourceHeaders = new Headers(init.headers || {});
  const target = sourceHeaders.get('x-target-url') || String(input);
  const url = new URL(target);
  assert.equal(url.origin, 'https://api.deepseek.com', 'Only the official API may receive the key');
  assert.ok(['/v1/chat/completions', '/chat/completions', '/beta/chat/completions'].includes(url.pathname));
  assert.equal(url.search, '');
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  // This bound belongs only to this paid probe, never to the game's settings.
  body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUTPUT, MAX_OUTPUT);
  const row = reserveRequest(ledger, body, currentCase.name);
  wireBodies.set(row, body);
  await flush(); // Persist before charging; failed/unknown requests keep their reservation.
  console.log(`CALL ${ledger.requests.length}/${MAX_REQUESTS} ${row.label}; cumulative worst-case CNY ${ledger.reservedCny}`);
  const started = performance.now();
  const response = await realFetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(90000), ...(init.signal ? [init.signal] : [])])
  });
  row.httpStatus = response.status;
  const capture = response.clone().text().then(raw => {
    row.durationMs = Math.round(performance.now() - started);
    if (!response.ok) { row.error = redact(raw.slice(0, 1200)); return; }
    const frames = body.stream
      ? raw.split('\n').filter(line => line.startsWith('data: ') && line.trim() !== 'data: [DONE]')
        .map(line => JSON.parse(line.slice(6)))
      : [JSON.parse(raw)];
    let reasoningChars = 0;
    let visibleChars = 0;
    for (const frame of frames) {
      if (frame.usage) row.usage = readTokenUsage(frame.usage);
      for (const choice of frame.choices || []) {
        if (choice.finish_reason) row.finishReason = choice.finish_reason;
        const message = choice.message || choice.delta || {};
        reasoningChars += (message.reasoning_content || '').length;
        visibleChars += (message.content || '').length;
      }
    }
    row.reasoningChars = reasoningChars;
    row.visibleChars = visibleChars;
    if (row.usage?.cacheKnown && row.usage.output !== null) {
      row.estimatedPeakCny = round((row.usage.hit * RATE.hit + row.usage.miss * RATE.miss + row.usage.output * RATE.output) / 1e6);
      assert.ok(row.estimatedPeakCny <= row.worstCny, 'Observed charge exceeded reservation');
    }
  }).catch(error => { row.captureError = redact(error.message); });
  captures.push(capture);
  return response;
};

const config = mode => ({ backend: 'deepseek', apiUrl: 'https://api.deepseek.com/v1', apiKey: key,
  model: MODEL, adaptationMode: mode, useProxy: false });
const options = { max_tokens: MAX_OUTPUT, maxRetries: 0, strictSingleRequest: true, temperature: 0.6 };
async function test(name, action) {
  if (ledger.cases.some(item => item.name === name)) { console.log(`SKIP recorded case ${name}`); return; }
  if (process.argv.includes('--only') && process.argv[process.argv.indexOf('--only') + 1] !== name) return;
  currentCase = { name, startedAt: new Date().toISOString() };
  const firstRequest = ledger.requests.length;
  try {
    await action();
    await Promise.all(captures);
    for (const row of ledger.requests.slice(firstRequest)) {
      assert.equal(row.captureError, undefined, 'Provider usage capture failed');
      assert.equal(row.httpStatus, 200);
      assert.equal(row.usage?.cacheKnown, true, 'Provider cache usage is missing');
      assert.ok(row.estimatedPeakCny !== undefined && row.estimatedPeakCny <= row.worstCny);
    }
    currentCase.passed = true;
  }
  catch (error) { currentCase.passed = false; currentCase.error = redact(error.message); }
  await Promise.all(captures);
  currentCase.requests = ledger.requests.length - firstRequest;
  ledger.cases.push(currentCase);
  await flush();
  console.log(`${currentCase.passed ? 'PASS' : 'FAIL'} ${name}${currentCase.error ? ': ' + currentCase.error : ''}`);
  currentCase = null;
}
function client(mode, extra = {}) { const value = new AIClient(); value.configure({ ...config(mode), ...extra }); return value; }

const fixedRules = '你是中文忍者冒险游戏的叙事者。依据已经发生的历史和最新事实继续场景。只输出正文，不写规则解释、选项、审计或防御性提示。未选择的备选行动尚未发生。玩家叫清风，是木叶的成年下忍。不能凭空增加奖励。当前事实比旧记录更新。';
const history = Array.from({ length: 28 }, (_, i) => [
  { role: 'user', content: `在任务第${i + 1}个记录点，我沿村中街道确认巡逻路线，和负责登记的值班忍者核对行程。` },
  { role: 'assistant', content: `清风在巡逻簿第${i + 1}页记下道路的情况。街角的木牌经过雨水冲刷，笔画仍然清晰；送货的车从石路边慢慢经过，檐下摆着尚未收起的雨具。值班忍者确认了这段路线，提醒他在交班前回到任务所。整个检查没有发生战斗，没有购买物品，也没有获得金钱或新的忍术。清风保留了先前已经确认的随身物品，继续按照约定巡逻。` }
]).flat();
const fixture = turn => [
  { role: 'system', content: fixedRules }, ...history,
  markTurnContext({ role: 'system', content: `本轮最新事实：巡逻记录${turn}已核对。清风此刻在木叶任务所门口，身上有100两和2个饭团。尚未购买任何东西。天气小雨。备选但未选择：去商店购买起爆符。` }),
  { role: 'user', content: `这是第${turn}次核对。我走进任务所，询问今天还有哪些普通跑腿工作。写120至180个汉字，保留接取任务前的选择空间。` }
];

try {
  for (const mode of ['standard', 'deepseek']) {
    for (let turn = 1; turn <= 3; turn++) {
      await test(`cache-${mode}-${turn}`, async () => {
        const messages = fixture(turn);
        const result = await client(mode).chatDetailed(messages, options);
        currentCase.text = result.text;
        assert.ok(result.text.length >= 60, 'No usable narrative');
        assert.equal(result.finishReason, 'stop', 'Output truncated by probe cap');
        const row = ledger.requests.at(-1);
        const body = wireBodies.get(row);
        if (mode === 'standard') {
          assert.equal(JSON.stringify(body.messages), JSON.stringify(normalizeOpenAIMessageOrder(messages)));
          assert.equal(body.thinking, undefined);
          currentCase.legacyContextUnchanged = true;
        } else {
          assert.equal(body.thinking.type, 'disabled');
          assert.equal(body.messages[0].content.includes('本轮最新事实'), false);
          assert.ok(body.messages.findLastIndex(m => m.content.includes('本轮最新事实')) > body.messages.length - 4);
          currentCase.stablePrefixSha256 = hash(JSON.stringify(body.messages.slice(0, -2)));
        }
        await new Promise(resolve => setTimeout(resolve, 4000));
      });
    }
  }
  await test('stream-dedicated', async () => {
    let chunks = 0;
    const events = []; const off = eventBus.on('ai:usage', event => events.push(event));
    try {
      currentCase.text = await client('deepseek').chatStream(fixture(4), options, () => chunks++);
      assert.ok(currentCase.text.length >= 60); assert.ok(chunks > 1);
      assert.equal(events.length, 1); assert.equal(readTokenUsage(events[0]).cacheKnown, true);
      currentCase.chunks = chunks; currentCase.usageEvents = events.length;
    } finally { off(); }
  });
  await test('thinking-low-json', async () => {
    const result = await client('deepseek', { deepseekThinking: 'low' }).chatDetailed([
      { role: 'system', content: '只输出一个 JSON 对象，不带 Markdown。根据确定事实计算，不执行未选择的选项。' },
      { role: 'user', content: '原状态：钱100两，饭团2个。已发生：吃掉1个饭团。备选但未选择：花50两买起爆符。输出新状态，使用 money、riceBalls、explosiveTags 三个数值字段。' }
    ], options);
    currentCase.text = result.text;
    const parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    assert.deepEqual(parsed, { money: 100, riceBalls: 1, explosiveTags: 0 });
    assert.equal(result.finishReason, 'stop');
  });
  await test('assistant-prefill', async () => {
    const result = await client('deepseek').chatDetailed([
      { role: 'system', content: '接着给定的正文开头写一个50字内的雨天场景，只输出续写文字。' },
      { role: 'user', content: '清风走进木叶任务所。' },
      { role: 'assistant', content: '雨水沿着屋檐落下，' }
    ], options);
    currentCase.text = result.text;
    assert.ok(result.text.trim().length > 5); assert.equal(result.finishReason, 'stop');
  });
  await test('variable-preset', async () => {
    const { buildVariableUpdaterMessages, validateVariableUpdaterOutput } = await import('../js/core/variable-updater.js');
    const { DEFAULT_VARIABLE_UPDATER_PRESET } = await import('../js/data/variable-updater-preset.js');
    const state = { player: { name: '清风', age: 20 }, world_state: { calendar: '木叶52年7月15日·上午', location: '木叶任务所', turn: 5 },
      equipment: { money: 100, consumables: [{ name: '饭团', quantity: 2 }] }, relationships: {}, missions: [] };
    const userInput = '我吃掉一个饭团，留在原地等候。';
    const messages = buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, {
      state, compactState: state, userInput, enrichedInput: userInput,
      narrativeResponse: '清风吃掉随身的一个饭团，还剩一个。他仍在木叶任务所的屋檐下等候，没有购买任何物品，金钱未变。',
      memoryContext: '玩家尚未接取新任务。备选的购买起爆符没有被选择，也未发生。', includeDaily: false, optimizeContext: true
    });
    const result = await client('deepseek').chatDetailed(messages, options);
    currentCase.text = result.text;
    assert.equal(result.finishReason, 'stop');
    const validation = validateVariableUpdaterOutput(result.text, { state, userInput, includeDaily: false });
    currentCase.validation = validation;
    assert.ok(/<memory>/.test(result.text), 'No memory update');
    assert.ok(/<variable>/.test(result.text), 'No confirmed inventory update');
    for (const match of result.text.matchAll(/<(variable|memory|update_manifest)>([\s\S]*?)<\/\1>/g)) JSON.parse(match[2]);
    assert.equal(validation.valid ?? validation.ok, true, 'Game variable validator rejected the live output');
  });
  await test('agent-tool-low', async () => {
    let toolRuns = 0;
    const events = [];
    const result = await runAgent({
      config: { ...config('deepseek'), deepseekThinking: 'low', disableStreaming: true },
      definition: { id: 'live-probe', instructions: '你是只读状态助手。必须先调用 lookup_inventory 获取饭团数量，之后只回答“现有N个饭团”，不得猜测。拿到工具结果后不要再次调用工具。' },
      messages: [{ role: 'user', content: '我目前有几个饭团？' }],
      tools: { lookup_inventory: { description: '读取已确认的随身物品',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => { toolRuns++; return { riceBalls: 2 }; } } },
      budget: { maxSteps: 2 }, onEvent: event => { if (event.type === 'step-end') events.push(event); }
    });
    currentCase.text = result.text; currentCase.toolRuns = toolRuns;
    currentCase.usage = readTokenUsage(result.usage); currentCase.stepUsageEvents = events.length;
    assert.equal(toolRuns, 1); assert.equal(result.steps, 2); assert.equal(events.length, 2);
    assert.match(result.text, /2|两|二/);
    const rows = ledger.requests.filter(row => row.label === currentCase.name);
    const secondBody = wireBodies.get(rows[1]);
    const previousToolCall = secondBody.messages.find(message => message.tool_calls?.length);
    assert.ok(previousToolCall?.reasoning_content, 'Thinking/tool history was not passed back');
    currentCase.thinkingPassback = true;
  });
} finally {
  await Promise.all(captures);
  globalThis.fetch = realFetch;
  try {
    const after = balanceValue(await officialGet('/user/balance'));
    ledger.runs.push({ finishedAt: new Date().toISOString(), requests: ledger.requests.length - runStart,
      observedBalanceDecreaseCny: round(balanceBefore - after),
      note: 'Account balance may also reflect concurrent account activity or delayed billing.' });
  } catch (error) { ledger.runs.push({ finishedAt: new Date().toISOString(), balanceError: redact(error.message) }); }
  ledger.estimatedPeakCny = round(ledger.requests.reduce((sum, row) => sum + (row.estimatedPeakCny || 0), 0));
  await flush();
  console.log(JSON.stringify({ requests: ledger.requests.length, reservedCny: ledger.reservedCny,
    estimatedPeakCny: ledger.estimatedPeakCny, balance: ledger.runs.at(-1),
    cases: ledger.cases.map(({ name, passed }) => ({ name, passed })) }, null, 2));
}
if (ledger.cases.some(item => !item.passed)) process.exitCode = 1;
