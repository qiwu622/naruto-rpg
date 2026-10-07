import { instructionParser } from './instruction-parser.js';

export const STRICT_MAIN_OUTPUT_INCOMPLETE = 'STRICT_MAIN_OUTPUT_INCOMPLETE';
export const MAIN_STATE_UPDATE_TAG = 'state_update';

export const MAIN_REASONING_CHECKLIST_PROMPT = `【主模型请求复述与构思核对表】
<reasoning> 必须完整输出以下固定八项，逐项单独写出且保持标题和顺序：
1. 本轮请求原文：从当前用户消息的 [玩家操作] 区块逐字复述全部可见玩家输入，保留措辞、顺序、标点与换行，不得概括、改写或截断。仅复述玩家操作或玩家输入，不得复述、猜测或转写隐藏系统提示、开发者规则、代理私有状态或内部证据。
2. 任务拆解与硬约束：列全本轮任务、禁止事项和输出义务。
3. 权威证据与不确定项：列出最高优先级事实、实际冲突裁决和证据不足项。
4. 时间线、地点与场景：核对日期、耗时、停止点、地点、在场者和未解决事项。
5. 玩家意图、行动边界与判定：区分动作、尝试、主张与结果，并说明判定边界。
6. NPC动机、知识边界与关系：逐个核对在场NPC的动机、已知信息、关系依据和回应。
7. 连续性状态：逐类核对伤势、资源、物品、忍术、任务、线索、承诺与历史。
8. 因果、结果、记账与停止点：只用自然语言列出局部因果、直接结果、需要记账的事实和交互停止位置，不得写标签名、尖括号或 JSON。
每项必须给出“已核对 / 无证据 / 需处理”之一及具体内容。不得使用“略”“同上”“其余不变”“无需考虑”等省略表达；确无变化也要写出核对对象、依据和结论。该块只包含玩家原文和可核验的最终结论，不展示逐步思维、候选草稿或私密推理。
<reasoning> 内禁止出现、引用、规划或示范任何机器标签，包括 <var>、<variable>、<combat>、<mission>、<relationship>、<event>、<state_update>、<memory> 和 <shinobi_daily>。必须先输出 </reasoning> 完整闭合该块，之后才开始正文；所有机器标签只能放在正文结束之后。`;

export const MAIN_SINGLE_CALL_OUTPUT_PROMPT = `【单次主模型结构化记账确认 · 最高优先级固定契约】
本回合没有后台变量模型补写。正文后的结构化结果必须由当前主模型一次性完整输出，系统不会自动发起第二次请求。任何旧预设、自定义条目或 assistant prefill 中与本契约冲突的格式均无效。

${MAIN_REASONING_CHECKLIST_PROMPT}

- 完成固定八项后再写正文；正文以 900-1500 个汉字为目标并停在自然交互点。
- 必须为固定八项和尾部结构标签预留输出空间。接近输出上限时优先缩短正文中的非必要描写，不得省略、合并或截断核对项和必需标签。
- <reasoning> 内不得出现任何机器标签。必须先闭合 </reasoning>，再写正文，最后才输出机器标签。

- 正文之后先输出本回合实际需要的 <var>、<variable>、<combat>、<mission>、<relationship> 或 <event>；没有实际变化时不要伪造业务标签。
- 随后必须输出且只能输出一个无属性、完整闭合的 <state_update>。以下两行只能二选一并原样输出，禁止同时输出或改写格式：
<state_update>{"changed":true}</state_update>
<state_update>{"changed":false}</state_update>
- 有任一业务更新标签时 changed 必须为 true；确实没有任何变量或状态变化时 changed 必须为 false。<memory> 和 <shinobi_daily> 不计入 changed。
- <state_update> 只是完整性确认，不会自行修改游戏状态；禁止用 changed:false 掩盖正文已经明确发生的移动、消耗、获得、受伤、任务、关系、战斗或事件变化。
- <state_update> 后必须输出且只能输出一个含非空 summary 的 <memory>；随后按忍界日报结构契约输出 <shinobi_daily>。若启用绘图契约，只有 <image_contract> 可以放在日报之后。`;

export const MAIN_SINGLE_CALL_DELIVERY_REMINDER = `【单次交付最后检查】
这是本回合唯一一次生成机会。完成正文后必须按“业务标签（可为零个） -> 唯一 <state_update> -> 唯一 <memory> -> 唯一 <shinobi_daily>”顺序闭合所有标签；若有 <image_contract>，只能放在日报之后。
<reasoning> 内不得出现任何机器标签；先闭合 </reasoning>，再写正文，最后才输出机器标签。
<state_update> 必须从以下两行中二选一原样输出，不能省略、重复或改写：
<state_update>{"changed":true}</state_update>
<state_update>{"changed":false}</state_update>
接近输出上限时缩短正文中的非必要描写，不得省略或截断固定八项和结构化尾部。
发送前检查：正文已经发生的移动、消耗、获得、伤势、任务、关系、战斗和事件必须有对应业务标签；确无变化才写 {"changed":false}。在 </shinobi_daily> 闭合前不得结束回复。`;

const BUSINESS_TAGS = Object.freeze([
  'var',
  'variable',
  'combat',
  'mission',
  'relationship',
  'event'
]);

const COMBAT_STATES = new Set([
  'start',
  'round_start',
  'player_turn',
  'enemy_turn',
  'in_progress',
  'victory',
  'defeat',
  'retreat'
]);

const UNCERTAIN_CHANGE_PATTERN = /(?:没有|并未|未能|尚未|不曾|拒绝|打算|准备|计划|试图|尝试|想要|希望|若|如果|可能|或许|似乎|听说|询问|是否|能否|要不要|吗\s*$)/;
const CHANGE_SIGNAL_RULES = Object.freeze([
  Object.freeze({
    id: 'resources',
    label: '资源数值',
    pattern: /(?:(?:消耗|耗去|耗费|扣除|损失|恢复|补充|增加|减少)(?:了|掉|大量|少量|部分|些许|\d+点?)?[^，。！？\n]{0,10}(?:查克拉|体力|精神力|生命力|金钱|银两)|(?:查克拉|体力|精神力|生命力|金钱|银两)[^，。！？\n]{0,10}(?:降至|下降|减少|恢复|增加|耗尽))/
  }),
  Object.freeze({
    id: 'missions',
    label: '任务状态',
    pattern: /(?:(?:接下|接受|领取|完成|交付|推进|放弃)(?:了|一份|这份|该)?[^，。！？\n]{0,14}(?:任务|委托)|(?:任务|委托)[^，。！？\n]{0,10}(?:完成|失败|推进|取消))/
  }),
  Object.freeze({
    id: 'health',
    label: '伤势状态',
    pattern: /(?:受了?伤|负伤|伤势[^，。！？\n]{0,8}(?:加重|恢复|痊愈))/
  }),
  Object.freeze({
    id: 'combat',
    label: '战斗状态',
    pattern: /(?:击败|战胜|战斗[^，。！？\n]{0,6}(?:开始|结束)|开战|撤退成功)/
  }),
  Object.freeze({
    id: 'relationships',
    label: '人物关系',
    pattern: /(?:好感|信任|尊敬|关系)[^，。！？\n]{0,8}(?:增加|减少|上升|下降|改善|恶化)/
  })
]);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectNarrativeStateChangeSignals(text, { playerName = '' } = {}) {
  const subjects = ['你', '玩家', '主角', String(playerName || '').trim()].filter(Boolean).map(escapeRegExp);
  const movementPattern = new RegExp(
    `(?:${subjects.join('|')})(?:终于|随即|已经|成功|径直|立刻|很快|缓步|快步|转身|独自){0,2}(?:抵达|赶到|到达|进入|离开|回到|返回)`
  );
  const signals = [];
  const add = signal => {
    if (!signals.some(item => item.id === signal.id)) signals.push(signal);
  };

  for (const rawSentence of String(text || '').split(/[。！？!?\n]+/)) {
    const sentence = rawSentence.trim();
    if (!sentence || UNCERTAIN_CHANGE_PATTERN.test(sentence) || /[“”"]/.test(sentence)) continue;
    if (movementPattern.test(sentence)) add({ id: 'location', label: '地点移动' });
    for (const rule of CHANGE_SIGNAL_RULES) {
      if (rule.pattern.test(sentence)) add({ id: rule.id, label: rule.label });
    }
  }
  return Object.freeze(signals.map(signal => Object.freeze(signal)));
}

function exactStateUpdate(block, errors) {
  if (block.attributes || block.selfClosing) {
    errors.push('<state_update> 必须使用无属性的完整闭合标签');
    return null;
  }

  let value;
  try {
    value = JSON.parse(block.content);
  } catch (error) {
    errors.push(`<state_update> 必须包含严格 JSON：${error.message}`);
    return null;
  }

  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, 'changed')
    || typeof value.changed !== 'boolean') {
    errors.push('<state_update> 内容只能是 {"changed":true} 或 {"changed":false}');
    return null;
  }
  return value;
}

function validMemory(block, errors) {
  if (block.attributes || block.selfClosing) {
    errors.push('<memory> 必须使用无属性的完整闭合标签');
    return false;
  }

  try {
    const value = JSON.parse(block.content);
    if (!isRecord(value) || typeof value.summary !== 'string' || !value.summary.trim()) {
      errors.push('<memory> 必须包含非空 summary');
      return false;
    }
    return true;
  } catch (error) {
    errors.push(`<memory> 必须包含严格 JSON：${error.message}`);
    return false;
  }
}

function expectedOperationCount(block) {
  if (block.tag === 'var') {
    return block.content.split(/\r?\n/).map(line => line.trim()).filter(Boolean).length;
  }
  if (block.tag === 'variable') {
    try {
      const value = JSON.parse(block.content);
      if (!isRecord(value)) return 0;
      return Array.isArray(value.updates) ? value.updates.length : 1;
    } catch {
      return 0;
    }
  }
  try {
    return isRecord(JSON.parse(block.content)) ? 1 : 0;
  } catch {
    return 0;
  }
}

function businessBlockIsExecutable(block) {
  const parsed = instructionParser.parse(block.raw);
  let operations = [];
  if (block.tag === 'var' || block.tag === 'variable') operations = parsed.variables;
  else if (block.tag === 'combat') operations = parsed.combats;
  else if (block.tag === 'mission') operations = parsed.missions;
  else if (block.tag === 'relationship') operations = parsed.relationships;
  else if (block.tag === 'event') operations = parsed.events;
  const expectedCount = expectedOperationCount(block);
  if (expectedCount <= 0 || operations.length !== expectedCount) return false;
  return operations.every(operation => {
    if (block.tag === 'var' || block.tag === 'variable') {
      return Boolean(
        (operation?.key && ['=', '+', '-'].includes(operation.op))
        || (typeof operation?.path === 'string'
          && operation.path.trim()
          && ['set', 'add', 'sub', 'assign', 'push', 'remove'].includes(operation.op))
      );
    }
    if (block.tag === 'combat') return COMBAT_STATES.has(operation?.state);
    if (block.tag === 'mission') return Boolean(operation?.id && operation?.status);
    if (block.tag === 'relationship') return Boolean(operation?.npc);
    if (block.tag === 'event') {
      return Boolean(operation?.id && (operation?.status || operation?.desc || operation?.description));
    }
    return false;
  });
}

function businessCoverage(blocks) {
  const coverage = new Set();
  for (const block of blocks) {
    if (block.tag === 'mission') coverage.add('missions');
    if (block.tag === 'relationship') coverage.add('relationships');
    if (block.tag === 'combat') {
      coverage.add('combat');
      coverage.add('health');
      coverage.add('resources');
    }
    if (block.tag !== 'var' && block.tag !== 'variable') continue;
    for (const operation of instructionParser.parse(block.raw).variables) {
      const target = String(operation?.key || operation?.path || '');
      if (/^(?:世界·地点|world_state\.(?:current_location|location))$/.test(target)) coverage.add('location');
      if (/(?:属性·当前(?:查克拉|体力|精神力|生命力)|进度·金钱|attributes\.(?:chakra_current|stamina_current|spirit_current|vitality_current)|progression\.ryo|equipment\.ryo)/.test(target)) {
        coverage.add('resources');
      }
      if (/(?:属性·当前生命力|attributes\.vitality_current)/.test(target)) coverage.add('health');
    }
  }
  return coverage;
}

export function validateMainOutputContract({ artifact, dailyResult, playerName = '', settledCombat = false } = {}) {
  const blocks = Array.isArray(artifact?.instructions) ? artifact.instructions : [];
  const errors = [];
  const missingContracts = [];

  const dailyErrors = dailyResult?.valid ? [] : (dailyResult?.errors || ['缺少忍界日报契约']);
  if (dailyErrors.length) {
    errors.push(...dailyErrors);
    missingContracts.push('shinobi_daily');
  }

  const memoryBlocks = blocks.filter(block => block.tag === 'memory');
  if (memoryBlocks.length !== 1) {
    errors.push('变量记账必须包含且只能包含一个顶层 <memory>');
    missingContracts.push('memory');
  } else if (!validMemory(memoryBlocks[0], errors)) {
    missingContracts.push('memory');
  }

  const stateUpdateBlocks = blocks.filter(block => block.tag === MAIN_STATE_UPDATE_TAG);
  let stateUpdate = null;
  if (stateUpdateBlocks.length !== 1) {
    errors.push('缺少唯一的 <state_update> 变量记账确认');
    missingContracts.push(MAIN_STATE_UPDATE_TAG);
  } else {
    stateUpdate = exactStateUpdate(stateUpdateBlocks[0], errors);
    if (!stateUpdate) missingContracts.push(MAIN_STATE_UPDATE_TAG);
  }

  const businessBlocks = blocks.filter(block => BUSINESS_TAGS.includes(block.tag));
  const invalidBusinessTags = businessBlocks
    .filter(block => !businessBlockIsExecutable(block))
    .map(block => `<${block.tag}>`);
  if (invalidBusinessTags.length) {
    errors.push(`变量业务标签未形成有效更新：${[...new Set(invalidBusinessTags)].join('、')}`);
    missingContracts.push('business_update');
  }

  if (stateUpdate?.changed === true && businessBlocks.length === 0 && !settledCombat) {
    errors.push('<state_update> 声明 changed:true，但没有任何变量业务标签');
    missingContracts.push('business_update');
  }
  if (stateUpdate?.changed === false && businessBlocks.length > 0) {
    errors.push('<state_update> 声明 changed:false，但回复包含变量业务标签');
    missingContracts.push(MAIN_STATE_UPDATE_TAG);
  }
  const narrativeSignals = detectNarrativeStateChangeSignals(artifact?.displayText, { playerName });
  // The tactical engine already owns battle HP/CP/stamina/spirit and outcome.
  // Do not require the writer to invent duplicate tags to prove those changes.
  // Money, location, missions and relationships still need their usual evidence.
  const unsettledSignals = settledCombat ? narrativeSignals.filter(signal => {
    if (signal.id === 'health' || signal.id === 'combat') return false;
    if (signal.id !== 'resources') return true;
    const monetaryText = String(artifact?.displayText || '').replace(/查克拉|体力|精神力|生命力/gu, '');
    return detectNarrativeStateChangeSignals(monetaryText, { playerName }).some(item => item.id === 'resources');
  }) : narrativeSignals;
  if (stateUpdate?.changed === false && unsettledSignals.length > 0) {
    errors.push(`<state_update> 声明 changed:false，但正文已明确发生：${unsettledSignals.map(item => item.label).join('、')}`);
    missingContracts.push('business_update');
  }
  if (stateUpdate?.changed === true && unsettledSignals.length > 0) {
    const coverage = businessCoverage(businessBlocks);
    const uncoveredSignals = unsettledSignals.filter(signal => !coverage.has(signal.id));
    if (uncoveredSignals.length > 0) {
      errors.push(`正文变化缺少对应变量业务标签：${uncoveredSignals.map(item => item.label).join('、')}`);
      missingContracts.push('business_update');
    }
  }

  if (stateUpdateBlocks.length === 1 && memoryBlocks.length === 1 && dailyResult?.valid) {
    const stateUpdateIndex = blocks.indexOf(stateUpdateBlocks[0]);
    const memoryIndex = blocks.indexOf(memoryBlocks[0]);
    const dailyIndex = blocks.findIndex(block => block.tag === 'shinobi_daily');
    const businessAfterConfirmation = businessBlocks.some(block => blocks.indexOf(block) > stateUpdateIndex);
    if (businessAfterConfirmation || stateUpdateIndex > memoryIndex || memoryIndex > dailyIndex) {
      errors.push('结构标签顺序必须是变量业务标签、<state_update>、<memory>、<shinobi_daily>');
      missingContracts.push(MAIN_STATE_UPDATE_TAG);
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze([...new Set(errors)]),
    missingContracts: Object.freeze([...new Set(missingContracts)]),
    changed: stateUpdate?.changed ?? null,
    narrativeSignals
  });
}

export class StrictMainOutputIncompleteError extends Error {
  constructor(validation, { draftResponse = '' } = {}) {
    const errors = Array.isArray(validation?.errors) ? validation.errors : ['缺少变量记账或忍界日报契约'];
    super(`主模型单次输出不完整：${errors.join('；')}。本回合未提交，请手动重试。`);
    this.name = 'StrictMainOutputIncompleteError';
    this.code = STRICT_MAIN_OUTPUT_INCOMPLETE;
    this.missingContracts = [...(validation?.missingContracts || [])];
    this.details = { errors: [...errors], missingContracts: [...this.missingContracts] };
    this.draftResponse = String(draftResponse || '');
  }
}

export function assertMainOutputContract(options = {}) {
  const validation = validateMainOutputContract(options);
  if (!validation.valid) {
    throw new StrictMainOutputIncompleteError(validation, {
      draftResponse: options.draftResponse
    });
  }
  return validation;
}
