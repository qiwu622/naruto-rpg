// 帮助文档和新手引导
class HelpGuide {
  constructor() {
    this._modalEscHandler = null;
    this._injectStyles();
    this._setupHelpButton();
  }

  _setupHelpButton() {
    // 等待 DOM 准备好后添加帮助按钮
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._addHelpButton());
    } else {
      this._addHelpButton();
    }
  }

  _addHelpButton() {
    if (document.getElementById('help-guide-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'help-guide-btn';
    btn.className = 'help-guide-btn';
    btn.setAttribute('aria-label', '帮助');
    btn.title = '帮助';
    btn.innerHTML = '?';
    btn.addEventListener('click', () => this.showHelp());

    document.body.appendChild(btn);

    // 首次访问自动显示
    const hasSeenWelcome = localStorage.getItem('naruto_seen_welcome');
    if (!hasSeenWelcome) {
      setTimeout(() => {
        this.showWelcome();
        localStorage.setItem('naruto_seen_welcome', 'true');
      }, 1500);
    }
  }

  showWelcome() {
    this._showModal({
      title: '欢迎来到忍者手记',
      content: `
        <p style="font-size:15px;line-height:1.7;color:#e8e4d9;margin-bottom:16px;">
          这是一个基于火影忍者世界观的 <strong>AI 文字跑团游戏</strong>。
          你将扮演一名忍者，在 AI 的引导下探索丰富的剧情。
        </p>
        <div class="help-section">
          <h3>🎯 开始之前</h3>
          <ol style="line-height:1.8;color:#c7c2b8;padding-left:20px;">
            <li>点击 <strong>设置图标</strong> 配置 AI API（支持 OpenAI/Claude/DeepSeek 等）</li>
            <li>填写 API URL、密钥和模型名</li>
            <li>返回主页面，点击 <strong>开始新游戏</strong> 创建角色</li>
            <li>输入行动开始你的忍者冒险</li>
          </ol>
        </div>
        <div class="help-section">
          <h3>💡 基础操作</h3>
          <ul style="line-height:1.8;color:#c7c2b8;padding-left:20px;">
            <li>输入框输入想做的行动，AI 会根据世界观回应</li>
            <li>点击 AI 提供的 <strong>「行动选项」</strong> 可快速选择</li>
            <li>状态栏显示当前查克拉、体力等数值</li>
            <li>所有数据自动保存到本地</li>
          </ul>
        </div>
        <div class="help-section">
          <h3>⚠️ 隐私提示</h3>
          <p style="color:#c7c2b8;line-height:1.6;">
            API 密钥仅持久化在你的浏览器本地；发起 AI 请求时会经本站无状态代理在内存中透传，但不会写入服务器数据库或日志。
            建议定期通过 <strong>导出存档</strong> 备份你的游戏数据。
          </p>
        </div>
      `,
      footer: `<button class="help-modal-btn-primary" id="help-welcome-ok">开始游戏</button>`
    });

    // 等待按钮渲染后绑定事件
    setTimeout(() => {
      const okBtn = document.getElementById('help-welcome-ok');
      if (okBtn) {
        okBtn.addEventListener('click', () => this._closeModal());
      }
    }, 50);
  }

  showHelp() {
    this._showModal({
      title: '帮助文档',
      content: `
        <div class="help-tabs">
          <button class="help-tab active" data-tab="basics">基础操作</button>
          <button class="help-tab" data-tab="systems">游戏系统</button>
          <button class="help-tab" data-tab="advanced">高级技巧</button>
          <button class="help-tab" data-tab="faq">常见问题</button>
        </div>
        <div class="help-tab-content" data-content="basics">
          <h3>🎮 基础操作</h3>
          <ul>
            <li><strong>输入行动</strong>：在底部输入框描述你想做什么</li>
            <li><strong>快捷选项</strong>：点击 AI 提供的「」选项快速选择</li>
            <li><strong>查看状态</strong>：点击顶部头像查看属性面板</li>
            <li><strong>地图查看</strong>：菜单中可打开地图查看已探索区域</li>
            <li><strong>时间线</strong>：可回溯历史节点，创建 IF 线分支</li>
          </ul>
        </div>
        <div class="help-tab-content" data-content="systems" style="display:none;">
          <h3>⚔️ 战斗系统</h3>
          <p>战斗采用回合制。每回合你可以选择攻击、防御、使用物品或撤退。</p>
          <ul>
            <li><strong>查克拉</strong>：施放忍术消耗</li>
            <li><strong>生命力</strong>：生命值，归零即死亡</li>
            <li><strong>体力</strong>：施展体术消耗</li>
            <li><strong>精神力</strong>：施展幻术消耗</li>
            <li><strong>速度</strong>：影响先攻和闪避</li>
          </ul>

          <h3>🤝 人际关系</h3>
          <p>NPC 有 <strong>好感度、信任、敬畏</strong>三个维度，影响他们对你的态度。</p>

          <h3>📋 任务系统</h3>
          <p>D级到S级任务，按忍阶解锁。完成获得经验和金钱奖励。</p>
        </div>
        <div class="help-tab-content" data-content="advanced" style="display:none;">
          <h3>🎯 Agent 高质量模式</h3>
          <p>在设置中开启后，AI 会经过多次推理生成更优质内容：</p>
          <ul>
            <li><strong>标准模式</strong>：场景节拍→详细写作大纲→终审→正文定稿→变量结算</li>
            <li><strong>完整模式</strong>：头脑风暴→多重审查→细节打磨（+7~10次调用）</li>
          </ul>

          <h3>📂 时间线分支</h3>
          <p>对剧情不满意？可以回溯到历史节点重新选择，形成 IF 平行世界线。</p>

          <h3>💾 存档管理</h3>
          <p>设置中可以导出/导入存档 JSON 文件，跨设备同步。</p>
        </div>
        <div class="help-tab-content" data-content="faq" style="display:none;">
          <h3>❓ 常见问题</h3>

          <div class="faq-item">
            <strong>Q: API 调用失败怎么办？</strong>
            <p>检查 API URL 是否正确（需包含 /v1），密钥是否有效，模型名是否准确。</p>
          </div>

          <div class="faq-item">
            <strong>Q: 游戏卡住没响应？</strong>
            <p>查看右上角错误提示。AI 响应较慢时请耐心等待（10-60秒）。如长时间无响应，刷新页面重试。</p>
          </div>

          <div class="faq-item">
            <strong>Q: 数据会丢失吗？</strong>
            <p>所有数据存于浏览器 IndexedDB。清理浏览器数据会丢失存档。建议定期导出 JSON 备份。</p>
          </div>

          <div class="faq-item">
            <strong>Q: 可以离线玩吗？</strong>
            <p>UI 可离线加载，但 AI 调用需要联网。可下载本地大模型搭配 LM Studio 等工具实现完全离线。</p>
          </div>

          <div class="faq-item">
            <strong>Q: 角色死亡了？</strong>
            <p>生命力归零角色死亡。可通过时间线回溯到死亡前节点，重新选择行动避免悲剧。</p>
          </div>
        </div>
      `,
      footer: `<button class="help-modal-btn-primary" id="help-close-btn">关闭</button>`
    });

    setTimeout(() => {
      // 绑定 tab 切换
      const tabs = document.querySelectorAll('.help-tab');
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          tabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const tabName = tab.dataset.tab;
          document.querySelectorAll('.help-tab-content').forEach(c => {
            c.style.display = c.dataset.content === tabName ? 'block' : 'none';
          });
        });
      });

      const closeBtn = document.getElementById('help-close-btn');
      if (closeBtn) closeBtn.addEventListener('click', () => this._closeModal());
    }, 50);
  }

  _showModal({ title, content, footer }) {
    this._closeModal();

    const modal = document.createElement('div');
    modal.id = 'help-modal';
    modal.className = 'help-modal';
    modal.innerHTML = `
      <div class="help-modal-overlay"></div>
      <div class="help-modal-dialog">
        <div class="help-modal-header">
          <h2>${title}</h2>
          <button class="help-modal-close" aria-label="关闭">×</button>
        </div>
        <div class="help-modal-body">${content}</div>
        ${footer ? `<div class="help-modal-footer">${footer}</div>` : ''}
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.help-modal-close').addEventListener('click', () => this._closeModal());
    modal.querySelector('.help-modal-overlay').addEventListener('click', () => this._closeModal());

    // ESC 关闭
    this._modalEscHandler = (e) => {
      if (e.key === 'Escape') {
        this._closeModal();
      }
    };
    document.addEventListener('keydown', this._modalEscHandler);
  }

  _closeModal() {
    if (this._modalEscHandler) {
      document.removeEventListener('keydown', this._modalEscHandler);
      this._modalEscHandler = null;
    }
    const modal = document.getElementById('help-modal');
    if (modal) modal.remove();
  }

  _injectStyles() {
    if (document.getElementById('help-guide-styles')) return;

    const style = document.createElement('style');
    style.id = 'help-guide-styles';
    style.textContent = `
      .help-guide-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: var(--ui-btn-tonal-bg, #2e2426);
        color: var(--ui-btn-tonal-ink, #f0ece2);
        border: 1px solid var(--ui-btn-tonal-border, #7c3f34);
        font-size: 18px;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        z-index: 9998;
        transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.12s ease;
        font-family: -apple-system, "Segoe UI", sans-serif;
      }
      .help-guide-btn:hover {
        background: var(--ui-btn-tonal-bg-hover, #3d2c2e);
        border-color: var(--ui-btn-tonal-border-hover, #a85442);
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.12);
      }
      .help-guide-btn:active {
        transform: translateY(1px);
      }
      body.settings-panel-open .help-guide-btn {
        display: none;
      }

      .help-modal {
        position: fixed;
        inset: 0;
        z-index: 10002;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.2s ease;
      }
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .help-modal-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
      }
      .help-modal-dialog {
        position: relative;
        background: rgba(15, 13, 12, 0.98);
        border: 1px solid rgba(235, 97, 63, 0.3);
        border-radius: 12px;
        max-width: 640px;
        width: calc(100% - 40px);
        max-height: calc(100vh - 40px);
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        font-family: -apple-system, "Segoe UI", sans-serif;
      }
      .help-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 20px 24px;
        border-bottom: 1px solid rgba(235, 97, 63, 0.2);
      }
      .help-modal-header h2 {
        margin: 0;
        color: #e8e4d9;
        font-size: 20px;
        font-weight: 600;
      }
      .help-modal-close {
        background: none;
        border: none;
        color: #e8e4d9;
        font-size: 28px;
        cursor: pointer;
        padding: 0;
        width: 32px;
        height: 32px;
        line-height: 24px;
        opacity: 0.7;
        transition: opacity 0.2s;
      }
      .help-modal-close:hover {
        opacity: 1;
      }
      .help-modal-body {
        padding: 20px 24px;
        overflow-y: auto;
        color: #c7c2b8;
      }
      .help-modal-body h3 {
        color: #eb613f;
        font-size: 15px;
        margin: 20px 0 12px 0;
      }
      .help-modal-body h3:first-child {
        margin-top: 0;
      }
      .help-modal-body ul,
      .help-modal-body ol {
        margin: 0 0 16px 0;
        padding-left: 20px;
      }
      .help-modal-body li {
        margin-bottom: 6px;
        line-height: 1.6;
      }
      .help-modal-body strong {
        color: #e8e4d9;
      }
      .help-section {
        margin-bottom: 24px;
      }
      .help-modal-footer {
        padding: 16px 24px;
        border-top: 1px solid rgba(235, 97, 63, 0.2);
        display: flex;
        justify-content: flex-end;
        gap: 12px;
      }
      .help-modal-btn-primary {
        background: var(--ui-btn-primary-bg, #6c3326);
        color: var(--ui-btn-primary-ink, #f6f1e7);
        border: 1px solid var(--ui-btn-primary-border, #9e5341);
        padding: 8px 24px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        letter-spacing: 0.02em;
        cursor: pointer;
        box-shadow: var(--ui-btn-primary-shadow, 0 1px 2px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.11));
        transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.12s ease;
      }
      .help-modal-btn-primary:hover:not(:disabled) {
        background: var(--ui-btn-primary-bg-hover, #7f3b2c);
        border-color: var(--ui-btn-primary-border-hover, #b8624d);
        box-shadow: var(--ui-btn-primary-shadow-hover, 0 2px 6px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.15));
      }
      .help-modal-btn-primary:active:not(:disabled) {
        background: var(--ui-btn-primary-bg-active, #5a2a1f);
        box-shadow: var(--ui-btn-primary-shadow-active, inset 0 1px 2px rgba(0, 0, 0, 0.38));
        transform: translateY(1px);
      }
      .help-tabs {
        display: flex;
        gap: 4px;
        margin-bottom: 20px;
        border-bottom: 1px solid rgba(235, 97, 63, 0.2);
        padding-bottom: 0;
        flex-wrap: wrap;
      }
      .help-tab {
        background: none;
        border: none;
        color: #a39f98;
        padding: 8px 16px;
        cursor: pointer;
        font-size: 13px;
        border-bottom: 2px solid transparent;
        transition: all 0.2s;
        font-family: inherit;
      }
      .help-tab:hover {
        color: #e8e4d9;
      }
      .help-tab.active {
        color: #eb613f;
        border-bottom-color: #eb613f;
      }
      .faq-item {
        margin-bottom: 16px;
        padding-bottom: 16px;
        border-bottom: 1px solid rgba(235, 97, 63, 0.1);
      }
      .faq-item:last-child {
        border-bottom: none;
      }
      .faq-item strong {
        display: block;
        margin-bottom: 6px;
        color: #e8e4d9;
      }
      .faq-item p {
        margin: 0;
        color: #c7c2b8;
        line-height: 1.6;
        font-size: 13px;
      }
      @media (max-width: 600px) {
        .help-guide-btn {
          bottom: 16px;
          right: 16px;
          width: 40px;
          height: 40px;
          font-size: 18px;
        }
        .help-modal-dialog {
          max-height: calc(100vh - 20px);
        }
        .help-tab {
          font-size: 12px;
          padding: 6px 10px;
        }
      }
    `;
    document.head.appendChild(style);
  }
}

export const helpGuide = new HelpGuide();
export default helpGuide;
