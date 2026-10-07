export const IMPORTED_PRESET_OUTPUT_INCOMPLETE = 'IMPORTED_PRESET_OUTPUT_INCOMPLETE';

const PRIVATE_WRAPPER_NAME_PATTERN = /(?:think|thought|reason|analysis|planning|driver|思维|思考|推理)/iu;
const PRIVATE_WRAPPER_EXCLUSION_PATTERN = /(?:^|[_:.-])(?:chain_of_thought|thought_of_chain|thinking_rules|thinking_step|data_analysis_protocol)$|(?:format|rules?|protocol|schema|template|setting|steps?)$|(?:锚定|协议|规则|设定|格式)$/iu;
const OUTPUT_DIRECTIVE_PATTERN = /(?:包裹|输出|思维链|思考过程|推理过程|正文之前|开始思考|完整格式|严格.{0,12}格式|planning|thinking|reasoning)/iu;
const XMLISH_TAG_PATTERN = /<\s*(\/?)\s*([A-Za-z_\u3400-\u9fff][\w.\-:\u3400-\u9fff]*~?)([^<>]*?)>/g;
const PROJECT_MACHINE_TAGS = new Set([
  'var',
  'variable',
  'combat',
  'mission',
  'relationship',
  'event',
  'state_update',
  'memory',
  'shinobi_daily',
  'status_query',
  'update_manifest',
  'var_thinking',
  'variable_thinking'
]);
const ROOT_DECLARATION_PATTERNS = Object.freeze([
  /根(?:节点|元素)\s*(?:必须|应当|应|需)?\s*(?:是|为)\s*[`'"“”‘’]*\s*<\s*([A-Za-z_\u3400-\u9fff][\w.\-:\u3400-\u9fff]*~?)(?=[\s>])/giu,
  /root\s+(?:node|element)\s*(?:must\s+be|should\s+be|is|[:=])\s*[`'"“”‘’]*\s*<\s*([A-Za-z_\u3400-\u9fff][\w.\-:\u3400-\u9fff]*~?)(?=[\s>])/giu
]);
const MACHINE_TAIL_CONTAINER_NAME_PATTERN = /(?:^|[_:.-])(?:after[_:.-]?format|post[_:.-]?output|afterword|tail|footer)(?:$|[_:.-])/iu;

export const IMPORTED_PRESET_ADAPTER_IDS = Object.freeze({
  FOX_V18: 'fox-v18',
  IZUMI_0707: 'izumi-0707',
  DREAM_WHALE_V4: 'dream-whale-v4',
  MIEMIE_V5: 'miemie-v5'
});

const DEDICATED_PRIVATE_WRAPPERS = Object.freeze({
  [IMPORTED_PRESET_ADAPTER_IDS.FOX_V18]: Object.freeze(['think_fox~']),
  [IMPORTED_PRESET_ADAPTER_IDS.IZUMI_0707]: Object.freeze(['konatan_planning~']),
  [IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4]: Object.freeze(['think', 'simple_thinking']),
  [IMPORTED_PRESET_ADAPTER_IDS.MIEMIE_V5]: Object.freeze([
    'acg_think',
    'combat_driver',
    'story_driver',
    'parallel_line_drive',
    'think'
  ])
});

const DEDICATED_SIGNATURE_TAGS = Object.freeze({
  [IMPORTED_PRESET_ADAPTER_IDS.FOX_V18]: Object.freeze([
    'think_fox~', 'content', 'fox_selc', 'fox_tip'
  ]),
  [IMPORTED_PRESET_ADAPTER_IDS.IZUMI_0707]: Object.freeze([
    'konatan_planning~', 'current_event', 'progress', 'tucao'
  ]),
  [IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4]: Object.freeze([
    'dream_plot', 'dream_body', 'dream_after_format', 'dream_scene',
    'dream_parallel_event', 'simple_thinking'
  ]),
  [IMPORTED_PRESET_ADAPTER_IDS.MIEMIE_V5]: Object.freeze([
    'acg_think', 'combat_driver', 'story_driver', 'story_scene',
    'memory_log', 'wlog', 'status', 'affinity'
  ])
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedWrapperName(value) {
  return String(value || '').trim().toLowerCase().replace(/~+$/, '');
}

function xmlishTokens(value) {
  const pattern = new RegExp(XMLISH_TAG_PATTERN.source, XMLISH_TAG_PATTERN.flags);
  const tokens = [];
  let match;
  while ((match = pattern.exec(String(value || ''))) !== null) {
    const closing = Boolean(match[1]);
    const attributes = String(match[3] || '');
    tokens.push({
      index: match.index,
      end: match.index + String(match[0] || '').length,
      raw: String(match[0] || ''),
      name: String(match[2] || ''),
      key: String(match[2] || '').toLowerCase(),
      attributes,
      closing,
      selfClosing: !closing && /\/\s*$/.test(attributes)
    });
  }
  return tokens;
}

function pushUniqueTag(target, seen, tag) {
  const value = String(tag || '').trim();
  const key = value.toLowerCase();
  if (!value || seen.has(key)) return;
  seen.add(key);
  target.push(value);
}

function declaredRootsForSource(source) {
  const declarations = [];
  for (const declarationPattern of ROOT_DECLARATION_PATTERNS) {
    declarationPattern.lastIndex = 0;
    let match;
    while ((match = declarationPattern.exec(String(source || ''))) !== null) {
      declarations.push({ tag: String(match[1] || ''), index: match.index });
    }
  }
  return declarations.sort((left, right) => left.index - right.index);
}

function directChildrenFromRootTemplates(source, rootWrapper) {
  const rootKey = String(rootWrapper || '').toLowerCase();
  const tokens = xmlishTokens(source);
  const bodies = [];
  let latestOpening = null;

  // Prompt prose often mentions an opening root token before showing the real
  // template. Pair each close with the nearest opening so that the literal
  // template wins over an earlier prose mention.
  for (const token of tokens) {
    if (token.key !== rootKey) continue;
    if (!token.closing && !token.selfClosing) {
      latestOpening = token;
      continue;
    }
    if (token.closing && latestOpening && latestOpening.index < token.index) {
      bodies.push({ start: latestOpening.end, end: token.index });
      latestOpening = null;
    }
  }

  const children = [];
  const seen = new Set();
  for (const body of bodies) {
    const stack = [];
    for (const token of tokens) {
      if (token.index < body.start || token.end > body.end || token.key === rootKey) continue;
      if (token.closing) {
        const matchingIndex = stack.map(item => item.key).lastIndexOf(token.key);
        if (matchingIndex >= 0) stack.splice(matchingIndex);
        continue;
      }
      if (!stack.length) pushUniqueTag(children, seen, token.name);
      if (!token.selfClosing) stack.push(token);
    }
  }
  return children;
}

function requiredOnceTags(source) {
  const value = String(source || '');
  const tags = [];
  const seen = new Set();
  const patterns = [
    /<\s*([A-Za-z_\u3400-\u9fff][\w.\-:\u3400-\u9fff]*~?)(?=[\s>])[^<>]*>\s*[`'"“”‘’]*\s*(?:必须|应当|须|需)\s*(?:恰好|仅|只)?\s*出现\s*(?:且仅)?\s*一次/giu,
    /<\s*([A-Za-z_\u3400-\u9fff][\w.\-:\u3400-\u9fff]*~?)(?=[\s>])[^<>]*>\s*[`'"“”‘’]*\s*must\s+(?:appear|occur|be\s+present)\s+(?:exactly\s+)?once/giu,
    /(?:必须|应当|须|需)\s*(?:包含|输出|提供)\s*(?:唯一|仅有|恰好)?\s*(?:一个|一次)?\s*[`'"“”‘’]*\s*<\s*([A-Za-z_\u3400-\u9fff][\w.\-:\u3400-\u9fff]*~?)(?=[\s>])/giu,
    /(?:must|should)\s+(?:contain|include|provide)\s+(?:exactly\s+)?(?:one|a\s+single)\s*[`'"“”‘’]*\s*<\s*([A-Za-z_\u3400-\u9fff][\w.\-:\u3400-\u9fff]*~?)(?=[\s>])/giu
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) pushUniqueTag(tags, seen, match[1]);
  }
  return tags;
}

function xsdChildrenForRoot(source, rootWrapper) {
  const rootKey = String(rootWrapper || '').toLowerCase();
  const tokens = xmlishTokens(source);
  const children = [];
  const seen = new Set();
  let elementDepth = 0;

  for (const token of tokens) {
    if (token.key !== 'xs:element') continue;
    if (token.closing) {
      if (elementDepth > 0) elementDepth--;
      continue;
    }

    const nameMatch = token.attributes.match(/\bname\s*=\s*(["'])(.*?)\1/iu);
    const elementName = String(nameMatch?.[2] || '').trim();
    if (elementDepth === 0) {
      if (elementName.toLowerCase() !== rootKey || token.selfClosing) continue;
      elementDepth = 1;
      continue;
    }

    if (elementDepth === 1 && elementName) {
      const optional = /\bminOccurs\s*=\s*(["'])0\1/iu.test(token.attributes);
      if (!optional) pushUniqueTag(children, seen, elementName);
    }
    if (!token.selfClosing) elementDepth++;
  }
  return children;
}

function deriveDeclaredRootContract(sources) {
  const candidates = new Map();
  let sequence = 0;
  for (const { source } of sources) {
    for (const declaration of declaredRootsForSource(source)) {
      const key = declaration.tag.toLowerCase();
      const current = candidates.get(key) || { tag: declaration.tag, count: 0, first: sequence++ };
      current.count++;
      candidates.set(key, current);
    }
  }
  const selected = [...candidates.values()]
    .sort((left, right) => right.count - left.count || left.first - right.first)[0];
  if (!selected) {
    return { rootWrapper: '', requiredDisplayWrappers: [], machineTailContainer: '' };
  }

  const rootWrapper = selected.tag;
  const requiredDisplayWrappers = [];
  const seen = new Set();
  const addDisplayWrapper = tag => {
    const value = String(tag || '').trim();
    const key = value.toLowerCase();
    if (!value || key === rootWrapper.toLowerCase() || isPrivateWrapperName(value) || PROJECT_MACHINE_TAGS.has(key)) return;
    pushUniqueTag(requiredDisplayWrappers, seen, value);
  };

  const declaringSources = sources.filter(({ source }) => declaredRootsForSource(source)
    .some(declaration => declaration.tag.toLowerCase() === rootWrapper.toLowerCase()));
  for (const { source } of declaringSources) {
    for (const tag of directChildrenFromRootTemplates(source, rootWrapper)) addDisplayWrapper(tag);
    for (const tag of requiredOnceTags(source)) addDisplayWrapper(tag);
  }
  for (const { source } of sources) {
    for (const tag of xsdChildrenForRoot(source, rootWrapper)) addDisplayWrapper(tag);
  }

  const machineTailContainer = requiredDisplayWrappers.find(tag => (
    MACHINE_TAIL_CONTAINER_NAME_PATTERN.test(normalizedWrapperName(tag))
  )) || '';
  return { rootWrapper, requiredDisplayWrappers, machineTailContainer };
}

function effectiveAssistantPrefill(preset) {
  const explicit = String(preset?.assistantPrefill || '');
  if (explicit.trim()) return explicit;
  const entries = Array.isArray(preset?.entries) ? preset.entries : [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.enabled === false || entry?.isMarker || entry?.role !== 'assistant') continue;
    const content = String(entry?.content || '');
    if (content.trim()) return content;
  }
  return '';
}

function detectDedicatedAdapter(preset, sources, rootContract) {
  const tagKeys = new Set();
  for (const { source } of sources) {
    for (const token of xmlishTokens(source)) tagKeys.add(token.key);
  }
  const hasSignature = adapterId => DEDICATED_SIGNATURE_TAGS[adapterId]
    .every(tag => tagKeys.has(tag.toLowerCase()));
  const prefill = effectiveAssistantPrefill(preset).trim();
  const matches = [];

  if (hasSignature(IMPORTED_PRESET_ADAPTER_IDS.FOX_V18)
    && /<\s*think_fox~(?=[\s>])[^<>]*>\s*$/iu.test(prefill)) {
    matches.push(IMPORTED_PRESET_ADAPTER_IDS.FOX_V18);
  }
  if (hasSignature(IMPORTED_PRESET_ADAPTER_IDS.IZUMI_0707)
    && /<\s*konatan_planning~(?=[\s>])[^<>]*>[^<>]*$/iu.test(prefill)
    && !/<\s*\/\s*konatan_planning~\s*>\s*$/iu.test(prefill)) {
    matches.push(IMPORTED_PRESET_ADAPTER_IDS.IZUMI_0707);
  }
  if (hasSignature(IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4)
    && String(rootContract?.rootWrapper || '').toLowerCase() === 'dream_plot') {
    const children = (rootContract?.requiredDisplayWrappers || []).map(tag => String(tag).toLowerCase());
    const bodyIndex = children.indexOf('dream_body');
    const afterIndex = children.indexOf('dream_after_format');
    if (bodyIndex >= 0 && afterIndex > bodyIndex) matches.push(IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4);
  }
  if (hasSignature(IMPORTED_PRESET_ADAPTER_IDS.MIEMIE_V5)
    && /<\s*think(?=[\s>])[^<>]*>\s*think\s+is\s+over\.\.\.\s*<\s*\/\s*think\s*>\s*$/iu.test(prefill)
    && (Array.isArray(preset?.regexScripts) ? preset.regexScripts.length : 0) === 0) {
    matches.push(IMPORTED_PRESET_ADAPTER_IDS.MIEMIE_V5);
  }

  return Object.freeze({
    adapterId: matches.length === 1 ? matches[0] : '',
    adapterMatches: Object.freeze(matches)
  });
}

function isPrivateWrapperName(value) {
  const normalized = normalizedWrapperName(value);
  return PRIVATE_WRAPPER_NAME_PATTERN.test(normalized)
    && !PRIVATE_WRAPPER_EXCLUSION_PATTERN.test(normalized);
}

function sourceDeclaresOutputWrapper(source, match, entryName) {
  const tag = String(match?.[2] || '');
  if (!tag || !isPrivateWrapperName(tag)) return false;
  if (tag.endsWith('~')) return true;

  const text = String(source || '');
  const closePattern = new RegExp(`<\\s*\\/\\s*${escapeRegExp(tag)}\\s*>`, 'i');
  const hasClosingTag = closePattern.test(text);
  const start = Math.max(0, Number(match.index || 0) - 220);
  const end = Math.min(text.length, Number(match.index || 0) + String(match[0] || '').length + 320);
  const context = `${entryName || ''}\n${text.slice(start, end)}`;
  if (hasClosingTag) return OUTPUT_DIRECTIVE_PATTERN.test(context);

  // Some imported presets declare the provider's native thinking wrapper by
  // showing only its opening token (for example “在 <think> 标签内思考”).  A
  // nearby, explicit “inside/using/output” directive is strong enough to treat
  // that token as an output contract without mistaking a distant schema name
  // or a prohibition example for a required wrapper.
  const escapedTag = escapeRegExp(tag);
  const explicitUse = new RegExp(
    `(?:<\\s*${escapedTag}(?=[\\s>])[^>]*>\\s*(?:标签)?(?:内|中)|(?:使用|以|用|输出|包裹|开始)[^<>\\n]{0,80}<\\s*${escapedTag}(?=[\\s>]))`,
    'iu'
  );
  return OUTPUT_DIRECTIVE_PATTERN.test(context) && explicitUse.test(context);
}

/**
 * Derive only runtime metadata from an already compiled preset. The imported
 * entries and their source content are never rewritten or supplemented.
 */
export function inspectImportedPresetOutputProfile(preset) {
  const active = preset?._importMode === 'replace';
  if (!active) {
    return Object.freeze({
      active: false,
      sourceFormat: String(preset?._sourceFormat || ''),
      privateWrappers: Object.freeze([]),
      rootWrapper: '',
      requiredDisplayWrappers: Object.freeze([]),
      machineTailContainer: '',
      adapterId: '',
      adapterMatches: Object.freeze([])
    });
  }

  const wrappers = [];
  const seen = new Set();
  const sources = (Array.isArray(preset?.entries) ? preset.entries : [])
    .filter(entry => entry?.enabled !== false && !entry?.isMarker)
    .map(entry => ({ source: String(entry?.content || ''), name: String(entry?.name || '') }));
  if (typeof preset?.assistantPrefill === 'string' && preset.assistantPrefill.trim()) {
    sources.push({ source: preset.assistantPrefill, name: 'assistant_prefill' });
  }

  for (const { source, name } of sources) {
    XMLISH_TAG_PATTERN.lastIndex = 0;
    let match;
    while ((match = XMLISH_TAG_PATTERN.exec(source)) !== null) {
      const closing = Boolean(match[1]);
      const attributes = String(match[3] || '');
      if (closing || /\/\s*$/.test(attributes)) continue;
      const tag = String(match[2] || '');
      if (!sourceDeclaresOutputWrapper(source, match, name)) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      wrappers.push(tag);
      if (wrappers.length >= 16) break;
    }
    if (wrappers.length >= 16) break;
  }

  const rootContract = deriveDeclaredRootContract(sources);
  const dedicated = detectDedicatedAdapter(preset, sources, rootContract);
  const privateWrappers = dedicated.adapterId
    ? DEDICATED_PRIVATE_WRAPPERS[dedicated.adapterId]
    : Object.freeze(wrappers);

  return Object.freeze({
    active: true,
    sourceFormat: String(preset?._sourceFormat || ''),
    privateWrappers,
    rootWrapper: dedicated.adapterId === IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4
      ? 'dream_plot'
      : rootContract.rootWrapper,
    requiredDisplayWrappers: dedicated.adapterId === IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4
      ? Object.freeze(['dream_body', 'dream_after_format'])
      : Object.freeze(rootContract.requiredDisplayWrappers),
    machineTailContainer: dedicated.adapterId === IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4
      ? 'dream_after_format'
      : rootContract.machineTailContainer,
    adapterId: dedicated.adapterId,
    adapterMatches: dedicated.adapterMatches
  });
}

function wrapperRequirement(profile) {
  const wrappers = Array.isArray(profile?.privateWrappers) ? profile.privateWrappers : [];
  if (!wrappers.length) {
    return '- 若导入预设没有声明私密思考容器，不得擅自新增项目自有思考标签。';
  }
  const samples = wrappers.map(tag => `<${tag}>...</${tag}>`).join('、');
  return `- 本轮已检测到导入预设声明的思考/推演容器：${samples}。凡预设要求输出的容器，都必须使用原名完整输出开始与结束标签；不得只输出开头、只输出结尾、改名、交叉闭合或让正文落入未闭合容器。`;
}

function rootRequirement(profile) {
  const root = String(profile?.rootWrapper || '').trim();
  if (!root) return '';
  const required = Array.isArray(profile?.requiredDisplayWrappers)
    ? profile.requiredDisplayWrappers.map(tag => `<${tag}>`).join('、')
    : '';
  const tail = String(profile?.machineTailContainer || '').trim();
  return [
    `- 本轮导入格式声明整份可见文档的唯一根节点为 <${root}>；除完整的预设私密思考容器、XML 声明与空白外，根节点之外不得出现任何文字或项目机器标签。`,
    required ? `- 根节点内必须各有且仅有一个 ${required}，并保持预设声明的先后与闭合顺序。` : '',
    tail ? `- 项目机器尾部必须放在 <${tail}> 内，不能追加到 </${root}> 之后。` : ''
  ].filter(Boolean).join('\n');
}

function projectTailSkeleton(updaterEnabled) {
  return updaterEnabled
    ? '[本阶段禁止输出项目机器标签；由后续变量模型单独提交]'
    : '[业务标签可为零个]\n<state_update>{"changed":true|false}</state_update>\n<memory>{...}</memory>\n<shinobi_daily>{...}</shinobi_daily>';
}

function dedicatedDeliverySkeleton(adapterId, updaterEnabled) {
  const tail = projectTailSkeleton(updaterEnabled);
  switch (adapterId) {
    case IMPORTED_PRESET_ADAPTER_IDS.FOX_V18:
      return `续写已经打开的 <think_fox~>，不要重复开始标签。最终边界严格为：
</think_fox~>
<content>[正文]</content>
<fox_selc>[预设要求的行动选项]</fox_selc>
<fox_tip>[预设留言]</fox_tip>
${tail}`;
    case IMPORTED_PRESET_ADAPTER_IDS.IZUMI_0707:
      return `续写已经打开的 <konatan_planning~>，不要重复开始标签。最终边界严格为：
</konatan_planning~>
[纯文本正文，不增加总 wrapper]
<current_event>[当前事件]</current_event>
<progress>[进度]</progress>
<tucao>[吐槽]</tucao>
${tail}`;
    case IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4:
      return `主 <think> 是 XML 文档之前的 transport 私密区；<simple_thinking> 只属于平行事件，二者不得嵌套。只要输出“检设定/辨视角/遵写规/演叙事”等任何主推演文字，首个非空内容就必须是 <think>，不得只输出 </think>。最终边界严格为：
<think>[主推演；确无主推演时整组省略]</think>
<dream_plot>
  <dream_body><dream_scene>...</dream_scene>[正文]</dream_body>
  <dream_after_format>
    <dream_parallel_event><simple_thinking>[局部推演]</simple_thinking>[平行事件]</dream_parallel_event>
    ${tail.replace(/\n/g, '\n    ')}
  </dream_after_format>
</dream_plot>`;
    case IMPORTED_PRESET_ADAPTER_IDS.MIEMIE_V5:
      return `前一条 assistant prefill 的 <think> 已经闭合；continuation 从 <acg_think> 开始，不得再打开 <think>。最终 sibling 顺序严格为：
<acg_think>...</acg_think>
<combat_driver>无或战斗推演</combat_driver>
<story_driver>...</story_driver>
<story_scene>[正文]<parallel_line_drive>[可选局部推演]</parallel_line_drive><parallel_line>[可选平行线]</parallel_line></story_scene>
<memory_log>...</memory_log>
<wlog time="...">...</wlog>
<status>...</status>
<affinity>...</affinity>
${tail}`;
    default:
      return '';
  }
}

export function buildImportedPresetModePrompt({ updaterEnabled = false, profile = null, tacticalCombat = false } = {}) {
  const ownership = updaterEnabled
    ? `本回合变量、记忆和忍界日报由后续变量模型负责。主叙事模型只输出导入预设要求的完整思考/推演容器、可见正文、行动选项及该预设自己的展示区；不得输出项目的 <var>、<variable>、<combat>、<mission>、<relationship>、<event>、<state_update>、<memory> 或 <shinobi_daily>。正文必须明确写出实际发生的物品、技能、任务、关系、战斗、伤势、资源、地点和时间结果，供后续模型准确记账。`
    : `本回合没有后续变量模型。先完整执行导入预设自己的思考、正文与展示格式，再由同一次回复生成项目机器尾部。项目机器尾部依次为：实际需要的 <var>/<variable>${tacticalCombat === true ? '/<combat>' : ''}/<mission>/<relationship>/<event>（可为零个）→唯一 <state_update>→唯一 <memory>→唯一 <shinobi_daily>。这些项目标签不得放进任何私密思考容器、代码围栏或可见正文主体；若预设强制使用单一根节点，可把项目尾部放进其非私密的 after/post-format 区域。`;

  const dedicatedSkeleton = dedicatedDeliverySkeleton(profile?.adapterId, updaterEnabled);
  if (dedicatedSkeleton) {
    return `【用户导入预设 · ${profile.adapterId} 专属交付条目】
用户导入预设仍完整负责文风、角色口吻、原生字段内容与选项数量；本条目只固定运行时边界，不修改或复制预设正文。
${dedicatedSkeleton}
- 私密区、可见区和项目机器标签不得互相包含；所有已经开始的标签必须在上述固定边界闭合。
- 缺少纯展示附属块时仍须优先保证正文与项目机器合同完整，禁止用另一种预设的 wrapper 补位。
${ownership}`;
  }

  return `【用户导入预设 · 项目最小运行条目】
用户导入的预设完整负责文风、角色口吻、原生思考格式、正文 wrapper、状态栏和行动选项；项目不复制默认主预设，也不改写导入条目。
${wrapperRequirement(profile)}
${rootRequirement(profile)}
- 所有导入预设要求的 XML/类 XML 容器必须结构完整；私密思考与可见正文必须分离，思考内容不得泄漏到正文。
- 导入预设与当前游戏状态冲突时，以当前状态、玩家主权和本条目的项目记账职责为准；除此之外保留预设原定格式与顺序。
${ownership}`;
}

export const IMPORTED_PRESET_SINGLE_CALL_DELIVERY_REMINDER = `【用户导入预设 · 单模型交付复核】
发送前先确认导入预设要求的思考、正文和展示容器均已完整闭合，再确认项目机器尾部没有落入私密思考或正文 wrapper。
项目机器尾部必须按“业务标签（可为零个）→唯一 <state_update>→唯一 <memory>→唯一 <shinobi_daily>”闭合；有任何业务标签时使用 <state_update>{"changed":true}</state_update>，确无状态变化时使用 <state_update>{"changed":false}</state_update>。接近输出上限时缩短正文，不得截断预设容器或项目机器尾部。`;

export const IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT = `【外部主预设输出兼容 · 最终裁决】
- 保留导入预设为思考、正文、选项、状态栏和其他展示区规定的 wrapper 名称、顺序、层级及围栏语言，使其显示正则能够命中；预设未定义的展示 wrapper 不得自创。
- 任何思考、planning、reasoning、analysis 或 driver 容器都必须成对完整闭合，并与可见正文严格分离；不得只依赖上一条消息中的半个开始标签，也不得让未闭合的私密容器吞掉正文。
- 项目运行条目决定本回合机器标签由主模型还是后续变量模型负责。主模型负责时，项目机器尾部必须位于所有私密容器之外；后续模型负责时，主模型不得抢先生成项目机器标签。
- 若导入格式要求整份回复只有一个根节点，项目机器尾部可放在该根节点内非私密的 after-format/post-output 区域，但不得放入正文主体、思考区或代码围栏。
本裁决只协调导入格式与项目运行契约，不改写用户预设内容，也不覆盖项目安全、连续性和玩家主权规则。`;

export function buildImportedPresetOutputCompatibilityPrompt(profile = null) {
  const adapterId = String(profile?.adapterId || '');
  if (!adapterId) return IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT;
  const reminders = {
    [IMPORTED_PRESET_ADAPTER_IDS.FOX_V18]: '狐神抚边界：think_fox~ → content → fox_selc → fox_tip → 项目机器尾部；禁止把机器标签放回 content 或思考区。',
    [IMPORTED_PRESET_ADAPTER_IDS.IZUMI_0707]: 'Izumi 边界：konatan_planning~ 闭合后直接输出纯文本正文，再依次 current_event、progress、tucao、项目机器尾部；禁止新增正文总 wrapper。',
    [IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4]: '梦鲸边界：任何根前主推演都必须从 <think> 开始并在 dream_plot 前闭合，禁止只给 </think>；simple_thinking 只能在 dream_parallel_event 内；项目机器尾部必须是 dream_after_format 的最后内容。',
    [IMPORTED_PRESET_ADAPTER_IDS.MIEMIE_V5]: '咩咩边界：已闭合 think 后的 acg_think、combat_driver、story_driver 必须是 sibling；story_scene 后依次 memory_log、wlog、status、affinity，项目机器尾部最后追加。'
  };
  return `【用户导入预设 · ${adapterId} 最终边界复核】\n${reminders[adapterId]}\n保留用户预设原内容；这里只校验标签边界和项目记账归属。`;
}

// Backward-compatible export for existing callers and saved prompt traces.
export const SILLY_TAVERN_OUTPUT_COMPATIBILITY_PROMPT = IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT;

function tokensOutsidePrivateWrappers(value, wrapperByKey) {
  const publicTokens = [];
  const privateStack = [];
  for (const token of xmlishTokens(value)) {
    const wrapper = wrapperByKey.get(token.key);
    if (wrapper && !token.selfClosing) {
      if (token.closing) {
        const matchingIndex = privateStack.map(item => item.key).lastIndexOf(token.key);
        if (matchingIndex >= 0) privateStack.splice(matchingIndex, 1);
      } else {
        privateStack.push({ key: token.key, tag: wrapper });
      }
      continue;
    }
    if (!privateStack.length) publicTokens.push(token);
  }
  return publicTokens;
}

function rangesContainToken(ranges, token) {
  return ranges.some(range => token.index >= range.start && token.end <= range.end);
}

function collectCompleteMachineBlocks(value) {
  const text = String(value || '');
  const openings = new Map();
  const completed = [];

  for (const token of xmlishTokens(text)) {
    if (!PROJECT_MACHINE_TAGS.has(token.key)) continue;
    if (token.selfClosing) {
      completed.push({ start: token.index, end: token.end });
      continue;
    }
    if (!token.closing) {
      if (!openings.has(token.key)) openings.set(token.key, []);
      openings.get(token.key).push(token);
      continue;
    }
    const sameTagOpenings = openings.get(token.key) || [];
    const opening = sameTagOpenings.pop();
    if (opening) completed.push({ start: opening.index, end: token.end });
  }

  // A project block may quote another project tag in its private audit text.
  // Moving only the outer complete block preserves that payload byte-for-byte.
  const sorted = completed.sort((left, right) => left.start - right.start || right.end - left.end);
  const ranges = [];
  for (const range of sorted) {
    const previous = ranges.at(-1);
    if (previous && range.start < previous.end) {
      if (range.end <= previous.end) continue;
      return { ambiguous: true, ranges: [] };
    }
    ranges.push(range);
  }
  return { ambiguous: false, ranges };
}

function inspectPrivateWrapperStructure(value, wrapperByKey, ignoredRanges = []) {
  const stack = [];
  const matchedOpeningIndexes = new Set();
  const tokens = xmlishTokens(value);

  for (const token of tokens) {
    if (rangesContainToken(ignoredRanges, token)) continue;
    const wrapper = wrapperByKey.get(token.key);
    if (!wrapper || token.selfClosing) continue;
    if (!token.closing) {
      stack.push({ ...token, tag: wrapper });
      continue;
    }
    if (!stack.length || stack.at(-1).key !== token.key) {
      return { ambiguous: true, stack: [], matchedOpeningIndexes, tokens };
    }
    matchedOpeningIndexes.add(stack.pop().index);
  }

  return { ambiguous: false, stack, matchedOpeningIndexes, tokens };
}

function insertSeparated(value, index, addition) {
  const text = String(value || '');
  const before = text.slice(0, index);
  const after = text.slice(index);
  const prefix = before && !/\s$/u.test(before) ? '\n' : '';
  const suffix = after && !/^\s/u.test(after) ? '\n' : '';
  return `${before}${prefix}${addition}${suffix}${after}`;
}

function closeRecoverablePrivateWrappers(value, profile, wrapperByKey) {
  let text = String(value || '');
  const rootKey = String(profile?.rootWrapper || '').trim().toLowerCase();
  const requiredKeys = new Set((Array.isArray(profile?.requiredDisplayWrappers)
    ? profile.requiredDisplayWrappers
    : []).map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean));
  const maxPasses = Math.max(2, wrapperByKey.size + 1);

  for (let pass = 0; pass < maxPasses; pass++) {
    const machine = collectCompleteMachineBlocks(text);
    if (machine.ambiguous) return { ambiguous: true, text: value };
    const structure = inspectPrivateWrapperStructure(text, wrapperByKey, machine.ranges);
    if (structure.ambiguous) return { ambiguous: true, text: value };
    if (!structure.stack.length) return { ambiguous: false, text };

    const unmatchedIndexes = new Set(structure.stack.map(token => token.index));
    const firstUnmatched = structure.stack[0];
    const boundaries = machine.ranges
      .map(range => range.start)
      .filter(index => index > firstUnmatched.index);

    for (const token of structure.tokens) {
      if (token.index <= firstUnmatched.index || token.closing || token.selfClosing) continue;
      if (rangesContainToken(machine.ranges, token)) continue;
      if (token.key === rootKey || requiredKeys.has(token.key)) {
        boundaries.push(token.index);
        continue;
      }
      if (wrapperByKey.has(token.key)
        && structure.matchedOpeningIndexes.has(token.index)
        && !unmatchedIndexes.has(token.index)) {
        boundaries.push(token.index);
      }
    }

    const boundary = boundaries.sort((left, right) => left - right)[0];
    if (!Number.isInteger(boundary)) return { ambiguous: false, text };
    const active = structure.stack.filter(token => token.index < boundary);
    if (!active.length) return { ambiguous: false, text };
    const closingTags = [...active].reverse().map(token => `</${token.tag}>`).join('\n');
    text = insertSeparated(text, boundary, closingTags);
  }

  return { ambiguous: false, text };
}

function removeRanges(value, ranges) {
  const text = String(value || '');
  let cursor = 0;
  let output = '';
  for (const range of ranges) {
    output += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return output + text.slice(cursor);
}

function pairedPublicTag(tokens, tag) {
  const key = String(tag || '').trim().toLowerCase();
  const matching = tokens.filter(token => token.key === key);
  const openings = matching.filter(token => !token.closing && !token.selfClosing);
  const closings = matching.filter(token => token.closing);
  if (matching.some(token => token.selfClosing) || openings.length !== 1 || closings.length !== 1) return null;
  if (closings[0].index < openings[0].end) return null;
  return { opening: openings[0], closing: closings[0] };
}

function declaredRootShape(value, profile, wrapperByKey) {
  const root = String(profile?.rootWrapper || '').trim();
  const tokens = tokensOutsidePrivateWrappers(value, wrapperByKey);
  const rootTokens = tokens.filter(token => token.key === root.toLowerCase());
  const pair = pairedPublicTag(tokens, root);
  return {
    tokens,
    pair,
    absent: rootTokens.length === 0
  };
}

function addMissingMachineTailContainer(value, profile, wrapperByKey, rootPair = null) {
  const container = String(profile?.machineTailContainer || '').trim();
  if (!container) return String(value || '');
  const tokens = tokensOutsidePrivateWrappers(value, wrapperByKey);
  if (pairedPublicTag(tokens, container)) return String(value || '');

  const required = Array.isArray(profile?.requiredDisplayWrappers)
    ? profile.requiredDisplayWrappers.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  const containerIndex = required.findIndex(tag => tag.toLowerCase() === container.toLowerCase());
  if (containerIndex < 0 || containerIndex !== required.length - 1) return String(value || '');
  for (const tag of required.slice(0, containerIndex)) {
    if (!pairedPublicTag(tokens, tag)) return String(value || '');
  }

  const insertionIndex = rootPair?.closing?.index
    ?? pairedPublicTag(tokens, required[containerIndex - 1])?.closing?.end;
  if (!Number.isInteger(insertionIndex)) return String(value || '');
  return insertSeparated(value, insertionIndex, `<${container}>\n</${container}>`);
}

function restoreDeclaredRoot(value, profile, wrapperByKey) {
  const root = String(profile?.rootWrapper || '').trim();
  if (!root) return String(value || '');
  let text = String(value || '');
  let shape = declaredRootShape(text, profile, wrapperByKey);

  if (shape.pair) {
    text = addMissingMachineTailContainer(text, profile, wrapperByKey, shape.pair);
    return text;
  }
  if (!shape.absent) return text;

  text = addMissingMachineTailContainer(text, profile, wrapperByKey);
  shape = declaredRootShape(text, profile, wrapperByKey);
  const required = Array.isArray(profile?.requiredDisplayWrappers)
    ? profile.requiredDisplayWrappers.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  if (!required.length) return text;
  const pairs = required.map(tag => pairedPublicTag(shape.tokens, tag));
  if (pairs.some(pair => !pair)) return text;
  for (let index = 1; index < pairs.length; index++) {
    if (pairs[index - 1].closing.end > pairs[index].opening.index) return text;
  }

  const start = pairs[0].opening.index;
  const end = pairs.at(-1).closing.end;
  text = insertSeparated(text, end, `</${root}>`);
  text = insertSeparated(text, start, `<${root}>`);
  return text;
}

function moveRootSuffixIntoMachineTail(value, profile, wrapperByKey) {
  const root = String(profile?.rootWrapper || '').trim();
  const container = String(profile?.machineTailContainer || '').trim();
  if (!root || !container) return String(value || '');
  const shape = declaredRootShape(value, profile, wrapperByKey);
  const containerPair = pairedPublicTag(shape.tokens, container);
  if (!shape.pair || !containerPair) return String(value || '');
  const suffix = String(value || '').slice(shape.pair.closing.end);
  if (!suffix.trim()) return String(value || '');

  const withoutSuffix = String(value || '').slice(0, shape.pair.closing.end);
  const refreshedTokens = tokensOutsidePrivateWrappers(withoutSuffix, wrapperByKey);
  const refreshedContainer = pairedPublicTag(refreshedTokens, container);
  if (!refreshedContainer) return String(value || '');
  return insertSeparated(withoutSuffix, refreshedContainer.closing.index, suffix.trim());
}

function tagShape(value, tag) {
  const key = String(tag || '').toLowerCase();
  const tokens = xmlishTokens(value).filter(token => token.key === key);
  return {
    tokens,
    openings: tokens.filter(token => !token.closing && !token.selfClosing),
    closings: tokens.filter(token => token.closing),
    selfClosing: tokens.filter(token => token.selfClosing)
  };
}

function singleTagPair(value, tag) {
  const shape = tagShape(value, tag);
  if (shape.openings.length !== 1 || shape.closings.length !== 1 || shape.selfClosing.length) return null;
  if (shape.closings[0].index < shape.openings[0].end) return null;
  return {
    tag: String(tag),
    opening: shape.openings[0],
    closing: shape.closings[0],
    start: shape.openings[0].index,
    end: shape.closings[0].end,
    contentStart: shape.openings[0].end,
    contentEnd: shape.closings[0].index
  };
}

function maskPairContent(value, pair) {
  const text = String(value || '');
  if (!pair || pair.contentStart > pair.contentEnd) return text;
  const masked = text.slice(pair.contentStart, pair.contentEnd).replace(/[^\r\n]/g, ' ');
  return `${text.slice(0, pair.contentStart)}${masked}${text.slice(pair.contentEnd)}`;
}

function leadingDocumentOffset(value) {
  const match = String(value || '').match(
    /^(?:\uFEFF)?\s*(?:<\?xml\b[^?]*\?>\s*)?/iu
  );
  return match?.[0]?.length || 0;
}

function anchoredPrivatePairBefore(value, tag, boundaryIndex) {
  const text = String(value || '');
  const limit = Math.max(0, Math.min(text.length, Number(boundaryIndex) || 0));
  const prefix = text.slice(0, limit);
  const escaped = escapeRegExp(tag);
  const leading = new RegExp(
    `^((?:\\uFEFF)?\\s*(?:<\\?xml\\b[^?]*\\?>\\s*)?)(<\\s*${escaped}(?=[\\s>])[^<>]*>)`,
    'iu'
  ).exec(prefix);
  const closing = new RegExp(`<\\s*\\/\\s*${escaped}\\s*>\\s*$`, 'iu').exec(prefix);
  if (!leading || !closing) return null;
  const openingStart = String(leading[1] || '').length;
  const openingEnd = openingStart + String(leading[2] || '').length;
  if (closing.index < openingEnd) return null;
  const closingEnd = closing.index + String(closing[0] || '').replace(/\s*$/u, '').length;
  return {
    tag: String(tag),
    opening: { index: openingStart, end: openingEnd },
    closing: { index: closing.index, end: closingEnd },
    start: openingStart,
    end: closingEnd,
    contentStart: openingEnd,
    contentEnd: closing.index
  };
}

function lastTagPair(value, tag, { endBefore = Number.POSITIVE_INFINITY } = {}) {
  const key = String(tag || '').toLowerCase();
  const tokens = xmlishTokens(value).filter(token => token.key === key && token.end <= endBefore);
  const closing = tokens.filter(token => token.closing).at(-1);
  if (!closing) return null;
  const opening = tokens.filter(token => (
    !token.closing && !token.selfClosing && token.index < closing.index
  )).at(-1);
  if (!opening) return null;
  return {
    tag: String(tag),
    opening,
    closing,
    start: opening.index,
    end: closing.end,
    contentStart: opening.end,
    contentEnd: closing.index
  };
}

function dreamStructuralBoundary(value) {
  const text = String(value || '');
  const root = lastTagPair(text, 'dream_plot');
  if (root) return { kind: 'root', pair: root, index: root.start };

  // Root restoration is allowed only around the otherwise complete native
  // body -> after-format sequence. Taking the last complete pairs prevents
  // literal format examples inside a leading transport thought from becoming
  // structural candidates.
  const after = lastTagPair(text, 'dream_after_format');
  const body = after ? lastTagPair(text, 'dream_body', { endBefore: after.start }) : null;
  if (!body || !after || body.end > after.start) return null;
  return { kind: 'body', pair: body, after, index: body.start };
}

function maskDreamTransportContent(value) {
  const text = String(value || '');
  const boundary = dreamStructuralBoundary(text);
  if (!boundary) return text;
  const transport = anchoredPrivatePairBefore(text, 'think', boundary.index);
  return transport ? maskPairContent(text, transport) : text;
}

function repairOrphanLeadingPrivateOpening(value, privateTag) {
  const text = String(value || '');
  const shape = tagShape(text, privateTag);
  if (shape.openings.length || shape.closings.length !== 1 || shape.selfClosing.length) {
    return { text, repaired: false, ambiguous: shape.openings.length !== shape.closings.length };
  }
  const closing = shape.closings[0];
  const prefix = text.slice(0, closing.index);
  const insertionIndex = leadingDocumentOffset(prefix);
  if (!prefix.slice(insertionIndex).trim()) {
    return {
      text: removeRanges(text, [{ start: closing.index, end: closing.end }]),
      repaired: true,
      ambiguous: false
    };
  }
  return {
    text: insertSeparated(text, insertionIndex, `<${privateTag}>`),
    repaired: true,
    ambiguous: false
  };
}

function pairInside(outer, inner) {
  return Boolean(outer && inner && inner.start >= outer.contentStart && inner.end <= outer.contentEnd);
}

function pairContent(value, pair) {
  return pair ? String(value || '').slice(pair.contentStart, pair.contentEnd) : '';
}

function removeXmlishMarkup(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(XMLISH_TAG_PATTERN, '')
    .trim();
}

function firstOpeningBoundary(value, tags, afterIndex = -1) {
  const keys = new Set(tags.map(tag => String(tag).toLowerCase()));
  return xmlishTokens(value).find(token => (
    !token.closing && !token.selfClosing && token.index > afterIndex && keys.has(token.key)
  )) || null;
}

function repairFixedBoundary(value, privateTag, boundaryTags) {
  let text = String(value || '');
  const shape = tagShape(text, privateTag);
  if (shape.openings.length === 0) return { text, ambiguous: shape.closings.length > 0 };
  if (shape.openings.length !== 1) return { text, ambiguous: true };
  const opening = shape.openings[0];
  const boundary = firstOpeningBoundary(text, boundaryTags, opening.index);
  if (!boundary) {
    return {
      text,
      ambiguous: shape.closings.length !== 1 || shape.closings[0].index < opening.end
    };
  }

  const beforeBoundary = shape.closings.filter(token => (
    token.index >= opening.end && token.index < boundary.index
  ));
  if (beforeBoundary.length === 1) return { text, ambiguous: shape.closings.length !== 1 };
  if (beforeBoundary.length > 1) return { text, ambiguous: true };

  const delayed = shape.closings.filter(token => token.index >= boundary.index);
  if (delayed.length > 1) return { text, ambiguous: true };
  if (delayed.length === 1) text = removeRanges(text, [{ start: delayed[0].index, end: delayed[0].end }]);
  const refreshedBoundary = firstOpeningBoundary(text, boundaryTags, opening.index);
  if (!refreshedBoundary) return { text: value, ambiguous: true };
  return {
    text: insertSeparated(text, refreshedBoundary.index, `</${privateTag}>`),
    ambiguous: false
  };
}

function machineBoundaryTags() {
  return [...PROJECT_MACHINE_TAGS];
}

function extractMachineTail(value, structuralValue = value) {
  const text = String(value || '');
  const machine = collectCompleteMachineBlocks(structuralValue);
  if (machine.ambiguous) return { ambiguous: true, text, blocks: [] };
  return {
    ambiguous: false,
    text: machine.ranges.length ? removeRanges(text, machine.ranges) : text,
    blocks: machine.ranges.map(range => text.slice(range.start, range.end))
  };
}

function appendOpaqueTail(value, blocks) {
  if (!blocks.length) return String(value || '');
  return `${String(value || '').replace(/\s*$/u, '')}\n\n${blocks.join('\n')}`.trim();
}

function insertOpaqueTailBefore(value, tag, blocks, structuralValue = value) {
  if (!blocks.length) return String(value || '');
  const pair = singleTagPair(structuralValue, tag);
  if (!pair) return String(value || '');
  return insertSeparated(value, pair.closing.index, blocks.join('\n'));
}

function wrapFoxBodyIfMissing(value) {
  const text = String(value || '');
  const shape = tagShape(text, 'content');
  if (shape.tokens.length) return text;
  const privatePair = singleTagPair(text, 'think_fox~');
  const start = privatePair?.end || 0;
  const boundary = firstOpeningBoundary(text, ['fox_selc', 'fox_tip'], start - 1);
  const end = boundary?.index ?? text.length;
  const body = text.slice(start, end);
  if (!removeXmlishMarkup(body)) return text;
  return `${text.slice(0, start)}<content>${body}</content>${text.slice(end)}`;
}

function repairFoxEnvelope(value) {
  const orphan = repairOrphanLeadingPrivateOpening(value, 'think_fox~');
  const boundary = orphan.repaired
    ? { text: orphan.text, ambiguous: false }
    : repairFixedBoundary(orphan.text, 'think_fox~', [
      'content', 'fox_selc', 'fox_tip', ...machineBoundaryTags()
    ]);
  if (boundary.ambiguous) return String(value || '');
  const privatePair = singleTagPair(boundary.text, 'think_fox~');
  const extracted = extractMachineTail(boundary.text, maskPairContent(boundary.text, privatePair));
  if (extracted.ambiguous) return String(value || '');
  return appendOpaqueTail(wrapFoxBodyIfMissing(extracted.text), extracted.blocks);
}

function repairIzumiEnvelope(value) {
  const orphan = repairOrphanLeadingPrivateOpening(value, 'konatan_planning~');
  const boundary = orphan.repaired
    ? { text: orphan.text, ambiguous: false }
    : repairFixedBoundary(orphan.text, 'konatan_planning~', [
      'current_event', 'progress', 'tucao', ...machineBoundaryTags()
    ]);
  if (boundary.ambiguous) return String(value || '');
  const privatePair = singleTagPair(boundary.text, 'konatan_planning~');
  const extracted = extractMachineTail(boundary.text, maskPairContent(boundary.text, privatePair));
  if (extracted.ambiguous) return String(value || '');
  return appendOpaqueTail(extracted.text, extracted.blocks);
}

function repairDreamTransport(value) {
  let text = String(value || '');
  let boundary = dreamStructuralBoundary(text);
  if (!boundary) return { text, ambiguous: false };
  if (anchoredPrivatePairBefore(text, 'think', boundary.index)) {
    return { text, ambiguous: false };
  }

  const prefix = text.slice(0, boundary.index);
  const openingPattern = /^((?:\uFEFF)?\s*(?:<\?xml\b[^?]*\?>\s*)?)(<\s*think(?=[\s>])[^<>]*>)/iu;
  const opening = openingPattern.exec(prefix);
  const closing = /<\s*\/\s*think\s*>\s*$/iu.exec(prefix);

  // 梦鲸自己的“思考正则格式化” accepts a continuation that starts with
  // natural-language analysis and supplies only </think>. Run that exact,
  // adapter-scoped recovery before strict XML validation so its display regex
  // is not prevented from ever seeing the response.
  if (!opening && closing) {
    const closingEnd = closing.index + String(closing[0] || '').replace(/\s*$/u, '').length;
    const insertionIndex = leadingDocumentOffset(prefix);
    if (!prefix.slice(insertionIndex, closing.index).trim()) {
      text = removeRanges(text, [{ start: closing.index, end: closingEnd }]);
    } else {
      text = insertSeparated(text, insertionIndex, '<think>');
    }
    return { text, ambiguous: false };
  }
  if (!opening) return { text, ambiguous: false };

  const think = tagShape(text, 'think');
  const delayed = think.closings.filter(token => token.index >= boundary.index);
  if (delayed.length > 1) return { text, ambiguous: true };
  if (delayed.length === 1) text = removeRanges(text, [{ start: delayed[0].index, end: delayed[0].end }]);
  boundary = dreamStructuralBoundary(text);
  if (!boundary) return { text: value, ambiguous: true };
  return { text: insertSeparated(text, boundary.index, '</think>'), ambiguous: false };
}

function restoreDreamRoot(value) {
  const text = String(value || '');
  const structural = maskDreamTransportContent(text);
  const root = tagShape(structural, 'dream_plot');
  if (root.tokens.length) return text;
  const body = singleTagPair(structural, 'dream_body');
  const after = singleTagPair(structural, 'dream_after_format');
  if (!body || !after || body.end > after.start) return text;
  const withClose = insertSeparated(text, after.end, '</dream_plot>');
  return insertSeparated(withClose, body.start, '<dream_plot>');
}

function placeDreamSimpleThinking(value) {
  const text = String(value || '');
  const structural = maskDreamTransportContent(text);
  const simple = singleTagPair(structural, 'simple_thinking');
  if (!simple) return text;
  const parallel = singleTagPair(structural, 'dream_parallel_event');
  if (!parallel || pairInside(parallel, simple)) return text;
  if (simple.start < parallel.end && parallel.start < simple.end) return text;
  const block = text.slice(simple.start, simple.end);
  const without = removeRanges(text, [{ start: simple.start, end: simple.end }]);
  const refreshed = singleTagPair(maskDreamTransportContent(without), 'dream_parallel_event');
  if (!refreshed) return text;
  return insertSeparated(without, refreshed.opening.end, block);
}

function repairDreamEnvelope(value) {
  const transport = repairDreamTransport(value);
  if (transport.ambiguous) return String(value || '');
  const extracted = extractMachineTail(transport.text, maskDreamTransportContent(transport.text));
  if (extracted.ambiguous) return String(value || '');
  let repaired = restoreDreamRoot(extracted.text);
  repaired = placeDreamSimpleThinking(repaired);
  if (extracted.blocks.length) {
    const structural = maskDreamTransportContent(repaired);
    if (!singleTagPair(structural, 'dream_after_format')) return String(value || '');
    repaired = insertOpaqueTailBefore(repaired, 'dream_after_format', extracted.blocks, structural);
  }
  return repaired;
}

function dedupeMiemieThinkPrefill(value) {
  const text = String(value || '');
  const acg = tagShape(text, 'acg_think').openings[0];
  const limit = acg?.index ?? text.length;
  const think = tagShape(text, 'think');
  if (think.openings.length <= 1 || think.openings.length !== think.closings.length) return text;
  const blocks = [];
  for (let index = 0; index < think.openings.length; index++) {
    const opening = think.openings[index];
    const closing = think.closings[index];
    if (opening.index >= limit || closing.index < opening.end) return text;
    const content = text.slice(opening.end, closing.index).replace(/\s+/g, ' ').trim().toLowerCase();
    if (content !== 'think is over...') return text;
    blocks.push({ start: opening.index, end: closing.end });
  }
  return removeRanges(text, blocks.slice(1));
}

function repairMiemieEnvelope(value) {
  let text = dedupeMiemieThinkPrefill(value);
  const sequence = [
    ['acg_think', ['combat_driver', 'story_driver', 'story_scene']],
    ['combat_driver', ['story_driver', 'story_scene']],
    ['story_driver', ['story_scene']],
    ['story_scene', ['memory_log', 'wlog', 'status', 'affinity']],
    ['parallel_line_drive', ['parallel_line']]
  ];
  for (const [tag, boundaries] of sequence) {
    const repaired = repairFixedBoundary(text, tag, [...boundaries, ...machineBoundaryTags()]);
    if (repaired.ambiguous) return String(value || '');
    text = repaired.text;
  }
  const extracted = extractMachineTail(text);
  if (extracted.ambiguous) return String(value || '');
  return appendOpaqueTail(extracted.text, extracted.blocks);
}

function repairDedicatedEnvelope(value, adapterId) {
  switch (adapterId) {
    case IMPORTED_PRESET_ADAPTER_IDS.FOX_V18: return repairFoxEnvelope(value);
    case IMPORTED_PRESET_ADAPTER_IDS.IZUMI_0707: return repairIzumiEnvelope(value);
    case IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4: return repairDreamEnvelope(value);
    case IMPORTED_PRESET_ADAPTER_IDS.MIEMIE_V5: return repairMiemieEnvelope(value);
    default: return String(value || '');
  }
}

function validatePair(value, tag, errors, { required = false, warning = '', warnings = [] } = {}) {
  const shape = tagShape(value, tag);
  if (!shape.tokens.length) {
    if (required) errors.push(`缺少必需的 <${tag}>...</${tag}>`);
    else if (warning) warnings.push(warning);
    return null;
  }
  if (shape.selfClosing.length || shape.openings.length !== 1 || shape.closings.length !== 1) {
    errors.push(`<${tag}> 必须是唯一且完整的一组开始与结束标签`);
    return null;
  }
  const pair = singleTagPair(value, tag);
  if (!pair) errors.push(`<${tag}> 的结束标签位于开始标签之前`);
  return pair;
}

function validateOptionalPrivateBefore(value, tag, boundaryPair, errors) {
  const pair = validatePair(value, tag, errors);
  if (pair && boundaryPair && pair.end > boundaryPair.start) {
    errors.push(`<${tag}> 必须在 <${boundaryPair.tag}> 之前完整闭合`);
  }
  return pair;
}

function validateSequence(pairs, errors) {
  let previous = null;
  for (const pair of pairs.filter(Boolean)) {
    if (previous && previous.end > pair.start) {
      errors.push(`<${previous.tag}> 与 <${pair.tag}> 必须是按固定顺序闭合的 sibling`);
    }
    previous = pair;
  }
}

function validateMachineRanges(value, errors) {
  const machine = collectCompleteMachineBlocks(value);
  if (machine.ambiguous) {
    errors.push('项目机器标签发生交叉或重叠，无法确定唯一机器尾部');
    return [];
  }
  const tokens = xmlishTokens(value).filter(token => PROJECT_MACHINE_TAGS.has(token.key));
  for (const token of tokens) {
    if (!rangesContainToken(machine.ranges, token)) {
      errors.push(`<${token.name}> 项目机器标签不完整或没有对应边界`);
    }
  }
  return machine.ranges;
}

function validateMachineAfter(value, ranges, anchor, errors, label) {
  if (!ranges.length) return;
  if (!anchor) {
    errors.push(`存在项目机器标签，但无法确定 ${label} 后的唯一落点`);
    return;
  }
  for (const range of ranges) {
    if (range.start < anchor.end) errors.push(`项目机器尾部必须位于 ${label} 之后`);
  }
}

function validationResult(errors, warnings = []) {
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze([...new Set(errors)]),
    warnings: Object.freeze([...new Set(warnings)]),
    missingContracts: Object.freeze(errors.length ? ['imported_preset_envelope'] : [])
  });
}

function validateFoxEnvelope(value) {
  const text = String(value || '');
  const errors = [];
  const warnings = [];
  const privatePair = validatePair(text, 'think_fox~', errors);
  const structural = maskPairContent(text, privatePair);
  const content = validatePair(structural, 'content', errors, { required: true, warnings });
  const selection = validatePair(structural, 'fox_selc', errors, {
    warnings,
    warning: '本回合缺少 <fox_selc> 行动选项，已保留正文与机器提交'
  });
  const tip = validatePair(structural, 'fox_tip', errors, {
    warnings,
    warning: '本回合缺少 <fox_tip> 留言，已保留正文与机器提交'
  });
  if (privatePair && content && privatePair.end > content.start) {
    errors.push('<think_fox~> 必须在 <content> 之前完整闭合');
  }
  validateSequence([content, selection, tip], errors);
  if (content && !removeXmlishMarkup(pairContent(text, content))) errors.push('<content> 正文为空');
  const machines = validateMachineRanges(structural, errors);
  validateMachineAfter(structural, machines, tip || selection || content, errors, '<fox_tip>/最后一个狐神抚展示块');
  return validationResult(errors, warnings);
}

function izumiBodyRange(value, planning, tailPairs, machineRanges) {
  const start = planning?.end || 0;
  const candidates = [
    ...tailPairs.filter(Boolean).map(pair => pair.start),
    ...machineRanges.map(range => range.start)
  ].filter(index => index >= start).sort((left, right) => left - right);
  return { start, end: candidates[0] ?? String(value || '').length };
}

function validateIzumiEnvelope(value) {
  const text = String(value || '');
  const errors = [];
  const warnings = [];
  const planning = validatePair(text, 'konatan_planning~', errors);
  const structural = maskPairContent(text, planning);
  const currentEvent = validatePair(structural, 'current_event', errors, {
    warnings, warning: '本回合缺少 <current_event>，已使用纯文本正文 fallback'
  });
  const progress = validatePair(structural, 'progress', errors, {
    warnings, warning: '本回合缺少 <progress>，已使用纯文本正文 fallback'
  });
  const tucao = validatePair(structural, 'tucao', errors, {
    warnings, warning: '本回合缺少 <tucao>，已保留正文与机器提交'
  });
  const firstTail = [currentEvent, progress, tucao].filter(Boolean).sort((a, b) => a.start - b.start)[0] || null;
  if (planning && firstTail && planning.end > firstTail.start) {
    errors.push('<konatan_planning~> 必须在 Izumi 展示尾部之前完整闭合');
  }
  validateSequence([currentEvent, progress, tucao], errors);
  const machines = validateMachineRanges(structural, errors);
  const body = izumiBodyRange(structural, planning, [currentEvent, progress, tucao], machines);
  if (!removeXmlishMarkup(text.slice(body.start, body.end))) errors.push('Izumi 纯文本正文为空或边界无法确定');
  validateMachineAfter(structural, machines, tucao || progress || currentEvent || {
    tag: '正文',
    end: body.end
  }, errors, '<tucao>/最后一个 Izumi 展示块');
  return validationResult(errors, warnings);
}

function validateDreamEnvelope(value) {
  const text = String(value || '');
  const errors = [];
  const warnings = [];
  const structural = maskDreamTransportContent(text);
  const root = validatePair(structural, 'dream_plot', errors, { required: true, warnings });
  const body = validatePair(structural, 'dream_body', errors, { required: true, warnings });
  const after = validatePair(structural, 'dream_after_format', errors, { required: true, warnings });
  const scene = validatePair(structural, 'dream_scene', errors, {
    warnings, warning: '本回合缺少 <dream_scene>，状态栏使用结构 fallback'
  });
  const parallel = validatePair(structural, 'dream_parallel_event', errors, {
    warnings, warning: '本回合没有 <dream_parallel_event> 平行事件块'
  });
  const simple = validatePair(structural, 'simple_thinking', errors);
  let think = null;

  if (root && body && !pairInside(root, body)) errors.push('<dream_body> 必须完整位于 <dream_plot> 内');
  if (root && after && !pairInside(root, after)) errors.push('<dream_after_format> 必须完整位于 <dream_plot> 内');
  validateSequence([body, after], errors);
  if (body && scene && !pairInside(body, scene)) errors.push('<dream_scene> 必须位于 <dream_body> 内');
  if (after && parallel && !pairInside(after, parallel)) errors.push('<dream_parallel_event> 必须位于 <dream_after_format> 内');
  if (simple && (!parallel || !pairInside(parallel, simple))) {
    errors.push('<simple_thinking> 只能完整位于 <dream_parallel_event> 内');
  }
  if (root) {
    const before = text.slice(0, root.start);
    const offset = leadingDocumentOffset(before);
    if (before.slice(offset).trim()) {
      think = anchoredPrivatePairBefore(text, 'think', root.start);
      if (!think) {
        errors.push('transport <think> 必须从根前首个非空内容开始，并在 <dream_plot> 之前完整闭合；不得只输出 </think>');
      }
    }
    const rootThinkTokens = xmlishTokens(structural).filter(token => (
      token.key === 'think' && token.index >= root.contentStart && token.end <= root.contentEnd
    ));
    if (rootThinkTokens.length) errors.push('transport <think> 不得位于 <dream_plot> XML 文档内');
    if (text.slice(root.end).trim()) errors.push('<dream_plot> 之后存在根外内容');
  }
  if (body) {
    let bodyText = pairContent(text, body);
    if (scene) bodyText = removeRanges(bodyText, [{
      start: scene.start - body.contentStart,
      end: scene.end - body.contentStart
    }].filter(range => range.start >= 0 && range.end <= bodyText.length));
    if (!removeXmlishMarkup(bodyText)) errors.push('<dream_body> 正文为空');
  }

  const machines = validateMachineRanges(structural, errors);
  if (machines.length && !after) errors.push('项目机器尾部缺少 <dream_after_format> 落点');
  for (const range of machines) {
    if (after && (range.start < after.contentStart || range.end > after.contentEnd)) {
      errors.push('项目机器尾部必须完整位于 <dream_after_format> 内');
    }
    if (parallel && range.start < parallel.end) {
      errors.push('项目机器尾部必须位于 <dream_parallel_event> 等原生后置模块之后');
    }
  }
  return validationResult(errors, warnings);
}

function removePairFromLocalContent(value, outer, inner) {
  const content = pairContent(value, outer);
  if (!outer || !inner || !pairInside(outer, inner)) return content;
  return removeRanges(content, [{
    start: inner.start - outer.contentStart,
    end: inner.end - outer.contentStart
  }]);
}

function validateMiemieEnvelope(value) {
  const text = String(value || '');
  const errors = [];
  const warnings = [];
  const think = validatePair(text, 'think', errors, {
    warnings, warning: '未回显已闭合的 <think> prefill；不会伪造思考内容'
  });
  const acg = validatePair(text, 'acg_think', errors, {
    warnings, warning: '本回合缺少 <acg_think> 阶段'
  });
  const combat = validatePair(text, 'combat_driver', errors, {
    warnings, warning: '本回合缺少 <combat_driver> 阶段'
  });
  const storyDriver = validatePair(text, 'story_driver', errors, {
    warnings, warning: '本回合缺少 <story_driver> 阶段'
  });
  const storyScene = validatePair(text, 'story_scene', errors, { required: true, warnings });
  const memoryLog = validatePair(text, 'memory_log', errors, {
    warnings, warning: '本回合缺少 <memory_log> 展示块'
  });
  const wlog = validatePair(text, 'wlog', errors, {
    warnings, warning: '本回合缺少 <wlog> 展示块'
  });
  const status = validatePair(text, 'status', errors, {
    warnings, warning: '本回合缺少 <status> 展示块'
  });
  const affinity = validatePair(text, 'affinity', errors, {
    warnings, warning: '本回合缺少 <affinity> 展示块'
  });
  const parallelDrive = validatePair(text, 'parallel_line_drive', errors);
  const parallelLine = validatePair(text, 'parallel_line', errors);

  validateSequence([think, acg, combat, storyDriver, storyScene, memoryLog, wlog, status, affinity], errors);
  if (storyScene && parallelDrive && !pairInside(storyScene, parallelDrive)) {
    errors.push('<parallel_line_drive> 必须位于 <story_scene> 内');
  }
  if (storyScene && parallelLine && !pairInside(storyScene, parallelLine)) {
    errors.push('<parallel_line> 必须位于 <story_scene> 内');
  }
  if (parallelDrive && parallelLine && parallelDrive.end > parallelLine.start) {
    errors.push('<parallel_line_drive> 必须在 <parallel_line> 之前闭合');
  }
  if (storyScene) {
    let mainText = removePairFromLocalContent(text, storyScene, parallelDrive);
    if (parallelLine && pairInside(storyScene, parallelLine)) {
      const adjustedPair = {
        ...parallelLine,
        start: parallelLine.start - storyScene.contentStart,
        end: parallelLine.end - storyScene.contentStart
      };
      mainText = removeRanges(mainText, [{
        start: Math.max(0, adjustedPair.start),
        end: Math.min(mainText.length, adjustedPair.end)
      }]);
    }
    if (!removeXmlishMarkup(mainText)) errors.push('<story_scene> 玩家侧正文为空');
  }
  const machines = validateMachineRanges(text, errors);
  validateMachineAfter(text, machines, affinity || status || wlog || memoryLog || storyScene, errors,
    '<affinity>/最后一个咩咩展示块');
  return validationResult(errors, warnings);
}

function validateDedicatedEnvelope(value, adapterId) {
  switch (adapterId) {
    case IMPORTED_PRESET_ADAPTER_IDS.FOX_V18: return validateFoxEnvelope(value);
    case IMPORTED_PRESET_ADAPTER_IDS.IZUMI_0707: return validateIzumiEnvelope(value);
    case IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4: return validateDreamEnvelope(value);
    case IMPORTED_PRESET_ADAPTER_IDS.MIEMIE_V5: return validateMiemieEnvelope(value);
    default: return null;
  }
}

/**
 * Repair only unambiguous transport damage in a model response. Imported
 * preset entries and storage are never touched: complete machine blocks are
 * moved as opaque strings, native wrapper names stay unchanged, and an
 * ambiguous/cross-closed response is returned untouched for strict rejection.
 */
export function repairImportedPresetOutputEnvelope(text, profile) {
  const original = String(text || '');
  if (!profile?.active || validateImportedPresetOutputEnvelope(original, profile).valid) return original;
  if (profile?.adapterId) {
    const repaired = repairDedicatedEnvelope(original, profile.adapterId);
    return validateDedicatedEnvelope(repaired, profile.adapterId)?.valid ? repaired : original;
  }
  const wrappers = Array.isArray(profile.privateWrappers)
    ? profile.privateWrappers.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  const wrapperByKey = new Map(wrappers.map(tag => [tag.toLowerCase(), tag]));

  const closed = closeRecoverablePrivateWrappers(original, profile, wrapperByKey);
  if (closed.ambiguous) return original;
  let repaired = closed.text;

  const machine = collectCompleteMachineBlocks(repaired);
  if (machine.ambiguous) return original;
  const machineBlocks = machine.ranges.map(range => repaired.slice(range.start, range.end));
  if (machineBlocks.length) repaired = removeRanges(repaired, machine.ranges);

  repaired = restoreDeclaredRoot(repaired, profile, wrapperByKey);
  repaired = moveRootSuffixIntoMachineTail(repaired, profile, wrapperByKey);

  if (machineBlocks.length) {
    const tail = machineBlocks.join('\n');
    const container = String(profile?.machineTailContainer || '').trim();
    if (String(profile?.rootWrapper || '').trim()) {
      const publicTokens = tokensOutsidePrivateWrappers(repaired, wrapperByKey);
      const containerPair = pairedPublicTag(publicTokens, container);
      if (!containerPair) return original;
      repaired = insertSeparated(repaired, containerPair.closing.index, tail);
    } else {
      repaired = `${repaired.replace(/\s*$/u, '')}\n\n${tail}`.trim();
    }
  }

  return validateImportedPresetOutputEnvelope(repaired, profile).valid ? repaired : original;
}

function stripCompletePrivateBlocks(value, wrappers) {
  let output = String(value || '');
  for (const tag of wrappers) {
    const escaped = escapeRegExp(tag);
    output = output.replace(
      new RegExp(`<\\s*${escaped}(?=[\\s>])[^<>]*>[\\s\\S]*?<\\s*\\/\\s*${escaped}\\s*>`, 'giu'),
      ''
    );
  }
  return output;
}

function outsideRootTextIsIgnorable(value, wrappers, { allowXmlDeclaration = false } = {}) {
  let output = stripCompletePrivateBlocks(value, wrappers).replace(/^\uFEFF/, '');
  if (allowXmlDeclaration) output = output.replace(/^\s*<\?xml\b[^?]*\?>/iu, '');
  return output.trim() === '';
}

function validateDeclaredRootContract(value, profile, wrapperByKey, errors) {
  const rootWrapper = String(profile?.rootWrapper || '').trim();
  if (!rootWrapper) return;
  const rootKey = rootWrapper.toLowerCase();
  const wrappers = [...wrapperByKey.values()];
  const publicTokens = tokensOutsidePrivateWrappers(value, wrapperByKey);
  const rootTokens = publicTokens.filter(token => token.key === rootKey);
  const rootOpenings = rootTokens.filter(token => !token.closing && !token.selfClosing);
  const rootClosings = rootTokens.filter(token => token.closing);
  const rootSelfClosing = rootTokens.filter(token => token.selfClosing);

  if (rootOpenings.length !== 1) {
    errors.push(`<${rootWrapper}> 根节点必须且只能开始一次，实际 ${rootOpenings.length} 次`);
  }
  if (rootClosings.length !== 1) {
    errors.push(`<${rootWrapper}> 根节点必须且只能结束一次，实际 ${rootClosings.length} 次`);
  }
  if (rootSelfClosing.length) errors.push(`<${rootWrapper}> 根节点不得使用自闭合标签`);
  if (rootOpenings.length !== 1 || rootClosings.length !== 1) return;

  const rootOpening = rootOpenings[0];
  const rootClosing = rootClosings[0];
  if (rootClosing.index < rootOpening.end) {
    errors.push(`<${rootWrapper}> 根节点结束标签位于开始标签之前`);
    return;
  }
  if (!outsideRootTextIsIgnorable(value.slice(0, rootOpening.index), wrappers, { allowXmlDeclaration: true })) {
    errors.push(`<${rootWrapper}> 根节点之前存在预设私密思考之外的文字或标签`);
  }
  if (!outsideRootTextIsIgnorable(value.slice(rootClosing.end), wrappers)) {
    errors.push(`<${rootWrapper}> 根节点之后存在文字或项目机器尾部`);
  }

  const required = Array.isArray(profile?.requiredDisplayWrappers)
    ? profile.requiredDisplayWrappers.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  const requiredPairs = new Map();
  for (const tag of required) {
    const key = tag.toLowerCase();
    const tokens = publicTokens.filter(token => token.key === key);
    const openings = tokens.filter(token => !token.closing && !token.selfClosing);
    const closings = tokens.filter(token => token.closing);
    if (tokens.some(token => token.selfClosing)) errors.push(`<${tag}> 不得使用自闭合标签`);
    if (openings.length !== 1 || closings.length !== 1) {
      errors.push(`<${tag}> 在 <${rootWrapper}> 内必须各有且仅有一组开始与结束标签`);
      continue;
    }
    const opening = openings[0];
    const closing = closings[0];
    if (opening.index < rootOpening.end || closing.end > rootClosing.index || closing.index < opening.end) {
      errors.push(`<${tag}> 必须完整位于 <${rootWrapper}> 根节点内`);
      continue;
    }
    requiredPairs.set(key, { tag, opening, closing });
  }

  for (let index = 1; index < required.length; index++) {
    const previous = requiredPairs.get(required[index - 1].toLowerCase());
    const current = requiredPairs.get(required[index].toLowerCase());
    if (previous && current && previous.closing.end > current.opening.index) {
      errors.push(`<${previous.tag}> 与 <${current.tag}> 的顺序或嵌套不符合导入预设声明`);
    }
  }

  const machineTags = publicTokens.filter(token => !token.closing && PROJECT_MACHINE_TAGS.has(token.key));
  const containerName = String(profile?.machineTailContainer || '').trim();
  const container = containerName ? requiredPairs.get(containerName.toLowerCase()) : null;
  if (machineTags.length && !containerName) {
    errors.push(`<${rootWrapper}> 单根格式没有声明可安全承载项目机器尾部的 after/post-format 容器`);
  } else if (machineTags.length && !container) {
    errors.push(`项目机器尾部要求的 <${containerName}> 容器缺失或不完整`);
  } else if (container) {
    for (const token of machineTags) {
      if (token.index < container.opening.end || token.end > container.closing.index) {
        errors.push(`<${token.name}> 必须位于 <${containerName}> 内，不能落在正文或根节点之外`);
      }
    }
  }
}

export function validateImportedPresetOutputEnvelope(text, profile) {
  if (!profile?.active) {
    return Object.freeze({
      valid: true,
      errors: Object.freeze([]),
      warnings: Object.freeze([]),
      missingContracts: Object.freeze([])
    });
  }
  if (Array.isArray(profile?.adapterMatches) && profile.adapterMatches.length > 1) {
    return validationResult([
      `导入预设同时命中多个专属适配器：${profile.adapterMatches.join('、')}，拒绝按名称猜测`
    ]);
  }
  if (profile?.adapterId) return validateDedicatedEnvelope(text, profile.adapterId);
  const wrappers = Array.isArray(profile.privateWrappers)
    ? profile.privateWrappers.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  const wrapperByKey = new Map(wrappers.map(tag => [tag.toLowerCase(), tag]));
  const counts = new Map(wrappers.map(tag => [tag.toLowerCase(), { openings: 0, closings: 0 }]));
  const stack = [];
  const errors = [];
  const value = String(text || '');
  let firstMachineIndex = -1;

  XMLISH_TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = XMLISH_TAG_PATTERN.exec(value)) !== null) {
    const closing = Boolean(match[1]);
    const key = String(match[2] || '').toLowerCase();
    const attributes = String(match[3] || '');
    const selfClosing = !closing && /\/\s*$/.test(attributes);
    const wrapper = wrapperByKey.get(key);

    if (!closing && PROJECT_MACHINE_TAGS.has(key)) {
      if (firstMachineIndex < 0) firstMachineIndex = match.index;
      if (stack.length) {
        errors.push(`<${match[2]}> 位于私密思考容器 <${stack.at(-1).tag}> 内`);
      }
    }

    if (!wrapper || selfClosing) continue;
    const counter = counts.get(key);
    if (closing) {
      counter.closings++;
      if (!stack.length) {
        errors.push(`<${wrapper}> 出现了没有对应开始标签的结束标签`);
        continue;
      }
      const current = stack.at(-1);
      if (current.key !== key) {
        errors.push(`<${current.tag}> 与 <${wrapper}> 发生交叉闭合`);
        const matchingIndex = stack.map(item => item.key).lastIndexOf(key);
        if (matchingIndex >= 0) stack.splice(matchingIndex, 1);
        continue;
      }
      stack.pop();
      continue;
    }

    counter.openings++;
    if (firstMachineIndex >= 0) {
      errors.push(`<${wrapper}> 出现在项目机器尾部之后`);
    }
    stack.push({ key, tag: wrapper });
  }

  for (const tag of wrappers) {
    const counter = counts.get(tag.toLowerCase());
    if (counter.openings === 0 && counter.closings === 0) {
      errors.push(`缺少导入预设要求的 <${tag}>...</${tag}>`);
    }
    if (counter.openings > counter.closings) {
      errors.push(`<${tag}> 有 ${counter.openings - counter.closings} 个开始标签未闭合`);
    }
    if (counter.closings > counter.openings) {
      errors.push(`<${tag}> 有 ${counter.closings - counter.openings} 个结束标签没有对应开始标签`);
    }
  }

  validateDeclaredRootContract(value, profile, wrapperByKey, errors);

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze([...new Set(errors)]),
    warnings: Object.freeze([]),
    missingContracts: Object.freeze(errors.length ? ['imported_preset_envelope'] : [])
  });
}

export class ImportedPresetOutputIncompleteError extends Error {
  constructor(validation, { draftResponse = '' } = {}) {
    const errors = Array.isArray(validation?.errors) ? validation.errors : ['导入预设输出容器不完整'];
    super(`导入预设输出不完整：${errors.join('；')}。本回合未提交，请重试。`);
    this.name = 'ImportedPresetOutputIncompleteError';
    this.code = IMPORTED_PRESET_OUTPUT_INCOMPLETE;
    this.missingContracts = [...(validation?.missingContracts || ['imported_preset_envelope'])];
    this.details = { errors: [...errors], missingContracts: [...this.missingContracts] };
    this.draftResponse = String(draftResponse || '');
  }
}

export function assertImportedPresetOutputEnvelope(text, profile, options = {}) {
  const validation = validateImportedPresetOutputEnvelope(text, profile);
  if (!validation.valid) throw new ImportedPresetOutputIncompleteError(validation, options);
  return validation;
}

/** Restore SillyTavern's assistant-prefill semantics at the response boundary. */
export function attachImportedAssistantPrefill(response, prefill) {
  const text = String(response || '');
  const prefix = String(prefill || '');
  if (!prefix.trim()) return text;
  const leading = text.match(/^[\uFEFF\s]*/u)?.[0] || '';
  const body = text.slice(leading.length);
  if (body.startsWith(prefix) || text.startsWith(prefix)) return text;

  const unmatched = [];
  for (const token of xmlishTokens(prefix)) {
    if (token.selfClosing) continue;
    if (token.closing) {
      const matchingIndex = unmatched.map(item => item.key).lastIndexOf(token.key);
      if (matchingIndex >= 0) unmatched.splice(matchingIndex, 1);
    } else {
      unmatched.push(token);
    }
  }
  const opening = unmatched.at(-1);
  if (opening) {
    const echoedPattern = new RegExp(`^<\\s*${escapeRegExp(opening.name)}(?=[\\s>])[^<>]*>`, 'iu');
    const echoed = body.match(echoedPattern);
    if (echoed) {
      let continuation = body.slice(echoed[0].length);
      const fixedSuffix = prefix.slice(opening.end);
      const fixedBody = fixedSuffix.replace(/^[\uFEFF\s]*/u, '');
      if (fixedBody) {
        const continuationLeading = continuation.match(/^[\uFEFF\s]*/u)?.[0] || '';
        const continuationBody = continuation.slice(continuationLeading.length);
        if (continuationBody.startsWith(fixedBody)) {
          continuation = continuationBody.slice(fixedBody.length);
        }
      }
      return `${leading}${prefix}${prefix.endsWith('\n') || !continuation ? '' : '\n'}${continuation}`;
    }
  }
  return `${leading}${prefix}${prefix.endsWith('\n') || !body ? '' : '\n'}${body}`;
}

/** Keep machine tags inside an imported preset's explicit non-private tail. */
export function insertProjectMachineTail(response, tail, profile = null) {
  let text = String(response || '');
  const suffix = String(tail || '').trim();
  if (!suffix) return text;
  if (profile?.adapterId) {
    text = repairImportedPresetOutputEnvelope(text, profile);
    let inserted;
    if (profile.adapterId === IMPORTED_PRESET_ADAPTER_IDS.DREAM_WHALE_V4) {
      const after = singleTagPair(maskDreamTransportContent(text), 'dream_after_format');
      if (!after) {
        throw new ImportedPresetOutputIncompleteError({
          errors: ['项目机器尾部要求的 <dream_after_format> 容器缺失'],
          missingContracts: ['imported_preset_envelope']
        }, { draftResponse: text });
      }
      inserted = insertSeparated(text, after.closing.index, suffix);
    } else {
      inserted = `${text.replace(/\s*$/u, '')}\n\n${suffix}`.trim();
    }
    assertImportedPresetOutputEnvelope(inserted, profile, { draftResponse: inserted });
    return inserted;
  }
  const explicitRoot = String(profile?.rootWrapper || '').trim();
  const explicitContainer = String(profile?.machineTailContainer || '').trim();
  if (explicitRoot && !explicitContainer) {
    throw new ImportedPresetOutputIncompleteError({
      errors: [`<${explicitRoot}> 单根格式未声明可承载项目机器尾部的 after/post-format 容器`],
      missingContracts: ['imported_preset_envelope']
    }, { draftResponse: text });
  }
  const candidates = explicitContainer
    ? [explicitContainer]
    : ['dream_after_format', 'after_format', 'post_output'];
  for (const tag of candidates) {
    const pattern = new RegExp(`<\\/\\s*${tag}\\s*>`, 'ig');
    let match;
    let last = null;
    while ((match = pattern.exec(text)) !== null) last = match;
    if (!last) continue;
    const inserted = `${text.slice(0, last.index).replace(/\s*$/, '')}\n${suffix}\n${text.slice(last.index)}`;
    if (profile?.active) assertImportedPresetOutputEnvelope(inserted, profile, { draftResponse: inserted });
    return inserted;
  }
  if (explicitRoot) {
    throw new ImportedPresetOutputIncompleteError({
      errors: [`项目机器尾部要求的 <${explicitContainer}> 容器缺失，拒绝追加到 </${explicitRoot}> 之外`],
      missingContracts: ['imported_preset_envelope']
    }, { draftResponse: text });
  }
  return `${text.replace(/\s*$/, '')}\n\n${suffix}`.trim();
}
