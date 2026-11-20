export const settingsStyles = `
        :host {
          position: fixed; inset: 0; z-index: 100000;
          color: var(--ui-ink, #f0ece2);
          font-family: var(--font-body, 'Noto Sans SC', 'Microsoft YaHei UI', 'PingFang SC', system-ui, sans-serif);
          color-scheme: var(--ui-color-scheme, dark);
        }
        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }
        button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible {
          outline: 2px solid color-mix(in srgb, var(--ui-accent, #eb613f) 75%, transparent);
          outline-offset: 2px;
        }

        .backdrop {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: flex-end; padding: 16px;
          background:
            radial-gradient(circle at 82% 14%, color-mix(in srgb, var(--ui-gold, #c69c6d) 10%, transparent), transparent 34%),
            var(--ui-backdrop, rgba(3, 5, 8, 0.80));
          backdrop-filter: blur(18px) saturate(135%);
          -webkit-backdrop-filter: blur(18px) saturate(135%);
          animation: sp-fade-in 0.24s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes sp-fade-in { from { opacity: 0; } to { opacity: 1; } }

        /* ── 墨印卷册容器 ──── */
        .panel {
          width: min(820px, calc(100vw - 32px));
          height: calc(100vh - 32px); height: calc(100dvh - 32px);
          display: flex; flex-direction: column;
          position: relative; overflow: hidden;
          border-radius: 16px;
          background:
            linear-gradient(150deg, color-mix(in srgb, var(--ui-gold, #c69c6d) 4%, transparent), transparent 36%),
            var(--ui-canvas, #0b0e13);
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.16));
          box-shadow: var(--ui-shadow, 0 24px 64px rgba(0, 0, 0, 0.50)), inset 0 1px 0 var(--ui-border, rgba(244, 241, 234, 0.08));
        }
        .panel::before {
          content: ''; position: absolute; inset: 0 auto 0 0; width: 2px; z-index: 4; pointer-events: none;
          background: linear-gradient(180deg, transparent, var(--ui-accent, #eb613f) 18%, var(--ui-gold, #c69c6d) 76%, transparent);
          opacity: 0.85;
        }
        .panel.creator {
          width: calc(100vw - 24px);
          height: calc(100vh - 24px); height: calc(100dvh - 24px);
          max-width: 1680px; margin: auto; border-radius: 14px;
        }

        .inner-bg {
          position: absolute; inset: 0; pointer-events: none; z-index: 0; opacity: 0.03;
          background-image:
            linear-gradient(var(--ui-ink, #f0ece2) 1px, transparent 1px),
            linear-gradient(90deg, var(--ui-ink, #f0ece2) 1px, transparent 1px);
          background-size: 28px 28px;
          mask-image: linear-gradient(90deg, transparent, #000 22%, #000);
        }

        /* ── 顶栏 ──── */
        .head {
          flex: 0 0 auto; position: relative; z-index: 2;
          min-height: 68px; padding: 12px 18px 12px 22px;
          display: flex; justify-content: space-between; align-items: center; gap: 12px;
          background: color-mix(in srgb, var(--ui-surface-1, #12161d) 92%, transparent);
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }
        .title {
          display: flex; align-items: center; gap: 12px; min-width: 0;
          font-family: var(--font-title, 'Noto Serif SC', serif);
          font-size: 18px; font-weight: 700; letter-spacing: 1.5px; line-height: 1.2;
          color: var(--ui-ink, #f0ece2);
        }
        .title span.title-seal {
          flex: 0 0 auto; width: 34px; height: 34px;
          display: grid; place-items: center; border-radius: 8px;
          font-family: var(--font-brush, 'Kaiti SC', serif);
          font-size: 18px; font-weight: 700; letter-spacing: 0;
          color: var(--ui-accent, #eb613f);
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 11%, transparent);
          border: 1px solid color-mix(in srgb, var(--ui-accent, #eb613f) 34%, transparent);
          box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ui-accent, #eb613f) 18%, transparent);
        }
        .title small {
          display: block; margin-top: 3px;
          color: var(--ui-ink-faint, #757168);
          font: 500 11px/1.3 var(--font-body, 'Noto Sans SC', system-ui, sans-serif);
          letter-spacing: 0.4px;
        }
        .head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .workbench-link {
          min-height: 36px; padding: 7px 14px; border-radius: 8px; cursor: pointer;
          display: inline-flex; align-items: center; gap: 6px;
          border: 1px solid color-mix(in srgb, var(--ui-gold, #c69c6d) 34%, transparent);
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 9%, transparent);
          color: var(--ui-ink, #f0ece2);
          font: 600 12px/1.2 var(--font-body, system-ui, sans-serif);
          transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
        }
        .workbench-link:hover {
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 16%, transparent);
          border-color: color-mix(in srgb, var(--ui-gold, #c69c6d) 60%, transparent);
        }
        .close {
          width: 36px; height: 36px; border: 1px solid transparent; border-radius: 8px;
          background: transparent; color: var(--ui-ink-muted, #aba69b);
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 22px; line-height: 1; font-weight: 300; cursor: pointer;
          transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
        }
        .close:hover {
          color: var(--ui-ink, #f0ece2);
          background: var(--ui-surface-2, #181d26);
          border-color: var(--ui-border, rgba(244, 241, 234, 0.09));
        }

        /* ── 主体布局与侧边导航 ──── */
        .layout {
          flex: 1 1 auto; min-height: 0; position: relative; z-index: 1;
          display: flex; flex-direction: row; overflow: hidden;
        }
        .sidebar {
          width: 192px; flex-shrink: 0; box-sizing: border-box;
          display: flex; flex-direction: column; gap: 4px;
          padding: 16px 10px;
          background: var(--ui-surface-1, #12161d);
          border-right: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          overflow-y: auto; scrollbar-width: none;
        }
        .sidebar::-webkit-scrollbar { display: none; }
        .creator .sidebar { width: 204px; padding: 16px 10px; }

        .tab-btn {
          position: relative; min-height: 42px; padding: 10px 14px;
          display: flex; align-items: center; gap: 10px;
          border: 1px solid transparent; border-radius: 9px;
          background: transparent; color: var(--ui-ink-muted, #aba69b);
          text-align: left; cursor: pointer;
          font: 500 13px/1.3 var(--font-body, 'Noto Sans SC', system-ui, sans-serif);
          transition: color 0.16s ease, background 0.16s ease, border-color 0.16s ease;
        }
        .tab-btn .tab-icon {
          flex: 0 0 auto; width: 16px; height: 16px;
          display: inline-flex; align-items: center; justify-content: center;
          opacity: 0.72; transition: opacity 0.16s ease, color 0.16s ease;
        }
        .tab-btn:hover {
          color: var(--ui-ink, #f0ece2);
          background: color-mix(in srgb, var(--ui-surface-2, #181d26) 75%, transparent);
        }
        .tab-btn:hover .tab-icon { opacity: 0.95; }
        .tab-btn.active {
          color: var(--ui-ink, #f0ece2); font-weight: 600;
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 11%, var(--ui-surface-2, #181d26));
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 24%, transparent);
        }
        .tab-btn.active .tab-icon { color: var(--ui-accent, #eb613f); opacity: 1; }
        .tab-btn.active::before {
          content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2.5px; border-radius: 9px;
          background: var(--ui-accent, #eb613f);
          box-shadow: 0 0 10px color-mix(in srgb, var(--ui-accent, #eb613f) 45%, transparent);
        }
        .tab-btn:disabled { cursor: default; opacity: .45; }
        .tab-btn:disabled:hover { color: var(--ui-ink-muted, #aba69b); background: transparent; }
        .support-tab { margin-top: auto; }

        /* ── 主内容区 ──── */
        .content {
          flex: 1 1 auto; min-width: 0; min-height: 0;
          overflow-y: auto; overflow-x: hidden;
          padding: 24px 28px 36px;
          scrollbar-width: thin;
          scrollbar-color: var(--ui-border-strong, rgba(244, 241, 234, 0.20)) transparent;
        }
        .content::-webkit-scrollbar { width: 6px; }
        .content::-webkit-scrollbar-thumb { background: var(--ui-border-strong, rgba(244, 241, 234, 0.20)); border-radius: 99px; }
        .creator .content { padding: 24px 32px 44px; }

        .tab-pane { display: none; animation: sp-fade-up 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
        .tab-pane.active { display: block; }
        .tab-pane.active ~ .tab-pane.active {
          margin-top: 34px; padding-top: 30px;
          border-top: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }
        @keyframes sp-fade-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

        .pane-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
          column-gap: 32px; row-gap: 28px; align-content: start;
        }
        section { position: relative; min-width: 0; }

        h3 {
          margin: 0 0 16px; padding-bottom: 10px;
          color: var(--ui-ink, #f0ece2);
          font-family: var(--font-title, 'Noto Serif SC', serif);
          font-size: 14px; font-weight: 700; letter-spacing: 0.8px;
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }
        .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09)); }
        .section-heading h3 { margin: 0; padding: 0; border-bottom: 0; }
        .section-sub { display: block; margin-top: 3px; font-size: 11px; color: var(--ui-ink-faint, #757168); font-weight: 400; }
        .owner-badge {
          padding: 4px 10px; border-radius: 999px; white-space: nowrap; font-size: 11px;
          border: 1px solid color-mix(in srgb, var(--ui-state-on, #58b97c) 32%, transparent);
          background: color-mix(in srgb, var(--ui-state-on, #58b97c) 10%, transparent);
          color: var(--ui-state-on, #58b97c);
        }
        .support-badge {
          border-color: color-mix(in srgb, var(--ui-gold, #c69c6d) 34%, transparent);
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 10%, transparent);
          color: var(--ui-gold, #c69c6d);
        }
        .setting-note { margin: 0 0 18px; color: var(--ui-ink-muted, #aba69b); font-size: 12px; line-height: 1.7; }

        .grid { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 14px 14px; align-items: center; }
        .compact-grid { max-width: 580px; }
        .variable-grid { grid-template-columns: 112px minmax(0, 1fr); }
        label { color: var(--ui-ink-muted, #aba69b); font-size: 13px; line-height: 1.4; }

        /* ── 统一表单控件 ──── */
        input[type="text"], input[type="password"], input[type="number"], input[type="url"], input[type="search"], select, textarea {
          width: 100%; box-sizing: border-box; min-height: 38px;
          padding: 8px 12px;
          background: var(--ui-surface-2, #181d26);
          color: var(--ui-ink, #f0ece2);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          border-radius: 8px;
          font: inherit; font-size: 13px;
          outline: none;
          transition: border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
        }
        input::placeholder, textarea::placeholder { color: var(--ui-ink-faint, #757168); }
        input:focus, select:focus, textarea:focus {
          border-color: var(--ui-accent, #eb613f);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent, #eb613f) 16%, transparent);
          background: var(--ui-surface-elevated, #1e2430);
        }
        select {
          appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 32px;
          background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23948d80' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 12px center;
        }
        select option { background: var(--ui-surface-elevated, #1e2430); color: var(--ui-ink, #f0ece2); }
        textarea { min-height: 88px; resize: vertical; padding: 10px 12px; line-height: 1.6; }

        /* 颜色选择器胶囊 */
        .color-picker-wrap {
          display: inline-flex; align-items: center; gap: 10px;
          padding: 4px 10px 4px 6px; border-radius: 999px;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          justify-self: start;
        }
        input[type="color"] {
          appearance: none; -webkit-appearance: none; border: none;
          width: 24px; height: 24px; border-radius: 50%; cursor: pointer; padding: 0; background: transparent;
          box-shadow: 0 0 0 1px var(--ui-border-strong, rgba(244, 241, 234, 0.20));
        }
        input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
        input[type="color"]::-webkit-color-swatch { border: none; border-radius: 50%; }
        .color-hex {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 12px; color: var(--ui-ink-muted, #aba69b); letter-spacing: 0.3px;
        }

        /* 开关切换 */
        input[type="checkbox"] {
          appearance: none; -webkit-appearance: none; width: 42px; height: 24px;
          border-radius: 999px; position: relative; cursor: pointer; margin: 0; justify-self: start; flex-shrink: 0;
          background: var(--ui-surface-elevated, #1e2430);
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.18));
          transition: background 0.18s ease, border-color 0.18s ease;
        }
        input[type="checkbox"]::after {
          content: ''; position: absolute; width: 18px; height: 18px; border-radius: 50%;
          top: 2px; left: 2px; background: var(--ui-ink-muted, #aba69b);
          transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), background 0.18s ease;
        }
        input[type="checkbox"]:checked {
          background: var(--ui-accent, #eb613f);
          border-color: var(--ui-accent, #eb613f);
        }
        input[type="checkbox"]:checked::after {
          transform: translateX(18px);
          background: var(--ui-accent-ink, #ffffff);
        }

        /* 范围滑块 */
        input[type="range"] {
          -webkit-appearance: none; appearance: none; width: 110px; height: 5px;
          background: var(--ui-surface-elevated, #1e2430);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          border-radius: 99px; outline: none; padding: 0; cursor: pointer;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%;
          background: var(--ui-accent, #eb613f);
          border: 2px solid var(--ui-canvas, #0b0e13);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
          cursor: pointer;
        }

        .file-input {
          padding: 4px 0 !important; font-size: 12px !important;
          color: var(--ui-ink-muted, #aba69b) !important; cursor: pointer;
          border: none !important; background: transparent !important; box-shadow: none !important; min-height: 0;
        }
        .file-input::-webkit-file-upload-button {
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.18));
          color: var(--ui-ink, #f0ece2);
          padding: 6px 12px; border-radius: 7px; cursor: pointer; margin-right: 10px;
          font-size: 12px; transition: background 0.16s ease, border-color 0.16s ease;
        }
        .file-input::-webkit-file-upload-button:hover {
          background: var(--ui-surface-elevated, #1e2430);
          border-color: var(--ui-accent, #eb613f);
        }

        /* ── 统一四级按钮体系（墨印漆作 · 沉稳暗漆与和纸边） ──── */
        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          min-height: 34px; padding: 7px 14px; border-radius: 6px; cursor: pointer;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.18));
          color: var(--ui-ink, #f0ece2);
          font: 500 12px/1.2 var(--font-body, 'Noto Sans SC', system-ui, sans-serif);
          letter-spacing: 0.02em; white-space: nowrap;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
          transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease, transform 0.12s ease;
        }
        .btn:hover:not(:disabled) {
          background: var(--ui-surface-elevated, #1e2430);
          border-color: color-mix(in srgb, var(--ui-gold, #c69c6d) 48%, transparent);
        }
        .btn:active:not(:disabled) { transform: translateY(1px); }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; transform: none; }
        .btn.primary {
          background: var(--ui-btn-primary-bg, #6c3326);
          border-color: var(--ui-btn-primary-border, #9e5341);
          color: var(--ui-btn-primary-ink, #f6f1e7);
          font-weight: 500;
          box-shadow: var(--ui-btn-primary-shadow, 0 1px 2px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.11));
        }
        .btn.primary:hover:not(:disabled) {
          background: var(--ui-btn-primary-bg-hover, #7f3b2c);
          border-color: var(--ui-btn-primary-border-hover, #b8624d);
          box-shadow: var(--ui-btn-primary-shadow-hover, 0 2px 6px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.15));
        }
        .btn.primary:active:not(:disabled) {
          background: var(--ui-btn-primary-bg-active, #5a2a1f);
          box-shadow: var(--ui-btn-primary-shadow-active, inset 0 1px 2px rgba(0, 0, 0, 0.38));
        }
        .btn.tonal {
          background: var(--ui-btn-tonal-bg, #2e2426);
          border-color: var(--ui-btn-tonal-border, #7c3f34);
          color: var(--ui-btn-tonal-ink, var(--ui-ink, #f0ece2));
          font-weight: 500;
          box-shadow: var(--ui-btn-tonal-shadow, 0 1px 2px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.06));
        }
        .btn.tonal:hover:not(:disabled) {
          background: var(--ui-btn-tonal-bg-hover, #3d2c2e);
          border-color: var(--ui-btn-tonal-border-hover, #a85442);
          box-shadow: var(--ui-btn-tonal-shadow-hover, 0 2px 5px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.10));
        }
        .btn.tonal:active:not(:disabled) {
          background: var(--ui-btn-tonal-bg-active, #251d1f);
          box-shadow: var(--ui-btn-primary-shadow-active, inset 0 1px 2px rgba(0, 0, 0, 0.34));
        }
        .btn.ghost {
          background: transparent;
          border-color: var(--ui-border, rgba(244, 241, 234, 0.10));
          color: var(--ui-ink-muted, #aba69b);
          padding: 8px 14px;
        }
        .btn.ghost:hover:not(:disabled) {
          background: var(--ui-surface-2, #181d26);
          color: var(--ui-ink, #f0ece2);
          border-color: var(--ui-border-strong, rgba(244, 241, 234, 0.20));
        }
        .btn.danger {
          background: transparent;
          border-color: color-mix(in srgb, var(--ui-state-danger, #e2645a) 45%, transparent);
          color: var(--ui-state-danger, #e2645a);
        }
        .btn.danger:hover:not(:disabled) {
          background: color-mix(in srgb, var(--ui-state-danger, #e2645a) 10%, transparent);
        }
        .btn-xs { min-height: 30px !important; padding: 5px 10px !important; font-size: 11px !important; border-radius: 6px !important; }

        /* ── 外观页：主题画廊 + 实时阅读预览 ──── */
        .visual-showcase { display: grid; gap: 18px; margin-bottom: 24px; }
        .theme-swatch-grid {
          display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px;
        }
        .theme-swatch-card {
          display: flex; flex-direction: column; gap: 8px; padding: 10px; text-align: left;
          border-radius: 10px; cursor: pointer;
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
          color: var(--ui-ink, #f0ece2);
          transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
        }
        .theme-swatch-card:hover {
          border-color: var(--ui-border-strong, rgba(244, 241, 234, 0.24));
          transform: translateY(-1px);
        }
        .theme-swatch-card.active {
          border-color: var(--ui-accent, #eb613f);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-accent, #eb613f) 24%, transparent);
        }
        .theme-swatch-preview {
          height: 38px; border-radius: 7px; padding: 6px 8px;
          display: flex; align-items: center; justify-content: space-between;
          border: 1px solid rgba(128, 128, 128, 0.24);
        }
        .theme-swatch-dots { display: inline-flex; align-items: center; gap: 5px; }
        .theme-swatch-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
        .theme-swatch-aa { font-family: var(--font-title, serif); font-size: 12px; font-weight: 700; }
        .theme-swatch-name { font-size: 12px; font-weight: 600; color: var(--ui-ink, #f0ece2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .theme-swatch-mode { font-size: 10px; color: var(--ui-ink-faint, #757168); }

        .reading-preview-card {
          padding: 16px 20px; border-radius: 12px;
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          background: var(--preview-bg, #070a0e);
          color: var(--preview-text, #e8e4d9);
          font-family: var(--preview-font, var(--font-body));
          font-size: var(--preview-size, 15px);
          line-height: var(--preview-lh, 1.85);
          transition: background 0.2s ease, color 0.2s ease;
        }
        .reading-preview-head {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          margin-bottom: 10px; padding-bottom: 8px;
          border-bottom: 1px solid color-mix(in srgb, var(--preview-text, #e8e4d9) 12%, transparent);
          font-size: 11px; color: var(--preview-gold, #c69c6d); font-family: var(--font-body, sans-serif);
        }
        .reading-preview-body {
          padding: 2px 0;
        }
        .reading-preview-body[data-card-style="line"] {
          padding-left: 14px;
          border-left: 2.5px solid var(--preview-accent, #eb613f);
        }
        .reading-preview-body[data-card-style="card"] {
          padding: 12px 14px; border-radius: 8px;
          background: color-mix(in srgb, var(--preview-text, #e8e4d9) 5%, transparent);
          border: 1px solid color-mix(in srgb, var(--preview-gold, #c69c6d) 24%, transparent);
        }
        .reading-preview-body p { margin: 0 0 6px; }
        .reading-preview-body p:last-child { margin-bottom: 0; }
        .reading-preview-body[data-indent="true"] p { text-indent: 2em; }
        .preview-dialogue { color: var(--preview-dialogue, #bae6fd); }
        .preview-thought { color: var(--preview-thought, #c4b5fd); font-style: italic; }
        .preview-mark { color: var(--preview-accent, #eb613f); font-weight: 600; }

        /* ── 开关卡片（游玩与输出） ──── */
        .setting-cards { display: flex; flex-direction: column; gap: 10px; max-width: 680px; }
        .setting-card {
          display: flex; align-items: center; gap: 14px; cursor: pointer;
          padding: 14px 16px; border-radius: 12px;
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
        }
        .setting-card:hover {
          background: var(--ui-surface-2, #181d26);
          border-color: var(--ui-border-strong, rgba(244, 241, 234, 0.18));
        }
        .setting-card:has(input:checked) {
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 34%, transparent);
          background:
            linear-gradient(120deg, color-mix(in srgb, var(--ui-accent, #eb613f) 7%, transparent), transparent 58%),
            var(--ui-surface-1, #12161d);
        }
        .setting-card .sc-icon {
          flex-shrink: 0; width: 38px; height: 38px; border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          color: var(--ui-ink-muted, #aba69b);
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          transition: color 0.18s ease, background 0.18s ease, border-color 0.18s ease;
        }
        .setting-card .sc-icon svg { width: 18px; height: 18px; }
        .setting-card:has(input:checked) .sc-icon {
          color: var(--ui-accent, #eb613f);
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 12%, transparent);
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 34%, transparent);
        }
        .setting-card .sc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .setting-card .sc-title { font-size: 13px; font-weight: 600; color: var(--ui-ink, #f0ece2); font-family: var(--font-title, serif); }
        .setting-card .sc-desc { font-size: 12px; color: var(--ui-ink-faint, #757168); line-height: 1.55; }

        /* ── 存档与空间 ──── */
        .storage-section {
          margin-top: 30px; padding-top: 26px; max-width: 680px;
          border-top: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }
        .storage-tool {
          overflow: hidden; border-radius: 12px;
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
          background: var(--ui-surface-1, #12161d);
        }
        .archive-toggle-row {
          display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 12px;
          min-width: 0; padding: 15px 16px; cursor: pointer;
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }
        .archive-toggle-row:hover { background: var(--ui-surface-2, #181d26); }
        .history-count-row input { width: 92px; min-width: 68px; text-align: center; }
        .storage-tool-icon {
          width: 38px; height: 38px; display: grid; place-items: center; border-radius: 9px;
          color: var(--ui-accent, #eb613f);
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 10%, transparent);
          border: 1px solid color-mix(in srgb, var(--ui-accent, #eb613f) 24%, transparent);
        }
        .storage-toggle-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .storage-toggle-copy strong { color: var(--ui-ink, #f0ece2); font: 600 13px/1.35 var(--font-title, serif); }
        .storage-toggle-copy span { color: var(--ui-ink-faint, #757168); font: 400 12px/1.5 var(--font-body, sans-serif); }
        .storage-status {
          min-height: 44px; display: flex; align-items: center; padding: 10px 16px;
          color: var(--ui-ink-muted, #aba69b); font-size: 12px;
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          background: var(--ui-surface-2, #181d26);
        }
        .storage-metrics {
          width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;
        }
        .storage-metric { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .storage-metric strong { font-size: 14px; font-weight: 700; color: var(--ui-ink, #f0ece2); font-variant-numeric: tabular-nums; }
        .storage-metric span { font-size: 11px; color: var(--ui-ink-faint, #757168); }
        .storage-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 14px; }
        .storage-actions .btn { min-height: 36px; padding: 7px 12px; font-size: 12px; }
        .storage-actions .btn:disabled { cursor: wait; opacity: 0.5; }

        /* ── 支持项目 ──── */
        .support-section { max-width: 660px; }
        .support-story { display: grid; gap: 11px; margin-bottom: 24px; }
        .support-story p { margin: 0; color: var(--ui-ink-muted, #aba69b); font-size: 12px; line-height: 1.85; }
        .support-story .support-lead { color: var(--ui-ink, #f0ece2); font-size: 13px; line-height: 1.75; font-weight: 500; }
        .support-meta {
          display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
          margin: 0 0 4px; padding: 0 0 14px;
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }
        .support-meta span { display: inline-flex; align-items: center; gap: 6px; color: var(--ui-ink-muted, #aba69b); font-size: 11px; }
        .support-meta svg { color: var(--ui-gold, #c69c6d); }
        .support-impact { margin-bottom: 20px; }
        .support-block-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
        .support-block-heading h4 { margin: 0; color: var(--ui-ink, #f0ece2); font: 700 13px/1.4 var(--font-title, serif); }
        .support-use-list {
          display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;
          margin: 0; padding: 0; list-style: none;
        }
        .support-use-list li {
          min-width: 0; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 10px;
          min-height: 52px; padding: 10px 12px; border-radius: 10px;
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          color: var(--ui-ink-muted, #aba69b); font-size: 12px; line-height: 1.45;
        }
        .support-use-icon {
          width: 30px; height: 30px; display: grid; place-items: center;
          color: var(--ui-accent, #eb613f); border-radius: 7px;
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 10%, transparent);
        }
        .support-recognition {
          margin: 0 0 24px; padding: 12px 16px; border-radius: 10px;
          color: var(--ui-ink, #f0ece2); font-size: 12px; line-height: 1.75;
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 8%, var(--ui-surface-1, #12161d));
          border: 1px solid color-mix(in srgb, var(--ui-gold, #c69c6d) 24%, transparent);
        }
        .support-options-heading { margin-bottom: 10px; }
        .support-methods { display: grid; gap: 12px; }
        .support-method {
          min-width: 0; padding: 16px; border-radius: 12px;
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          background: var(--ui-surface-1, #12161d);
        }
        .support-method-afdian { display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; align-items: center; gap: 14px; }
        .support-method-wechat { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(220px, 270px); align-items: center; gap: 20px; }
        .support-method-overview { display: flex; align-items: flex-start; gap: 14px; min-width: 0; }
        .support-method-icon {
          flex: 0 0 42px; width: 42px; height: 42px; display: grid; place-items: center; border-radius: 10px;
          color: var(--ui-accent, #eb613f);
          border: 1px solid color-mix(in srgb, var(--ui-accent, #eb613f) 28%, transparent);
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 10%, transparent);
        }
        .support-method-copy { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
        .support-method-kicker { color: var(--ui-gold, #c69c6d); font-size: 11px; font-weight: 600; }
        .support-method-copy strong { color: var(--ui-ink, #f0ece2); font: 700 13px/1.4 var(--font-title, serif); }
        .support-method-copy p { margin: 0; color: var(--ui-ink-muted, #aba69b); font-size: 12px; line-height: 1.6; }
        .support-primary-link { text-decoration: none; }
        .support-qr { min-width: 0; }
        .support-qr-frame {
          display: block; overflow: hidden; padding: 6px; border-radius: 10px; background: #ffffff;
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.20));
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        }
        .support-qr-frame img { display: block; width: 100%; height: auto; aspect-ratio: 1; object-fit: contain; }
        .support-image-actions { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 8px; }
        .support-image-actions a {
          min-height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
          color: var(--ui-ink-muted, #aba69b); font-size: 11px; text-decoration: none;
        }
        .support-image-actions a:hover { color: var(--ui-ink, #f0ece2); }
        .support-community { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09)); }
        .support-community p { margin: 0; color: var(--ui-ink-muted, #aba69b); font-size: 12px; line-height: 1.8; }
        .support-community-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
        .support-community-link { text-decoration: none; font-size: 11px !important; }
        .support-gratitude { margin: 20px 0 4px; color: var(--ui-ink-faint, #757168); font-size: 11px; text-align: center; }

        /* ── 工作台卡片 / 数据库 / 管线 ──── */
        .connection-section { max-width: 640px; }
        .connection-strip {
          position: sticky; top: -24px; z-index: 8; display: flex; align-items: center; gap: 8px;
          margin: -24px -32px 24px; padding: 10px 32px;
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          background: color-mix(in srgb, var(--ui-surface-1, #12161d) 92%, transparent);
          backdrop-filter: blur(12px);
          color: var(--ui-ink-muted, #aba69b); font-size: 12px;
        }
        .connection-strip button {
          margin-left: auto; border: 0; background: transparent;
          color: var(--ui-accent, #eb613f); cursor: pointer; font-size: 12px; font-weight: 600;
        }
        .connection-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ui-state-danger, #e2645a); }
        .connection-dot.online { background: var(--ui-state-on, #58b97c); box-shadow: 0 0 8px color-mix(in srgb, var(--ui-state-on, #58b97c) 45%, transparent); }

        .inline-field { display: flex; gap: 8px; min-width: 0; align-items: center; }
        .inline-field input { flex: 1; min-width: 0; }
        .inline-model-list {
          max-height: 180px; overflow-y: auto; margin-top: 6px; border-radius: 8px;
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.18));
          background: var(--ui-surface-elevated, #1e2430);
        }
        .inline-model-item {
          padding: 8px 12px; cursor: pointer; font-size: 12px;
          color: var(--ui-ink-muted, #aba69b);
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.06));
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .inline-model-item:hover { background: var(--ui-surface-2, #181d26); color: var(--ui-ink, #f0ece2); }
        .inline-model-item.selected {
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 14%, transparent);
          color: var(--ui-accent, #eb613f); font-weight: 600;
        }

        .config-card, .prompt-preset-card {
          position: relative; overflow: hidden; padding: 18px 20px; border-radius: 12px;
          background:
            radial-gradient(ellipse 90% 70% at 10% -20%, color-mix(in srgb, var(--ui-gold, #c69c6d) 7%, transparent), transparent 55%),
            var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
        }
        .config-card + .config-card { margin-top: 14px; }
        .prompt-preset-card { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
        .prompt-preset-card strong, .config-card-title { color: var(--ui-ink, #f0ece2); font: 700 14px/1.4 var(--font-title, serif); margin: 0 0 6px; }
        .prompt-preset-card span { color: var(--ui-gold, #c69c6d); font-size: 12px; }
        .prompt-preset-card p, .config-card-note { margin: 0 0 14px; color: var(--ui-ink-muted, #aba69b); font-size: 12px; line-height: 1.7; }
        .config-card-toggle { display: flex; align-items: center; gap: 12px; color: var(--ui-ink, #f0ece2); cursor: pointer; }
        .config-card-toggle strong { font-family: var(--font-title, serif); font-size: 14px; }
        .config-card-estimate {
          display: inline-block; margin-top: 4px; padding: 5px 12px; border-radius: 999px;
          font-size: 11px; color: var(--ui-gold, #c69c6d);
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 10%, transparent);
          border: 1px solid color-mix(in srgb, var(--ui-gold, #c69c6d) 26%, transparent);
        }
        .config-card-blocked { margin-top: 8px; font-size: 11px; color: var(--ui-ink-faint, #757168); }
        .config-card-blocked:empty { display: none; }
        .config-card-grid { grid-template-columns: auto minmax(0, 1fr); gap: 12px 16px; align-items: center; }
        .config-label-sub { color: var(--ui-ink-faint, #757168) !important; font-size: 12px !important; }

        .database-summary { display: flex; flex-direction: column; align-items: flex-start; gap: 18px; padding: 10px 0; }
        .database-metrics {
          width: 100%; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
          border-radius: 10px; overflow: hidden;
          background: var(--ui-surface-1, #12161d);
        }
        .database-metrics span {
          min-width: 0; padding: 14px 12px; display: flex; flex-direction: column; gap: 4px;
          color: var(--ui-ink-faint, #757168); font-size: 11px;
          border-right: 1px solid var(--ui-border, rgba(244, 241, 234, 0.08));
        }
        .database-metrics span:last-child { border-right: 0; }
        .database-metrics strong { color: var(--ui-ink, #f0ece2); font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .workbench-metrics { margin-bottom: 16px; }

        /* ── 声音与画面 ──── */
        .media-image-section { margin-bottom: 28px; padding-bottom: 26px; border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09)); }
        .music-panel { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 16px; }
        .music-player-bar {
          display: flex; align-items: center; justify-content: space-between; gap: 20px;
          padding: 16px 18px; border-radius: 12px;
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
        }
        .music-info { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
        .music-now { font-family: var(--font-title, serif); font-size: 14px; font-weight: 700; color: var(--ui-ink, #f0ece2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .music-status { font-size: 11px; color: var(--ui-ink-faint, #757168); }
        .music-controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; justify-content: flex-end; }
        .music-controls label { display: flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; font-size: 12px; color: var(--ui-ink-muted, #aba69b); }
        .music-sync-status { font-size: 11px; color: var(--ui-ink-faint, #757168); min-width: 64px; white-space: nowrap; }
        .music-search-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; }
        .music-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10)); }
        .music-tab {
          flex: 1; padding: 10px 8px; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px;
          background: transparent; color: var(--ui-ink-faint, #757168); cursor: pointer;
          font-family: var(--font-title, serif); font-size: 12px; transition: color 0.16s ease, border-color 0.16s ease;
        }
        .music-tab:hover { color: var(--ui-ink, #f0ece2); }
        .music-tab.active { color: var(--ui-ink, #f0ece2); border-bottom-color: var(--ui-accent, #eb613f); font-weight: 700; }
        .music-result-list {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px;
          min-height: 0; max-height: 240px; overflow-y: auto; padding-right: 6px;
          overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
        }
        .music-empty-hint { text-align: center; color: var(--ui-ink-faint, #757168); padding: 28px 16px; font-size: 12px; line-height: 1.7; grid-column: 1 / -1; }
        .music-item {
          display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 14px; border-radius: 9px; cursor: pointer;
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          transition: background 0.16s ease, border-color 0.16s ease;
        }
        .music-item:hover { background: var(--ui-surface-2, #181d26); border-color: var(--ui-border-strong, rgba(244, 241, 234, 0.20)); }
        .music-item-info { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
        .music-item-name { font-family: var(--font-title, serif); font-size: 13px; font-weight: 600; color: var(--ui-ink, #f0ece2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .music-item-artist { font-size: 11px; color: var(--ui-ink-faint, #757168); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .music-play-icon { color: var(--ui-ink-muted, #aba69b); font-size: 13px; }
        .music-item:hover .music-play-icon { color: var(--ui-accent, #eb613f); }
        .music-item-fav { color: var(--ui-ink-faint, #757168); font-size: 15px; padding: 4px; }
        .music-item-fav.favorited { color: var(--ui-gold, #c69c6d); }

        /* ── 底栏与反馈 ──── */
        .actions {
          flex: 0 0 auto; position: relative; z-index: 2;
          min-height: 62px; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px;
          padding: 10px 18px max(10px, env(safe-area-inset-bottom));
          background: color-mix(in srgb, var(--ui-surface-1, #12161d) 94%, transparent);
          border-top: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          backdrop-filter: blur(14px);
        }
        .actions .save-state {
          margin-right: auto; display: inline-flex; align-items: center; gap: 7px;
          color: var(--ui-ink-faint, #757168); font-size: 11px; letter-spacing: 0.3px;
        }
        .actions.is-dirty .save-state { color: var(--ui-ink, #f0ece2); }
        .actions.is-dirty .save-state::before {
          content: ''; width: 7px; height: 7px; border-radius: 50%;
          background: var(--ui-accent, #eb613f);
          box-shadow: 0 0 8px color-mix(in srgb, var(--ui-accent, #eb613f) 60%, transparent);
        }
        .actions .btn { min-width: 82px; padding: 9px 16px; }

        .settings-toast {
          position: absolute; z-index: 60; left: 50%; bottom: 76px; max-width: min(420px, calc(100% - 32px));
          transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
          padding: 9px 14px; border-radius: 9px;
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.20));
          background: var(--ui-surface-elevated, #1e2430);
          color: var(--ui-ink, #f0ece2);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
          font-size: 12px; line-height: 1.5; text-align: center;
          transition: opacity 0.18s ease, transform 0.18s ease;
        }
        .settings-toast.visible { opacity: 1; transform: translate(-50%, 0); }

        .workbench-editor-layer {
          display: none; position: absolute; z-index: 30;
          inset: 0 0 0 204px; min-width: 0; min-height: 0;
          background: var(--ui-canvas, #0b0e13);
        }
        .workbench-editor-layer.active { display: block; }
        .workbench-editor-layer > * { width: 100%; height: 100%; }

        @media (min-width: 769px) and (max-width: 1100px) {
          .workbench-editor-layer { inset: 0; }
          .storage-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .storage-actions .btn { width: 100%; }
          .theme-swatch-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }

        @media (max-width: 768px) {
          .backdrop { padding: 0; }
          .panel, .panel.creator {
            width: 100vw; height: 100vh; height: 100dvh; max-height: 100vh; max-height: 100dvh;
            margin: 0; border-radius: 0; border: none;
          }
          .head { min-height: 60px; padding: max(8px, env(safe-area-inset-top)) 10px 8px 14px; }
          .title { font-size: 16px; gap: 9px; }
          .title span.title-seal { width: 30px; height: 30px; font-size: 16px; }
          .title small { margin-top: 2px; font-size: 10px; }
          .head-actions { gap: 6px; }
          .workbench-link { min-height: 44px; padding: 8px 11px; font-size: 11px; }
          .close { width: 44px; height: 44px; }

          /* 保留单一触摸滚动容器，确保窄屏与输入法弹出时仍可顺畅滚动 */
          .layout { display: block; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
          .layout.editor-open { overflow: hidden; }

          /* 单行横向平滑滚动胶囊栏，告别 2×3 占高网格 */
          .sidebar, .creator .sidebar {
            width: auto; display: flex; flex-direction: row; flex-wrap: nowrap;
            overflow-x: auto; overflow-y: visible; scrollbar-width: none; -webkit-overflow-scrolling: touch;
            flex: 0 0 auto; border-right: none;
            border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
            padding: 8px 12px; gap: 6px;
          }
          .tab-btn {
            flex: 0 0 auto; min-height: 44px; padding: 10px 14px;
            white-space: nowrap; border-radius: 999px; font-size: 12px;
            background: var(--ui-surface-2, #181d26);
            border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          }
          .support-tab { margin-top: 0; }
          .tab-btn.active {
            background: color-mix(in srgb, var(--ui-accent, #eb613f) 14%, var(--ui-surface-2, #181d26));
            border-color: var(--ui-accent, #eb613f);
          }
          .tab-btn.active::before { display: none; }

          .content, .creator .content { padding: 18px 16px 26px; overflow: visible; }
          .connection-strip { top: 0; margin: -18px -16px 18px; padding: 10px 16px; }
          .pane-grid { grid-template-columns: 1fr; }
          .variable-grid { grid-template-columns: 1fr; gap: 10px; }
          .theme-swatch-grid { display: flex; overflow-x: auto; gap: 8px; padding-bottom: 4px; scrollbar-width: none; }
          .theme-swatch-card { flex: 0 0 108px; }

          .music-player-bar { flex-direction: column; align-items: stretch; gap: 14px; }
          .music-controls { flex-wrap: wrap; justify-content: space-between; }
          .music-result-list { grid-template-columns: 1fr; max-height: 220px; }
          .database-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .database-metrics span:nth-child(2) { border-right: 0; }
          .database-metrics span:nth-child(-n+2) { border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09)); }
          .actions { min-height: 64px; padding-left: 12px; padding-right: 12px; }
          .actions .save-state { max-width: 45%; line-height: 1.35; }
          .actions .btn { min-width: 72px; min-height: 44px; padding: 9px 12px; }
          .workbench-editor-layer { inset: 0; }
          .storage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .storage-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .storage-actions .btn { width: 100%; min-height: 44px; }

          .support-meta { gap: 10px 14px; }
          .support-use-list { grid-template-columns: minmax(0, 1fr); }
          .support-method-afdian, .support-method-wechat { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
          .support-primary-link { width: 100%; min-height: 45px; }
          .support-qr { width: min(100%, 340px); margin: 0 auto; }
          .support-image-actions a { min-height: 45px; }
          .support-community-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .support-community-actions .support-community-link { min-height: 45px; width: 100%; }
        }

        @media (max-width: 520px) {
          .grid, .variable-grid { grid-template-columns: minmax(0, 1fr); gap: 7px; }
          .grid > label:not(:first-child), .variable-grid > label:not(:first-child) { margin-top: 7px; }
          .grid input[type="checkbox"] { margin-bottom: 4px; }
          .section-heading { gap: 10px; }
          .section-heading .btn { padding-left: 10px; padding-right: 10px; }
          .music-search-row { grid-template-columns: minmax(0, 1fr) auto; }
          .music-controls { gap: 12px; }
          .actions .save-state { font-size: 10px; }
          .archive-toggle-row { grid-template-columns: 38px minmax(0, 1fr) auto; padding: 13px 12px; gap: 10px; }
          .history-count-row input { grid-column: 2 / -1; width: 100%; }
          .storage-status { padding: 10px 12px; line-height: 1.5; }
          .support-community-actions { grid-template-columns: minmax(0, 1fr); }
        }
`;
