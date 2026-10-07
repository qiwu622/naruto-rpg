import { test, expect } from '@playwright/test';

async function openHarness(page, mode) {
  await page.goto(`/tests/fixtures/preset-output-app-shell-harness.html?mode=${mode}`);
  await page.waitForFunction(() => window.__PRESET_OUTPUT_HARNESS_READY__ === true);
}

for (const [name, replaceString] of [
  ['empty', ''], ['whitespace', ' \n\t '], ['cleaned-internal-tag', '<analysis>PRIVATE_REPLACEMENT</analysis>']
]) {
  test(`keeps streamed narrative after variable completion when display regex becomes ${name}`, async ({ page }) => {
    await openHarness(page, 'fallback');
    await installPreset(page, {
      name: 'Empty display output fixture',
      entries: [{ id: 'plain-fixture', name: 'plain fixture', enabled: true, role: 'system', content: '继续故事。' }],
      regexScripts: [{
        id: 'empty-body-display', enabled: true, markdownOnly: true, placement: [2],
        findRegex: '/<story_scene>[\\s\\S]*?<\\/story_scene>/', replaceString
      }]
    });
    const raw = '<reasoning>PRIVATE_RAW_REASONING</reasoning><story_scene>等待变量更新时可见的正文。</story_scene>'
      + '<variable>{"key":"进度·经验","op":"+","value":1}</variable>';
    const content = page.locator('.chat-message--ai .chat-content');
    await page.evaluate(value => window.__PRESET_OUTPUT_HARNESS__.stream(value), raw);
    await expect(content).toContainText('等待变量更新时可见的正文。');
    await expect(page.locator('.is-streaming')).toHaveCount(1);
    await page.evaluate(value => window.__PRESET_OUTPUT_HARNESS__.finish(value, '等待变量更新时可见的正文。'), raw);
    await expect(page.locator('.is-streaming')).toHaveCount(0);
    await expect(page.locator('.think-block')).toContainText('独立展示的思维链。');
    await expect(content.locator('[data-shinobi-daily-host]')).toHaveCount(1);
    await expect(content.locator('.preset-output-presentation')).toContainText('等待变量更新时可见的正文。');
    await expect(content).not.toContainText('PRIVATE_RAW_REASONING');
    await expect(content).not.toContainText('PRIVATE_REPLACEMENT');
    await expect(content).not.toContainText('进度·经验');
  });
}

function foxStaticPreset() {
  return {
    name: 'Fox static UI fixture',
    assistantPrefill: '<think_fox~>',
    entries: [{
      id: 'fox-signature', name: 'fox signature', enabled: true, role: 'system',
      content: '<think_fox~></think_fox~><content></content><fox_selc></fox_selc><fox_tip></fox_tip>'
    }],
    regexScripts: [{
      id: 'fox-actions', enabled: true, markdownOnly: true, placement: [2],
      findRegex: '/<fox_selc>[\\s\\S]*?<\\/fox_selc>/gi',
      replaceString: `<style>
        body{display:flex;align-items:center;justify-content:center;height:100vh;background:#090909}
        .rim-collapsible{width:100%;min-height:100vh}.rim-content{max-height:0;overflow:hidden}
        .rim-content-inner{display:grid;gap:8px}.action-card{padding:10px;color:#fff;background:#222}
      </style><div class="rim-collapsible"><div class="rim-header" aria-expanded="false">狐策</div><div class="rim-content"><div class="fox-tip-area"></div><div class="rim-content-inner" id="actionsContainer"></div></div></div><script>document.body.dataset.importedFoxScriptRan='true'</script>`
    }]
  };
}

function dreamStaticPreset() {
  return {
    name: 'Dream static UI fixture',
    entries: [{
      id: 'dream-signature', name: 'dream signature', enabled: true, role: 'system',
      content: `根节点必须是 <dream_plot>
<dream_plot><dream_body><dream_scene><date></date><time></time><location></location></dream_scene></dream_body><dream_after_format><dream_parallel_event><simple_thinking></simple_thinking></dream_parallel_event></dream_after_format></dream_plot>`
    }],
    regexScripts: [
      {
        id: 'dream-scene', enabled: true, markdownOnly: true, placement: [2],
        findRegex: '/<dream_scene>\\s*<date>([\\s\\S]*?)<\\/date>\\s*<time>([\\s\\S]*?)<\\/time>\\s*<location>([\\s\\S]*?)<\\/location>\\s*<\\/dream_scene>/gm',
        replaceString: '<style>.dream-scene-bar{display:flex;gap:8px;min-height:100vh;background:#151515}.dream-scene-bar__value{padding:8px}</style><div class="dream-scene-bar"><span class="dream-scene-bar__value">$1</span><span class="dream-scene-bar__value">$2</span><span class="dream-scene-bar__value">$3</span></div>'
      },
      {
        id: 'dream-parallel', enabled: true, markdownOnly: true, placement: [2],
        findRegex: '/<dream_parallel_event>\\s*([\\s\\S]*?)\\s*<\\/dream_parallel_event>/gm',
        replaceString: `<style>
          .dream-paraller-event-ui__panel{min-height:100vh;margin:0;background:#151515;color:#eee}
          summary{padding:10px}.dream-paraller-event-ui__event{padding:10px}.dream-paraller-event-ui__description-part{display:block}
        </style><div class="dream-paraller-event-ui"><template class="dream-paraller-event-ui__source">$1</template><details class="dream-paraller-event-ui__panel"><summary>平行事件 <span class="dream-paraller-event-ui__meta"></span></summary><div class="dream-paraller-event-ui__events"></div></details></div><script>window.__IMPORTED_DREAM_SCRIPT_RAN__=true</script>`
      },
      {
        id: 'dream-options', enabled: true, markdownOnly: true, placement: [2],
        findRegex: '/<dream_option>\\s*([\\s\\S]*?)\\s*<\\/dream_option>/gi',
        replaceString: `<style>
          .dream-option-ui{min-height:100vh;background:#151515;color:#eee}.dream-option-ui__list{display:grid;gap:8px}
          .dream-option-ui__option{padding:10px;color:inherit;background:#222;border:1px solid #555}
        </style><div class="dream-option-ui"><template class="dream-option-ui__source">$1</template><section><span class="dream-option-ui__count"></span><button class="dream-option-ui__settings-toggle">设置</button><div class="dream-option-ui__settings"></div><div class="dream-option-ui__list"></div></section></div><script>document.body.dataset.importedDreamOptionScriptRan='true'</script>`
      }
    ]
  };
}

function izumiStaticPreset() {
  return {
    name: 'Izumi static UI fixture',
    assistantPrefill: '<konatan_planning~>',
    entries: [{
      id: 'izumi-signature', name: 'izumi signature', enabled: true, role: 'system',
      content: '<konatan_planning~></konatan_planning~><current_event></current_event><progress></progress><tucao></tucao>'
    }],
    regexScripts: [
      {
        id: 'izumi-options', enabled: true, markdownOnly: true, placement: [2],
        findRegex: '<options>\\s*?>选项一：\\s*([^>]+?)\\s*?>选项二：\\s*([^>]+?)\\s*?>选项三：\\s*([^>]+?)\\s*?>选项四：\\s*([^>]+?)\\s*<\\/options>',
        replaceString: '<style>.option-panel-container{background:#fff;color:#333}.option-list{display:grid;gap:6px}.option-link{padding:8px}</style><div class="option-panel-container"><ul class="option-list"></ul></div><script>window.__IMPORTED_IZUMI_SCRIPT_RAN__=true</script>'
      },
      {
        id: 'izumi-danmu', enabled: true, markdownOnly: true, placement: [2],
        findRegex: '/<!-- Technical.*?<danmu>([\\s\\S]*?)<\\/danmu>.*?-->/gsi',
        replaceString: '<style>body{padding:20px}.danmaku-super-container-rgb{height:100vh;background:#111;color:#fff}.danmaku-content-multicolor-rgb{position:absolute}</style><div class="danmaku-super-container-rgb"></div><div id="danmaku-data-source" style="display:none">$1</div><script>document.body.dataset.importedIzumiDanmuScriptRan="true"</script>'
      }
    ]
  };
}

async function installPreset(page, preset) {
  await page.evaluate(value => window.__PRESET_OUTPUT_HARNESS__.setPreset(value), preset);
}

async function assertNoHorizontalOverflow(page) {
  const hostOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(hostOverflow).toBeLessThanOrEqual(1);
  const frameOverflows = await Promise.all(page.frames().slice(1).map(frame => frame.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))));
  for (const overflow of frameOverflows) expect(overflow).toBeLessThanOrEqual(1);
}

async function waitForSandboxReady(frame) {
  await expect(frame).not.toHaveAttribute('aria-busy', 'true');
  await expect(frame.contentFrame().locator('html')).toHaveAttribute('data-naruto-preset-interactive', 'true');
}

test('renders imported markdown regex from the raw branch without exposing private blocks', async ({ page }) => {
  await openHarness(page, 'markdown');
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.complete([
    '<reasoning>PRIVATE_REASONING</reasoning>',
    '<story_scene>可见剧情</story_scene>',
    '<review_audit>PRIVATE_AUDIT</review_audit>'
  ].join('\n'), '安全正文'));

  const content = page.locator('.chat-message--ai .chat-content');
  await expect(content).toContainText('卷轴美化');
  await expect(content).toContainText('可见剧情');
  await expect(content).not.toContainText('PRIVATE_REASONING');
  await expect(content).not.toContainText('PRIVATE_AUDIT');
  await expect(content.locator('iframe')).toHaveCount(0);
});

test('mounts HTML replacements in a sandbox and actions only fill the input', async ({ page }) => {
  await openHarness(page, 'sandbox');
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.complete(
    '<story_scene>原始剧情</story_scene>',
    '安全正文'
  ));

  const frame = page.locator('.preset-output-sandbox');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.frameLocator('.preset-output-sandbox').locator('#beautified')).toHaveText('狐纹美化');
  await waitForSandboxReady(frame);
  await page.frameLocator('.preset-output-sandbox').locator('#preset-action').click();

  await expect.poll(() => page.locator('#chat-input').inputValue()).toBe('向北潜行');
  expect(await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.submitCount)).toBe(0);
});

test('uses structured fallback without regex scripts and omits driver or audit blocks', async ({ page }) => {
  await openHarness(page, 'fallback');
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.complete([
    '<planning_driver>PRIVATE_DRIVER</planning_driver>',
    '<story_scene>通用结构正文</story_scene>',
    '<memory_log>可展示记忆</memory_log>',
    '<selection>1. 向北潜行\n2. 留在原地</selection>',
    '<audit>PRIVATE_AUDIT</audit>'
  ].join('\n'), '安全正文'));

  const content = page.locator('.chat-message--ai .chat-content');
  await expect(content).toContainText('通用结构正文');
  await expect(content).toContainText('可展示记忆');
  await expect(content).not.toContainText('PRIVATE_DRIVER');
  await expect(content).not.toContainText('PRIVATE_AUDIT');
  await expect(content.locator('.preset-output-host-action')).toHaveCount(2);
  await content.locator('.preset-output-host-action').first().click();
  await expect(page.locator('#chat-input')).toHaveValue('向北潜行');
  expect(await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.submitCount)).toBe(0);
});

test('history redraw uses only persisted clean text and never rebuilds a raw sandbox', async ({ page }) => {
  await openHarness(page, 'sandbox');
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.complete('<story_scene>当前回合</story_scene>'));
  await expect(page.locator('.preset-output-sandbox')).toHaveCount(1);

  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.restore('历史安全正文', [{
    role: 'assistant',
    content: '<reasoning>HISTORY_REASONING</reasoning><audit>HISTORY_AUDIT</audit>'
  }]));

  const content = page.locator('.chat-message--ai .chat-content');
  await expect(content.locator(':scope > p')).toHaveText('历史安全正文');
  await expect(page.locator('.preset-output-sandbox')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('HISTORY_REASONING');
  await expect(page.locator('body')).not.toContainText('HISTORY_AUDIT');
});

test('failed imported preset exposes the complete local raw response and copy action', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => { window.__COPIED_PRESET_DEBUG__ = text; }
      }
    });
  });
  const consoleLines = [];
  page.on('console', message => consoleLines.push(message.text()));
  await openHarness(page, 'fallback');
  const raw = [
    '<think>完整原始推演',
    '<simple_thinking>交叉内容</think>',
    '<state_update>{"changed":false}</state_update>',
    '<memory>{"summary":"完整原始记忆"}</memory>'
  ].join('\n');
  await page.evaluate(value => window.__PRESET_OUTPUT_HARNESS__.failImportedPreset(value), raw);

  const errorCard = page.locator('.chat-message--error');
  await expect(errorCard).toContainText('导入预设输出未通过校验');
  await expect(errorCard).toContainText('F12 控制台搜索 [ImportedPresetDebug]');
  await expect(errorCard).not.toContainText('完整原始推演');
  await expect.poll(() => consoleLines.some(line => line.includes(raw))).toBe(true);
  expect(await page.evaluate(() => window.__NARUTO_PRESET_DEBUG__.rawResponse)).toBe(raw);

  const cardBox = await errorCard.boundingBox();
  const viewport = page.viewportSize();
  expect(cardBox).not.toBeNull();
  expect(cardBox.x).toBeGreaterThanOrEqual(0);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);
  await testInfo.attach('imported-preset-debug-error-card', {
    body: await errorCard.screenshot(),
    contentType: 'image/png'
  });
  if (process.env.NARUTO_CAPTURE_PRESET_DEBUG === '1') {
    await errorCard.screenshot({ path: '.codex-tmp/imported-preset-debug-error-card.png' });
  }

  await errorCard.locator('.preset-debug-copy-btn').click();
  await expect.poll(() => page.evaluate(() => window.__COPIED_PRESET_DEBUG__)).toBe(raw);

  await page.evaluate(() => { delete window.__NARUTO_PRESET_DEBUG__; });
  await errorCard.locator('.preset-debug-copy-btn').click();
  await expect(page.locator('.toast')).toHaveText('本次完整 AI 回复日志已失效，请重新生成后再复制。');

  await page.evaluate(value => {
    window.__PRESET_OUTPUT_HARNESS__.failImportedPreset(value);
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  }, `${raw}\nSECOND_FAILURE`);
  await page.locator('.chat-message--error').last().locator('.preset-debug-copy-btn').click();
  await expect(page.locator('.toast')).toContainText('copy(window.__NARUTO_PRESET_DEBUG__.rawResponse)');
});

test('dream adapter keeps viewport-sized regex cards compact and resizes details both ways', async ({ page }) => {
  await openHarness(page, 'fallback');
  await installPreset(page, dreamStaticPreset());
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.complete(`<think>PRIVATE_MAIN</think>
<dream_plot><dream_body><dream_scene><date>木叶历60年</date><time>午后</time><location>训练场</location></dream_scene>梦鲸正文。</dream_body>
<dream_after_format><dream_parallel_event><simple_thinking>PRIVATE_LOCAL</simple_thinking>
火影楼|纲手翻阅卷宗。<br>她让静音核对名单。
村口|巡逻队检查通行证。<br>风吹动门旗。
</dream_parallel_event><dream_option>继续训练｜跟随巡逻队</dream_option></dream_after_format></dream_plot>`, '梦鲸正文。'));

  const blocks = page.locator('.preset-output-structured-block');
  const sceneBlock = blocks.filter({ has: page.locator('.preset-output-structured-label', { hasText: '场景' }) });
  const parallelBlock = blocks.filter({ has: page.locator('.preset-output-structured-label', { hasText: '平行事件' }) });
  const optionBlock = blocks.filter({ has: page.locator('.preset-output-structured-label', { hasText: '行动选项' }) });
  const sceneFrame = sceneBlock.locator('iframe');
  const parallelFrame = parallelBlock.locator('iframe');
  const optionFrame = optionBlock.locator('iframe');

  await expect(sceneFrame.contentFrame().locator('.dream-scene-bar')).toContainText('木叶历60年');
  await expect(parallelFrame.contentFrame().locator('.dream-paraller-event-ui__event')).toHaveCount(2);
  await expect(optionFrame.contentFrame().locator('.dream-option-ui__option')).toHaveCount(2);
  await expect(page.locator('body')).not.toContainText('PRIVATE_MAIN');
  await expect(page.locator('body')).not.toContainText('PRIVATE_LOCAL');

  await expect.poll(() => sceneFrame.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(150);
  await expect.poll(() => parallelFrame.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(150);
  await expect.poll(() => optionFrame.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(260);
  await waitForSandboxReady(parallelFrame);
  await waitForSandboxReady(optionFrame);
  const collapsedHeight = await parallelFrame.evaluate(element => element.getBoundingClientRect().height);
  await parallelFrame.contentFrame().locator('summary').click();
  await expect.poll(() => parallelFrame.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight + 25);
  await parallelFrame.contentFrame().locator('summary').click();
  await expect.poll(() => parallelFrame.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(collapsedHeight + 8);

  await optionFrame.contentFrame().locator('.dream-option-ui__option').first().click();
  await expect(page.locator('#chat-input')).toHaveValue('继续训练');
  await expect(optionFrame.contentFrame().locator('body')).not.toHaveAttribute('data-imported-dream-option-script-ran', 'true');

  for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await assertNoHorizontalOverflow(page);
  }

  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.complete(`<dream_plot><dream_body>正文。</dream_body><dream_after_format><dream_parallel_event><simple_thinking>ONLY_PRIVATE</simple_thinking></dream_parallel_event></dream_after_format></dream_plot>`, '正文。'));
  await expect(page.locator('.preset-output-structured-label', { hasText: '平行事件' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('ONLY_PRIVATE');
});

test('fox adapter restores script-built cards as safe clickable static actions', async ({ page }) => {
  await openHarness(page, 'fallback');
  await installPreset(page, foxStaticPreset());
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.complete(`<think_fox~>PRIVATE_FOX</think_fox~>
<content>狐神正文。</content><fox_selc>
【默认】(｡･ω･｡)<font color="#4ECDC4">调查脚印</font>
【正面】(ง •̀_•́)ง<font color="#FF6B6B">询问同伴</font>
</fox_selc><fox_tip>留言</fox_tip>`, '狐神正文。'));

  const frame = page.locator('.preset-output-sandbox');
  const frameBody = frame.contentFrame();
  await expect(frameBody.locator('.action-card')).toHaveCount(2);
  await expect.poll(() => frame.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(300);
  await waitForSandboxReady(frame);
  await frameBody.locator('.action-card').first().click();
  await expect(page.locator('#chat-input')).toHaveValue('调查脚印');
  await expect(frameBody.locator('body')).not.toHaveAttribute('data-imported-fox-script-ran', 'true');
  await expect(page.locator('body')).not.toContainText('PRIVATE_FOX');

  for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await assertNoHorizontalOverflow(page);
  }
});

test('izumi adapter restores option and danmu replacements without blank script shells', async ({ page }) => {
  await openHarness(page, 'fallback');
  await installPreset(page, izumiStaticPreset());
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.complete(`<konatan_planning~>PRIVATE_IZUMI</konatan_planning~>Izumi 正文。
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
Technical Footer End -->`, 'Izumi 正文。'));

  const optionFrame = page.locator('.preset-output-structured-block--sandbox').filter({
    has: page.locator('.preset-output-structured-label', { hasText: '行动选项' })
  }).locator('iframe');
  const danmuFrame = page.locator('.preset-output-structured-block--sandbox').filter({
    has: page.locator('.preset-output-structured-label', { hasText: '弹幕' })
  }).locator('iframe');
  await expect(optionFrame.contentFrame().locator('.option-link')).toHaveCount(4);
  await expect(danmuFrame.contentFrame().locator('.danmaku-content-multicolor-rgb')).toHaveCount(2);
  await expect.poll(() => danmuFrame.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(220);
  await waitForSandboxReady(optionFrame);
  await optionFrame.contentFrame().locator('.option-link').last().click();
  await expect(page.locator('#chat-input')).toHaveValue('返回村口');
  await expect(danmuFrame.contentFrame().locator('body')).not.toHaveAttribute('data-imported-izumi-danmu-script-ran', 'true');
  await expect(page.locator('body')).not.toContainText('PRIVATE_IZUMI');

  for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await assertNoHorizontalOverflow(page);
  }
});
