import assert from 'node:assert/strict';

import {
  applyPresetRegexScripts,
  buildPresetPresentation
} from '../js/core/preset-regex-runtime.js';
import { instructionParser } from '../js/core/instruction-parser.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

function assertContainsNoSecret(value, secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    assert.doesNotMatch(serialized, new RegExp(secret), `presentation leaked ${secret}`);
  }
}

const contentToHtml = Object.freeze({
  id: 'content-card',
  name: 'content card',
  enabled: true,
  markdownOnly: true,
  placement: [2],
  findRegex: '/<content>([\\s\\S]*?)<\\/content>/gi',
  replaceString: '<section class="preset-card">$1</section>'
});

test('empty display replacements preserve the safe narrative at final presentation', () => {
  const raw = '<reasoning>PRIVATE_REASONING</reasoning><content>变量更新后仍然保留的正文。</content>'
    + '<variable>{"key":"进度·经验","op":"+","value":1}</variable>';
  const clean = instructionParser.cleanupPartialResponse(raw);
  assert.equal(clean, '变量更新后仍然保留的正文。');
  for (const replaceString of ['', ' \n\t ', '<analysis>PRIVATE_REPLACEMENT</analysis>']) {
    const result = buildPresetPresentation(raw, clean, [{
      id: 'empty-body-display', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<content>[\\s\\S]*?<\\/content>/', replaceString
    }]);
    assert.equal(result.kind, 'markdown');
    assert.deepEqual(result.appliedScripts, ['empty-body-display']);
    assert.equal(result.text, clean);
    assert.equal(result.fallbackText, clean);
    assertContainsNoSecret(result, ['PRIVATE_REASONING', 'PRIVATE_REPLACEMENT', '进度·经验']);
  }
});

test('empty regex output recovers from safe raw narrative when clean text is missing', () => {
  const result = buildPresetPresentation(
    '<review_audit>PRIVATE_AUDIT</review_audit><content>原始安全正文。</content>', '', [{
      id: 'remove-body', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<content>[\\s\\S]*?<\\/content>/', replaceString: ''
    }]
  );
  assert.equal(result.text, '原始安全正文。');
  assertContainsNoSecret(result, ['PRIVATE_AUDIT']);
});

test('display regexes only inspect the safe presentation projection', () => {
  const secrets = [
    'SECRET_FOX',
    'SECRET_IZUMI',
    'SECRET_ANALYSIS',
    'SECRET_AUDIT',
    'SECRET_ATTRIBUTE',
    'SECRET_DRIVER',
    'SECRET_MACHINE',
    'SECRET_COMMENT',
    'SECRET_SCRIPT',
    'SECRET_STYLE',
    'SECRET_SVG',
    'SECRET_TEMPLATE',
    'SECRET_FALLBACK'
  ];
  const raw = `<think_fox~>SECRET_FOX</think_fox~>
<konatan_planning~>SECRET_IZUMI</konatan_planning~>
<analysis>SECRET_ANALYSIS</analysis>
<review_audit>SECRET_AUDIT</review_audit>
<aside visibility="private">SECRET_ATTRIBUTE</aside>
<story_driver>SECRET_DRIVER</story_driver>
<memory>{"note":"SECRET_MACHINE"}</memory>
<!-- SECRET_COMMENT -->
<script>globalThis.value = 'SECRET_SCRIPT';</script>
<style>.private::after { content: 'SECRET_STYLE'; }</style>
<svg><text>SECRET_SVG</text></svg>
<template>SECRET_TEMPLATE</template>
<content>公开正文<options>向左｜向右</options></content>`;
  const result = buildPresetPresentation(
    raw,
    '<analysis>SECRET_FALLBACK</analysis>公开正文',
    [contentToHtml]
  );

  assert.equal(result.kind, 'sandbox');
  assert.match(result.source, /公开正文/);
  assert.match(result.source, /<options>向左｜向右<\/options>/);
  assert.deepEqual(result.actions, ['向左', '向右']);
  assert.deepEqual(result.appliedScripts, ['content-card']);
  assertContainsNoSecret(result, secrets);
});

test('ordinary content and options wrappers remain triggerable', () => {
  const result = applyPresetRegexScripts(
    '<think>SECRET_TRIGGER</think><content>正文<options>甲｜乙</options></content>',
    [
      {
        id: 'must-not-match',
        enabled: true,
        markdownOnly: true,
        placement: [2],
        findRegex: '/SECRET_TRIGGER/g',
        replaceString: '<div>泄漏</div>'
      },
      contentToHtml,
      {
        id: 'options-card',
        enabled: true,
        markdownOnly: true,
        placement: [2],
        findRegex: '/<options>([\\s\\S]*?)<\\/options>/gi',
        replaceString: '<div class="options">$1</div>'
      }
    ]
  );

  assert.deepEqual(result.appliedScripts, ['content-card', 'options-card']);
  assert.match(result.text, /<section class="preset-card">正文<div class="options">甲｜乙<\/div><\/section>/);
  assert.doesNotMatch(result.text, /SECRET_TRIGGER|泄漏/);
});

test('regex trace records applied and skipped reasons without executing empty rows', () => {
  const result = applyPresetRegexScripts('<content>正文</content>', [
    { id: 'disabled-row', disabled: true, markdownOnly: true, placement: [2], findRegex: '/正文/g', replaceString: 'X' },
    { id: 'empty-divider', markdownOnly: true, placement: [2], findRegex: '', replaceString: '' },
    { id: 'wrong-depth', markdownOnly: true, placement: [2], minDepth: 2, maxDepth: 3, findRegex: '/正文/g', replaceString: 'X' },
    { id: 'no-match', markdownOnly: true, placement: [2], findRegex: '/不存在/g', replaceString: 'X' },
    { id: 'applied-row', markdownOnly: true, placement: [2], findRegex: '/正文/g', replaceString: '故事' }
  ], { channel: 'display', placement: 2, depth: 0 });

  assert.deepEqual(result.scriptTrace.map(row => [row.id, row.status, row.reason]), [
    ['disabled-row', 'skipped', 'disabled'],
    ['empty-divider', 'skipped', 'empty_pattern'],
    ['wrong-depth', 'skipped', 'depth'],
    ['no-match', 'skipped', 'no_match'],
    ['applied-row', 'applied', 'matched']
  ]);
  assert.match(result.text, /故事/);
});

test('standard inline and table HTML replacements use the sandbox', () => {
  const result = buildPresetPresentation(
    '<content>标准标签正文</content>',
    '标准标签正文',
    [{
      id: 'standard-html',
      enabled: true,
      markdownOnly: true,
      placement: [2],
      findRegex: '/<content>([\\s\\S]*?)<\\/content>/gi',
      replaceString: '<style>.inline{color:gold}</style><span class="inline"><p>$1</p><table><tr><td>状态</td></tr></table><img alt="图标"></span>'
    }]
  );

  assert.equal(result.kind, 'sandbox');
  assert.match(result.source, /<style>\.inline\{color:gold\}<\/style>/);
  assert.match(result.source, /<span class="inline">/);
  assert.match(result.source, /<table>/);
  assert.match(result.source, /<img alt="图标">/);
});

test('safe option aliases provide host actions even when regexes replace their wrappers', () => {
  const raw = `<story_driver><options>SECRET_PRIVATE_ACTION｜不得提取</options></story_driver>
<fox_selc>
【默认】(｡･ω･｡)<font color="#4ECDC4">调查门外的脚印</font>
【正面】(ง •̀_•́)ง<font color="#FF6B6B">请同伴一起分析线索</font>
</fox_selc>
<dream_option>留在原地观察｜跟上巡逻队</dream_option>
<options>
>选项一：主动询问值守忍者
>选项二：暂时离开火影楼
</options>`;
  const result = buildPresetPresentation(raw, raw, [{
    id: 'replace-dream-options',
    enabled: true,
    markdownOnly: true,
    placement: [2],
    findRegex: '/<dream_option>[\\s\\S]*?<\\/dream_option>/gi',
    replaceString: '<div class="dynamic-option-card">行动卡片</div>'
  }]);

  assert.equal(result.kind, 'sandbox');
  assert.deepEqual(result.actions, [
    '调查门外的脚印',
    '请同伴一起分析线索',
    '留在原地观察',
    '跟上巡逻队',
    '主动询问值守忍者',
    '暂时离开火影楼'
  ]);
  assertContainsNoSecret(result, ['SECRET_PRIVATE_ACTION', '不得提取']);
});

test('closed private blocks are removed while following presentation survives', () => {
  const result = buildPresetPresentation(
    '<reasoning>SECRET_CLOSED</reasoning><content>闭合块后的正文</content>',
    '<reasoning>SECRET_CLOSED</reasoning>闭合块后的正文',
    [contentToHtml]
  );

  assert.equal(result.kind, 'sandbox');
  assert.match(result.source, /闭合块后的正文/);
  assertContainsNoSecret(result, ['SECRET_CLOSED']);
});

test('unclosed private and driver scopes hide the remainder', () => {
  for (const tag of ['think_fox~', 'konatan_planning~', 'analysis', 'review_audit', 'npc_driver']) {
    const raw = `公开开头<${tag}>SECRET_TAIL<content>不得出现的尾部</content>`;
    const result = buildPresetPresentation(raw, raw, []);
    assert.equal(result.kind, 'markdown', tag);
    assert.equal(result.text, '公开开头', tag);
    assertContainsNoSecret(result, ['SECRET_TAIL', '不得出现的尾部']);
  }
});

test('think extraction prioritizes imported wrappers including tilde tag names', () => {
  const raw = `<reasoning>LEGACY_REASONING</reasoning>
<think_fox~ data-mode="full">FOX_REASONING</think_fox~>
<konatan_planning~>IZUMI_REASONING</konatan_planning~>`;

  assert.equal(
    instructionParser.extractThinkContent(raw, ['think_fox~']),
    'FOX_REASONING'
  );
  assert.equal(
    instructionParser.extractThinkContent(raw, ['konatan_planning~', 'think_fox~']),
    'IZUMI_REASONING',
    'profile order must win over document order and built-in tags'
  );
});

test('think extraction keeps legacy tags and reflection fallback when preferred wrappers are absent', () => {
  assert.equal(
    instructionParser.extractThinkContent(
      '<reasoning>LEGACY_REASONING</reasoning>',
      ['missing_wrapper~']
    ),
    'LEGACY_REASONING'
  );
  assert.equal(
    instructionParser.extractThinkContent('回映摘要\n[回映结束]\n正文', ['missing_wrapper~']),
    '回映摘要'
  );
});

test('zero-regex tagged output becomes a structured presentation', () => {
  const raw = `<story_driver>SECRET_ZERO_DRIVER</story_driver>
<story_scene>雨落在屋檐上。<htmlcontent><!doctype html><html><body><div class="scroll">任务卷轴</div></body></html></htmlcontent></story_scene>
<memory_log>【木叶】鸣人接下任务。</memory_log>
<wlog time="午后">第三班正在集合。</wlog>
<status>体力：90</status>
<character_state>佐助：警觉</character_state>
<options>前往训练场｜留在火影楼</options>`;
  const result = buildPresetPresentation(raw, raw, []);

  assert.equal(result.kind, 'structured');
  assert.match(result.text, /雨落在屋檐上/);
  assert.deepEqual(result.actions, ['前往训练场', '留在火影楼']);
  assert.deepEqual(
    result.blocks.map(block => [block.kind, block.tag]),
    [
      ['sandbox', 'htmlcontent'],
      ['status', 'memory_log'],
      ['status', 'wlog'],
      ['status', 'status'],
      ['status', 'character_state'],
      ['status', 'options']
    ]
  );
  const sandbox = result.blocks.find(block => block.kind === 'sandbox');
  assert.match(sandbox.source, /<div class="scroll">任务卷轴<\/div>/);
  assert.doesNotMatch(sandbox.source, /<!doctype|<\/?html|<\/?body/i);
  assertContainsNoSecret(result, ['SECRET_ZERO_DRIVER']);
});

test('story_scene takes precedence over enclosing content without duplication', () => {
  const result = buildPresetPresentation(
    '<content>外层说明<story_scene>唯一可见正文</story_scene></content>',
    '外层说明唯一可见正文',
    []
  );

  assert.equal(result.kind, 'structured');
  assert.equal(result.text, '唯一可见正文');
  assert.deepEqual(result.blocks, []);
});

test('project machine blocks cannot enter structured fields', () => {
  const result = buildPresetPresentation(
    '<variable>{"secret":"SECRET_VARIABLE"}</variable><story_scene>公开正文</story_scene><status_query />',
    '<variable>{"secret":"SECRET_VARIABLE"}</variable>公开正文',
    []
  );

  assert.equal(result.kind, 'structured');
  assert.equal(result.text, '公开正文');
  assertContainsNoSecret(result, ['SECRET_VARIABLE', 'status_query']);
});

test('plain unwrapped text retains the markdown fallback', () => {
  const result = buildPresetPresentation('没有结构标签的正文。', '没有结构标签的正文。', []);
  assert.equal(result.kind, 'markdown');
  assert.equal(result.text, '没有结构标签的正文。');
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.appliedScripts, []);
});

test('fox-v18 sandboxes only the fox_selc beautification block', () => {
  const raw = `<think_fox~>SECRET_FOX_DEDICATED</think_fox~>
<content>狐神正文保持 markdown。</content>
<fox_selc>【默认】调查脚印｜【正面】询问同伴</fox_selc>
<fox_tip>狐神留言</fox_tip>
<memory>{"secret":"SECRET_FOX_MACHINE"}</memory>`;
  const result = buildPresetPresentation(raw, '狐神正文保持 markdown。', [{
    id: 'fox-action-card',
    enabled: true,
    markdownOnly: true,
    placement: [2],
    findRegex: '/<fox_selc>([\\s\\S]*?)<\\/fox_selc>/gi',
    replaceString: '<style>.fox-actions{color:gold}</style><div class="fox-actions">$1</div>'
  }], { adapterId: 'fox-v18' });

  assert.equal(result.kind, 'structured');
  assert.deepEqual(result.blocks.map(block => block.kind), ['markdown', 'sandbox', 'status']);
  assert.equal(result.blocks[0].text, '狐神正文保持 markdown。');
  assert.match(result.blocks[1].source, /fox-actions/);
  assert.deepEqual(result.actions, ['调查脚印', '询问同伴']);
  assertContainsNoSecret(result, ['SECRET_FOX_DEDICATED', 'SECRET_FOX_MACHINE']);
});

test('izumi-0707 keeps plain body separate from the event-progress HTML card', () => {
  const raw = `<konatan_planning~>SECRET_IZUMI_DEDICATED</konatan_planning~>
Izumi 纯文本正文。
<current_event>护送任务</current_event>
<progress>第二阶段</progress>
<tucao>小此吐槽</tucao>
<state_update>{"changed":false}</state_update>`;
  const result = buildPresetPresentation(raw, 'Izumi 纯文本正文。', [{
    id: 'izumi-event-card',
    enabled: true,
    markdownOnly: true,
    placement: [2],
    findRegex: '/<current_event>([\\s\\S]*?)<\\/current_event>\\s*<progress>([\\s\\S]*?)<\\/progress>/gi',
    replaceString: '<section class="izumi-event">$1 · $2</section>'
  }], { adapterId: 'izumi-0707' });

  assert.equal(result.kind, 'structured');
  assert.deepEqual(result.blocks.map(block => block.kind), ['markdown', 'sandbox', 'status']);
  assert.equal(result.blocks[0].text, 'Izumi 纯文本正文。');
  assert.match(result.blocks[1].source, /护送任务 · 第二阶段/);
  assertContainsNoSecret(result, ['SECRET_IZUMI_DEDICATED', 'state_update']);
});

test('dream-whale-v4 renders scene, body, parallel event and options as independent blocks', () => {
  const raw = `<think>SECRET_DREAM_MAIN</think>
<dream_plot><dream_body><dream_scene><date>木叶历60年</date><time>午后</time><location>训练场</location></dream_scene>梦鲸正文。</dream_body>
<dream_after_format><dream_parallel_event><simple_thinking>SECRET_DREAM_LOCAL</simple_thinking>暗部从屋顶经过。</dream_parallel_event>
<dream_option>继续训练｜跟随暗部</dream_option>
<shinobi_daily>{"secret":"SECRET_DREAM_MACHINE"}</shinobi_daily></dream_after_format></dream_plot>`;
  const result = buildPresetPresentation(raw, '梦鲸正文。', [{
    id: 'dream-parallel-card',
    enabled: true,
    markdownOnly: true,
    placement: [2],
    findRegex: '/<dream_parallel_event>([\\s\\S]*?)<\\/dream_parallel_event>/gi',
    replaceString: '<aside class="dream-parallel">$1</aside>'
  }], { adapterId: 'dream-whale-v4' });

  assert.equal(result.kind, 'structured');
  assert.deepEqual(result.blocks.map(block => block.kind), ['status', 'markdown', 'sandbox', 'status']);
  assert.match(result.blocks[0].text, /木叶历60年/);
  assert.equal(result.blocks[1].text, '梦鲸正文。');
  assert.match(result.blocks[2].source, /暗部从屋顶经过/);
  assert.deepEqual(result.actions, ['继续训练', '跟随暗部']);
  assertContainsNoSecret(result, ['SECRET_DREAM_MAIN', 'SECRET_DREAM_LOCAL', 'SECRET_DREAM_MACHINE']);
});

test('miemie-v5 zero-regex renderer separates story, parallel line, logs, status and affinity', () => {
  const raw = `<think>think is over...</think><acg_think>SECRET_MIE_ACG</acg_think><combat_driver>SECRET_MIE_COMBAT</combat_driver><story_driver>SECRET_MIE_STORY</story_driver>
<story_scene>咩咩玩家侧正文。<parallel_line_drive>SECRET_MIE_PARALLEL</parallel_line_drive><parallel_line>另一边，巡逻队抵达。</parallel_line></story_scene>
<memory_log>记忆记录</memory_log><wlog time="午后">世界记录</wlog><status>体力90</status><affinity>佐助+1</affinity>
<memory>{"secret":"SECRET_MIE_MACHINE"}</memory>`;
  const result = buildPresetPresentation(raw, '咩咩玩家侧正文。', [], { adapterId: 'miemie-v5' });

  assert.equal(result.kind, 'structured');
  assert.deepEqual(result.blocks.map(block => block.label), [
    '', '平行事件', '记忆记录', '世界记录', '状态', '关系变化'
  ]);
  assert.equal(result.blocks[0].kind, 'markdown');
  assert.equal(result.blocks[0].text, '咩咩玩家侧正文。');
  assert.match(result.blocks.find(block => block.tag === 'wlog').text, /午后\s+世界记录/);
  assertContainsNoSecret(result, [
    'SECRET_MIE_ACG', 'SECRET_MIE_COMBAT', 'SECRET_MIE_STORY',
    'SECRET_MIE_PARALLEL', 'SECRET_MIE_MACHINE'
  ]);
});

test('fox-v18 statically restores its script-built action panel and respects hidden tip regex', () => {
  const raw = `<think_fox~>SECRET_FOX_STATIC</think_fox~>
<content>静态狐策正文。</content>
<fox_selc>
【默认】(｡･ω･｡)<font color="#4ECDC4">调查脚印</font>
【正面】(ง •̀_•́)ง<font color="#FF6B6B">询问同伴</font>
</fox_selc>
<fox_tip>不应被重新放回展示</fox_tip>`;
  const result = buildPresetPresentation(raw, '静态狐策正文。', [
    {
      id: 'fox-hide-tip', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<fox_tip>[\\s\\S]*?<\\/fox_tip>/gi', replaceString: ''
    },
    {
      id: 'fox-script-panel', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<fox_selc>[\\s\\S]*?<\\/fox_selc>/gi',
      replaceString: `<style>.rim-content{max-height:0}.action-card{display:block}</style>
        <div class="rim-collapsible"><div class="rim-header" aria-expanded="false">狐策</div>
        <div class="rim-content"><div class="fox-tip-area"></div><div class="rim-content-inner" id="actionsContainer"></div></div></div>
        <script>document.getElementById('actionsContainer').textContent='IMPORTED_SCRIPT_RAN'</script>`
    }
  ], { adapterId: 'fox-v18' });

  assert.deepEqual(result.blocks.map(block => block.kind), ['markdown', 'sandbox']);
  const panel = result.blocks[1].source;
  assert.match(panel, /class="rim-collapsible expanded"/);
  assert.match(panel, /class="action-card" data-option-text="调查脚印"/);
  assert.match(panel, /class="action-card" data-option-text="询问同伴"/);
  assert.doesNotMatch(JSON.stringify(result), /不应被重新放回展示|SECRET_FOX_STATIC/);
});

test('izumi-0707 restores option and Technical Footer widgets without imported scripts', () => {
  const raw = `<konatan_planning~>SECRET_IZUMI_STATIC</konatan_planning~>Izumi 正文。
<current_event>护送任务</current_event><progress>第二阶段</progress><tucao>吐槽</tucao>
<options>
>选项一：调查脚印
>选项二：询问同伴
>选项三：原地等待
>选项四：返回村口
</options>
<!-- Technical Footer Start
<danmu>第一条弹幕
第二条弹幕</danmu>
Technical Footer End -->`;
  const result = buildPresetPresentation(raw, 'Izumi 正文。', [
    {
      id: 'izumi-options', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '<options>\\s*?>选项一：\\s*([^>]+?)\\s*?>选项二：\\s*([^>]+?)\\s*?>选项三：\\s*([^>]+?)\\s*?>选项四：\\s*([^>]+?)\\s*<\\/options>',
      replaceString: `<style>.option-list{display:grid}</style><div class="option-panel-container"><ul class="option-list"><li>EMPTY</li></ul></div><script>IMPORTED_SCRIPT</script>`
    },
    {
      id: 'izumi-danmu', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<!-- Technical.*?<danmu>([\\s\\S]*?)<\\/danmu>.*?-->/gsi',
      replaceString: `<style>.danmaku-super-container-rgb{height:100vh}</style><div class="danmaku-super-container-rgb"></div><div id="danmaku-data-source" style="display:none">$1</div><script>IMPORTED_SCRIPT</script>`
    }
  ], { adapterId: 'izumi-0707' });

  const options = result.blocks.find(block => block.tag === 'options');
  const danmu = result.blocks.find(block => block.tag === 'danmu');
  assert.equal(options.kind, 'sandbox');
  assert.match(options.source, /data-option-text="调查脚印"/);
  assert.match(options.source, /data-option-text="返回村口"/);
  assert.equal(danmu.kind, 'sandbox');
  assert.match(danmu.source, />第一条弹幕</);
  assert.match(danmu.source, />第二条弹幕</);
  assert.match(danmu.source, /height: auto !important/);
  assertContainsNoSecret(result, ['SECRET_IZUMI_STATIC']);
});

test('dream-whale-v4 statically restores scene, parallel events, options and big discuss', () => {
  const raw = `<think>SECRET_DREAM_STATIC</think><dream_plot><dream_body>
<dream_scene><date>木叶历60年</date><time>午后</time><location>训练场</location></dream_scene>
梦鲸正文。</dream_body><dream_after_format>
<dream_parallel_event><simple_thinking>SECRET_DREAM_LOCAL</simple_thinking>
火影楼|纲手翻阅卷宗。<br>她让静音核对名单。
村口|巡逻队检查通行证。<br>风吹动门旗。
</dream_parallel_event>
<dream_option>继续训练｜跟随巡逻队</dream_option>
<dream_big_discuss>一起讨论。<q content="接下来去哪？"><a>火影楼</a><a>村口</a></q></dream_big_discuss>
</dream_after_format></dream_plot>`;
  const scripts = [
    {
      id: 'dream-scene', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<dream_scene>\\s*<date>([\\s\\S]*?)<\\/date>\\s*<time>([\\s\\S]*?)<\\/time>\\s*<location>([\\s\\S]*?)<\\/location>\\s*<\\/dream_scene>/gm',
      replaceString: '<div class="dream-scene-bar"><span class="dream-scene-bar__value">$1</span><span class="dream-scene-bar__value">$2</span><span class="dream-scene-bar__value">$3</span></div>'
    },
    {
      id: 'dream-parallel', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<dream_parallel_event>\\s*([\\s\\S]*?)\\s*<\\/dream_parallel_event>/gm',
      replaceString: `<style>.dream-paraller-event-ui__panel{min-height:100vh}</style><div class="dream-paraller-event-ui"><template class="dream-paraller-event-ui__source">$1</template><details class="dream-paraller-event-ui__panel"><summary>平行事件 <span class="dream-paraller-event-ui__meta"></span></summary><div class="dream-paraller-event-ui__events"></div></details></div><script>IMPORTED_SCRIPT</script>`
    },
    {
      id: 'dream-options', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<dream_option>\\s*([\\s\\S]*?)\\s*<\\/dream_option>/gi',
      replaceString: `<style>.dream-option-ui__list{display:grid}</style><div class="dream-option-ui"><template class="dream-option-ui__source">$1</template><section><span class="dream-option-ui__count"></span><button class="dream-option-ui__settings-toggle">设置</button><div class="dream-option-ui__settings"></div><div class="dream-option-ui__list"></div></section></div><script>IMPORTED_SCRIPT</script>`
    },
    {
      id: 'dream-discuss', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<dream_big_discuss>\\s*([\\s\\S]*?)\\s*<\\/dream_big_discuss>/gm',
      replaceString: `<style>.dream-big-discuss-ui__grid{display:grid}</style><div class="dream-big-discuss-ui"><template class="dream-big-discuss-ui__source">$1</template><span class="dream-big-discuss-ui__summary-meta"></span><div class="dream-big-discuss-ui__note" hidden></div><div class="dream-big-discuss-ui__grid"></div></div><script>IMPORTED_SCRIPT</script>`
    }
  ];
  const result = buildPresetPresentation(raw, '梦鲸正文。', scripts, { adapterId: 'dream-whale-v4' });

  const scene = result.blocks.find(block => block.tag === 'dream_scene');
  const parallel = result.blocks.find(block => block.tag === 'dream_parallel_event');
  const options = result.blocks.find(block => block.tag === 'dream_option');
  const discuss = result.blocks.find(block => block.tag === 'dream_big_discuss');
  assert.match(scene.source, />木叶历60年</);
  assert.match(parallel.source, /dream-paraller-event-ui__event/);
  assert.match(parallel.source, /2 则/);
  assert.doesNotMatch(parallel.source, /dream-paraller-event-ui__source/);
  assert.match(options.source, /data-option-text="继续训练"/);
  assert.match(options.source, /2 项/);
  assert.match(discuss.source, /dream-big-discuss-ui__card/);
  assert.match(discuss.source, /data-action="&lt;dream_answer q=&quot;接下来去哪？&quot;&gt;/);
  assertContainsNoSecret(result, ['SECRET_DREAM_STATIC', 'SECRET_DREAM_LOCAL']);

  const emptyParallel = buildPresetPresentation(
    '<dream_plot><dream_body>正文</dream_body><dream_after_format><dream_parallel_event><simple_thinking>ONLY_PRIVATE</simple_thinking></dream_parallel_event></dream_after_format></dream_plot>',
    '正文',
    scripts,
    { adapterId: 'dream-whale-v4' }
  );
  assert.equal(emptyParallel.blocks.some(block => block.tag === 'dream_parallel_event'), false);
  assertContainsNoSecret(emptyParallel, ['ONLY_PRIVATE']);
});

test('HTML assets with no visible result fall back instead of mounting a blank sandbox', () => {
  const result = buildPresetPresentation(
    '<content>仍应显示的正文</content>',
    '仍应显示的正文',
    [{
      id: 'css-only', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<content>[\\s\\S]*?<\\/content>/gi',
      replaceString: '<style>body{height:100vh;background:#000}</style><script>IMPORTED_SCRIPT</script>'
    }],
    { adapterId: 'fox-v18' }
  );

  assert.equal(result.blocks[0].kind, 'markdown');
  assert.equal(result.blocks[0].text, '仍应显示的正文');
});

console.log(`PASS ${passed} preset regex runtime regression checks.`);
