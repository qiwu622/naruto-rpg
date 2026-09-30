import { eventBus } from '../core/event-bus.js';
import { stateManager } from '../core/state-manager.js';
import {
  listPersonaProfiles,
  getPersonaProfile,
  savePersonaProfile,
  deletePersonaProfile
} from '../core/persona-profiles.js';
import { GAME_DATA } from '../data/game-data.js';
import { CANON_DATABASE, displayCanonTechniqueName } from '../data/canon-database.js';
import { equipmentSystem } from '../systems/equipment-system.js';
import { createOpeningContract } from '../systems/opening-contract.js';
import {
  AI_COMPLETION_MODES,
  OPENING_DIFFICULTIES,
  OPENING_TEMPLATES,
  OFFICIAL_RANKS,
  START_PRESET_V2_KEY,
  applyOpeningTemplate,
  calculateCombatLevel,
  combatMasteriesFromAbilities,
  createOpeningDraft,
  initializeOpeningRuntime,
  loadOpeningPreset,
  normalizeOpeningDraft,
  serializeOpeningPreset
} from '../systems/opening-draft.js';
import { icon } from '../utils/icons.js';
import { escAttr, escHtml } from '../utils/format.js';
import { TIMELINE_FILE_ACCEPT } from '../core/timeline-file-codec.js';

const STAGES = [
  { id: 'campaign', label: '开局舞台', short: '舞台', mark: '壹' },
  { id: 'identity', label: '身份档案', short: '身份', mark: '贰' },
  { id: 'power', label: '实力配置', short: '实力', mark: '叁' },
  { id: 'assets', label: '资产与羁绊', short: '资产', mark: '肆' },
  { id: 'review', label: '核对开局', short: '核对', mark: '伍' }
];

const VARIANT_NAMES = {
  A: '档案工作台',
  B: '忍者登记卷',
  C: '开场编排台'
};

const TEMPLATE_ICONS = {
  academy: 'user',
  genin_team: 'users',
  chunin: 'map',
  anbu: 'lock',
  missing_nin: 'retreat',
  wanderer: 'wind',
  bloodline_heir: 'ice',
  scientific: 'zap',
  custom: 'sliders'
};

const NATURE_GLOWS = {
  火: '226,96,60',
  风: '93,170,140',
  雷: '203,162,107',
  土: '168,124,80',
  水: '88,160,180',
  阴: '139,124,183',
  阳: '230,197,122',
  冰遁: '159,212,228',
  灼遁: '226,130,74'
};

const ABILITY_TYPES = [
  ['jutsu', '忍术'], ['taijutsu', '体术'], ['genjutsu', '幻术'], ['support', '支援']
];
const ITEM_TYPES = [
  ['weapons', '武器'], ['armor', '防具'], ['tools', '忍具'], ['consumables', '消耗品']
];
const EQUIP_SLOTS = [
  ['', '不装备'], ['weapon', '武器位'], ['armor', '防具位'], ['accessory1', '饰品位一'], ['accessory2', '饰品位二']
];
const CHAKRA_NATURES = Object.keys(GAME_DATA.chakraNatures);
const OFFICIAL_RANK_OPTIONS = OFFICIAL_RANKS.map(rank => [rank, rank]);
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => [index + 1, `${index + 1}月`]);
const DAY_OPTIONS = Array.from({ length: 30 }, (_, index) => [index + 1, `${index + 1}日`]);
const TECHNIQUE_TYPE_LABELS = { jutsu: '忍术', taijutsu: '体术', genjutsu: '幻术', support: '支援' };
const TECHNIQUE_RANKS = ['E', 'D', 'C', 'B', 'A', 'S', '特'];
const TECHNIQUE_ELEMENTS = ['无', '火', '风', '雷', '土', '水', '阴', '阳', '阴阳'];
const TECHNIQUE_ROLES = [['攻击', '攻击'], ['防御', '防御'], ['辅助', '辅助']];
const TECHNIQUE_RESOURCES = [['chakra', '查克拉'], ['stamina', '体力'], ['spirit', '精神力']];
const TECHNIQUE_CLASSES = [
  ['血继限界', '血继限界'], ['秘传', '秘传术'], ['瞳术', '瞳术'], ['医疗忍术', '医疗忍术'],
  ['封印术', '封印术'], ['时空间忍术', '时空间忍术'], ['仙术', '仙术'], ['分身术', '分身术'],
  ['结界忍术', '结界忍术'], ['禁术', '禁术'], ['剑术', '剑术'], ['手里剑术', '手里剑术'],
  ['武器术', '武器术'], ['忍体术', '忍体术'], ['咒印术', '咒印术']
];
const TECHNIQUE_PAGE_SIZES = [12, 24, 48];

class CharacterCreator extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    const params = new URLSearchParams(globalThis.location?.search || '');
    this._prototype = params.get('creatorPrototype') === '1';
    const requestedVariant = String(params.get('variant') || 'A').toUpperCase();
    this._variant = this._prototype && VARIANT_NAMES[requestedVariant] ? requestedVariant : 'A';
    this._stage = 0;
    this._notice = '';
    this._presetLoaded = false;
    this._presetMigrated = false;
    this._techniqueQuery = '';
    this._techniqueType = '';
    this._techniqueRank = '';
    this._techniqueElement = '';
    this._techniqueRole = '';
    this._techniqueResource = '';
    this._techniqueClass = '';
    this._techniquePage = 1;
    this._techniquePageSize = TECHNIQUE_PAGE_SIZES[0];
    this._selectedPersonaId = '';
    this._draft = createOpeningDraft();
    if (!this._prototype) this._loadPreset();
    this._onPrototypeKey = (event) => this._handlePrototypeKey(event);
  }

  connectedCallback() {
    globalThis.addEventListener?.('keydown', this._onPrototypeKey);
    this._render();
  }

  setDraftMode(draft) {
    this._draftMode = true;
    this._draft = normalizeOpeningDraft(draft);
    this._presetLoaded = false;
    this._presetMigrated = false;
    this._stage = 0;
    if (this.isConnected) this._render();
  }

  disconnectedCallback() {
    globalThis.removeEventListener?.('keydown', this._onPrototypeKey);
  }

  _loadPreset() {
    const result = loadOpeningPreset(globalThis.localStorage);
    this._draft = result.draft;
    this._presetLoaded = result.loaded;
    this._presetMigrated = result.migrated;
    if (result.migrated) this._savePreset();
  }

  _savePreset() {
    if (this._prototype) return;
    if (this._draftMode) return;
    try {
      globalThis.localStorage?.setItem(START_PRESET_V2_KEY, JSON.stringify(serializeOpeningPreset(this._draft)));
    } catch (error) {
      console.warn('[CharacterCreator] Failed to save v2 opening preset:', error.message);
    }
  }

  _render() {
    this._syncCombatLevel();
    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="creator creator--${this._variant.toLowerCase()}${this._prototype ? ' is-prototype' : ''}" style="--cc-nature-glow:${this._natureGlow()}">
        <div class="creator-aura" aria-hidden="true"></div>
        ${this._header()}
        ${this._personaPanel()}
        ${this._presetBanner()}
        ${this._variant === 'B' ? this._variantB() : this._variant === 'C' ? this._variantC() : this._variantA()}
        ${this._notice ? `<div class="creator-notice" role="status">${icon('check', 15)}<span>${this._esc(this._notice)}</span></div>` : ''}
      </div>
      ${this._prototype ? this._prototypeSwitcher() : ''}
    `;
    this._bindEvents();
    this._loadPersonaProfiles();
  }

  _natureGlow() {
    const first = this._draft.power.chakraNatures[0];
    return NATURE_GLOWS[first] || '226,96,60';
  }

  _personaPanel() {
    return `
      <div class="persona-panel">
        <div class="persona-panel-title">${icon('user', 15)} 人设方案</div>
        <div class="persona-row">
          <select class="persona-select" id="persona-select">
            <option value="">— 选择已保存人设 —</option>
          </select>
          <button class="ghost-btn" type="button" data-action="persona-delete">删除</button>
        </div>
        <div class="persona-save-row">
          <input class="persona-name" id="persona-name" placeholder="人设名称，如「雾隐暗部·夜枭」" autocomplete="off" />
          <button class="ghost-btn" type="button" data-action="persona-save">保存当前人设</button>
        </div>
        <div class="persona-hint">人设长期保存在个人中心；开局前在下拉中选中即可切换。</div>
      </div>
    `;
  }

  async _loadPersonaProfiles() {
    const profiles = await listPersonaProfiles();
    const select = this.shadowRoot.querySelector('#persona-select');
    if (!select) return;
    const selectedId = profiles.some(profile => profile.id === this._selectedPersonaId)
      ? this._selectedPersonaId
      : '';
    this._selectedPersonaId = selectedId;
    select.innerHTML = [
      '<option value="">— 选择已保存人设 —</option>',
      ...profiles.map(profile => `<option value="${escAttr(profile.id)}">${escAttr(profile.name)}</option>`)
    ].join('');
    select.value = selectedId;
  }

  async _loadPersona(id) {
    if (!id) {
      this._selectedPersonaId = '';
      return;
    }
    const profile = await getPersonaProfile(id);
    if (!profile) {
      this._selectedPersonaId = '';
      this._loadPersonaProfiles();
      return;
    }
    this._selectedPersonaId = id;
    this._draft = normalizeOpeningDraft(profile.draft || this._draft);
    this._presetLoaded = true;
    this._savePreset();
    this._notice = `已切换人设「${profile.name}」。`;
    this._render();
  }

  async _savePersona() {
    const root = this.shadowRoot;
    const name = root.querySelector('#persona-name')?.value.trim();
    if (!name) { this._notice = '请先填写人设名称'; this._render(); return; }
    const id = await savePersonaProfile({ name, draft: this._draft });
    if (!id) { this._notice = '人设保存失败，请重试'; this._render(); return; }
    this._selectedPersonaId = id;
    this._notice = `已保存人设「${name}」，可在个人中心查看。`;
    this._render();
  }

  async _deletePersona() {
    const select = this.shadowRoot.querySelector('#persona-select');
    const id = select?.value;
    if (!id) { this._notice = '请先选择一个人设再删除'; this._render(); return; }
    const deleted = await deletePersonaProfile(id);
    this._selectedPersonaId = '';
    this._notice = deleted ? '人设已删除。' : '未找到要删除的人设。';
    this._render();
  }

  _header() {
    const done = this._completionCount();
    const dash = (done / STAGES.length * 62.83).toFixed(2);
    return `
      <header class="creator-header">
        <div class="creator-brand">
          <span class="creator-seal" aria-hidden="true">始</span>
          <div class="creator-title">
            <div class="creator-kicker">OPENING DOSSIER · V2</div>
            <h1>编写你的忍者开局</h1>
          </div>
          <span class="creator-side" aria-hidden="true">忍籍登録</span>
        </div>
        <div class="creator-header-actions">
          ${this._prototype ? '<span class="prototype-badge">仅原型 · 不写入存档</span>' : ''}
          <div class="progress-ring" role="img" aria-label="已配置 ${done} / ${STAGES.length} 章">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle class="ring-track" cx="12" cy="12" r="10"></circle>
              <circle class="ring-fill" cx="12" cy="12" r="10" style="stroke-dasharray:${dash} 62.83"></circle>
            </svg>
            <span>${done}<small>/${STAGES.length}</small></span>
          </div>
          <button class="ghost-btn" type="button" data-action="import-timeline">${icon('export', 15)} 导入时间线</button>
          <input id="timeline-import-file" type="file" accept="${TIMELINE_FILE_ACCEPT}" hidden />
        </div>
      </header>
    `;
  }

  _presetBanner() {
    if (!this._presetLoaded || this._prototype) return '';
    return `
      <div class="preset-banner">
        <div>${icon('file-text', 17)}<span><strong>${this._presetMigrated ? '旧版卷轴已安全迁移' : '已载入上次的开局草稿'}</strong><small>v1 仍保留作回退；本次编辑只写入 v2 草稿。</small></span></div>
        <button class="icon-btn" type="button" title="重置开局草稿" aria-label="重置开局草稿" data-action="clear-preset">${icon('close', 16)}</button>
      </div>
    `;
  }

  _variantA() {
    return `
      <div class="workbench">
        <nav class="stage-rail" aria-label="开局配置阶段">
          <div class="rail-heading">档案目录</div>
          ${STAGES.map((stage, index) => this._stageButton(stage, index, 'rail')).join('')}
          <div class="rail-foot"><span>${this._completionCount()}/5</span> 章节已配置</div>
        </nav>
        <main class="editor-panel">
          ${this._stageHeader()}
          ${this._stageContent(this._stage)}
          ${this._stageNavigation()}
        </main>
        <aside class="live-summary" data-live-summary>
          ${this._summaryPanel()}
        </aside>
      </div>
    `;
  }

  _variantB() {
    return `
      <div class="scroll-layout">
        <main class="registration-scroll">
          <div class="scroll-title-row">
            <div><span>火之国忍籍记录 · 自由格式</span><h2>忍者登记卷</h2></div>
            <div class="scroll-stamp">第 ${this._draft.version} 版</div>
          </div>
          ${STAGES.map((stage, index) => `
            <section class="scroll-section" id="creator-section-${stage.id}">
              <header><span>${stage.mark}</span><div><small>SECTION 0${index + 1}</small><h3>${stage.label}</h3></div></header>
              ${this._stageContent(index)}
            </section>
          `).join('')}
          <div class="scroll-final">${this._finishButton(true)}</div>
        </main>
        <aside class="scroll-index">
          <div data-live-summary>${this._summaryPanel()}</div>
          <nav aria-label="登记卷章节">
            ${STAGES.map(stage => `<button type="button" data-action="scroll-section" data-target="${stage.id}">${stage.mark} · ${stage.short}</button>`).join('')}
          </nav>
        </aside>
      </div>
    `;
  }

  _variantC() {
    const current = STAGES[this._stage];
    return `
      <div class="composer">
        <div class="composer-flow" aria-label="开场编排进度">
          ${STAGES.map((stage, index) => this._stageButton(stage, index, 'flow')).join('<span class="flow-line"></span>')}
        </div>
        <div class="composer-grid">
          <aside class="scene-board">
            <div class="scene-board-kicker">SCENE ZERO</div>
            <h2>${this._esc(this._draft.campaign.openingHook || '尚未写下开场钩子')}</h2>
            <dl>
              <div><dt>时代</dt><dd>${this._esc(this._timelineLabel())}</dd></div>
              <div><dt>镜头落点</dt><dd>${this._esc(this._draft.campaign.location || '未定')}</dd></div>
              <div><dt>主角身份</dt><dd>${this._esc(this._draft.identity.publicIdentity || '未公开')}</dd></div>
              <div><dt>故事方向</dt><dd>${this._esc(this._draft.campaign.storyFocus || '自由展开')}</dd></div>
            </dl>
            <div class="scene-cast">
              <small>首幕已知人物</small>
              <div>${this._draft.relationships.length ? this._draft.relationships.map(item => `<span>${this._esc(item.name)}</span>`).join('') : '<em>尚无预设羁绊</em>'}</div>
            </div>
          </aside>
          <main class="composer-editor">
            <div class="composer-stage-title"><span>${current.mark}</span><div><small>COMPOSER STEP 0${this._stage + 1}</small><h2>${current.label}</h2></div></div>
            ${this._stageContent(this._stage)}
            ${this._stageNavigation()}
          </main>
        </div>
      </div>
    `;
  }

  _stageButton(stage, index, mode) {
    const active = index === this._stage;
    const done = index < this._stage;
    if (mode === 'flow') {
      return `<button class="flow-node${active ? ' active' : ''}${done ? ' done' : ''}" type="button" data-action="stage" data-stage="${index}"><span>${done ? icon('check', 13) : stage.mark}</span><small>${stage.short}</small></button>`;
    }
    return `<button class="rail-step${active ? ' active' : ''}${done ? ' done' : ''}" type="button" data-action="stage" data-stage="${index}"><span>${done ? icon('check', 14) : stage.mark}</span><div><small>0${index + 1}</small>${stage.label}</div></button>`;
  }

  _stageHeader() {
    const stage = STAGES[this._stage];
    const descriptions = [
      '先定时代、阵营和故事镜头。模板只负责填充，之后所有字段都能改。',
      '身体、呈现、称呼与公开身份彼此独立，不再被一个性别选项捆绑。',
      '直接填写最终数值；忍阶参考线只是基准，不会限制你的组合。',
      '能力、装备和初始羁绊均可添加任意多条，页面会自然向下延伸。',
      '核对本地将要写入的完整档案，并决定 AI 对空白内容的权限。'
    ];
    return `<header class="stage-header"><div><small>CHAPTER 0${this._stage + 1}</small><h2>${stage.label}</h2></div><p>${descriptions[this._stage]}</p></header>`;
  }

  _stageContent(index) {
    if (index === 0) return this._campaignSection();
    if (index === 1) return this._identitySection();
    if (index === 2) return this._powerSection();
    if (index === 3) return this._assetsSection();
    return this._reviewSection();
  }

  _campaignSection() {
    const campaign = this._draft.campaign;
    return `
      <div class="section-block">
        <div class="block-heading"><div><small>SCENARIO</small><h3>情景模板</h3></div><p>模板之间没有时代、忍村或实力限制。</p></div>
        <div class="template-grid">
          ${OPENING_TEMPLATES.map(template => `
            <button class="template-card${template.id === this._draft.templateId ? ' selected' : ''}" style="--template-accent:${template.accent}" type="button" data-action="apply-template" data-template="${template.id}">
              <i class="template-watermark" aria-hidden="true">${icon(TEMPLATE_ICONS[template.id] || 'chakra', 56)}</i>
              <span>${template.eyebrow}</span><strong>${template.label}</strong><small>${template.description}</small>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="section-block">
        <div class="block-heading"><div><small>WORLD</small><h3>时代与落点</h3></div></div>
        <div class="form-grid cols-2">
          ${this._selectField('开局时代', 'campaign.timeline', campaign.timeline, this._timelineOptions())}
          ${campaign.timeline === '__custom_timeline__' ? this._inputField('自定义木叶纪年', 'campaign.customYear', campaign.customYear, 'number') : this._inputField('所属阵营 / 组织', 'campaign.affiliation', campaign.affiliation)}
          ${campaign.timeline === '__custom_timeline__' ? this._inputField('所属阵营 / 组织', 'campaign.affiliation', campaign.affiliation) : ''}
          ${this._inputField('起始地点', 'campaign.location', campaign.location)}
          ${this._selectField('开局月份', 'campaign.month', campaign.month, MONTH_OPTIONS)}
          ${this._selectField('开局日期', 'campaign.day', campaign.day, DAY_OPTIONS)}
        </div>
      </div>
      <div class="section-block">
        <div class="block-heading"><div><small>PRESSURE</small><h3>故事压力</h3></div><p>难度不再冒用忍阶名称。</p></div>
        <div class="choice-row five">
          ${OPENING_DIFFICULTIES.map(item => `<button class="choice-chip${campaign.difficulty === item.id ? ' selected' : ''}" type="button" data-action="set-value" data-path="campaign.difficulty" data-value="${item.id}"><strong>${item.label}</strong><span>${item.description}</span></button>`).join('')}
        </div>
      </div>
      <div class="section-block">
        <div class="form-grid cols-2">
          ${this._selectField('原作剧情介入', 'campaign.canonInvolvement', campaign.canonInvolvement, ['完全原创', '边缘交汇', '平行参与', '深度交汇', '改写原作', '自定义'])}
          ${this._inputField('故事基调', 'campaign.storyTone', campaign.storyTone)}
          ${this._inputField('故事重点', 'campaign.storyFocus', campaign.storyFocus)}
          ${this._inputField('当前目标', 'campaign.goal', campaign.goal)}
        </div>
        ${this._textareaField('开场钩子', 'campaign.openingHook', campaign.openingHook, '第一幕从什么异常、命令、相遇或危机开始？')}
      </div>
    `;
  }

  _identitySection() {
    const identity = this._draft.identity;
    return `
      <div class="section-block">
        <div class="block-heading"><div><small>CORE</small><h3>基本身份</h3></div></div>
        <div class="form-grid cols-3">
          ${this._inputField('忍名 *', 'identity.name', identity.name, 'text', '例如：雨宫澪')}
          ${this._inputField('身体年龄', 'identity.physicalAge', identity.physicalAge, 'number')}
          ${this._inputField('灵魂年龄', 'identity.soulAge', identity.soulAge, 'number')}
          ${this._inputField('性别认同', 'identity.gender', identity.gender)}
          ${this._inputField('身体设定', 'identity.bodySetting', identity.bodySetting)}
          ${this._inputField('外在呈现', 'identity.presentation', identity.presentation)}
          ${this._inputField('偏好称呼', 'identity.address', identity.address)}
          ${this._inputField('出身背景', 'identity.background', identity.background)}
          ${this._inputField('公开身份', 'identity.publicIdentity', identity.publicIdentity)}
        </div>
      </div>
      <div class="section-block">
        <div class="form-grid cols-2">
          ${this._textareaField('外貌与可见特征', 'identity.appearance', identity.appearance, '体型、发色、服装、伤痕、气质……')}
          ${this._textareaField('性格与行为倾向', 'identity.personality', identity.personality, '性格、习惯、底线、恐惧与处事方式……')}
        </div>
        ${this._textareaField('秘密与真实身份', 'identity.secrets', identity.secrets, '这些是真实设定，但未获知的 NPC 不会自动知道。')}
      </div>
    `;
  }

  _powerSection() {
    const power = this._draft.power;
    const attrs = [
      ['chakra', '查克拉', 'chakra'], ['vitality', '生命力', 'defense'], ['spirit', '精神力', 'spirit'],
      ['stamina', '体力', 'willpower'], ['speed', '速度', 'speed'], ['luck', '幸运', 'luck']
    ];
    return `
      <div class="section-block">
        <div class="block-heading"><div><small>RANK</small><h3>身份与实战分离</h3></div><p>官方忍阶与实际战力可以完全不同。</p></div>
        <div class="form-grid cols-2">
          ${this._selectField('官方正式忍阶', 'power.officialRank', power.officialRank, OFFICIAL_RANK_OPTIONS)}
          <div class="field derived-power-field"><span>实际战力等级</span><output data-combat-level-output aria-live="polite">${this._esc(power.combatLevel)}</output><small>由六项属性与实战造诣统一评定</small></div>
        </div>
        ${this._rankBenchmark()}
      </div>
      <div class="section-block">
        <div class="block-heading"><div><small>ATTRIBUTES</small><h3>六项最终数值</h3></div><p>无点数池，不会自动缩放。</p></div>
        <div class="attribute-grid">
          ${attrs.map(([key, label, iconName]) => `<label class="attribute-field"><span>${icon(iconName, 17)}${label}</span><input data-path="power.attributes.${key}" type="number" min="0" max="9999" value="${this._escAttr(power.attributes[key])}" /></label>`).join('')}
        </div>
      </div>
      <div class="section-block">
        <div class="block-heading"><div><small>NATURE</small><h3>查克拉性质</h3></div><p>可多选基础属性与血继性质。</p></div>
        <div class="nature-grid">
          ${CHAKRA_NATURES.map(nature => `<button class="nature-chip${power.chakraNatures.includes(nature) ? ' selected' : ''}" type="button" data-action="toggle-nature" data-nature="${nature}">${icon(GAME_DATA.chakraNatures[nature]?.emoji || 'chakra', 15)} ${nature}</button>`).join('')}
        </div>
      </div>
      <div class="section-block">
        <div class="block-heading"><div><small>GIFTS</small><h3>天赋与血继</h3></div><button class="add-btn" type="button" data-action="add-entry" data-list="talents">＋ 添加条目</button></div>
        <div class="entry-list">${this._draft.talents.length ? this._draft.talents.map((entry, index) => this._talentEditor(entry, index)).join('') : this._emptyState('尚未设置天赋或血继；这也是有效开局。')}</div>
      </div>
    `;
  }

  _assetsSection() {
    return `
      <div class="section-block">
        <div class="block-heading"><div><small>TECHNIQUES</small><h3>能力与术式</h3></div><button class="add-btn" type="button" data-action="add-entry" data-list="abilities">＋ 自创忍术 / 能力</button></div>
        ${this._techniquePicker()}
        <div class="entry-list ability-entry-list">${this._draft.abilities.length ? this._draft.abilities.map((entry, index) => this._abilityEditor(entry, index)).join('') : this._emptyState('尚未选择初始忍术；可以从忍术库挑选，也可以自创。')}</div>
      </div>
      <div class="section-block">
        <div class="block-heading"><div><small>LOADOUT</small><h3>物品与装备</h3></div><div class="block-actions"><label class="ryo-field">初始両 <input data-path="resources.ryo" type="number" min="0" value="${this._escAttr(this._draft.resources.ryo)}" /></label><button class="add-btn" type="button" data-action="add-entry" data-list="equipment">＋ 添加物品</button></div></div>
        <div class="entry-list">${this._draft.equipment.length ? this._draft.equipment.map((entry, index) => this._equipmentEditor(entry, index)).join('') : this._emptyState('行囊为空。')}</div>
      </div>
      <div class="section-block">
        <div class="block-heading"><div><small>BONDS</small><h3>初始人物羁绊</h3></div><button class="add-btn" type="button" data-action="add-entry" data-list="relationships">＋ 添加人物</button></div>
        <div class="entry-list">${this._draft.relationships.length ? this._draft.relationships.map((entry, index) => this._relationshipEditor(entry, index)).join('') : this._emptyState('没有预设羁绊；开场仍可自然遇到新人物。')}</div>
      </div>
    `;
  }

  _reviewSection() {
    const draft = this._draft;
    return `
      <div class="review-hero">
        <div><small>READY FOR SCENE ONE</small><h2>${this._esc(draft.identity.name || '未命名忍者')}</h2><p>${this._esc(draft.identity.publicIdentity || '身份未公开')} · ${this._esc(draft.power.officialRank || '无正式忍阶')} · ${this._esc(draft.campaign.affiliation || '无所属')}</p></div>
        <span>${this._esc(draft.power.combatLevel || '未评定')}</span>
      </div>
      <div class="review-grid">
        <section><small>开局镜头</small><h3>${this._esc(draft.campaign.location || '未知地点')}</h3><p>${this._esc(draft.campaign.openingHook || '未填写开场钩子')}</p></section>
        <section><small>身份</small><h3>${this._esc(draft.identity.presentation || '未设定呈现')}</h3><p>${this._esc(draft.identity.appearance || draft.identity.personality || '未填写外貌与性格')}</p></section>
        <section><small>实力</small><h3>${draft.abilities.length} 项能力 · ${draft.talents.length} 项天赋/血继</h3><p>${this._esc(draft.power.chakraNatures.join('、') || '无查克拉性质')}</p></section>
        <section><small>随行内容</small><h3>${draft.equipment.length} 件物品 · ${draft.relationships.length} 段羁绊</h3><p>${this._esc(draft.relationships.map(item => item.name).join('、') || '无预设人物')}</p></section>
      </div>
      <div class="section-block completion-block">
        <div class="block-heading"><div><small>AI BOUNDARY</small><h3>AI 补全权限</h3></div><p>无论选择哪项，玩家填写内容都不会被覆盖。</p></div>
        <div class="completion-modes">
          ${AI_COMPLETION_MODES.map(mode => `<button class="completion-card${draft.campaign.aiCompletionMode === mode.id ? ' selected' : ''}" type="button" data-action="set-value" data-path="campaign.aiCompletionMode" data-value="${mode.id}"><span>${draft.campaign.aiCompletionMode === mode.id ? icon('check', 15) : ''}</span><strong>${mode.label}${mode.id === 'fill' ? '<em>默认</em>' : ''}</strong><small>${mode.description}</small></button>`).join('')}
        </div>
      </div>
      ${this._finishButton(false)}
    `;
  }

  _talentEditor(entry, index) {
    return `<article class="entry-card"><header><div><span class="entry-index">${String(index + 1).padStart(2, '0')}</span><strong>${this._esc(entry.name || '新天赋')}</strong></div>${this._removeButton('talents', index)}</header><div class="form-grid cols-3">${this._selectField('类别', `talents.${index}.type`, entry.type, [['talent', '天赋'], ['kekkei_genkai', '血继限界']])}${this._inputField('名称', `talents.${index}.name`, entry.name)}${this._inputField('阶段 / 等级', `talents.${index}.rank`, entry.rank)}${this._inputField('掌握度', `talents.${index}.mastery`, entry.mastery, 'number')}</div><div class="form-grid cols-2">${this._textareaField('能力描述', `talents.${index}.description`, entry.description)}${this._textareaField('限制与代价', `talents.${index}.limitations`, entry.limitations)}</div></article>`;
  }

  _abilityEditor(entry, index) {
    const resourceKey = { 查克拉: 'chakra', 精神力: 'spirit', 体力: 'stamina' }[entry.resourceType] || 'chakra';
    const resourcePool = Math.max(0, Number(this._draft.power.attributes[resourceKey]) || 0);
    const cost = Math.max(0, Number(entry.cost) || 0);
    const uses = cost > 0 ? Math.floor(resourcePool / cost) : '不限';
    const costLabel = `单次消耗（当前约可用${uses}次）`;
    const techniqueAttr = entry.technique_id ? ` data-technique-id="${this._escAttr(entry.technique_id)}"` : '';
    if (entry.source === 'canon' && entry.technique_id) {
      return `<article class="entry-card canon-ability-card" data-ability-entry${techniqueAttr}><header><div><span class="entry-index">${String(index + 1).padStart(2, '0')}</span><strong>${this._esc(entry.name || '正史忍术')}</strong><em class="source-badge">正史忍术库</em></div>${this._removeButton('abilities', index)}</header><div class="canon-ability-facts"><span>${this._esc(TECHNIQUE_TYPE_LABELS[entry.type] || '能力')}</span><span>${this._esc(entry.rank)}级</span><span>${this._esc(entry.element || '无属性')}</span><span>${this._esc(entry.resourceType)} ${this._esc(entry.cost)}</span><span>威力 ${this._esc(entry.power)}</span><span>约可用 ${this._esc(uses)} 次</span></div><p class="canon-ability-description">${this._esc(entry.description || '忍术库暂无描述。')}</p><div class="canon-mastery">${this._inputField('初始掌握度（可调整）', `abilities.${index}.mastery`, entry.mastery, 'number')}</div></article>`;
    }
    const sourceBadge = entry.source === 'custom' ? '<em class="source-badge custom">自创</em>' : '';
    return `<article class="entry-card" data-ability-entry${techniqueAttr}><header><div><span class="entry-index">${String(index + 1).padStart(2, '0')}</span><strong>${this._esc(entry.name || '新能力')}</strong>${sourceBadge}</div>${this._removeButton('abilities', index)}</header><div class="form-grid cols-4">${this._selectField('类别', `abilities.${index}.type`, entry.type, ABILITY_TYPES)}${this._inputField('名称', `abilities.${index}.name`, entry.name)}${this._inputField('等级', `abilities.${index}.rank`, entry.rank)}${this._inputField('属性', `abilities.${index}.element`, entry.element)}${this._selectField('消耗资源', `abilities.${index}.resourceType`, entry.resourceType, [['查克拉','查克拉'],['精神力','精神力'],['体力','体力']])}${this._inputField(costLabel, `abilities.${index}.cost`, entry.cost, 'number')}${this._inputField('威力', `abilities.${index}.power`, entry.power, 'number')}${this._inputField('掌握度', `abilities.${index}.mastery`, entry.mastery, 'number')}</div><div class="form-grid cols-2">${this._textareaField('表现与用途', `abilities.${index}.description`, entry.description)}${this._textareaField('限制与代价', `abilities.${index}.limitations`, entry.limitations)}</div></article>`;
  }

  _rankBenchmark() {
    const rank = this._draft.power.officialRank;
    const benchmark = GAME_DATA.rankBenchmarks[rank];
    if (!benchmark) return '<div class="benchmark muted" data-rank-benchmark><span>当前忍阶没有预设参考线；数值仍可自由填写。</span></div>';
    return `<div class="benchmark" data-rank-benchmark><span>${this._esc(rank)}中性参考线</span>${Object.entries(benchmark).filter(([key]) => key !== 'skillMastery').map(([key, range]) => `<em>${this._attrLabel(key)} ${range[0]}–${range[1]}</em>`).join('')}</div>`;
  }

  _techniquePicker() {
    return `
      <div class="technique-picker" data-technique-picker>
        <div class="technique-picker-heading">
          <div><strong>从正史忍术库选择</strong><span>已接入 ${CANON_DATABASE.getRecords('techniques').length} 条术式；添加后只需调整初始掌握度。</span></div>
        </div>
        <div class="technique-toolbar">
          <label class="technique-search"><span>搜索名称、别名、属性或分类</span><input type="search" data-technique-query value="${this._escAttr(this._techniqueQuery)}" placeholder="例如：豪火球、医疗、幻术、雷遁" /></label>
          <label><span>类型</span><select data-technique-filter="type"><option value="">全部类型</option>${Object.entries(TECHNIQUE_TYPE_LABELS).filter(([key]) => key !== 'support').map(([value, label]) => `<option value="${value}"${this._techniqueType === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
          <label><span>等级</span><select data-technique-filter="rank"><option value="">全部等级</option>${TECHNIQUE_RANKS.map(rank => `<option value="${rank}"${this._techniqueRank === rank ? ' selected' : ''}>${rank === '特' ? '特殊等级' : `${rank}级`}</option>`).join('')}</select></label>
          <label><span>查克拉属性</span><select data-technique-filter="element"><option value="">全部属性</option>${TECHNIQUE_ELEMENTS.map(element => `<option value="${element}"${this._techniqueElement === element ? ' selected' : ''}>${element === '无' ? '无属性' : element}</option>`).join('')}</select></label>
          <label><span>用途</span><select data-technique-filter="role"><option value="">全部用途</option>${TECHNIQUE_ROLES.map(([value, label]) => `<option value="${value}"${this._techniqueRole === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
          <label><span>消耗资源</span><select data-technique-filter="resource"><option value="">全部资源</option>${TECHNIQUE_RESOURCES.map(([value, label]) => `<option value="${value}"${this._techniqueResource === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
          <label><span>术式分类</span><select data-technique-filter="class"><option value="">全部分类</option>${TECHNIQUE_CLASSES.map(([value, label]) => `<option value="${value}"${this._techniqueClass === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        </div>
        <div class="technique-results" data-technique-results>${this._techniqueResults()}</div>
      </div>
    `;
  }

  _techniqueResults() {
    const { records, total, page, pageCount, start, end } = this._filteredTechniques();
    const pageSizeSelect = `<label class="technique-page-size"><span>每页</span><select data-technique-page-size>${TECHNIQUE_PAGE_SIZES.map(size => `<option value="${size}"${this._techniquePageSize === size ? ' selected' : ''}>${size} 条</option>`).join('')}</select></label>`;
    if (!records.length) return `<div class="technique-result-meta"><span>共 0 条</span>${pageSizeSelect}</div><div class="technique-empty">没有匹配的忍术，请换一个名称、别名或筛选条件。</div>`;
    return `
      <div class="technique-result-meta"><span>共 ${total} 条 · 当前 ${start}–${end}</span>${pageSizeSelect}</div>
      ${this._techniquePagination(page, pageCount)}
      <div class="technique-result-grid">
        ${records.map(technique => {
          const name = displayCanonTechniqueName(technique);
          const added = this._isTechniqueAdded(technique);
          const type = TECHNIQUE_TYPE_LABELS[technique.type] || '能力';
          const rank = technique.rank === '特' ? '特殊等级' : `${technique.rank}级`;
          const element = (technique.elements || []).filter(Boolean).join('、') || '无属性';
          return `<article class="technique-result-card${added ? ' added' : ''}" data-technique-result="${this._escAttr(technique.id)}"><header><div><strong>${this._esc(name)}</strong><span>${this._esc(type)} · ${this._esc(rank)} · ${this._esc(element)}</span></div><button type="button" data-add-technique="${this._escAttr(technique.id)}"${added ? ' disabled' : ''}>${added ? '已添加' : '添加'}</button></header><p>${this._esc(this._truncate(technique.summary || '忍术库暂无描述。', 118))}</p><footer><span>消耗 ${this._esc(technique.cost ?? 0)}</span><span>威力 ${this._esc(technique.power ?? 0)}</span><code>${this._esc(technique.id)}</code></footer></article>`;
        }).join('')}
      </div>
    `;
  }

  _filteredTechniques() {
    const terms = String(this._techniqueQuery || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    let records = CANON_DATABASE.getRecords('techniques');
    if (this._techniqueType) records = records.filter(item => item.type === this._techniqueType);
    if (this._techniqueRank) records = records.filter(item => item.rank === this._techniqueRank);
    if (this._techniqueElement) records = records.filter(item => (item.elements || []).includes(this._techniqueElement));
    if (this._techniqueResource) records = records.filter(item => item.resource === this._techniqueResource);
    if (this._techniqueRole) records = records.filter(item => this._techniqueClassTags(item).includes(this._techniqueRole));
    if (this._techniqueClass) records = records.filter(item => this._techniqueClassTags(item).some(tag => tag === this._techniqueClass || tag.startsWith(`${this._techniqueClass}~`)));
    if (terms.length) {
      records = records.filter(item => {
        const searchText = [
          displayCanonTechniqueName(item), item.name, item.id,
          ...(item.aliases || []), ...(item.lookup_aliases || []),
          ...(item.classes || []), ...(item.lookup_classes || []),
          ...(item.elements || []), ...(item.lookup_elements || [])
        ].join(' ').toLocaleLowerCase();
        return terms.every(term => searchText.includes(term));
      });
    }
    const total = records.length;
    const pageSize = TECHNIQUE_PAGE_SIZES.includes(Number(this._techniquePageSize)) ? Number(this._techniquePageSize) : TECHNIQUE_PAGE_SIZES[0];
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.max(1, Math.min(pageCount, Number(this._techniquePage) || 1));
    this._techniquePage = page;
    const offset = (page - 1) * pageSize;
    return {
      total,
      page,
      pageCount,
      start: total ? offset + 1 : 0,
      end: Math.min(total, offset + pageSize),
      records: records.slice(offset, offset + pageSize)
    };
  }

  _techniquePagination(page, pageCount) {
    const pageNumbers = new Set([1, pageCount]);
    for (let current = Math.max(1, page - 2); current <= Math.min(pageCount, page + 2); current++) pageNumbers.add(current);
    const ordered = [...pageNumbers].sort((a, b) => a - b);
    let previous = 0;
    const buttons = ordered.map(current => {
      const gap = previous && current - previous > 1 ? '<span class="technique-page-gap">…</span>' : '';
      previous = current;
      return `${gap}<button type="button" data-technique-page="${current}"${current === page ? ' class="active" aria-current="page"' : ''}>${current}</button>`;
    }).join('');
    return `<nav class="technique-pagination" aria-label="忍术库分页"><button type="button" data-technique-page="prev"${page <= 1 ? ' disabled' : ''}>← 上一页</button><div class="technique-page-numbers">${buttons}</div><span data-technique-page-state>第 ${page} / ${pageCount} 页</span><button type="button" data-technique-page="next"${page >= pageCount ? ' disabled' : ''}>下一页 →</button></nav>`;
  }

  _techniqueClassTags(technique) {
    return (technique.classes || []).flatMap(value => String(value).split(',')).map(value => value.trim()).filter(Boolean);
  }

  _isTechniqueAdded(technique) {
    const name = displayCanonTechniqueName(technique);
    return this._draft.abilities.some(item => item.technique_id === technique.id || (item.type === technique.type && item.name === name));
  }

  _truncate(value, maxLength) {
    const source = String(value || '').trim();
    return source.length > maxLength ? `${source.slice(0, maxLength)}…` : source;
  }

  _equipmentEditor(entry, index) {
    return `<article class="entry-card"><header><div><span class="entry-index">${String(index + 1).padStart(2, '0')}</span><strong>${this._esc(entry.name || '新物品')}</strong></div>${this._removeButton('equipment', index)}</header><div class="form-grid cols-4">${this._selectField('分类', `equipment.${index}.category`, entry.category, ITEM_TYPES)}${this._inputField('名称', `equipment.${index}.name`, entry.name)}${this._inputField('数量', `equipment.${index}.quantity`, entry.quantity, 'number')}${this._inputField('品质', `equipment.${index}.quality`, entry.quality)}${this._selectField('初始装备槽', `equipment.${index}.equippedSlot`, entry.equippedSlot, EQUIP_SLOTS)}</div>${this._textareaField('物品描述', `equipment.${index}.description`, entry.description)}</article>`;
  }

  _relationshipEditor(entry, index) {
    return `<article class="entry-card relation-entry"><header><div><span class="entry-index">${String(index + 1).padStart(2, '0')}</span><strong>${this._esc(entry.name || '新人物')}</strong></div>${this._removeButton('relationships', index)}</header><div class="form-grid cols-2">${this._inputField('人物姓名', `relationships.${index}.name`, entry.name)}${this._inputField('关系定位', `relationships.${index}.relation`, entry.relation, 'text', '导师 / 亲人 / 宿敌 / 债主……')}</div><div class="form-grid cols-2">${this._textareaField('公开经历', `relationships.${index}.publicHistory`, entry.publicHistory, '双方公开承认或可被调查到的历史')}${this._textareaField('私密真相 / 真实心理', `relationships.${index}.secret`, entry.secret, '不会自动透露给其他 NPC')}</div><div class="relation-values">${this._rangeField('好感', `relationships.${index}.affection`, entry.affection)}${this._rangeField('信任', `relationships.${index}.trust`, entry.trust)}${this._rangeField('尊重', `relationships.${index}.respect`, entry.respect)}</div></article>`;
  }

  _inputField(label, path, value, type = 'text', placeholder = '') {
    return `<label class="field"><span>${label}</span><input data-path="${path}" type="${type}" value="${this._escAttr(value)}" ${type === 'number' ? 'min="0" max="9999"' : ''} placeholder="${this._escAttr(placeholder)}" /></label>`;
  }

  _textareaField(label, path, value, placeholder = '') {
    return `<label class="field textarea-field"><span>${label}</span><textarea data-path="${path}" rows="3" placeholder="${this._escAttr(placeholder)}">${this._esc(value)}</textarea></label>`;
  }

  _selectField(label, path, value, options) {
    const normalized = options.map(option => Array.isArray(option) ? option : [option, option]);
    return `<label class="field"><span>${label}</span><select data-path="${path}">${normalized.map(([optionValue, optionLabel]) => `<option value="${this._escAttr(optionValue)}"${String(optionValue) === String(value) ? ' selected' : ''}>${this._esc(optionLabel)}</option>`).join('')}</select></label>`;
  }

  _rangeField(label, path, value) {
    return `<label><span>${label}<output>${this._esc(value)}</output></span><input data-path="${path}" type="range" min="-100" max="100" step="1" value="${this._escAttr(value)}" /></label>`;
  }

  _removeButton(list, index) {
    return `<button class="icon-btn danger" type="button" title="删除此条目" aria-label="删除此条目" data-action="remove-entry" data-list="${list}" data-index="${index}">${icon('close', 15)}</button>`;
  }

  _emptyState(text) {
    return `<div class="empty-state"><span>—</span><p>${text}</p></div>`;
  }

  _stageNavigation() {
    return `<div class="stage-nav"><button class="secondary-btn" type="button" data-action="prev"${this._stage === 0 ? ' disabled' : ''}>← 上一章</button>${this._stage === STAGES.length - 1 ? this._finishButton(true) : `<button class="primary-btn" type="button" data-action="next">下一章 →</button>`}</div>`;
  }

  _finishButton(compact) {
    const label = this._draftMode ? '保存到我的联机开局' : this._prototype ? '检查原型档案' : '封存档案并生成开场';
    return `<button class="primary-btn finish-btn${compact ? ' compact' : ''}" type="button" data-action="finish">${icon('check', 16)} ${label}</button>`;
  }

  _summaryPanel() {
    const draft = this._draft;
    const attrs = draft.power.attributes;
    return `
      <div class="summary-heading"><small>LIVE DOSSIER</small><h3>${this._esc(draft.identity.name || '未命名忍者')}</h3><span>${this._esc(draft.power.combatLevel || '未评定')}</span></div>
      <div class="summary-identity"><strong>${this._esc(draft.identity.publicIdentity || '身份未公开')}</strong><p>${this._esc(draft.campaign.affiliation || '无所属')} · ${this._esc(draft.power.officialRank || '无正式忍阶')}</p></div>
      <dl class="summary-facts">
        <div><dt>时代</dt><dd>${this._esc(this._timelineLabel())}</dd></div>
        <div><dt>地点</dt><dd>${this._esc(draft.campaign.location || '未定')}</dd></div>
        <div><dt>目标</dt><dd>${this._esc(draft.campaign.goal || '未定')}</dd></div>
      </dl>
      <div class="mini-attrs">${[['查', attrs.chakra], ['生', attrs.vitality], ['精', attrs.spirit], ['体', attrs.stamina], ['速', attrs.speed], ['运', attrs.luck]].map(([label, value]) => `<span><small>${label}</small><strong>${value}</strong></span>`).join('')}</div>
      <div class="summary-counts"><span><strong>${draft.talents.length}</strong> 天赋/血继</span><span><strong>${draft.abilities.length}</strong> 能力</span><span><strong>${draft.equipment.length}</strong> 物品</span><span><strong>${draft.relationships.length}</strong> 羁绊</span></div>
      <div class="summary-mode"><small>AI 权限</small><strong>${this._esc(AI_COMPLETION_MODES.find(mode => mode.id === draft.campaign.aiCompletionMode)?.label || '补全空白')}</strong></div>
    `;
  }

  _timelineOptions() {
    return Object.values(GAME_DATA.timelinePresets).map(item => [item.id, item.label]);
  }

  _timelineLabel() {
    const { month, day } = this._draft.campaign;
    if (this._draft.campaign.timeline === '__custom_timeline__') return `木叶${this._draft.campaign.customYear}年${month}月${day}日 · 自定义`;
    const label = GAME_DATA.timelinePresets[this._draft.campaign.timeline]?.label || this._draft.campaign.timeline;
    return `${label} · ${month}月${day}日`;
  }

  _attrLabel(key) {
    return { chakra: '查', vitality: '生', stamina: '体', spirit: '精', speed: '速', luck: '运' }[key] || key;
  }

  _completionCount() {
    const draft = this._draft;
    return [
      !!(draft.campaign.location && draft.campaign.timeline),
      !!draft.identity.name,
      Object.values(draft.power.attributes).every(value => Number.isFinite(Number(value))),
      !!(draft.abilities.length || draft.equipment.length || draft.relationships.length || draft.resources.ryo >= 0),
      !!draft.campaign.aiCompletionMode
    ].filter(Boolean).length;
  }

  _prototypeSwitcher() {
    return `<div class="prototype-switcher" role="group" aria-label="创建器原型变体"><button type="button" aria-label="上一个原型" data-action="variant-prev">←</button><span><small>CREATOR PROTOTYPE</small><strong>${this._variant} — ${VARIANT_NAMES[this._variant]}</strong></span><button type="button" aria-label="下一个原型" data-action="variant-next">→</button></div>`;
  }

  _bindEvents() {
    this.shadowRoot.querySelectorAll('[data-path]').forEach(control => {
      const eventName = control.matches('select,input[type="range"]') ? 'change' : 'input';
      control.addEventListener(eventName, () => {
        const numeric = control.type === 'number' || control.type === 'range' || ['campaign.month', 'campaign.day'].includes(control.dataset.path);
        this._setPath(control.dataset.path, numeric ? Number(control.value) : control.value);
        if (control.dataset.path.startsWith('power.attributes.')) this._syncCombatLevel();
        if (control.dataset.path === 'power.officialRank') this._refreshRankBenchmark();
        if (control.type === 'range') control.closest('label')?.querySelector('output')?.replaceChildren(control.value);
        this._savePreset();
        this._refreshSummary();
        if (control.dataset.path === 'campaign.timeline') this._render();
      });
      if (eventName !== 'change') {
        control.addEventListener('change', () => {
          this._setPath(control.dataset.path, control.type === 'number' ? Number(control.value) : control.value);
          this._draft = normalizeOpeningDraft(this._draft);
          this._savePreset();
          this._refreshSummary();
        });
      }
    });

    this.shadowRoot.querySelectorAll('[data-action]').forEach(control => {
      control.addEventListener('click', event => this._handleAction(event.currentTarget));
    });

    const personaSelect = this.shadowRoot.querySelector('#persona-select');
    personaSelect?.addEventListener('change', () => this._loadPersona(personaSelect.value));

    const techniquePicker = this.shadowRoot.querySelector('[data-technique-picker]');
    techniquePicker?.addEventListener('input', event => {
      const input = event.target.closest?.('[data-technique-query]');
      if (!input) return;
      this._techniqueQuery = input.value;
      this._techniquePage = 1;
      this._refreshTechniqueResults();
    });
    techniquePicker?.addEventListener('change', event => {
      const pageSize = event.target.closest?.('[data-technique-page-size]');
      if (pageSize) {
        this._techniquePageSize = Number(pageSize.value);
        this._techniquePage = 1;
        this._refreshTechniqueResults();
        return;
      }
      const filter = event.target.closest?.('[data-technique-filter]');
      if (!filter) return;
      const stateKey = {
        type: '_techniqueType', rank: '_techniqueRank', element: '_techniqueElement',
        role: '_techniqueRole', resource: '_techniqueResource', class: '_techniqueClass'
      }[filter.dataset.techniqueFilter];
      if (stateKey) this[stateKey] = filter.value;
      this._techniquePage = 1;
      this._refreshTechniqueResults();
    });
    techniquePicker?.addEventListener('click', event => {
      const pageButton = event.target.closest?.('[data-technique-page]');
      if (pageButton && !pageButton.disabled) {
        const { page, pageCount } = this._filteredTechniques();
        const requested = pageButton.dataset.techniquePage;
        this._techniquePage = requested === 'prev' ? Math.max(1, page - 1)
          : requested === 'next' ? Math.min(pageCount, page + 1)
            : Math.max(1, Math.min(pageCount, Number(requested) || 1));
        this._refreshTechniqueResults();
        return;
      }
      const button = event.target.closest?.('[data-add-technique]');
      if (button && !button.disabled) this._addCanonTechnique(button.dataset.addTechnique);
    });

    const fileInput = this.shadowRoot.querySelector('#timeline-import-file');
    fileInput?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (file) eventBus.emit('app:timeline-import-file', { file });
      event.target.value = '';
    });
  }

  _handleAction(control) {
    const action = control.dataset.action;
    if (!['apply-template', 'finish', 'clear-preset', 'persona-save', 'persona-delete'].includes(action)) this._notice = '';
    if (action === 'persona-save') { this._savePersona(); return; }
    if (action === 'persona-delete') { this._deletePersona(); return; }
    if (action === 'stage') {
      this._stage = Number(control.dataset.stage) || 0;
      this._render();
      this._scrollTop();
      return;
    }
    if (action === 'prev' || action === 'next') {
      this._stage = Math.max(0, Math.min(STAGES.length - 1, this._stage + (action === 'next' ? 1 : -1)));
      this._render();
      this._scrollTop();
      return;
    }
    if (action === 'apply-template') {
      this._draft = applyOpeningTemplate(this._draft, control.dataset.template);
      this._notice = `已应用「${OPENING_TEMPLATES.find(item => item.id === control.dataset.template)?.label || '情景'}」，所有字段仍可修改。`;
      this._savePreset();
      this._render();
      return;
    }
    if (action === 'set-value') {
      this._setPath(control.dataset.path, control.dataset.value);
      this._savePreset();
      this._render();
      return;
    }
    if (action === 'toggle-nature') {
      const nature = control.dataset.nature;
      const list = this._draft.power.chakraNatures;
      this._draft.power.chakraNatures = list.includes(nature) ? list.filter(item => item !== nature) : [...list, nature];
      this._savePreset();
      this._render();
      return;
    }
    if (action === 'add-entry') {
      this._addEntry(control.dataset.list);
      this._savePreset();
      this._renderPreservingScroll();
      return;
    }
    if (action === 'remove-entry') {
      const list = this._draft[control.dataset.list];
      if (Array.isArray(list)) list.splice(Number(control.dataset.index), 1);
      this._savePreset();
      this._renderPreservingScroll();
      return;
    }
    if (action === 'finish') {
      this._finish();
      return;
    }
    if (action === 'clear-preset') {
      this._draft = createOpeningDraft();
      this._presetLoaded = false;
      this._presetMigrated = false;
      this._notice = '已重置为新的 v2 草稿。';
      this._savePreset();
      this._render();
      return;
    }
    if (action === 'import-timeline') {
      this.shadowRoot.querySelector('#timeline-import-file')?.click();
      return;
    }
    if (action === 'scroll-section') {
      this.shadowRoot.querySelector(`#creator-section-${control.dataset.target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (action === 'variant-prev' || action === 'variant-next') {
      this._cycleVariant(action === 'variant-next' ? 1 : -1);
    }
  }

  _addEntry(listName) {
    const defaults = {
      talents: { type: 'talent', name: '', rank: '未定', mastery: 0, description: '', limitations: '' },
      abilities: { source: 'custom', type: 'jutsu', name: '', rank: 'E', element: '无', cost: 8, resourceType: '查克拉', power: 0, mastery: 0, description: '', limitations: '' },
      equipment: { category: 'tools', name: '', quantity: 1, quality: '普通', description: '', equippedSlot: '' },
      relationships: { name: '', relation: '', publicHistory: '', secret: '', affection: 0, trust: 0, respect: 0 }
    };
    if (defaults[listName]) this._draft[listName].push({ ...defaults[listName] });
  }

  _addCanonTechnique(techniqueId) {
    const technique = CANON_DATABASE.getRecord('techniques', techniqueId);
    const selected = CANON_DATABASE.toStateSkill(technique, { mastery: 0 });
    if (!technique || !selected) {
      this._notice = '未能读取这条忍术，请刷新忍术库后重试。';
      this._renderPreservingScroll();
      return;
    }
    if (this._draft.abilities.some(item => item.technique_id === selected.technique_id || (item.type === selected.type && item.name === selected.name))) {
      this._notice = `「${selected.name}」已经在初始能力中。`;
      this._renderPreservingScroll();
      return;
    }
    this._draft.abilities.push({
      technique_id: selected.technique_id,
      source: selected.source,
      type: selected.type,
      name: selected.name,
      rank: selected.rank,
      element: selected.element,
      resourceType: selected.resource_type,
      cost: selected.cost,
      power: selected.power,
      mastery: selected.mastery,
      description: selected.description,
      limitations: ''
    });
    this._notice = `已从忍术库添加「${selected.name}」，可以继续调整初始掌握度。`;
    this._savePreset();
    this._renderPreservingScroll();
  }

  _setPath(path, value) {
    const parts = String(path || '').split('.').filter(Boolean);
    let cursor = this._draft;
    for (let index = 0; index < parts.length - 1; index++) {
      const key = /^\d+$/.test(parts[index]) ? Number(parts[index]) : parts[index];
      if (cursor[key] == null) cursor[key] = /^\d+$/.test(parts[index + 1]) ? [] : {};
      cursor = cursor[key];
    }
    const last = parts.at(-1);
    if (last !== undefined) cursor[/^\d+$/.test(last) ? Number(last) : last] = value;
  }

  _refreshSummary() {
    const combatLevel = this._syncCombatLevel();
    this.shadowRoot.querySelectorAll('[data-combat-level-output]').forEach(node => { node.textContent = combatLevel; });
    this.shadowRoot.querySelectorAll('[data-live-summary]').forEach(node => { node.innerHTML = this._summaryPanel(); });
  }

  _refreshRankBenchmark() {
    this.shadowRoot.querySelectorAll('[data-rank-benchmark]').forEach(node => {
      node.outerHTML = this._rankBenchmark();
    });
  }

  _refreshTechniqueResults() {
    const container = this.shadowRoot.querySelector('[data-technique-results]');
    if (!container) return;
    const scrollContainer = this.closest('.chat-container');
    const scrollTop = scrollContainer?.scrollTop;
    container.innerHTML = this._techniqueResults();
    if (scrollContainer && Number.isFinite(scrollTop)) scrollContainer.scrollTop = scrollTop;
  }

  _renderPreservingScroll() {
    const scrollContainer = this.closest('.chat-container');
    const scrollTop = scrollContainer?.scrollTop;
    this._render();
    if (scrollContainer && Number.isFinite(scrollTop)) scrollContainer.scrollTop = scrollTop;
  }

  _syncCombatLevel() {
    const combatLevel = calculateCombatLevel(
      this._draft.power.attributes,
      combatMasteriesFromAbilities(this._draft.abilities)
    );
    this._draft.power.combatLevel = combatLevel;
    return combatLevel;
  }

  _prefersReducedMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  _showSealStamp(caption, holdMs = 1400) {
    const overlay = document.createElement('div');
    overlay.className = 'seal-stamp-overlay';
    overlay.setAttribute('role', 'status');
    overlay.innerHTML = `
      <div class="seal-stamp-stage">
        <span class="seal-stamp-ripple" aria-hidden="true"></span>
        <span class="seal-stamp-mark" aria-hidden="true">封</span>
        <p>${this._esc(caption)}</p>
      </div>
    `;
    this.shadowRoot.appendChild(overlay);
    return new Promise(resolve => {
      setTimeout(() => {
        overlay.classList.add('is-leaving');
        setTimeout(() => { overlay.remove(); resolve(); }, 320);
      }, holdMs);
    });
  }

  _finish() {
    this._draft = normalizeOpeningDraft(this._draft);
    if (!this._draft.identity.name) {
      this._notice = '请先填写忍名，再封存开局档案。';
      if (this._variant !== 'B') this._stage = 1;
      this._render();
      return;
    }
    if (this._draftMode) {
      this.dispatchEvent(new CustomEvent('opening-draft-saved', {
        detail: { draft: normalizeOpeningDraft(this._draft) }, bubbles: true, composed: true
      }));
      return;
    }
    if (this._prototype) {
      const summary = `原型档案检查通过：${this._draft.abilities.length} 项能力、${this._draft.equipment.length} 件物品、${this._draft.relationships.length} 段羁绊；未写入任何真实状态。`;
      if (this._prefersReducedMotion()) {
        this._notice = summary;
        this._render();
        return;
      }
      this._notice = '';
      this._render();
      this._showSealStamp('原型档案检查通过').then(() => {
        this._notice = summary;
        this._render();
      });
      return;
    }

    const initialized = initializeOpeningRuntime(this._draft, {
      stateManager,
      equipmentSystem,
      createOpeningContract
    });
    this._savePreset();
    const payload = {
      name: initialized['玩家·姓名'],
      contract: initialized._opening_contract,
      draftVersion: this._draft.version
    };
    if (this._prefersReducedMotion()) {
      eventBus.emit('character:created', payload);
      return;
    }
    this._showSealStamp('档案封存 · 正在生成开场', 950).then(() => {
      eventBus.emit('character:created', payload);
    });
  }

  _handlePrototypeKey(event) {
    if (!this._prototype || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    // Window listeners see the shadow host as event.target; composedPath keeps the real editor control.
    const target = event.composedPath?.()[0] || event.target;
    if (target?.matches?.('input, textarea, select, [contenteditable], [contenteditable] *') || target?.isContentEditable) return;
    event.preventDefault();
    this._cycleVariant(event.key === 'ArrowRight' ? 1 : -1);
  }

  _cycleVariant(direction) {
    const variants = Object.keys(VARIANT_NAMES);
    const index = variants.indexOf(this._variant);
    this._variant = variants[(index + direction + variants.length) % variants.length];
    const url = new URL(globalThis.location.href);
    url.searchParams.set('creatorPrototype', '1');
    url.searchParams.set('variant', this._variant);
    globalThis.history?.replaceState({}, '', url);
    this._render();
    this._scrollTop();
  }

  _scrollTop() {
    this.closest('.chat-container')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  _esc(value) { return escHtml(String(value ?? '')); }
  _escAttr(value) { return escAttr(String(value ?? '')); }

  _styles() {
    return `
      /* ═══════════════════════════════════════════
         开局创建器 · 自包含设计系统（不落之卷）
         不引用项目 tokens；全部令牌以 --cc-* 命名
         ═══════════════════════════════════════════ */
      :host {
        display:block; min-height:100%;
        --cc-ink-0:#06090d; --cc-ink-1:#0a0e14; --cc-ink-2:#0e131b; --cc-ink-3:#141a24;
        --cc-line:rgba(236,229,216,.07); --cc-line-2:rgba(236,229,216,.13);
        --cc-text-1:#efe9dc; --cc-text-2:#b6b0a3; --cc-text-3:#7e786d; --cc-text-4:#5b564e;
        --cc-shu:#e2603c; --cc-shu-2:#ef7a52; --cc-shu-deep:#a83a20; --cc-inkred:#c03028;
        --cc-kin:#cba26b; --cc-kin-2:#e6c584;
        --cc-ao:#58a0b4; --cc-matsu:#5daa8c;
        --cc-serif:'Noto Serif SC','Source Han Serif SC','Songti SC','SimSun',serif;
        --cc-sans:'Noto Sans SC','Microsoft YaHei UI','PingFang SC',system-ui,sans-serif;
        --cc-mono:'JetBrains Mono','Fira Code',monospace;
        --cc-r:12px; --cc-r-s:8px;
        --cc-ease:cubic-bezier(.22,.75,.25,1);
        color:var(--cc-text-1); font-family:var(--cc-sans);
      }
      * { box-sizing:border-box; }
      button,input,textarea,select { font:inherit; }
      button { color:inherit; }
      button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible { outline:2px solid rgba(226,96,60,.55); outline-offset:2px; }
      h1,h2,h3,p { margin:0; }

      /* ── 氛围层：和纸纹理 + 双光晕 ─────────────── */
      .creator { position:relative; isolation:isolate; width:min(1480px,100%); margin:0 auto; padding:40px 32px 130px; }
      .creator-aura { position:fixed; inset:0; z-index:-1; pointer-events:none;
        background:
          radial-gradient(760px 480px at 88% -8%, rgba(var(--cc-nature-glow,226,96,60),.085), transparent 65%),
          radial-gradient(660px 520px at -6% 104%, rgba(203,162,107,.06), transparent 62%),
          radial-gradient(1100px 800px at 50% 45%, rgba(16,22,32,.5), transparent 75%);
        transition:background .6s;
      }
      .creator-aura::after { content:''; position:absolute; inset:0; opacity:.05;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
      }

      /* ── 页头：朱印 + 大排版 + 进度环 ──────────── */
      .creator-header { display:flex; align-items:flex-end; justify-content:space-between; gap:26px; margin-bottom:30px; padding-bottom:26px; border-bottom:1px solid var(--cc-line); }
      .creator-brand { display:flex; align-items:center; gap:20px; min-width:0; }
      .creator-seal { flex:0 0 auto; display:grid; place-items:center; width:54px; height:54px; border-radius:10px;
        background:linear-gradient(135deg,var(--cc-shu) 0%,var(--cc-inkred) 100%); color:#fdf6ec;
        font:800 26px var(--cc-serif); transform:rotate(-3deg);
        box-shadow:inset 0 0 0 2px rgba(253,246,236,.22), inset 0 -6px 14px rgba(60,8,4,.45), 0 10px 26px rgba(168,58,32,.28);
        transition:transform .3s var(--cc-ease);
      }
      .creator-seal:hover { transform:rotate(-3deg) scale(.94); }
      .creator-title { min-width:0; }
      .creator-kicker,.stage-header small,.block-heading small,.summary-heading small,.composer-stage-title small,.scene-board-kicker,.scroll-section header small,.review-hero small,.review-grid small { color:var(--cc-text-3); font:600 10px/1.5 var(--cc-mono); letter-spacing:2.5px; }
      h1 { margin-top:6px; font:800 clamp(28px,3.6vw,44px)/1.15 var(--cc-serif); letter-spacing:4px;
        background:linear-gradient(180deg,#f6f1e4 30%,#b9b1a1 100%); -webkit-background-clip:text; background-clip:text; color:transparent; }
      .creator-side { flex:0 0 auto; align-self:center; writing-mode:vertical-rl; color:var(--cc-text-4); font:600 11px var(--cc-serif); letter-spacing:7px; padding-left:18px; border-left:1px solid var(--cc-line); }
      .creator-header-actions { display:flex; align-items:center; gap:12px; }
      .prototype-badge { border:1px solid rgba(88,160,180,.4); color:#8cc3d3; background:rgba(88,160,180,.08); padding:7px 11px; border-radius:6px; font-size:11px; letter-spacing:1px; }
      .progress-ring { position:relative; width:46px; height:46px; display:grid; place-items:center; }
      .progress-ring svg { position:absolute; inset:0; width:100%; height:100%; transform:rotate(-90deg); }
      .progress-ring circle { fill:none; stroke-width:2.4; }
      .ring-track { stroke:rgba(236,229,216,.1); }
      .ring-fill { stroke:var(--cc-kin); stroke-linecap:round; transition:stroke-dasharray .6s var(--cc-ease); }
      .progress-ring>span { color:var(--cc-kin-2); font:700 13px var(--cc-mono); }
      .progress-ring>span small { color:var(--cc-text-4); font-size:9px; }

      /* ── 按钮族 ─────────────────────────────── */
      .ghost-btn,.secondary-btn,.primary-btn,.add-btn,.icon-btn,.choice-chip,.nature-chip,.completion-card,.rail-step,.flow-node,.template-card,.scroll-index button { border:1px solid var(--cc-line-2); background:rgba(236,229,216,.03); cursor:pointer; transition:border-color .2s var(--cc-ease),background .2s var(--cc-ease),color .2s var(--cc-ease),transform .2s var(--cc-ease),box-shadow .2s var(--cc-ease); }
      .ghost-btn,.secondary-btn,.primary-btn,.add-btn { min-height:40px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:9px 16px; border-radius:var(--cc-r-s); }
      .ghost-btn { color:var(--cc-text-2); }
      .ghost-btn:hover,.secondary-btn:hover,.add-btn:hover { border-color:rgba(226,96,60,.55); color:var(--cc-text-1); background:rgba(226,96,60,.07); }
      .secondary-btn { color:var(--cc-text-2); }
      .primary-btn { position:relative; overflow:hidden; border-color:transparent; border-radius:var(--cc-r-s);
        background:linear-gradient(135deg,var(--cc-shu-2) 0%,var(--cc-shu) 45%,var(--cc-shu-deep) 100%);
        color:#fff8f0; font-weight:700; letter-spacing:1px; box-shadow:0 10px 28px rgba(168,58,32,.3), inset 0 1px 0 rgba(255,255,255,.18); }
      .primary-btn::after { content:''; position:absolute; top:0; bottom:0; left:-70%; width:45%;
        background:linear-gradient(105deg,transparent,rgba(255,255,255,.22),transparent); transform:skewX(-18deg); transition:left .55s var(--cc-ease); }
      .primary-btn:hover { transform:translateY(-1px); box-shadow:0 14px 34px rgba(168,58,32,.42), inset 0 1px 0 rgba(255,255,255,.22); }
      .primary-btn:hover::after { left:130%; }
      .primary-btn:active { transform:translateY(0) scale(.98); }
      .secondary-btn:disabled { opacity:.3; cursor:not-allowed; }
      .icon-btn { width:34px; height:34px; display:grid; place-items:center; padding:0; border-radius:var(--cc-r-s); color:var(--cc-text-3); }
      .icon-btn:hover { border-color:var(--cc-line-2); color:var(--cc-text-1); }
      .icon-btn.danger:hover { border-color:rgba(192,48,40,.6); color:#f08070; background:rgba(192,48,40,.09); }

      /* ── 预设横幅与人设面板 ────────────────────── */
      .preset-banner { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:13px 16px; margin-bottom:18px; border:1px solid rgba(203,162,107,.22); border-left:3px solid var(--cc-kin); border-radius:var(--cc-r-s); background:linear-gradient(90deg,rgba(203,162,107,.09),rgba(203,162,107,.02)); color:#c9bb9e; }
      .preset-banner>div { display:flex; align-items:center; gap:10px; }
      .preset-banner span { display:grid; gap:2px; }
      .preset-banner strong { color:var(--cc-text-1); font-size:13px; }
      .preset-banner small { color:var(--cc-text-3); font-size:11px; }
      .persona-panel { display:grid; gap:11px; padding:14px 16px; margin-bottom:16px; border:1px solid rgba(203,162,107,.26); border-radius:var(--cc-r); background:linear-gradient(135deg,rgba(203,162,107,.08),rgba(203,162,107,.02)); }
      .persona-panel-title { display:flex; align-items:center; gap:8px; color:var(--cc-kin-2); font:700 12px var(--cc-serif); letter-spacing:2.5px; }
      .persona-row { display:flex; gap:8px; align-items:center; }
      .persona-row .persona-select { flex:1; }
      .persona-save-row { display:flex; gap:8px; align-items:center; }
      .persona-save-row .persona-name { flex:1; }
      .persona-hint { color:var(--cc-text-3); font-size:11px; }

      /* ── 面板基底（三级层级） ──────────────────── */
      .stage-rail,.live-summary,.registration-scroll,.scroll-index>div,.scene-board { border:1px solid var(--cc-line); border-radius:var(--cc-r); background:linear-gradient(180deg,rgba(14,19,27,.82),rgba(10,14,20,.86)); backdrop-filter:blur(18px); box-shadow:0 18px 44px rgba(0,0,0,.35); }
      .editor-panel,.composer-editor { border:1px solid var(--cc-line-2); border-radius:var(--cc-r); background:linear-gradient(180deg,rgba(18,24,34,.88),rgba(12,17,24,.9)); backdrop-filter:blur(18px); box-shadow:0 24px 60px rgba(0,0,0,.42); }

      /* ── 变体 A：工作台 ──────────────────────── */
      .workbench { display:grid; grid-template-columns:208px minmax(0,1fr) 272px; gap:20px; align-items:start; }
      .stage-rail { position:sticky; top:22px; padding:16px 11px; }
      .rail-heading { padding:5px 10px 14px; color:var(--cc-text-4); font:600 10px var(--cc-mono); letter-spacing:2.5px; }
      .rail-step { width:100%; display:flex; align-items:center; gap:11px; padding:11px 10px; margin:3px 0; text-align:left; border-color:transparent; border-radius:var(--cc-r-s); color:var(--cc-text-3); }
      .rail-step>span { width:30px; height:30px; display:grid; place-items:center; border:1px solid var(--cc-line-2); border-radius:7px; color:var(--cc-text-4); font:700 12px var(--cc-serif); transition:inherit; }
      .rail-step div { display:grid; gap:2px; font-size:13px; }
      .rail-step small { font:500 9px var(--cc-mono); color:var(--cc-text-4); letter-spacing:1px; }
      .rail-step:hover { color:var(--cc-text-1); background:rgba(236,229,216,.04); }
      .rail-step.active { color:#fff; border-color:rgba(226,96,60,.4); background:linear-gradient(90deg,rgba(226,96,60,.13),rgba(226,96,60,.04)); box-shadow:inset 0 0 0 1px rgba(226,96,60,.12); }
      .rail-step.active>span { border-color:var(--cc-shu); color:var(--cc-shu-2); animation:ccPulse 2.6s var(--cc-ease) infinite; }
      .rail-step.done>span { color:var(--cc-matsu); border-color:rgba(93,170,140,.45); }
      .rail-foot { margin:15px 10px 4px; padding-top:13px; border-top:1px solid var(--cc-line); color:var(--cc-text-4); font-size:10px; letter-spacing:1px; }
      .rail-foot span { color:var(--cc-kin); font:700 12px var(--cc-mono); }
      .editor-panel { min-width:0; padding:34px 36px; }
      .stage-header { display:grid; grid-template-columns:minmax(0,1fr) minmax(220px,42%); gap:22px; padding-bottom:24px; border-bottom:1px solid var(--cc-line); }
      .stage-header h2 { margin-top:6px; font:800 27px var(--cc-serif); letter-spacing:2px; }
      .stage-header p { align-self:end; color:var(--cc-text-3); font-size:12px; line-height:1.9; }

      /* ── 章节块与表单 ────────────────────────── */
      .section-block { padding:28px 0; border-bottom:1px solid var(--cc-line); }
      .section-block:last-of-type { border-bottom:0; }
      .block-heading { display:flex; justify-content:space-between; align-items:flex-end; gap:18px; margin-bottom:16px; }
      .block-heading h3 { margin-top:4px; font:700 17px var(--cc-serif); letter-spacing:1px; }
      .block-heading p { max-width:420px; color:var(--cc-text-4); font-size:11px; text-align:right; line-height:1.7; }
      .block-actions { display:flex; align-items:center; gap:9px; }
      .add-btn { min-height:34px; padding:6px 12px; color:var(--cc-kin); font-size:11px; letter-spacing:1px; }
      .form-grid { display:grid; gap:13px; }
      .form-grid+.form-grid,.form-grid+.field,.field+.field { margin-top:13px; }
      .cols-2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .cols-3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
      .cols-4 { grid-template-columns:repeat(4,minmax(0,1fr)); }
      .field { display:grid; gap:7px; min-width:0; }
      .field>span,.attribute-field>span { color:var(--cc-text-3); font-size:11px; letter-spacing:.6px; }
      input,textarea,select { width:100%; border:1px solid var(--cc-line-2); border-radius:var(--cc-r-s); outline:0; background:rgba(4,7,11,.5); color:var(--cc-text-1); padding:10px 12px; transition:border-color .2s var(--cc-ease),box-shadow .2s var(--cc-ease),background .2s var(--cc-ease); }
      input,select { min-height:40px; }
      textarea { min-height:88px; resize:vertical; line-height:1.7; }
      input:hover,textarea:hover,select:hover { border-color:rgba(236,229,216,.2); }
      input:focus,textarea:focus,select:focus { border-color:rgba(226,96,60,.7); box-shadow:0 0 0 3px rgba(226,96,60,.12); background:rgba(6,9,14,.65); }
      input::placeholder,textarea::placeholder { color:var(--cc-text-4); }
      select { appearance:none; -webkit-appearance:none; padding-right:32px; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%237e786d' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 12px center; }
      select option { background:#12171f; color:var(--cc-text-1); }
      .derived-power-field output { display:flex; align-items:center; min-height:40px; padding:10px 13px; border:1px solid rgba(226,96,60,.4); border-radius:var(--cc-r-s); background:linear-gradient(90deg,rgba(226,96,60,.12),rgba(226,96,60,.04)); color:var(--cc-shu-2); font:700 15px var(--cc-mono); letter-spacing:1px; }
      .derived-power-field small { color:var(--cc-text-4); font-size:10px; line-height:1.5; }

      /* ── 模板卡 ─────────────────────────────── */
      .template-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
      .template-card { position:relative; display:grid; gap:6px; min-height:118px; padding:16px; text-align:left; border-radius:var(--cc-r-s); overflow:hidden; }
      .template-card::before { content:''; position:absolute; inset:0 auto 0 0; width:3px; background:var(--template-accent); opacity:.5; transition:opacity .2s var(--cc-ease); }
      .template-watermark { position:absolute; right:10px; bottom:8px; color:var(--template-accent); opacity:.13; transition:opacity .25s var(--cc-ease),transform .25s var(--cc-ease); pointer-events:none; }
      .template-card span { color:var(--template-accent); font-size:10px; letter-spacing:1.5px; }
      .template-card strong { font:700 15px var(--cc-serif); letter-spacing:1px; }
      .template-card small { color:var(--cc-text-3); font-size:11px; line-height:1.6; }
      .template-card:hover { border-color:color-mix(in srgb,var(--template-accent) 55%,transparent); background:rgba(236,229,216,.045); transform:translateY(-2px); }
      .template-card:hover::before { opacity:.9; }
      .template-card:hover .template-watermark { opacity:.26; transform:scale(1.08) rotate(-4deg); }
      .template-card.selected { border-color:var(--template-accent); background:color-mix(in srgb,var(--template-accent) 10%,transparent); box-shadow:0 8px 24px color-mix(in srgb,var(--template-accent) 16%,transparent); }
      .template-card.selected .template-watermark { opacity:.3; }

      /* ── 难度 / 性质 / 补全选择 ────────────────── */
      .choice-row { display:grid; gap:8px; }
      .choice-row.five { grid-template-columns:repeat(5,minmax(0,1fr)); }
      .choice-chip { display:grid; gap:5px; min-height:86px; padding:13px; text-align:left; border-radius:var(--cc-r-s); }
      .choice-chip strong { font-size:13px; letter-spacing:1px; }
      .choice-chip span { color:var(--cc-text-4); font-size:10px; line-height:1.6; }
      .choice-chip:hover { border-color:rgba(203,162,107,.45); transform:translateY(-1px); }
      .choice-chip.selected { border-color:var(--cc-kin); background:linear-gradient(135deg,rgba(203,162,107,.13),rgba(203,162,107,.04)); box-shadow:0 6px 18px rgba(203,162,107,.1); }
      .choice-chip.selected strong { color:var(--cc-kin-2); }
      .nature-grid { display:flex; flex-wrap:wrap; gap:8px; }
      .nature-chip { display:flex; align-items:center; gap:7px; min-height:36px; padding:7px 12px; border-radius:999px; color:var(--cc-text-3); font-size:12px; }
      .nature-chip:hover { border-color:rgba(88,160,180,.5); color:var(--cc-text-1); }
      .nature-chip.selected { border-color:rgba(88,160,180,.65); color:#a5d8e4; background:rgba(88,160,180,.1); box-shadow:0 4px 14px rgba(88,160,180,.12); }
      .benchmark { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:14px; padding:10px 12px; border:1px solid rgba(88,160,180,.18); border-left:3px solid var(--cc-ao); border-radius:var(--cc-r-s); background:rgba(88,160,180,.05); }
      .benchmark span { color:#8fbccb; font-size:11px; margin-right:4px; }
      .benchmark em { color:var(--cc-text-3); font:normal 10px var(--cc-mono); }
      .benchmark.muted { border-left-color:var(--cc-text-4); border-color:var(--cc-line); background:transparent; }

      /* ── 属性六维 ────────────────────────────── */
      .attribute-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
      .attribute-field { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 13px; border:1px solid var(--cc-line); border-radius:var(--cc-r-s); background:rgba(236,229,216,.02); transition:border-color .2s var(--cc-ease); }
      .attribute-field:focus-within { border-color:rgba(203,162,107,.5); }
      .attribute-field span { display:flex; align-items:center; gap:8px; color:var(--cc-text-2); }
      .attribute-field input { width:92px; min-height:36px; text-align:right; color:var(--cc-kin-2); font:700 14px var(--cc-mono); }

      /* ── 条目卡 ─────────────────────────────── */
      .entry-list { display:grid; gap:12px; }
      .entry-card { padding:16px; border:1px solid var(--cc-line); border-radius:var(--cc-r-s); background:rgba(236,229,216,.02); transition:border-color .2s var(--cc-ease); }
      .entry-card:hover { border-color:var(--cc-line-2); }
      .entry-card>header { display:flex; justify-content:space-between; align-items:center; margin-bottom:13px; }
      .entry-card>header>div { display:flex; align-items:center; gap:10px; }
      .entry-card>header strong { font:700 14px var(--cc-serif); letter-spacing:1px; }
      .entry-index { color:var(--cc-kin); font:600 10px var(--cc-mono); letter-spacing:1px; }
      .source-badge { padding:3px 7px; border:1px solid rgba(88,160,180,.42); border-radius:999px; color:#93c9d6; background:rgba(88,160,180,.08); font:normal 9px var(--cc-mono); letter-spacing:.6px; }
      .source-badge.custom { border-color:rgba(203,162,107,.4); color:var(--cc-kin); background:rgba(203,162,107,.07); }
      .empty-state { display:flex; align-items:center; gap:13px; padding:18px; border:1px dashed var(--cc-line-2); border-radius:var(--cc-r-s); color:var(--cc-text-4); }
      .empty-state>span { display:grid; place-items:center; width:32px; height:32px; border:1px solid var(--cc-line-2); border-radius:7px; color:var(--cc-text-4); font:700 12px var(--cc-serif); }
      .empty-state p { font-size:12px; }
      .ryo-field { display:flex; align-items:center; gap:8px; color:var(--cc-text-3); font-size:11px; }
      .ryo-field input { width:110px; min-height:34px; padding:6px 9px; }
      .relation-values { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:15px; margin-top:14px; }
      .relation-values label { display:grid; gap:7px; }
      .relation-values span { display:flex; justify-content:space-between; color:var(--cc-text-3); font-size:11px; }
      .relation-values output { color:var(--cc-kin-2); font:600 11px var(--cc-mono); }
      .relation-values input { min-height:auto; padding:0; accent-color:var(--cc-shu); }

      /* ── 忍术库选择器 ────────────────────────── */
      .technique-picker { display:grid; gap:13px; padding:16px; margin-bottom:15px; border:1px solid rgba(88,160,180,.22); border-radius:var(--cc-r); background:linear-gradient(160deg,rgba(88,160,180,.06),rgba(88,160,180,.015)); }
      .technique-picker-heading>div { display:grid; gap:3px; }
      .technique-picker-heading strong { color:#dce7e8; font-size:13px; letter-spacing:1px; }
      .technique-picker-heading span { color:#7b8c8f; font-size:11px; line-height:1.6; }
      .technique-toolbar { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; align-items:end; }
      .technique-search { grid-column:span 2; }
      .technique-toolbar label { display:grid; gap:6px; }
      .technique-toolbar label>span { color:#829093; font-size:10px; }
      .technique-result-meta { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:9px; color:#849397; font-size:10px; }
      .technique-page-size { display:flex; align-items:center; gap:6px; color:#6f7e81; }
      .technique-page-size select { width:auto; min-height:32px; padding:5px 26px 5px 9px; font-size:10px; }
      .technique-pagination { position:sticky; top:8px; z-index:3; display:flex; align-items:center; gap:8px; padding:8px; margin-bottom:9px; border:1px solid rgba(88,160,180,.2); border-radius:var(--cc-r-s); background:rgba(8,14,18,.97); box-shadow:0 8px 20px rgba(0,0,0,.3); }
      .technique-pagination button { min-height:30px; padding:5px 9px; border:1px solid var(--cc-line-2); border-radius:6px; background:rgba(236,229,216,.03); color:#859396; cursor:pointer; font-size:10px; transition:all .18s var(--cc-ease); }
      .technique-pagination button:hover:not(:disabled),.technique-pagination button.active { border-color:rgba(88,160,180,.55); color:#b9e0e7; background:rgba(88,160,180,.1); }
      .technique-pagination button:disabled { opacity:.32; cursor:default; }
      .technique-page-numbers { display:flex; flex:1; justify-content:center; align-items:center; gap:4px; }
      .technique-page-numbers button { min-width:30px; padding-inline:6px; }
      .technique-page-gap { color:#586568; font-size:10px; }
      .technique-pagination>[data-technique-page-state] { color:#788689; white-space:nowrap; font-size:10px; }
      .technique-result-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
      .technique-result-card { display:grid; gap:9px; min-width:0; padding:13px; border:1px solid var(--cc-line); border-radius:var(--cc-r-s); background:rgba(4,9,12,.4); transition:border-color .18s var(--cc-ease),transform .18s var(--cc-ease); }
      .technique-result-card:hover { border-color:rgba(88,160,180,.35); transform:translateY(-1px); }
      .technique-result-card.added { border-color:rgba(93,170,140,.3); background:rgba(93,170,140,.04); }
      .technique-result-card>header { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
      .technique-result-card>header>div { display:grid; gap:3px; min-width:0; }
      .technique-result-card strong { color:#d3dcdc; font-size:12px; overflow-wrap:anywhere; }
      .technique-result-card header span { color:#718084; font-size:9px; }
      .technique-result-card button { flex:0 0 auto; min-height:30px; padding:5px 11px; border:1px solid rgba(88,160,180,.45); border-radius:6px; background:rgba(88,160,180,.09); color:#9ccbd5; cursor:pointer; font-size:10px; transition:all .18s var(--cc-ease); }
      .technique-result-card button:hover { border-color:#62b2c4; color:#d9f2f6; }
      .technique-result-card button:disabled { border-color:rgba(93,170,140,.28); color:#6b9d89; background:rgba(93,170,140,.05); cursor:default; }
      .technique-result-card p { color:#747d7d; font-size:10px; line-height:1.65; }
      .technique-result-card footer { display:flex; flex-wrap:wrap; gap:5px 10px; color:#627174; font-size:9px; }
      .technique-result-card code { margin-left:auto; color:#4f5c5f; font:inherit; }
      .technique-empty { padding:20px; border:1px dashed var(--cc-line-2); border-radius:var(--cc-r-s); color:#737d7f; text-align:center; font-size:11px; }
      .canon-ability-card { border-color:rgba(88,160,180,.24); background:rgba(88,160,180,.03); }
      .canon-ability-facts { display:flex; flex-wrap:wrap; gap:6px; }
      .canon-ability-facts span { padding:4px 8px; border:1px solid var(--cc-line); border-radius:5px; color:#8e9b9d; background:rgba(0,0,0,.2); font-size:10px; }
      .canon-ability-description { margin:11px 0; color:#898f8e; font-size:11px; line-height:1.75; white-space:pre-wrap; }
      .canon-mastery { max-width:300px; }

      /* ── 阶段导航与完成按钮 ────────────────────── */
      .stage-nav { display:flex; justify-content:space-between; gap:12px; padding-top:26px; }
      .finish-btn { min-height:46px; }
      .finish-btn:not(.compact) { width:100%; margin-top:20px; font-size:15px; }

      /* ── 实时摘要 ────────────────────────────── */
      .live-summary { position:sticky; top:22px; padding:20px; }
      .summary-heading { position:relative; padding-bottom:15px; border-bottom:1px solid var(--cc-line); }
      .summary-heading h3 { margin-top:7px; padding-right:52px; font:800 20px var(--cc-serif); letter-spacing:1px; }
      .summary-heading>span { position:absolute; right:0; bottom:16px; color:var(--cc-shu-2); font:700 13px var(--cc-mono); }
      .summary-identity { padding:15px 0; }
      .summary-identity strong { color:#cdc2ae; font-size:12px; }
      .summary-identity p { margin-top:5px; color:var(--cc-text-4); font-size:11px; }
      .summary-facts { display:grid; gap:9px; margin:0; }
      .summary-facts div { display:grid; grid-template-columns:38px 1fr; gap:8px; }
      .summary-facts dt { color:var(--cc-text-4); font-size:10px; }
      .summary-facts dd { margin:0; color:var(--cc-text-2); font-size:11px; line-height:1.6; }
      .mini-attrs { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:16px 0; }
      .mini-attrs span { display:grid; gap:3px; padding:8px; border:1px solid var(--cc-line); border-radius:6px; text-align:center; }
      .mini-attrs small { color:var(--cc-text-4); font-size:9px; }
      .mini-attrs strong { color:var(--cc-kin-2); font:650 12px var(--cc-mono); }
      .summary-counts { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
      .summary-counts span { color:var(--cc-text-3); font-size:10px; }
      .summary-counts strong { color:var(--cc-text-1); font:650 12px var(--cc-mono); }
      .summary-mode { display:flex; justify-content:space-between; align-items:center; margin-top:15px; padding-top:13px; border-top:1px solid var(--cc-line); }
      .summary-mode small { color:var(--cc-text-4); font-size:10px; }
      .summary-mode strong { color:var(--cc-matsu); font-size:11px; }

      /* ── 核对页：档案卡 ──────────────────────── */
      .review-hero { position:relative; overflow:hidden; display:flex; justify-content:space-between; align-items:center; gap:20px; padding:26px 28px; margin-top:24px; border:1px solid rgba(226,96,60,.3); border-radius:var(--cc-r);
        background:linear-gradient(120deg,rgba(226,96,60,.12),rgba(226,96,60,.03) 55%,rgba(203,162,107,.06)); }
      .review-hero::before { content:'開'; position:absolute; right:76px; top:50%; transform:translateY(-50%); color:rgba(226,96,60,.07); font:800 120px var(--cc-serif); pointer-events:none; }
      .review-hero h2 { margin:6px 0 4px; font:800 30px var(--cc-serif); letter-spacing:3px; }
      .review-hero p { color:var(--cc-text-3); font-size:12px; letter-spacing:1px; }
      .review-hero>span { position:relative; color:var(--cc-shu-2); font:800 24px var(--cc-mono); padding:8px 14px; border:1px solid rgba(226,96,60,.35); border-radius:var(--cc-r-s); background:rgba(226,96,60,.08); }
      .review-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; }
      .review-grid section { min-height:118px; padding:16px; border:1px solid var(--cc-line); border-radius:var(--cc-r-s); background:rgba(236,229,216,.02); transition:border-color .2s var(--cc-ease); }
      .review-grid section:hover { border-color:var(--cc-line-2); }
      .review-grid h3 { margin:7px 0; font:700 14px var(--cc-serif); letter-spacing:1px; }
      .review-grid p { color:var(--cc-text-3); font-size:11px; line-height:1.7; }
      .completion-modes { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
      .completion-card { position:relative; display:grid; gap:6px; min-height:110px; padding:15px; text-align:left; border-radius:var(--cc-r-s); }
      .completion-card>span { position:absolute; right:11px; top:11px; color:var(--cc-matsu); }
      .completion-card strong { display:flex; align-items:center; gap:7px; font-size:13px; letter-spacing:1px; }
      .completion-card em { padding:2px 5px; color:var(--cc-kin-2); border:1px solid rgba(203,162,107,.35); border-radius:4px; font:normal 9px var(--cc-mono); }
      .completion-card small { color:var(--cc-text-3); font-size:10px; line-height:1.65; }
      .completion-card:hover { border-color:rgba(93,170,140,.4); transform:translateY(-1px); }
      .completion-card.selected { border-color:rgba(93,170,140,.6); background:linear-gradient(135deg,rgba(93,170,140,.12),rgba(93,170,140,.03)); box-shadow:0 6px 18px rgba(93,170,140,.1); }

      /* ── 通知浮条 ────────────────────────────── */
      .creator-notice { position:fixed; right:84px; bottom:24px; z-index:10001; display:flex; align-items:center; gap:9px; max-width:420px; padding:12px 15px; border:1px solid rgba(93,170,140,.45); border-radius:var(--cc-r-s); background:rgba(13,22,19,.96); color:#a9d9c5; box-shadow:0 14px 40px rgba(0,0,0,.5); font-size:12px; animation:ccToastIn .35s var(--cc-ease); }

      /* ── 变体 B：登记卷 ──────────────────────── */
      .scroll-layout { display:grid; grid-template-columns:minmax(0,1fr) 272px; gap:20px; align-items:start; max-width:1180px; margin:0 auto; }
      .registration-scroll { padding:38px 44px; }
      .scroll-title-row { display:flex; justify-content:space-between; align-items:center; padding-bottom:30px; border-bottom:2px solid rgba(203,162,107,.4); }
      .scroll-title-row span { color:var(--cc-text-3); font-size:11px; letter-spacing:2.5px; }
      .scroll-title-row h2 { margin-top:7px; font:800 33px var(--cc-serif); letter-spacing:6px; }
      .scroll-stamp { display:grid; place-items:center; width:66px; height:66px; border:2px solid rgba(226,96,60,.6); border-radius:10px; color:var(--cc-shu-2); font:700 13px var(--cc-serif); transform:rotate(4deg); box-shadow:inset 0 0 12px rgba(226,96,60,.12); }
      .scroll-section { padding:32px 0; border-bottom:1px solid var(--cc-line); scroll-margin-top:24px; }
      .scroll-section>header { display:flex; align-items:center; gap:14px; margin-bottom:6px; }
      .scroll-section>header>span { display:grid; place-items:center; width:44px; height:44px; border:1px solid rgba(226,96,60,.4); border-radius:9px; color:var(--cc-shu-2); font:800 22px var(--cc-serif); background:rgba(226,96,60,.06); }
      .scroll-section>header h3 { margin-top:3px; font:800 20px var(--cc-serif); letter-spacing:2px; }
      .scroll-section .stage-nav,.scroll-section .finish-btn:not(.compact) { display:none; }
      .scroll-index { position:sticky; top:22px; display:grid; gap:11px; }
      .scroll-index>div { padding:20px; }
      .scroll-index nav { display:grid; padding:8px; border:1px solid var(--cc-line); border-radius:var(--cc-r); background:linear-gradient(180deg,rgba(14,19,27,.82),rgba(10,14,20,.86)); }
      .scroll-index button { padding:10px 11px; border-color:transparent; border-radius:7px; text-align:left; color:var(--cc-text-3); font-size:12px; letter-spacing:1px; }
      .scroll-index button:hover { color:#fff; background:rgba(226,96,60,.08); }
      .scroll-final { display:flex; justify-content:flex-end; padding-top:30px; }

      /* ── 变体 C：编排台 ──────────────────────── */
      .composer { max-width:1260px; margin:0 auto; }
      .composer-flow { display:flex; align-items:flex-start; justify-content:center; padding:18px 22px; margin-bottom:16px; border:1px solid var(--cc-line); border-radius:var(--cc-r); background:linear-gradient(180deg,rgba(14,19,27,.78),rgba(10,14,20,.82)); }
      .flow-node { display:grid; justify-items:center; gap:6px; width:82px; border:0; background:transparent; color:var(--cc-text-4); }
      .flow-node>span { display:grid; place-items:center; width:34px; height:34px; border:1px solid var(--cc-line-2); border-radius:50%; color:var(--cc-text-4); font:700 11px var(--cc-serif); transition:all .2s var(--cc-ease); }
      .flow-node small { font-size:10px; letter-spacing:1px; }
      .flow-node.active { color:var(--cc-text-1); }
      .flow-node.active>span { color:var(--cc-shu-2); border-color:var(--cc-shu); background:rgba(226,96,60,.12); box-shadow:0 0 0 4px rgba(226,96,60,.1); animation:ccPulse 2.6s var(--cc-ease) infinite; }
      .flow-node.done>span { color:var(--cc-matsu); border-color:rgba(93,170,140,.5); }
      .flow-line { width:56px; height:1px; margin-top:17px; background:var(--cc-line-2); }
      .composer-grid { display:grid; grid-template-columns:320px minmax(0,1fr); gap:16px; align-items:start; }
      .scene-board { position:sticky; top:22px; padding:26px; border-top:2px solid var(--cc-ao); }
      .scene-board h2 { margin:13px 0 24px; color:#ddd7cc; font:700 21px/1.6 var(--cc-serif); letter-spacing:1px; }
      .scene-board dl { display:grid; gap:12px; margin:0; }
      .scene-board dl div { padding-bottom:11px; border-bottom:1px solid var(--cc-line); }
      .scene-board dt { color:var(--cc-text-4); font-size:10px; letter-spacing:1px; }
      .scene-board dd { margin:5px 0 0; color:var(--cc-text-2); font-size:12px; line-height:1.6; }
      .scene-cast { margin-top:22px; }
      .scene-cast small { color:var(--cc-text-4); font-size:10px; letter-spacing:1px; }
      .scene-cast>div { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .scene-cast span { padding:5px 9px; border:1px solid rgba(203,162,107,.3); border-radius:999px; color:var(--cc-kin); font-size:10px; }
      .scene-cast em { color:var(--cc-text-4); font-size:11px; }
      .composer-editor { padding:32px; }
      .composer-stage-title { display:flex; align-items:center; gap:15px; padding-bottom:22px; border-bottom:1px solid var(--cc-line); }
      .composer-stage-title>span { display:grid; place-items:center; width:52px; height:52px; border:1px solid rgba(226,96,60,.4); border-radius:10px; color:var(--cc-shu-2); font:800 26px var(--cc-serif); background:rgba(226,96,60,.07); }
      .composer-stage-title h2 { margin-top:4px; font:800 24px var(--cc-serif); letter-spacing:2px; }

      /* ── 原型切换器 ──────────────────────────── */
      .prototype-switcher { position:fixed; left:50%; bottom:18px; z-index:10001; transform:translateX(-50%); display:flex; align-items:center; gap:5px; padding:6px; border:1px solid var(--cc-line-2); border-radius:10px; background:rgba(8,11,15,.96); box-shadow:0 14px 40px rgba(0,0,0,.6); }
      .prototype-switcher button { width:40px; height:40px; border:0; border-radius:7px; background:rgba(236,229,216,.05); color:var(--cc-text-1); cursor:pointer; transition:background .18s var(--cc-ease); }
      .prototype-switcher button:hover { background:var(--cc-shu); }
      .prototype-switcher span { display:grid; min-width:196px; padding:0 13px; text-align:center; }
      .prototype-switcher small { color:var(--cc-text-4); font:500 8px var(--cc-mono); letter-spacing:1.5px; }
      .prototype-switcher strong { margin-top:2px; font-size:11px; }

      /* ── 盖章封存 ────────────────────────────── */
      .seal-stamp-overlay { position:fixed; inset:0; z-index:10002; display:grid; place-items:center; background:rgba(4,6,9,.55); backdrop-filter:blur(3px); animation:ccFadeIn .25s var(--cc-ease) both; }
      .seal-stamp-overlay.is-leaving { animation:ccFadeOut .3s var(--cc-ease) both; }
      .seal-stamp-stage { position:relative; display:grid; justify-items:center; gap:26px; }
      .seal-stamp-mark { position:relative; display:grid; place-items:center; width:118px; height:118px; border-radius:18px;
        background:linear-gradient(135deg,var(--cc-shu) 0%,var(--cc-inkred) 100%); color:#fdf6ec;
        font:800 58px var(--cc-serif); transform:rotate(-6deg);
        box-shadow:inset 0 0 0 4px rgba(253,246,236,.24), inset 0 -12px 26px rgba(60,8,4,.5), 0 26px 60px rgba(168,58,32,.4);
        animation:ccStampDrop .55s cubic-bezier(.3,1.6,.45,1) .1s both;
      }
      .seal-stamp-ripple { position:absolute; top:59px; left:50%; width:118px; height:118px; border:2px solid rgba(226,96,60,.55); border-radius:20px; transform:translate(-50%,-50%) rotate(-6deg); animation:ccRipple .8s var(--cc-ease) .5s both; pointer-events:none; }
      .seal-stamp-stage p { color:var(--cc-text-2); font:600 14px var(--cc-serif); letter-spacing:4px; animation:ccRise .4s var(--cc-ease) .55s both; }

      /* ── 动效 ─────────────────────────────── */
      @keyframes ccFadeIn { from { opacity:0; } to { opacity:1; } }
      @keyframes ccFadeOut { from { opacity:1; } to { opacity:0; } }
      @keyframes ccStampDrop {
        0% { opacity:0; transform:rotate(-6deg) translateY(-140px) scale(1.35); }
        62% { opacity:1; transform:rotate(-6deg) translateY(6px) scale(.96); }
        82% { transform:rotate(-6deg) translateY(-3px) scale(1.01); }
        100% { opacity:1; transform:rotate(-6deg) translateY(0) scale(1); }
      }
      @keyframes ccRipple {
        from { opacity:.9; transform:translate(-50%,-50%) rotate(-6deg) scale(1); }
        to { opacity:0; transform:translate(-50%,-50%) rotate(-6deg) scale(1.9); }
      }
      @keyframes ccPulse {
        0%,100% { box-shadow:0 0 0 0 rgba(226,96,60,.28); }
        55% { box-shadow:0 0 0 6px rgba(226,96,60,0); }
      }
      @keyframes ccRise {
        from { opacity:0; transform:translateY(14px); }
        to { opacity:1; transform:translateY(0); }
      }
      @keyframes ccToastIn {
        from { opacity:0; transform:translateY(10px); }
        to { opacity:1; transform:translateY(0); }
      }
      @media (prefers-reduced-motion: no-preference) {
        .creator-header { animation:ccRise .5s var(--cc-ease) both; }
        .persona-panel,.preset-banner { animation:ccRise .5s var(--cc-ease) .08s both; }
        .workbench,.scroll-layout,.composer { animation:ccRise .55s var(--cc-ease) .16s both; }
        .stage-rail .rail-step { animation:ccRise .4s var(--cc-ease) both; }
        .stage-rail .rail-step:nth-of-type(1) { animation-delay:.2s; }
        .stage-rail .rail-step:nth-of-type(2) { animation-delay:.26s; }
        .stage-rail .rail-step:nth-of-type(3) { animation-delay:.32s; }
        .stage-rail .rail-step:nth-of-type(4) { animation-delay:.38s; }
        .stage-rail .rail-step:nth-of-type(5) { animation-delay:.44s; }
        .editor-panel>.section-block,.composer-editor>.section-block { animation:ccRise .45s var(--cc-ease) both; }
        .editor-panel>.section-block:nth-of-type(2),.composer-editor>.section-block:nth-of-type(2) { animation-delay:.07s; }
        .editor-panel>.section-block:nth-of-type(3),.composer-editor>.section-block:nth-of-type(3) { animation-delay:.14s; }
        .editor-panel>.section-block:nth-of-type(4),.composer-editor>.section-block:nth-of-type(4) { animation-delay:.21s; }
      }
      @media (prefers-reduced-motion: reduce) {
        *,*::before,*::after { animation-duration:.01ms !important; animation-iteration-count:1 !important; transition-duration:.01ms !important; }
      }

      /* ── 响应式 ─────────────────────────────── */
      @media (max-width:1100px) {
        .workbench { grid-template-columns:180px minmax(0,1fr); }
        .live-summary { display:none; }
        .template-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .choice-row.five { grid-template-columns:repeat(3,minmax(0,1fr)); }
        .scroll-layout { grid-template-columns:minmax(0,1fr); }
        .scroll-index { display:none; }
      }
      @media (max-width:800px) {
        .creator { padding:24px 15px 118px; }
        .creator-header { align-items:flex-start; }
        .creator-side { display:none; }
        .creator-header-actions { flex-direction:column; align-items:flex-end; }
        .prototype-badge { display:none; }
        .workbench { display:block; }
        .stage-rail { position:static; display:flex; overflow-x:auto; gap:6px; margin-bottom:12px; padding:9px; }
        .rail-heading,.rail-foot { display:none; }
        .rail-step { flex:0 0 auto; width:auto; margin:0; }
        .rail-step div { display:none; }
        .editor-panel,.composer-editor { padding:22px 16px; }
        .stage-header { grid-template-columns:1fr; gap:9px; }
        .stage-header p { align-self:auto; }
        .cols-3,.cols-4 { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .attribute-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .choice-row.five { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .technique-toolbar { grid-template-columns:1fr 1fr; }
        .technique-search { grid-column:1 / -1; }
        .technique-result-grid { grid-template-columns:1fr; }
        .technique-pagination { flex-wrap:wrap; }
        .technique-page-numbers { order:3; flex-basis:100%; }
        .composer-grid { grid-template-columns:1fr; }
        .scene-board { position:static; }
        .composer-flow { overflow-x:auto; justify-content:flex-start; }
        .flow-line { min-width:22px; width:22px; }
        .registration-scroll { padding:26px 19px; }
      }
      @media (max-width:560px) {
        .creator-header { display:grid; }
        .creator-header-actions { align-items:stretch; }
        h1 { font-size:25px; letter-spacing:2px; }
        .creator-seal { width:44px; height:44px; font-size:21px; }
        .template-grid,.cols-2,.cols-3,.cols-4,.attribute-grid,.review-grid,.completion-modes,.relation-values { grid-template-columns:1fr; }
        .choice-row.five { grid-template-columns:1fr 1fr; }
        .technique-toolbar { grid-template-columns:1fr; }
        .technique-search { grid-column:auto; }
        .technique-result-meta { align-items:flex-start; }
        .technique-pagination>[data-technique-page-state] { margin-left:auto; }
        .block-heading { align-items:flex-start; }
        .block-heading p { display:none; }
        .block-actions { align-items:flex-end; flex-direction:column; }
        .attribute-field input { width:110px; }
        input,textarea,select { font-size:16px; }
        .scroll-title-row h2 { font-size:26px; }
        .scroll-stamp { width:54px; height:54px; }
        .review-hero::before { display:none; }
        .prototype-switcher { left:12px; bottom:calc(var(--statusbar-h,30px) + 14px); width:calc(100% - 88px); transform:none; justify-content:space-between; }
        .prototype-switcher span { min-width:0; }
        .creator-notice { left:12px; right:88px; bottom:calc(var(--statusbar-h,30px) + 74px); }
      }
    `;
  }
}

if (!customElements.get('character-creator')) customElements.define('character-creator', CharacterCreator);
export default CharacterCreator;
