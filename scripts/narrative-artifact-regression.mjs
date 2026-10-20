import assert from 'node:assert/strict';

import {
  createNarrativeArtifact,
  extractNarrativeInstructions,
  renderNarrativeInstructions,
  sanitizeNarrativeDisplayText,
  sanitizeNarrativePartialText,
  toNarrativeDisplayRecord,
  toPersistedNarrative
} from '../js/core/narrative-artifact.js';
import {
  applyNarrativeReview,
  beginNarrativeReview,
  createNarrativeReviewTransaction,
  discardNarrativeReview,
  failNarrativeReview,
  getNarrativeReviewRequestArtifact,
  receiveNarrativeReviewPreview,
  resolveNarrativeReviewArtifact,
  retryNarrativeReview,
  toNarrativeReviewPreviewView,
  toPersistedReviewNarrative
} from '../js/core/narrative-review-transaction.js';
import {
  buildNarrativeReviewMessages,
  parseNarrativeReviewPreview,
  requestNarrativeReviewPreview
} from '../js/core/narrative-review.js';
import { instructionParser } from '../js/core/instruction-parser.js';

let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

await test('literal unclosed tag names inside audit prose do not swallow following real instructions', () => {
  for (const wrapper of ['variable_thinking', 'thinking', 'model_private_notes', 'context visibility="private"']) {
    const name = wrapper.split(' ')[0];
    for (const tag of ['variable', 'var', 'memory', 'mission', 'relationship', 'combat', 'event']) {
      const raw = `<${wrapper}>本轮使用 <${tag}> 标签记录，不在这里执行。</${name}>`
        + `<${tag}>${JSON.stringify({ summary: '真实已发生结果' })}</${tag}>`;
      const blocks = extractNarrativeInstructions(raw);
      assert.deepEqual(blocks.map(block => block.tag), [tag], `${wrapper}: ${tag}`);
      assert.equal(JSON.parse(blocks[0].content).summary, '真实已发生结果');
      assert.equal(sanitizeNarrativeDisplayText(raw), '');
    }
  }
});

await test('NarrativeArtifact separates visible prose, instructions, audit and evidence', () => {
  const raw = `<thinking>内部推理引用 E1 与 EV-P2-SECRET-01</thinking>
<audit_internal>审查过程不得展示</audit_internal>
<private_intent>NPC 准备背叛<variable>{"path":"secret","op":"set","value":true}</variable></private_intent>
<evidence_refs>["WB-KONOHA-01", "MEM-TURN-7"]</evidence_refs>
<final><emphasis>雨声压在木叶屋檐上。</emphasis>值守忍者合上名册。</final>
<relationship>{"npc":"甲","trust_change":1,"inner_thoughts":"不公开"}</relationship>
<status_query />`;
  const artifact = createNarrativeArtifact(raw);

  assert.equal(artifact.displayText, '雨声压在木叶屋檐上。值守忍者合上名册。');
  assert.deepEqual(artifact.instructions.map(block => block.tag), ['relationship', 'status_query']);
  assert.doesNotMatch(renderNarrativeInstructions(artifact), /path.*secret/s);
  assert.match(artifact.auditInternal, /内部推理/);
  assert.match(artifact.auditInternal, /NPC 准备背叛/);
  assert.ok(!artifact.evidenceRefs.includes('E1'));
  assert.ok(!artifact.evidenceRefs.includes('EV-P2-SECRET-01'));
  assert.ok(artifact.evidenceRefs.includes('WB-KONOHA-01'));
  assert.equal('rawResponse' in artifact, false);
});

await test('only the narrow display projection is safe to persist', () => {
  const artifact = createNarrativeArtifact('<analysis>永不入库的推理</analysis><final>可保存正文</final><memory>{"summary":"机器记忆"}</memory>');
  assert.equal(toPersistedNarrative(artifact), '可保存正文');
  assert.deepEqual(toNarrativeDisplayRecord(artifact), { displayText: '可保存正文' });
  const persisted = JSON.stringify(toNarrativeDisplayRecord(artifact));
  assert.doesNotMatch(persisted, /永不入库|机器记忆|analysis|memory/);
});

await test('update manifest is a hidden machine instruction, never visible prose', () => {
  const raw = '<final>公开正文</final><update_manifest>{"domains":{},"present_npcs":{},"active_missions":{}}</update_manifest>';
  const artifact = createNarrativeArtifact(raw);
  assert.equal(artifact.displayText, '公开正文');
  assert.deepEqual(artifact.instructions.map(block => block.tag), ['update_manifest']);
  assert.match(renderNarrativeInstructions(artifact), /<update_manifest>/);
});

await test('private aliases, private attributes and malformed tails never reach display', () => {
  const raw = `公开第一句。
<model_private_notes>隐藏备注</model_private_notes>
<context visibility="private">幕后坐标</context>
<npc_intent>私密动机</npc_intent>
公开第二句。`;
  assert.equal(sanitizeNarrativeDisplayText(raw), '公开第一句。\n\n公开第二句。');
  assert.equal(sanitizeNarrativeDisplayText('公开正文<audit_internal>未闭合秘密'), '公开正文');
  assert.equal(sanitizeNarrativeDisplayText('公开正文<script>危险脚本</script><style>危险样式</style>'), '公开正文');
  assert.equal(sanitizeNarrativePartialText('公开正文<private_intent>流式秘密'), '公开正文');
  assert.equal(sanitizeNarrativePartialText('公开正文<varia'), '公开正文');
  assert.equal(sanitizeNarrativePartialText('公开正文<status_query /'), '公开正文');
});

await test('bare visual-contract JSON never reaches display or persistence projections', () => {
  const bareContract = '{"schema":"naruto.visual-contract/v1","purpose":"turn_illustration","scene":{"summary":"VISUAL_PROMPT_SECRET"}}';
  const raw = `公开正文。\n${bareContract}\n公开结尾。`;
  const artifact = createNarrativeArtifact(raw);

  assert.equal(sanitizeNarrativeDisplayText(raw), '公开正文。\n\n公开结尾。');
  assert.equal(artifact.displayText, '公开正文。\n\n公开结尾。');
  assert.equal(toPersistedNarrative(artifact), '公开正文。\n\n公开结尾。');
  assert.doesNotMatch(JSON.stringify(toNarrativeDisplayRecord(artifact)), /VISUAL_PROMPT_SECRET|naruto\.visual-contract|"schema"/);
  assert.equal(sanitizeNarrativePartialText('公开正文。{"sche'), '公开正文。');
});

await test('InstructionParser uses the same safe final and streaming boundary', () => {
  const finalText = instructionParser.cleanupResponse('<review_audit>审查秘密</review_audit><final>正文</final><private>NPC秘密</private>');
  const partialText = instructionParser.cleanupPartialResponse('<audit_internal>正在生成内部审查');
  assert.equal(finalText, '正文');
  assert.equal(partialText, '');
});

await test('JSON strings retain literal markup while outer private scopes stay isolated', () => {
  const literal = createNarrativeArtifact(`<final>公开正文</final><memory>{"summary":"摘要<audit_internal>秘密审校</audit_internal>","facts":["<private>NPC秘密</private>"]}</memory>`);
  assert.equal(literal.displayText, '公开正文');
  assert.equal(instructionParser.parse(renderNarrativeInstructions(literal)).memory.summary, '摘要<audit_internal>秘密审校</audit_internal>');

  const escaped = createNarrativeArtifact(`<final>公开正文</final><memory>{"summary":"保留：\\u003cprivate\\u003e秘密\\u003c/private\\u003e公开事实","facts":[]}</memory>`);
  const parsed = instructionParser.parse(renderNarrativeInstructions(escaped));
  assert.equal(parsed.memory.summary, '保留：<private>秘密</private>公开事实');
  assert.equal(renderNarrativeInstructions(createNarrativeArtifact('<private><memory>{"summary":"隐藏数据"}</memory></private>')), '');
});

await test('review prompt receives ordinary future plot evidence and a safe candidate', () => {
  const messages = buildNarrativeReviewMessages({
    sourceMessages: [{ role: 'system', content: '<<< CURRENT_PLOT_START current=K052-03-01 target=K052-03-04 days_until=3 date_relation=future >>>\n场景标题: 三日后的会面\n<<< CURRENT_PLOT_END >>>' }],
    candidateResponse: '<thinking>草稿私密推理</thinking><final>候选正文写错了当前日期。</final>',
    feedback: '把日期修正，但不要替玩家行动。'
  });
  const request = messages.map(message => message.content).join('\n');
  assert.match(request, /候选正文写错了当前日期/);
  assert.match(request, /把日期修正/);
  assert.doesNotMatch(request, /草稿私密推理/);
  assert.match(request, /尚未提交|非提交预览/);
  assert.match(request, /三日后的会面/);
  assert.doesNotMatch(request, /未来硬隔离|NEXT_ANCHOR|FUTURE_ONLY|protected_future/);
});

await test('review output becomes an uncommitted artifact with hidden audit', () => {
  const raw = `<audit_internal>问题位置：首句 → 违反证据：E1 → 替换文本：改回当前日期 → 复检结果：通过。</audit_internal>
<final>雨声压在木叶屋檐上，值守忍者合上名册。走廊尽头的脚步停在门外，来人没有擅自闯入，只隔着门板等待回应。</final>`;
  const artifact = parseNarrativeReviewPreview(raw);
  assert.match(artifact.auditInternal, /违反证据/);
  assert.doesNotMatch(artifact.displayText, /问题位置|违反证据/);
  assert.match(artifact.displayText, /雨声压在木叶屋檐上/);
});

await test('receiving a preview does not create a commit candidate', () => {
  let transaction = createNarrativeReviewTransaction({ candidateResponse: '<thinking>原稿推理</thinking><final>原稿正文</final>' });
  transaction = beginNarrativeReview(transaction);
  transaction = receiveNarrativeReviewPreview(
    transaction,
    '<audit_internal>审查秘密</audit_internal><final>预览正文</final>'
  );

  assert.equal(transaction.state, 'preview');
  assert.equal(resolveNarrativeReviewArtifact(transaction), null);
  const view = toNarrativeReviewPreviewView(transaction);
  assert.equal(view.displayText, '预览正文');
  assert.doesNotMatch(JSON.stringify(view), /审查秘密|原稿推理/);
  assert.equal(toPersistedReviewNarrative(transaction), null);
});

await test('review can retry with feedback indefinitely and rejects stale results', () => {
  let transaction = createNarrativeReviewTransaction({ candidateResponse: '原稿正文' });
  transaction = beginNarrativeReview(transaction);
  transaction = receiveNarrativeReviewPreview(transaction, '<audit>第一次</audit><final>第一次预览</final>');

  for (let index = 2; index <= 25; index++) {
    transaction = retryNarrativeReview(transaction, { feedback: `第 ${index} 次反馈` });
    assert.equal(getNarrativeReviewRequestArtifact(transaction).displayText, `${index - 1 === 1 ? '第一次' : `第 ${index - 1} 次`}预览`);
    assert.throws(
      () => receiveNarrativeReviewPreview(transaction, '<audit>过期</audit><final>过期结果</final>', { attemptNumber: index - 1 }),
      /Stale narrative review result/
    );
    transaction = receiveNarrativeReviewPreview(
      transaction,
      `<audit>第 ${index} 次审查</audit><final>第 ${index} 次预览</final>`,
      { attemptNumber: index }
    );
  }

  assert.equal(transaction.activeAttempt, 25);
  assert.equal(transaction.attempts.at(-1).feedback, '第 25 次反馈');
  transaction = applyNarrativeReview(transaction);
  assert.equal(transaction.state, 'applied');
  assert.equal(toPersistedReviewNarrative(transaction), '第 25 次预览');
  assert.doesNotMatch(toPersistedReviewNarrative(transaction), /审查/);
});

await test('discard selects the original candidate and failure remains retryable', () => {
  let failed = createNarrativeReviewTransaction({ candidateResponse: '<audit>原稿内部</audit><final>原稿正文</final>' });
  failed = beginNarrativeReview(failed);
  failed = failNarrativeReview(failed, new Error('模型暂时失败'));
  assert.equal(failed.state, 'failed');
  assert.equal(toNarrativeReviewPreviewView(failed).canRetry, true);
  failed = retryNarrativeReview(failed, { feedback: '再试一次' });
  failed = receiveNarrativeReviewPreview(failed, '<audit>新审查</audit><final>不采用的预览</final>');
  const discarded = discardNarrativeReview(failed);
  assert.equal(discarded.state, 'discarded');
  assert.equal(toPersistedReviewNarrative(discarded), '原稿正文');
  assert.equal(resolveNarrativeReviewArtifact(discarded), discarded.baseArtifact);
});

await test('disabled review returns an artifact without issuing an auxiliary request', async () => {
  const artifact = await requestNarrativeReviewPreview({
    mainConfig: { narrativeReview: { enabled: false } },
    candidateResponse: '<thinking>内部</thinking><final>单模型正文</final>'
  });
  assert.equal(artifact.displayText, '单模型正文');
  assert.equal(artifact.auditInternal, '内部');
});

console.log(`PASS ${passed} narrative artifact and review transaction regression checks.`);
