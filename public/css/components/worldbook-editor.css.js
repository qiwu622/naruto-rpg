export const worldbookStyles = `
        :host {
          display: flex; position: fixed; inset: 0; z-index: 100002;
          justify-content: center; align-items: center; padding: 20px; box-sizing: border-box;
          background: var(--ui-backdrop, rgba(3, 5, 8, 0.84));
          backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
          font-family: var(--font-body, 'Noto Sans SC', 'Microsoft YaHei UI', system-ui, sans-serif);
          color: var(--ui-ink, #f0ece2);
          color-scheme: var(--ui-color-scheme, dark);
        }
        :host([embedded]) {
          position: relative; inset: auto; z-index: auto;
          width: 100%; height: 100%; padding: 0;
          background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none;
        }
        :host([embedded]) .wb-container {
          max-width: none; max-height: none; border-radius: 0; border: 0; box-shadow: none;
        }
        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }

        .wb-container {
          width: 100%; max-width: 1280px; height: 100%; max-height: 860px;
          display: flex; flex-direction: column; overflow: hidden;
          background: var(--ui-canvas, #0b0e13);
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.16));
          border-radius: 14px;
          box-shadow: var(--ui-shadow, 0 24px 64px rgba(0, 0, 0, 0.55));
        }

        /* ── 顶栏 ──── */
        .wb-header {
          flex: 0 0 auto; padding: 12px 18px;
          display: flex; justify-content: space-between; align-items: center; gap: 14px;
          background: var(--ui-surface-1, #12161d);
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }
        .wb-title {
          margin: 0; min-width: 0;
          display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
          font-family: var(--font-title, 'Noto Serif SC', serif);
          font-size: 16px; font-weight: 700; letter-spacing: 0.8px;
          color: var(--ui-ink, #f0ece2);
        }
        .wb-stats-pills { display: inline-flex; flex-wrap: wrap; gap: 6px; font-family: var(--font-body, sans-serif); font-weight: 500; letter-spacing: 0; }
        .wb-stat-pill {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 9px; border-radius: 999px; font-size: 11px;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
          color: var(--ui-ink-muted, #aba69b);
        }
        .wb-stat-pill.is-gold {
          color: var(--ui-gold, #c69c6d);
          border-color: color-mix(in srgb, var(--ui-gold, #c69c6d) 30%, transparent);
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 9%, transparent);
        }
        .wb-stat-pill.is-accent {
          color: var(--ui-accent, #eb613f);
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 32%, transparent);
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 10%, transparent);
        }

        .wb-actions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; }

        /* ── 按钮 ──── */
        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 5px;
          min-height: 34px; padding: 6px 13px; border-radius: 6px; cursor: pointer;
          background: var(--ui-surface-2, #181d26);
          color: var(--ui-ink, #f0ece2);
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.16));
          font: 500 12px/1.2 inherit; letter-spacing: 0.02em; white-space: nowrap;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
          transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease, transform 0.12s ease;
        }
        .btn:hover:not(:disabled) {
          background: var(--ui-surface-elevated, #1e2430);
          border-color: color-mix(in srgb, var(--ui-gold, #c69c6d) 50%, transparent);
        }
        .btn:active:not(:disabled) { transform: translateY(1px); }
        .btn:disabled { opacity: 0.42; cursor: not-allowed; box-shadow: none; transform: none; }
        .btn.primary {
          background: var(--ui-btn-primary-bg, #6c3326);
          border-color: var(--ui-btn-primary-border, #9e5341);
          color: var(--ui-btn-primary-ink, #f6f1e7); font-weight: 500;
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
        .btn.danger {
          background: transparent;
          border-color: color-mix(in srgb, var(--ui-state-danger, #e2645a) 45%, transparent);
          color: var(--ui-state-danger, #e2645a);
        }
        .btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-state-danger, #e2645a) 11%, transparent); }
        .btn.good {
          background: color-mix(in srgb, var(--ui-state-on, #58b97c) 11%, transparent);
          border-color: color-mix(in srgb, var(--ui-state-on, #58b97c) 36%, transparent);
          color: var(--ui-state-on, #58b97c);
        }
        .btn.good:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-state-on, #58b97c) 18%, transparent); }
        .btn.ghost {
          background: transparent;
          border-color: var(--ui-border, rgba(244, 241, 234, 0.10));
          color: var(--ui-ink-muted, #aba69b);
        }
        .btn.ghost:hover:not(:disabled) {
          background: var(--ui-surface-2, #181d26);
          color: var(--ui-ink, #f0ece2);
        }
        .btn.sm { min-height: 29px; padding: 4px 10px; font-size: 11px; border-radius: 6px; }

        /* ── 主体分栏 ──── */
        .wb-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }
        .wb-sidebar {
          width: 332px; flex-shrink: 0; min-height: 0;
          display: flex; flex-direction: column;
          background: var(--ui-surface-1, #12161d);
          border-right: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }
        .wb-sidebar-top {
          flex: 0 0 auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          background: var(--ui-surface-1, #12161d);
        }
        .wb-search-wrap { position: relative; display: flex; align-items: center; }
        .wb-search-icon {
          position: absolute; left: 10px; pointer-events: none;
          display: inline-flex; color: var(--ui-ink-faint, #757168);
        }
        .wb-search-input {
          width: 100%; min-height: 36px; padding: 7px 30px 7px 32px;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          border-radius: 8px; color: var(--ui-ink, #f0ece2); font-size: 13px; outline: none;
          transition: border-color 0.16s ease, box-shadow 0.16s ease;
        }
        .wb-search-input::placeholder { color: var(--ui-ink-faint, #757168); }
        .wb-search-input:focus {
          border-color: var(--ui-accent, #eb613f);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent, #eb613f) 15%, transparent);
        }
        .wb-search-clear {
          position: absolute; right: 6px; width: 24px; height: 24px; border: 0; border-radius: 50%;
          display: grid; place-items: center; cursor: pointer;
          background: transparent; color: var(--ui-ink-faint, #757168); font-size: 14px;
        }
        .wb-search-clear:hover { color: var(--ui-ink, #f0ece2); background: var(--ui-surface-elevated, #1e2430); }

        .wb-filter-pills { display: flex; flex-wrap: wrap; gap: 5px; }
        .wb-filter-pill {
          min-height: 26px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          color: var(--ui-ink-muted, #aba69b); font-size: 11px;
          transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        }
        .wb-filter-pill:hover { color: var(--ui-ink, #f0ece2); border-color: var(--ui-border-strong, rgba(244, 241, 234, 0.20)); }
        .wb-filter-pill.active {
          color: var(--ui-accent, #eb613f);
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 45%, transparent);
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 12%, var(--ui-surface-2, #181d26));
          font-weight: 600;
        }
        .wb-category-select {
          width: 100%; min-height: 32px; padding: 5px 28px 5px 10px;
          border-radius: 7px; font-size: 12px;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
          color: var(--ui-ink, #f0ece2); outline: none; cursor: pointer;
        }
        .wb-category-select option { background: var(--ui-surface-elevated, #1e2430); color: var(--ui-ink, #f0ece2); }

        /* ── 条目列表（固定排版高度，确保选中/切换不跳动） ──── */
        .wb-list {
          flex: 1; min-height: 0; overflow-y: auto; overflow-anchor: none; padding: 6px;
          scrollbar-width: thin;
          scrollbar-color: var(--ui-border-strong, rgba(244, 241, 234, 0.20)) transparent;
        }
        .wb-list::-webkit-scrollbar { width: 5px; }
        .wb-list::-webkit-scrollbar-thumb { background: var(--ui-border-strong, rgba(244, 241, 234, 0.20)); border-radius: 99px; }

        .wb-section-hdr {
          margin: 4px 2px; padding: 8px 10px; border-radius: 8px;
          font-size: 11px; font-weight: 700; letter-spacing: 0.8px;
          color: var(--ui-gold, #c69c6d);
          background: color-mix(in srgb, var(--ui-surface-2, #181d26) 72%, transparent);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.08));
          display: flex; justify-content: space-between; align-items: center; gap: 8px; cursor: pointer;
        }
        .wb-section-hdr:hover { background: var(--ui-surface-2, #181d26); border-color: var(--ui-border-strong, rgba(244, 241, 234, 0.16)); }
        .wb-section-hdr .count { font-size: 11px; color: var(--ui-ink-faint, #757168); font-weight: 400; letter-spacing: 0; margin-left: auto; }
        .wb-section-chevron { font-size: 11px; color: var(--ui-ink-faint, #757168); }

        .wb-builtin-toolbar {
          display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 6px 8px; margin: 2px 2px 6px;
          border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.08));
        }

        .wb-item {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 10px; margin: 2px 0; border-radius: 8px;
          border: 1px solid transparent; border-left: 3px solid transparent;
          cursor: pointer; transition: background 0.14s ease, border-color 0.14s ease;
        }
        .wb-item:hover { background: color-mix(in srgb, var(--ui-surface-2, #181d26) 70%, transparent); }
        .wb-item.active {
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 10%, var(--ui-surface-2, #181d26));
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 24%, transparent);
          border-left-color: var(--ui-accent, #eb613f);
        }
        .wb-item.is-disabled .wb-item-title { opacity: 0.45; text-decoration: line-through; }

        .wb-item-toggle {
          width: 30px; height: 17px; border-radius: 999px; flex-shrink: 0;
          background: var(--ui-surface-elevated, #1e2430);
          border: 1px solid var(--ui-border-strong, rgba(244, 241, 234, 0.18));
          position: relative; cursor: pointer; transition: background 0.18s ease, border-color 0.18s ease;
        }
        .wb-item-toggle.on {
          background: var(--ui-state-on, #58b97c);
          border-color: var(--ui-state-on, #58b97c);
        }
        .wb-item-toggle::after {
          content: ''; position: absolute; top: 1.5px; left: 2px;
          width: 12px; height: 12px; border-radius: 50%;
          background: var(--ui-accent-ink, #ffffff); transition: transform 0.18s ease;
        }
        .wb-item-toggle.on::after { transform: translateX(12px); }

        .wb-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .wb-item-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .wb-item-title {
          flex: 1; min-width: 0; font-size: 13px; font-weight: 600; line-height: 1.35;
          color: var(--ui-ink, #f0ece2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .wb-builtin-tag {
          flex-shrink: 0; font-size: 10px; line-height: 1.2; padding: 2px 6px; border-radius: 4px;
          background: var(--ui-surface-elevated, #1e2430);
          color: var(--ui-ink-faint, #757168);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
        }
        .wb-builtin-tag.modified {
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 14%, transparent);
          color: var(--ui-accent, #eb613f);
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 32%, transparent);
        }
        .wb-item-sub { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .wb-item-meta {
          font-size: 11px; line-height: 1.3; color: var(--ui-ink-faint, #757168);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .wb-item-meta[data-mode="keyword"] { color: var(--ui-state-on, #58b97c); }
        .wb-item-meta[data-mode="always"] { color: var(--ui-state-always, #6da8ec); }

        .wb-empty-list {
          padding: 20px 14px; text-align: center;
          color: var(--ui-ink-faint, #757168); font-size: 12px; line-height: 1.6;
        }

        .wb-sidebar-foot {
          flex: 0 0 auto; padding: 10px 12px;
          border-top: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          background: var(--ui-surface-1, #12161d);
          display: flex; gap: 6px; flex-wrap: wrap;
        }
        .wb-sidebar-foot .btn { flex: 1 1 auto; }

        /* ── 右侧细节编辑区 ──── */
        .wb-editor {
          flex: 1; min-width: 0; min-height: 0;
          display: flex; flex-direction: column; gap: 14px;
          padding: 18px 22px 22px; overflow-y: auto;
          background: var(--ui-canvas, #0b0e13);
          scrollbar-width: thin;
          scrollbar-color: var(--ui-border-strong, rgba(244, 241, 234, 0.20)) transparent;
        }
        .wb-editor::-webkit-scrollbar { width: 6px; }
        .wb-editor::-webkit-scrollbar-thumb { background: var(--ui-border-strong, rgba(244, 241, 234, 0.20)); border-radius: 99px; }

        .wb-mobile-bar {
          display: none; align-items: center; justify-content: space-between; gap: 10px;
          padding-bottom: 10px; border-bottom: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
        }

        .wb-editor-head {
          display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
          padding: 12px 16px; border-radius: 10px;
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
        }
        .wb-mount-group { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .wb-source-badge {
          font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          color: var(--ui-gold, #c69c6d);
        }
        .wb-source-badge.is-modified {
          color: var(--ui-accent, #eb613f);
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 32%, transparent);
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 10%, transparent);
        }
        .wb-mount-label { font-size: 12px; color: var(--ui-ink-muted, #aba69b); }
        .wb-editor-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

        .wb-builtin-banner {
          display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
          padding: 11px 14px; border-radius: 10px;
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 8%, var(--ui-surface-1, #12161d));
          border: 1px solid color-mix(in srgb, var(--ui-gold, #c69c6d) 24%, transparent);
        }
        .wb-builtin-banner.modified {
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 8%, var(--ui-surface-1, #12161d));
          border-color: color-mix(in srgb, var(--ui-accent, #eb613f) 30%, transparent);
        }
        .wb-builtin-banner-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 220px; }
        .wb-builtin-banner-copy strong { font-size: 12px; color: var(--ui-ink, #f0ece2); }
        .wb-builtin-banner-copy span { font-size: 11px; color: var(--ui-ink-muted, #aba69b); line-height: 1.5; }
        .wb-builtin-banner-actions { display: flex; gap: 6px; flex-wrap: wrap; }

        .wb-card {
          padding: 14px 16px; border-radius: 10px;
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.09));
          display: flex; flex-direction: column; gap: 12px;
        }
        .wb-content-card { flex: 1 1 auto; min-height: 260px; }

        .wb-form-group { margin-bottom: 0; display: flex; flex-direction: column; gap: 6px; }
        .wb-form-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
        .wb-form-label { font-size: 12px; font-weight: 600; color: var(--ui-gold, #c69c6d); letter-spacing: 0.4px; }
        .wb-hint { font-size: 11px; color: var(--ui-ink-faint, #757168); line-height: 1.6; }
        .wb-counter {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 11px; color: var(--ui-ink-faint, #757168);
        }

        .wb-input {
          width: 100%; box-sizing: border-box; min-height: 38px; padding: 8px 12px;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          border-radius: 8px; color: var(--ui-ink, #f0ece2); font-size: 13px; outline: none; font-family: inherit;
          transition: border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
        }
        .wb-input:focus {
          border-color: var(--ui-accent, #eb613f);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent, #eb613f) 16%, transparent);
          background: var(--ui-surface-elevated, #1e2430);
        }
        .wb-input:disabled { opacity: 0.45; cursor: not-allowed; }
        .wb-title-input { font-family: var(--font-title, 'Noto Serif SC', serif); font-size: 15px; font-weight: 700; }
        select.wb-input {
          appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 32px;
          background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23948d80' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 12px center;
        }
        select.wb-input option { background: var(--ui-surface-elevated, #1e2430); color: var(--ui-ink, #f0ece2); }

        .wb-mode-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
        .wb-mode-badge {
          justify-self: start;
          padding: 6px 11px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          color: var(--ui-ink-muted, #aba69b);
        }
        .wb-mode-badge[data-mode="keyword"] {
          color: var(--ui-state-on, #58b97c);
          border-color: color-mix(in srgb, var(--ui-state-on, #58b97c) 34%, transparent);
          background: color-mix(in srgb, var(--ui-state-on, #58b97c) 10%, transparent);
        }
        .wb-mode-badge[data-mode="always"] {
          color: var(--ui-state-always, #6da8ec);
          border-color: color-mix(in srgb, var(--ui-state-always, #6da8ec) 34%, transparent);
          background: color-mix(in srgb, var(--ui-state-always, #6da8ec) 10%, transparent);
        }

        .wb-keys-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
        .wb-keys-chips:empty { display: none; }
        .wb-key-chip {
          padding: 2px 8px; border-radius: 999px; font-size: 11px;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.12));
          color: var(--ui-ink-muted, #aba69b);
        }

        .wb-secondary-grid { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 8px; align-items: center; }
        .wb-textarea {
          flex: 1 1 auto; resize: vertical; min-height: 220px; padding: 12px 14px;
          font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace);
          line-height: 1.65; font-size: 13px;
        }

        .wb-editor-empty {
          height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 10px;
          text-align: center; padding: 32px;
          color: var(--ui-ink-faint, #757168);
        }
        .wb-empty-icon {
          width: 48px; height: 48px; border-radius: 12px; display: grid; place-items: center;
          color: var(--ui-gold, #c69c6d);
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244, 241, 234, 0.10));
        }
        .wb-editor-empty strong { font-size: 15px; color: var(--ui-ink, #f0ece2); font-family: var(--font-title, serif); }
        .wb-editor-empty span { font-size: 12px; max-width: 340px; line-height: 1.65; }
        .wb-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }

        /* ── 平板与移动端 ──── */
        @media (max-width: 960px) {
          .wb-sidebar { width: 290px; }
          .wb-secondary-grid { grid-template-columns: minmax(0, 1fr); }
        }
        @media (max-width: 768px) {
          :host { padding: 0; }
          .wb-container { max-width: none; max-height: none; border-radius: 0; border: 0; }
          .wb-body { flex-direction: column; }
          .wb-sidebar { width: 100%; flex: 1 1 auto; min-height: 0; border-right: none; }
          .wb-editor { width: 100%; flex: 1 1 auto; min-height: 0; padding: 14px; }
          .wb-body.mobile-view-list .wb-editor { display: none; }
          .wb-body.mobile-view-editor .wb-sidebar { display: none; }
          .wb-mobile-bar { display: flex; }
          .wb-editor-head .wb-source-badge { display: none; }
          .wb-mode-row { grid-template-columns: minmax(0, 1fr); }
          .wb-item-toggle { width: 34px; height: 20px; }
          .wb-item-toggle::after { width: 14px; height: 14px; top: 2px; }
          .wb-item-toggle.on::after { transform: translateX(14px); }
        }
        @media (max-width: 600px) {
          .wb-header { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; }
          .wb-title { min-width: 0; font-size: 15px; line-height: 1.35; }
          .wb-actions { width: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
          .wb-actions .btn { width: 100%; min-width: 0; min-height: 44px; padding: 9px 10px; }
        }
      </style>

`;
