import { AIClient } from './ai-client.js';
import { inheritAPIAdaptation } from './deepseek-mode.js';
import { eventBus } from './event-bus.js';
import { publishPromptTrace } from './prompt-trace.js';
import { parseShinobiDailyContract, SHINOBI_DAILY_REVIEW_PROMPT } from './shinobi-daily.js';
import {
  createNarrativeArtifact,
  isNarrativeArtifact,
  renderNarrativeInstructions,
  sanitizeNarrativePartialText
} from './narrative-artifact.js';
import {
  beginNarrativeReview,
  createNarrativeReviewTransaction,
  failNarrativeReview,
  getNarrativeReviewRequestArtifact,
  isNarrativeReviewTransaction,
  receiveNarrativeReviewPreview
} from './narrative-review-transaction.js';

export * from './narrative-review-transaction.js';

export const NARRATIVE_REVIEW_DEFAULTS = Object.freeze({
  enabled: false,
  backend: 'inherit',
  apiUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.25,
  maxTokens: 16384,
  timeoutMs: 0,
  streaming: true
});

export const NARRATIVE_REVIEW_TRACE_STORAGE_KEY = 'naruto_narrative_review_prompt_trace';

export function getNarrativeReviewConfig(mainConfig = {}) {
  return { ...NARRATIVE_REVIEW_DEFAULTS, ...(mainConfig.narrativeReview || {}) };
}

export function isNarrativeReviewEnabled(mainConfig = {}) {
  return getNarrativeReviewConfig(mainConfig).enabled === true;
}

export function resolveNarrativeReviewApiConfig(mainConfig = {}) {
  const review = getNarrativeReviewConfig(mainConfig);
  return inheritAPIAdaptation(mainConfig, {
    ...mainConfig,
    ...review,
    backend: review.backend && review.backend !== 'inherit' ? review.backend : mainConfig.backend,
    apiUrl: review.apiUrl || mainConfig.apiUrl,
    apiKey: review.apiKey || mainConfig.apiKey,
    model: review.model || mainConfig.model,
    useProxy: mainConfig.useProxy !== false
  });
}

function formatSourceMessages(sourceMessages = []) {
  return sourceMessages.map((message, index) => {
    const role = message?.role || 'system';
    return `[E${index + 1} · ${role}]\n${String(message?.content || '')}`;
  }).join('\n\n');
}

export function buildNarrativeReviewMessages({ sourceMessages = [], candidateResponse = '', candidateArtifact = null, feedback = '' } = {}) {
  const candidate = isNarrativeArtifact(candidateArtifact)
    ? candidateArtifact
    : createNarrativeArtifact(candidateResponse);
  const candidateForReview = [candidate.presentationText ?? candidate.displayText, renderNarrativeInstructions(candidate)]
    .filter(Boolean)
    .join('\n\n');
  const dailyReviewRule = candidate.instructions.some(block => block.tag === 'shinobi_daily')
    ? `\n\n${SHINOBI_DAILY_REVIEW_PROMPT}`
    : '';
  const system = `你是忍者手记的可选正文复检器。你只生成一份尚未提交的预览，用户明确选择“应用”前，预览不能改写历史、时间线、记忆或变量。

【来源权威】当前状态与开局契约 > 持久记忆、NPC历史、任务与近期对话 > 本回合世界书 > 玩家本轮声称 > 模型预训练知识。世界书与存档和模型常识冲突时，必须服从世界书与存档。

【三类最高风险】
- 时间连续性：日期或时段变化必须有正文、玩家行动或变量证据，不能无原因跳过数年。
- 连续性失忆：忘记玩家此前已经完成的行动、获得或失去的对象、承诺、伤势、线索和关系历史。
- 预训练污染：用模型记忆中的原作资料覆盖本项目世界书，或在世界书无证据时擅自补成确定事实。

同时检查玩家代行、NPC越权、预设成功、凭空物品/忍术、关系速成、因果断裂、OOC、正文视角、结尾替玩家决定、结构标签与当前变量模式冲突。

行动选项是尚未执行的建议，玩家输入只表达意图。只以正文实际发生的结果更新事实；保留选项的标签或明确的“[行动]”标记，不将未选分支改写成已经发生的事件。

【强制工作方式】
一、先针对这份具体草稿建立证据编号和候选问题位置。
二、只在 <audit_internal> 中写精简审校记录；每条结论必须引用 E 编号和草稿中的具体句段，不能泛泛说“通过”。审校记录不会进入界面或存档。
三、每个问题必须记录“问题位置 → 违反证据 → 替换文本 → 复检结果”，并把替换真正写入预览正文。
四、输出完整修正版，不输出评分、建议清单、代码围栏或额外说明。保留运行时要求的必要标签，删除当前模式禁止的标签；不得把草稿中的错误变量固化。
五、如果草稿无问题，也必须在 <audit_internal> 中列出具体核对证据；不得原样声称自检成功。
六、任何 private、hidden、secret、NPC 私密意图和内部推理标签都不得出现在 <final> 中。

最终格式只能是：<audit_internal>具体复检与纠错记录</audit_internal><final>完整预览正文及当前模式允许的结构标签</final>。${dailyReviewRule}`;

  const feedbackBlock = String(feedback || '').trim()
    ? `\n\n[用户对上一次预览的修改反馈]\n${String(feedback).trim()}`
    : '';
  const user = `[本回合 reviewer 安全证据投影]\n${formatSourceMessages(sourceMessages)}\n\n[待复检候选；已移除原模型思维与私密标签]\n${candidateForReview}${feedbackBlock}\n\n请现在输出经过实际修正的非提交预览。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

export function validateNarrativeReviewOutput(text, {
  sourceMessages = [],
  candidateArtifact = null,
  candidateResponse = ''
} = {}) {
  const value = String(text || '').trim();
  if (value.length < 80) throw new Error(`正文复检返回过短（${value.length} 字符）`);
  const artifact = createNarrativeArtifact(value);
  if (!artifact.auditInternal) {
    throw new Error('正文复检未返回完整的审校记录');
  }
  if (artifact.displayText.length < 40) throw new Error('正文复检没有返回可展示的最终正文');
  const candidate = isNarrativeArtifact(candidateArtifact)
    ? candidateArtifact
    : createNarrativeArtifact(candidateResponse);
  if (candidate.instructions.some(block => block.tag === 'shinobi_daily')) {
    const dailyResult = parseShinobiDailyContract(renderNarrativeInstructions(artifact), { required: true });
    if (!dailyResult.valid) {
      throw new Error(`正文复检未保留唯一有效的忍界日报契约：${dailyResult.errors.join('；')}`);
    }
  }
  return value;
}

export function parseNarrativeReviewPreview(text, options = {}) {
  const value = validateNarrativeReviewOutput(text, options);
  return createNarrativeArtifact(value, { evidenceRefs: options.evidenceRefs || [] });
}

function publishTrace(messages, config, generationOptions) {
  publishPromptTrace({
    kind: 'narrative-review',
    title: '二次叙事审校模型请求',
    model: config.model,
    generationOptions,
    messages,
    messageSources: [
      { source: '叙事审校器', label: '审校规则' },
      { source: '叙事审校器', label: 'reviewer 安全证据投影与候选正文' }
    ]
  });
}

async function requestNarrativeReviewResult({
  mainConfig = {},
  sourceMessages = [],
  candidateResponse = '',
  candidateArtifact = null,
  feedback = '',
  onChunk,
  onPreview,
  onClient
} = {}) {
  const review = getNarrativeReviewConfig(mainConfig);
  if (!review.enabled) return null;

  const apiConfig = resolveNarrativeReviewApiConfig(mainConfig);
  if (!apiConfig.model || (apiConfig.backend !== 'tavern' && !apiConfig.apiUrl)) {
    throw new Error('正文双阶段复检已开启，但复检模型配置不完整');
  }

  const messages = buildNarrativeReviewMessages({
    sourceMessages,
    candidateResponse,
    candidateArtifact,
    feedback
  });
  const generationOptions = {
    temperature: Number.isFinite(Number(review.temperature)) ? Number(review.temperature) : NARRATIVE_REVIEW_DEFAULTS.temperature,
    max_tokens: Math.max(1024, Number(review.maxTokens) || NARRATIVE_REVIEW_DEFAULTS.maxTokens)
    // 不设置超时截止：慢生成由用户手动停止。
  };
  publishTrace(messages, apiConfig, generationOptions);
  eventBus.emit('pipeline:review-started', { model: apiConfig.model });
  eventBus.emit('pipeline:review-preview-started', { model: apiConfig.model });

  const client = new AIClient();
  onClient?.(client);
  client.configure(apiConfig);
  try {
    let accumulated = '';
    return review.streaming !== false
      ? await client.chatStream(messages, generationOptions, chunk => {
          accumulated += chunk;
          onChunk?.(chunk);
          onPreview?.(sanitizeNarrativePartialText(accumulated));
        })
      : await client.chat(messages, generationOptions);
  } finally {
    onClient?.(null);
  }
}

/**
 * Request a non-committed review artifact.  This function never mutates game
 * state and never chooses the returned preview for persistence.
 */
export async function requestNarrativeReviewPreview(options = {}) {
  const candidate = isNarrativeArtifact(options.candidateArtifact)
    ? options.candidateArtifact
    : createNarrativeArtifact(options.candidateResponse || '');
  if (!isNarrativeReviewEnabled(options.mainConfig || {})) return candidate;
  const result = await requestNarrativeReviewResult({ ...options, candidateArtifact: candidate });
  return parseNarrativeReviewPreview(result, {
    sourceMessages: options.sourceMessages || [],
    candidateArtifact: candidate,
    evidenceRefs: candidate.evidenceRefs
  });
}

/**
 * Convenience orchestration for the pure transaction state machine.  A
 * successful call ends in `preview`, never `applied`; applying/discarding is a
 * separate explicit user action.
 */
export async function runNarrativeReviewPreview({
  transaction = null,
  transactionId = null,
  feedback = '',
  throwOnError = false,
  ...requestOptions
} = {}) {
  let current = isNarrativeReviewTransaction(transaction)
    ? transaction
    : createNarrativeReviewTransaction({
        id: transactionId,
        baseArtifact: requestOptions.candidateArtifact,
        candidateResponse: requestOptions.candidateResponse || ''
      });
  if (current.state !== 'requesting') current = beginNarrativeReview(current, { feedback });
  const attemptNumber = current.activeAttempt;
  const requestArtifact = getNarrativeReviewRequestArtifact(current);
  const attemptFeedback = current.attempts.at(-1)?.feedback || feedback;
  try {
    const preview = await requestNarrativeReviewPreview({
      ...requestOptions,
      candidateArtifact: requestArtifact,
      feedback: attemptFeedback
    });
    return receiveNarrativeReviewPreview(current, preview, { attemptNumber });
  } catch (error) {
    const failed = failNarrativeReview(current, error, { attemptNumber });
    if (throwOnError) {
      error.reviewTransaction = failed;
      throw error;
    }
    return failed;
  }
}

/**
 * Backward-compatible raw-string API for callers not yet migrated to the
 * preview transaction.  New code must use runNarrativeReviewPreview().
 */
export async function runNarrativeReview(options = {}) {
  if (!isNarrativeReviewEnabled(options.mainConfig || {})) return options.candidateResponse || '';
  const result = await requestNarrativeReviewResult(options);
  return validateNarrativeReviewOutput(result, {
    sourceMessages: options.sourceMessages || [],
    candidateArtifact: options.candidateArtifact,
    candidateResponse: options.candidateResponse || ''
  });
}
