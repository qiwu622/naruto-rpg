import { eventBus } from '../core/event-bus.js';
import { readTokenUsage } from '../core/deepseek-mode.js';
import { ImageContractStreamFilter } from '../core/image-studio/contracts.js';

const STAGES = [
  { key: 'context_search',   kanji: '索', label: '历史检索' },
  { key: 'story_plan',       kanji: '策', label: '三日策划' },
  { key: 'brainstorm',       kanji: '灵', label: '意识风暴' },
  { key: 'outline',          kanji: '景', label: '场景节拍' },
  { key: 'review_outline',   kanji: '明', label: '逻辑洞察' },
  { key: 'character_agents', kanji: '演', label: '人物行动' },
  { key: 'writing',          kanji: '织', label: '详纲编织' },
  { key: 'review_draft',     kanji: '炼', label: '详纲建议' },
  { key: 'final_audit',      kanji: '议', label: '整理建议' },
  { key: 'final_write',      kanji: '文', label: '正文定稿' },
  { key: 'continuity_updater', kanji: '账', label: '变量结算' },
  { key: 'archive',          kanji: '封', label: '记忆封印' }
];

class AgentProgress extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._currentStage = null;
    this._completedStages = new Set();
    this._detail = '';
    this._streamText = '';
    this._streamAgent = null;
    this._streamFilter = new ImageContractStreamFilter();
    this._runtimeLines = [];
    this._cacheStats = null;
    this._agents = new Map();
    this._detailOpen = true;
    this._agentsRenderScheduled = false;
    this._lastAgentsRenderAt = 0;
    this._openAgentIds = new Set();
    this._usageAccum = { hit: 0, miss: 0 };
    this._unsubs = [];
  }

  connectedCallback() {
    this._render();
    this._unsubs.push(
      eventBus.on('agent:progress', ({ stage, detail }) => this._onProgress(stage, detail)),
      eventBus.on('agent:fallback', ({ reason }) => this._onFallback(reason)),
      eventBus.on('agent:stream', ({ agent, chunk }) => this._onStream(agent, chunk)),
      eventBus.on('agent:reasoning', event => this._onReasoning(event)),
      eventBus.on('agent:character', event => this._onCharacter(event)),
      eventBus.on('agent:runtime-event', event => this._onRuntimeEvent(event)),
      eventBus.on('agent:context-ready', event => this._onContextReady(event)),
      eventBus.on('agent:subagent-start', event => this._onSubagent(event, true)),
      eventBus.on('agent:subagent-end', event => this._onSubagent(event, false)),
      eventBus.on('agent:character-fallback', event => this._onCharacterFallback(event)),
      eventBus.on('agent:audit', event => this._onAudit(event)),
      eventBus.on('ai:usage', usage => this._onUsage(usage))
    );
  }

  disconnectedCallback() {
    this._unsubs.forEach(fn => fn?.());
    this._unsubs = [];
  }

  _onProgress(stage, detail) {
    if (this._currentStage && this._currentStage !== stage) {
      this._completedStages.add(this._currentStage);
    }
    this._currentStage = stage;
    this._detail = detail || '';
    this._streamText = '';
    this._streamAgent = null;
    this._streamFilter = new ImageContractStreamFilter();
    if (this._streamEl) {
      this._streamEl.textContent = '';
    }
    
    if (stage === 'done') {
      this._completedStages.add('archive');
      this._renderPromptCache('本回合总缓存');
      setTimeout(() => this.remove(), 2000);
    }
    this._update();
  }

  _onFallback(reason) {
    this._detail = `术式崩溃: ${reason}`;
    this._currentStage = 'fallback';
    this._update();
    setTimeout(() => this.remove(), 3000);
  }

  _onStream(agent, chunk) {
    if (!chunk) return;
    // 每个子模型的流式输出都记入推演详情（含 critic/规划 JSON，便于点开查看）
    const entry = this._getAgent(agent);
    entry.output += chunk;
    if (entry.output.length > 24000) entry.output = entry.output.slice(-24000);
    this._scheduleAgentsRender();
    // 公开的规划流可以展示；NPC 私密意图与审校记录不能伪装成正文。
    if (String(agent || '').startsWith('char-') || String(agent || '').startsWith('critic-')) return;
    if (this._streamAgent !== agent) {
      this._streamAgent = agent;
      this._streamText = '';
      this._streamFilter = new ImageContractStreamFilter();
    }

    this._streamText += this._streamFilter.push(chunk);
    if (this._streamEl) {
      const displayLength = 1000;
      this._streamEl.textContent = this._streamText.length > displayLength
        ? `...${this._streamText.slice(-displayLength)}`
        : this._streamText;
      this._streamEl.scrollTop = this._streamEl.scrollHeight;
    }
  }

  _onReasoning({ agent, chunk }) {
    if (!chunk) return;
    const entry = this._getAgent(agent);
    entry.reasoning += chunk;
    if (entry.reasoning.length > 24000) entry.reasoning = entry.reasoning.slice(-24000);
    this._scheduleAgentsRender();
  }

  _onCharacter({ npc, response }) {
    if (!npc) return;
    const entry = this._getAgent(`character:${npc}`);
    const observable = response?.observable || {};
    const lines = [
      observable.action ? `行动：${observable.action}` : '',
      observable.dialogue ? `台词："${observable.dialogue}"` : '',
      observable.moodShift ? `情绪变化：${observable.moodShift}` : '',
      observable.towardsPlayer ? `对玩家态度：${observable.towardsPlayer}` : ''
    ].filter(Boolean);
    entry.output = lines.join('\n') || '（无可观察行为，见审计）';
    entry.status = response?.provenance === 'director-fallback' ? '降级' : '完成';
    if (response?.fallbackReason) entry.fallbackReason = response.fallbackReason;
    this._scheduleAgentsRender();
  }

  _pushRuntimeLine(line) {
    if (!line) return;
    this._runtimeLines.push(String(line).slice(0, 180));
    this._runtimeLines = this._runtimeLines.slice(-4);
    if (this._runtimeTraceEl) this._runtimeTraceEl.textContent = this._runtimeLines.join('\n');
  }

  _formatSources(sources) {
    const safe = (Array.isArray(sources) ? sources : []).slice(0, 3)
      .map(source => [source?.kind, source?.id].filter(Boolean).join(':'))
      .filter(Boolean);
    return safe.length ? ` · ${safe.join(' / ')}` : '';
  }

  _updateCache(stats) {
    if (!stats || typeof stats !== 'object') return;
    this._cacheStats = stats;
    if (!this._cacheEl) return;
    const hits = Number(stats.hits) || 0;
    const misses = Number(stats.misses) || 0;
    const rate = Number.isFinite(Number(stats.hitRate))
      ? Math.round(Number(stats.hitRate) * 100)
      : (hits + misses ? Math.round(hits / (hits + misses) * 100) : 0);
    this._cacheEl.textContent = `缓存 ${hits}/${hits + misses} · ${rate}%`;
  }

  _onRuntimeEvent(event) {
    this._updateCache(event?.cache);
    const duration = Number.isFinite(event?.durationMs) ? ` · ${event.durationMs}ms` : '';
    if (event?.type === 'tool-start') {
      this._pushRuntimeLine(`工具 · ${event.tool || 'unknown'} · 运行中`);
      const entry = this._getAgent(event.agent);
      entry.tools.push(`▸ ${event.tool || 'unknown'} 运行中`);
      this._scheduleAgentsRender();
    } else if (event?.type === 'tool-end') {
      this._pushRuntimeLine(`工具 · ${event.tool || 'unknown'} · ${event.success ? '完成' : '失败'}${duration}${this._formatSources(event.sources)}`);
      const entry = this._getAgent(event.agent);
      entry.tools.push(`${event.success ? '✔' : '✘'} ${event.tool || 'unknown'}${duration}`);
      this._scheduleAgentsRender();
    } else if (event?.type === 'agent-fallback') {
      this._pushRuntimeLine(`兼容协议 · ${event.agent || 'agent'} · 已切换`);
      const entry = this._getAgent(event.agent);
      entry.status = '降级';
      this._scheduleAgentsRender();
    } else if (event?.type === 'agent-start') {
      const entry = this._getAgent(event.agent);
      entry.mode = event?.detail?.mode || entry.mode;
      entry.status = '运行中';
      entry.startedAt = entry.startedAt || performance.now();
      this._scheduleAgentsRender();
    } else if (event?.type === 'agent-end') {
      this._pushRuntimeLine(`代理 · ${event.agent || 'agent'} · ${event.success ? '完成' : '失败'}${duration}`);
      const entry = this._getAgent(event.agent);
      entry.status = event?.success ? '完成' : '失败';
      entry.durationMs = event?.durationMs ?? entry.durationMs;
      entry.steps = event?.detail?.steps ?? entry.steps;
      this._scheduleAgentsRender();
    }
  }

  _onContextReady(event) {
    this._updateCache(event?.cache);
    const duration = Number.isFinite(event?.durationMs) ? ` · ${event.durationMs}ms` : '';
    this._pushRuntimeLine(`检索 · 完成${duration}${this._formatSources(event?.sources)}`);
  }

  _onSubagent(event, started) {
    const name = event?.npc || event?.subagent || 'subagent';
    const suffix = started ? '运行中' : (event?.success ? '完成' : (event?.fallback ? '降级' : '失败'));
    this._pushRuntimeLine(`子代理 · ${name} · ${suffix}`);
  }

  _onCharacterFallback(event) {
    this._pushRuntimeLine(`角色素材暂缺 · ${event?.npc || 'unknown'} · 由作家结合场景续写`);
  }

  _onAudit(event) {
    this._pushRuntimeLine(`正文检查 · ${event?.valid ? '可继续' : '交付异常'} · ${event?.warnings?.length || 0} 条参考意见`);
  }

  // 提示词 KV 缓存命中率：DeepSeek 返回 prompt_cache_hit/miss_tokens 或
  // prompt_tokens_details.cached_tokens；原生 SDK 映射为 cache_read/miss_input_tokens。
  // 每次 AI 调用完成即刷新，回合结束(done)再更新为回合总命中。
  _onUsage(usage) {
    const { hit, miss, cacheKnown } = readTokenUsage(usage || {});
    if (!cacheKnown || !(hit + miss)) return;
    this._usageAccum.hit += hit;
    this._usageAccum.miss += miss;
    this._renderPromptCache('本回合累计');
  }

  _renderPromptCache(label) {
    const total = this._usageAccum.hit + this._usageAccum.miss;
    if (!total) return;
    const rate = Math.round(this._usageAccum.hit / total * 100);
    if (this._promptCacheEl) {
      this._promptCacheEl.textContent = `${label} · 提示词缓存 ${this._usageAccum.hit}/${total} · ${rate}%`;
      this._promptCacheEl.style.display = '';
    }
  }

  _getAgent(id) {
    const key = String(id || 'unknown');
    let entry = this._agents.get(key);
    if (!entry) {
      entry = {
        id: key,
        label: this._agentLabel(key),
        status: '',
        mode: '',
        reasoning: '',
        output: '',
        tools: [],
        startedAt: performance.now(),
        durationMs: null,
        steps: 0,
        fallbackReason: ''
      };
      this._agents.set(key, entry);
    }
    return entry;
  }

  _agentLabel(id) {
    if (id.startsWith('character:')) return `角色代理 · ${id.slice(10)}`;
    const map = {
      'writer-outline': '主模型 · 详细写作大纲',
      'final-writer': '主模型 · 最终正文',
      'writer': '主模型 · 旧版写作',
      'writer-polish': '主模型 · 润色',
      'story-planner': '三日策划',
      'brainstormer': '意识风暴',
      'outliner': '场景节拍',
      'critic-realism': '审查 · 现实性',
      'critic-character': '审查 · 角色契约',
      'critic-contract': '审查 · 开局契约',
      'critic-detail': '审查 · 细节',
      'critic-style': '审查 · 风格',
      'critic-writing-outline': '审查 · 详细写作大纲',
      'critic-writing-outline-final': '建议 · 详细写作大纲',
      'critic-outline-search': '建议 · 历史检索'
    };
    return map[id] || id;
  }

  _scheduleAgentsRender() {
    if (this._agentsRenderScheduled || !this._detailOpen) return;
    this._agentsRenderScheduled = true;
    const now = performance.now();
    const sinceLast = now - (this._lastAgentsRenderAt || 0);
    const delay = Math.max(0, 500 - sinceLast);
    const flush = () => {
      this._agentsRenderScheduled = false;
      this._lastAgentsRenderAt = performance.now();
      this._renderAgents();
    };
    // 流式时最多每 500ms 重建一次代理列表，避免频繁重渲染打断查看已展开的子代理。
    if (delay > 0) {
      setTimeout(flush, delay);
    } else if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(flush);
    } else {
      flush();
    }
  }

  _renderAgents() {
    const listEl = this._detailListEl;
    if (!listEl) return;
    if (!this._agents.size) {
      listEl.innerHTML = '<div class="ad-empty">暂无子模型调用</div>';
      return;
    }
    const sorted = [...this._agents.values()].sort((a, b) => a.startedAt - b.startedAt);
    listEl.innerHTML = sorted.map(entry => {
      const open = this._openAgentIds.has(entry.id) ? ' open' : '';
      const duration = Number.isFinite(entry.durationMs) ? ` · ${Math.round(entry.durationMs)}ms` : '';
      const steps = entry.steps > 0 ? ` · ${entry.steps}步` : '';
      const mode = entry.mode ? ` · ${entry.mode === 'native-tools' ? '原生工具' : '文本协议'}` : '';
      const statusCls = entry.status === '完成' ? 'ad-ok' : (entry.status === '失败' || entry.status === '降级' ? 'ad-bad' : 'ad-run');
      const status = entry.status || (entry.reasoning || entry.output ? '运行中' : '');
      const fallback = entry.fallbackReason ? `<div class="ad-section"><div class="ad-section-title ad-warn">降级原因</div><pre>${this._esc(entry.fallbackReason)}</pre></div>` : '';
      const reasoning = entry.reasoning
        ? `<div class="ad-section"><div class="ad-section-title">思维链</div><pre>${this._esc(entry.reasoning)}</pre></div>` : '';
      const output = entry.output
        ? `<div class="ad-section"><div class="ad-section-title">输出</div><pre>${this._esc(entry.output)}</pre></div>` : '';
      const tools = entry.tools.length
        ? `<div class="ad-section"><div class="ad-section-title">工具步骤</div><pre>${this._esc(entry.tools.join('\n'))}</pre></div>` : '';
      return `
        <details class="agent-detail"${open} data-agent-id="${this._escAttr(entry.id)}">
          <summary>
            <span class="ad-status ${statusCls}"></span>
            <span class="ad-name">${this._esc(entry.label)}</span>
            <span class="ad-meta">${this._esc(status)}${this._esc(mode)}${this._esc(duration)}${this._esc(steps)}</span>
          </summary>
          <div class="ad-body">
            ${reasoning}
            ${output}
            ${tools}
            ${fallback}
          </div>
        </details>`;
    }).join('');
    listEl.querySelectorAll('.agent-detail').forEach(details => {
      details.addEventListener('toggle', () => {
        const id = details.dataset.agentId;
        if (details.open) this._openAgentIds.add(id);
        else this._openAgentIds.delete(id);
      });
    });
  }

  _esc(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  _escAttr(value) { return this._esc(value); }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: relative;
          margin: 32px 16px;
          padding: 32px 40px;
          background: radial-gradient(circle at center, #0f1115 0%, #050608 100%);
          border-radius: 16px;
          border: 1px solid rgba(198,156,109,0.2);
          box-shadow: 0 20px 60px rgba(0,0,0,0.9), inset 0 0 80px rgba(0,0,0,0.8), 0 0 20px rgba(198,156,109,0.05);
          overflow: hidden;
          font-family: var(--font-body, sans-serif);
        }
        
        /* 卷轴边缘装饰 */
        :host::before, :host::after {
          content: '';
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          width: 90%;
          height: 2px;
          background: linear-gradient(90deg, transparent, rgba(198,156,109,0.8), transparent);
          box-shadow: 0 0 10px rgba(198,156,109,0.4);
        }
        :host::before { top: 0; }
        :host::after { bottom: 0; }

        /* 核心：八卦封印阵复合结构 */
        .bg-seal-container {
          position: absolute;
          top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          width: 400px; height: 400px;
          pointer-events: none;
          z-index: 0;
          opacity: 0.15; /* 整体透明度，防止喧宾夺主 */
          display: flex;
          justify-content: center;
          align-items: center;
        }

        /* 绝对居中的八卦核心漩涡 */
        .seal-core {
          position: absolute;
          width: 40px; height: 40px;
          background: radial-gradient(circle, var(--c-shuiro, #eb613f) 0%, transparent 70%);
          border-radius: 50%;
          box-shadow: 0 0 30px var(--c-shuiro);
          animation: core-pulse 2s ease-in-out infinite alternate;
        }

        /* 第一层：内圈符文阵列（逆时针快转） */
        .seal-ring-inner {
          position: absolute;
          width: 120px; height: 120px;
          border: 1px solid var(--c-kin, #c69c6d);
          border-radius: 50%;
          animation: spin-reverse 15s linear infinite;
        }
        .seal-ring-inner::before {
          content: '临 兵 斗 者 皆 阵 列 前 行';
          position: absolute;
          top: -8px; left: -8px; right: -8px; bottom: -8px;
          border-radius: 50%;
          font-family: 'Noto Serif SC', serif;
          font-size: 10px;
          color: var(--c-shuiro, #eb613f);
          letter-spacing: 6px;
          text-align: center;
          line-height: 136px;
          transform-origin: center;
          text-shadow: 0 0 5px var(--c-shuiro);
        }

        /* 第二层：八卦交叉结印线（静止/微闪） */
        .seal-lines {
          position: absolute;
          width: 220px; height: 220px;
          border-radius: 50%;
        }
        .seal-lines::before, .seal-lines::after {
          content: '';
          position: absolute;
          top: 0; left: 50%;
          width: 1px; height: 100%;
          background: rgba(198,156,109, 0.4);
        }
        .seal-lines::after {
          transform: rotate(90deg);
        }
        .seal-lines-diag {
          position: absolute;
          width: 220px; height: 220px;
          transform: rotate(45deg);
        }
        .seal-lines-diag::before, .seal-lines-diag::after {
          content: '';
          position: absolute;
          top: 0; left: 50%;
          width: 1px; height: 100%;
          background: rgba(198,156,109, 0.4);
        }
        .seal-lines-diag::after {
          transform: rotate(90deg);
        }

        /* 第三层：外圈古老符咒（顺时针慢转） */
        .seal-ring-outer {
          position: absolute;
          width: 320px; height: 320px;
          border: 2px solid rgba(198,156,109, 0.3);
          border-radius: 50%;
          box-shadow: 0 0 20px rgba(198,156,109, 0.1), inset 0 0 20px rgba(198,156,109, 0.1);
          animation: spin 40s linear infinite;
        }
        /* 利用重复锥形渐变模拟外围密集的符文刻度 */
        .seal-ring-outer::after {
          content: '';
          position: absolute;
          top: -10px; left: -10px; right: -10px; bottom: -10px;
          border-radius: 50%;
          background: repeating-conic-gradient(
            from 0deg,
            transparent 0deg,
            transparent 2deg,
            rgba(198,156,109, 0.5) 2deg,
            rgba(198,156,109, 0.5) 3deg
          );
          -webkit-mask-image: radial-gradient(transparent 68%, black 70%);
          mask-image: radial-gradient(transparent 68%, black 70%);
        }

        @keyframes spin { 100% { transform: rotate(360deg); } }
        @keyframes spin-reverse { 100% { transform: rotate(-360deg); } }
        @keyframes core-pulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.2); opacity: 1; } }

        .header {
          position: relative;
          z-index: 2;
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 40px;
          padding: 0 10px;
        }
        .title {
          font-size: 16px;
          color: var(--c-kin, #c69c6d);
          letter-spacing: 6px;
          font-weight: 800;
          font-family: var(--font-title, serif);
          text-shadow: 0 0 15px rgba(198,156,109,0.6);
        }
        .status {
          font-size: 12px;
          color: #a39f98;
          display: flex;
          align-items: center;
          gap: 10px;
          letter-spacing: 1px;
          background: rgba(0,0,0,0.4);
          padding: 6px 16px;
          border-radius: 20px;
          border: 1px solid rgba(198,156,109,0.1);
        }
        .status-glow {
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--c-shuiro, #eb613f);
          box-shadow: 0 0 12px var(--c-shuiro);
          animation: breath 1.5s ease-in-out infinite;
        }

        /* 经络/查克拉运行轨迹 */
        .meridian-track {
          position: relative;
          z-index: 2;
          display: flex;
          justify-content: space-between;
          align-items: center;
          height: 56px;
          margin: 0 8px 26px 8px;
        }
        .meridian-line-bg {
          position: absolute;
          top: 50%; left: 0; right: 0;
          height: 1px;
          background: rgba(198,156,109,0.2);
          transform: translateY(-50%);
          z-index: 1;
        }
        .meridian-line-fill {
          position: absolute;
          top: 50%; left: 0;
          height: 3px;
          background: var(--c-kin, #c69c6d);
          box-shadow: 0 0 15px var(--c-kin);
          transform: translateY(-50%);
          z-index: 1;
          transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
          width: 0%;
        }

        /* 节点样式 */
        .node {
          position: relative;
          z-index: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: 44px;
        }
        .node .circle {
          width: 10px; height: 10px;
          background: rgba(198,156,109,0.4);
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .node .kanji {
          opacity: 0; font-size: 16px; font-weight: bold;
          font-family: var(--font-title, serif);
          transition: opacity 0.3s;
        }
        .node .label {
          position: absolute; top: 40px;
          font-size: 10px; color: #a39f98; white-space: nowrap;
          opacity: 0; transform: translateY(-5px);
          transition: all 0.3s;
          letter-spacing: 1px;
        }

        /* 激活状态：结印亮起 */
        .node.active .circle {
          width: 40px; height: 40px;
          background: rgba(235,97,63,0.15);
          border: 1px solid var(--c-shuiro, #eb613f);
          box-shadow: 0 0 25px rgba(235,97,63,0.6), inset 0 0 15px rgba(235,97,63,0.4);
          color: var(--c-shuiro);
        }
        .node.active .kanji { opacity: 1; text-shadow: 0 0 10px var(--c-shuiro); }
        .node.active .label { opacity: 1; transform: translateY(0); color: var(--c-shuiro); text-shadow: 0 0 5px rgba(235,97,63,0.5); }

        /* 完成状态：经络打通 */
        .node.completed .circle {
          width: 14px; height: 14px;
          background: var(--c-kin, #c69c6d);
          box-shadow: 0 0 15px var(--c-kin);
          border: none;
        }

        /* 虚空文字流 (Stream Portal) */
        .stream-portal {
          position: relative;
          z-index: 2;
          margin: 10px 20px 0 20px;
          height: 180px;
          background: radial-gradient(ellipse at top, rgba(198,156,109,0.08), transparent 80%);
          border-top: 1px solid rgba(198,156,109,0.2);
          border-radius: 8px;
          padding: 24px 20px 10px 20px;
        }
        .stream-content {
          height: 100%;
          overflow-y: auto;
          font-family: var(--font-title, 'Noto Serif SC', serif);
          font-size: 14px;
          line-height: 2.2;
          color: rgba(232,228,217,0.85);
          text-align: justify;
          text-shadow: 0 0 3px rgba(255,255,255,0.15);
          padding-right: 20px;
          mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
          -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
          scrollbar-width: none;
        }
        .stream-content::-webkit-scrollbar { display: none; }

        .runtime-meta {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin: 0 20px 10px;
          min-height: 46px;
          color: rgba(232,228,217,0.62);
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 10px;
          line-height: 1.5;
        }
        .runtime-trace {
          min-width: 0;
          flex: 1;
          white-space: pre-line;
          overflow-wrap: anywhere;
        }
        .cache-status {
          flex: none;
          color: var(--c-kin, #c69c6d);
          white-space: nowrap;
        }

        .detail-toggle {
          position: relative;
          z-index: 2;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin: 8px 20px 0;
          padding: 6px 12px;
          border: 1px solid rgba(198,156,109,0.35);
          border-radius: 999px;
          background: rgba(198,156,109,0.08);
          color: var(--c-kin, #c69c6d);
          font-family: inherit;
          font-size: 11px;
          letter-spacing: 1px;
          cursor: pointer;
          transition: background 0.2s, border-color 0.2s;
        }
        .detail-toggle:hover { background: rgba(198,156,109,0.18); border-color: rgba(198,156,109,0.6); }
        .detail-toggle .dt-arrow { transition: transform 0.2s; }
        .detail-panel {
          position: relative;
          z-index: 2;
          margin: 6px 20px 16px;
          border: 1px solid rgba(198,156,109,0.18);
          border-radius: 10px;
          background: rgba(0,0,0,0.28);
          padding: 10px;
          max-height: 320px;
          overflow-y: auto;
        }
        .detail-panel.collapsed { display: none; }
        .ad-empty { color: rgba(232,228,217,0.45); font-size: 11px; padding: 6px 4px; letter-spacing: 1px; }
        .agent-detail {
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          background: rgba(255,255,255,0.025);
          margin-bottom: 8px;
          overflow: hidden;
        }
        .agent-detail[open] { background: rgba(255,255,255,0.05); }
        .agent-detail > summary {
          list-style: none;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 10px;
          cursor: pointer;
          color: rgba(232,228,217,0.85);
          font-size: 12px;
          user-select: none;
        }
        .agent-detail > summary::-webkit-details-marker { display: none; }
        .agent-detail > summary::before { content: '▸'; color: var(--c-kin, #c69c6d); font-size: 10px; transition: transform 0.15s; }
        .agent-detail[open] > summary::before { transform: rotate(90deg); }
        .ad-status {
          width: 8px; height: 8px; border-radius: 50%; flex: none;
          background: rgba(198,156,109,0.4);
        }
        .ad-status.ad-ok { background: #6bc775; box-shadow: 0 0 8px #6bc775; }
        .ad-status.ad-bad { background: #eb613f; box-shadow: 0 0 8px #eb613f; }
        .ad-status.ad-run { background: #c69c6d; box-shadow: 0 0 8px rgba(198,156,109,0.8); animation: breath 1.4s ease-in-out infinite; }
        .ad-name { font-weight: 700; letter-spacing: 1px; color: rgba(232,228,217,0.9); }
        .ad-meta { margin-left: auto; font-size: 10px; color: rgba(232,228,217,0.5); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
        .ad-body { padding: 2px 10px 10px; }
        .ad-section { margin-top: 8px; }
        .ad-section-title { font-size: 10px; color: var(--c-kin, #c69c6d); letter-spacing: 1px; margin-bottom: 4px; }
        .ad-section-title.ad-warn { color: #e8a44a; }
        .agent-detail pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
          color: rgba(232,228,217,0.75);
          background: rgba(0,0,0,0.3);
          border-radius: 6px;
          padding: 8px;
          max-height: 220px;
          overflow-y: auto;
          user-select: text;
        }

        @media (max-width: 720px) {
          :host { margin: 20px 8px; padding: 24px 14px; }
          .header { margin-bottom: 28px; }
          .title { font-size: 13px; letter-spacing: 3px; }
          .status { max-width: 58%; padding: 5px 8px; }
          .node { width: 28px; }
          .node .label { display: none; }
          .runtime-meta { margin: 0 6px 8px; flex-wrap: wrap; }
          .stream-portal { margin: 8px 6px 0; height: 150px; padding: 18px 12px 8px; }
        }

        @keyframes slow-spin { 100% { transform: translate(-50%, -50%) rotate(360deg); } }
        @keyframes slow-spin-reverse { 100% { transform: translate(-50%, -50%) rotate(-360deg); } }
        @keyframes breath { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }
      </style>
      
      <div class="bg-seal-container">
        <div class="seal-core"></div>
        <div class="seal-ring-inner"></div>
        <div class="seal-lines"></div>
        <div class="seal-lines-diag"></div>
        <div class="seal-ring-outer"></div>
      </div>
      
      <div class="header">
        <span class="title">秘术 · 天机推演</span>
        <div class="status">
          <div class="status-glow" id="status-glow"></div>
          <span id="status-text">提取查克拉...</span>
        </div>
      </div>

      <div class="meridian-track">
        <div class="meridian-line-bg"></div>
        <div class="meridian-line-fill" id="meridian-fill"></div>
        <div style="display:flex; justify-content:space-between; width:100%; position:absolute; z-index:2;" id="stages">
        </div>
      </div>

      <div class="runtime-meta">
        <div class="runtime-trace" id="runtime-trace"></div>
        <div class="cache-status" id="prompt-cache-status" style="display:none;"></div>
        <div class="cache-status" id="cache-status">缓存 0/0 · 0%</div>
      </div>

      <div class="stream-portal">
        <div class="stream-content" id="stream"></div>
      </div>

      <button type="button" class="detail-toggle" id="detail-toggle" aria-expanded="true">
        <span class="dt-arrow">▾</span> 子模型推演 · 点击子项查看思考与输出
      </button>
      <div class="detail-panel" id="detail-panel">
        <div id="detail-list"><div class="ad-empty">暂无子模型调用</div></div>
      </div>
    `;

    this._stagesEl = this.shadowRoot.getElementById('stages');
    this._streamEl = this.shadowRoot.getElementById('stream');
    this._fillEl = this.shadowRoot.getElementById('meridian-fill');
    this._statusTextEl = this.shadowRoot.getElementById('status-text');
    this._statusGlowEl = this.shadowRoot.getElementById('status-glow');
    this._runtimeTraceEl = this.shadowRoot.getElementById('runtime-trace');
    this._cacheEl = this.shadowRoot.getElementById('cache-status');
    this._promptCacheEl = this.shadowRoot.getElementById('prompt-cache-status');
    this._detailToggleEl = this.shadowRoot.getElementById('detail-toggle');
    this._detailListEl = this.shadowRoot.getElementById('detail-list');
    this._detailPanelEl = this.shadowRoot.getElementById('detail-panel');
    this._detailToggleEl.addEventListener('click', () => {
      this._detailOpen = !this._detailOpen;
      this._detailPanelEl.classList.toggle('collapsed', !this._detailOpen);
      this._detailToggleEl.querySelector('.dt-arrow').textContent = this._detailOpen ? '▾' : '▸';
      this._detailToggleEl.setAttribute('aria-expanded', String(this._detailOpen));
      if (this._detailOpen) this._renderAgents();
    });
    this._renderAgents();
    this._update();
  }

  _update() {
    if (!this._stagesEl) return;

    let stageIdx = STAGES.findIndex(s => s.key === this._currentStage);
    if (stageIdx === -1 && this._currentStage === 'done') stageIdx = STAGES.length - 1;

    // Calculate fill percentage
    const progressPct = Math.max(0, (stageIdx / (STAGES.length - 1)) * 100);
    this._fillEl.style.width = `${progressPct}%`;

    this._stagesEl.innerHTML = STAGES.map((s, i) => {
      let cls = 'node';
      if (this._completedStages.has(s.key)) cls += ' completed';
      else if (s.key === this._currentStage) cls += ' active';
      
      return `
        <div class="${cls}">
          <div class="circle"><span class="kanji">${s.kanji}</span></div>
          <div class="label">${s.label}</div>
        </div>
      `;
    }).join('');

    if (this._currentStage === 'fallback') {
      this._statusTextEl.textContent = `术式反噬：${this._detail}`;
      this._statusTextEl.style.color = '#e8a44a';
      this._statusGlowEl.style.background = '#e8a44a';
    } else if (this._currentStage === 'done') {
      this._statusTextEl.textContent = '阵法编织完成';
      this._statusTextEl.style.color = 'var(--c-moegi, #6bc775)';
      this._statusGlowEl.style.background = 'var(--c-moegi, #6bc775)';
      this._statusGlowEl.style.animation = 'none';
    } else {
      this._statusTextEl.textContent = this._detail || '正在推演命运走向...';
    }
  }
}

customElements.define('agent-progress', AgentProgress);
export default AgentProgress;
