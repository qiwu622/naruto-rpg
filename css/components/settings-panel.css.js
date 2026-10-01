export const settingsStyles = `
        :host { position: fixed; inset: 0; z-index: 100000; color: var(--text-primary); font-family: var(--font-body); }
        
        .backdrop {
          position: absolute; inset: 0; background: rgba(3,4,6,0.85);
          display: flex; align-items: center; justify-content: center; padding: 24px;
          backdrop-filter: var(--blur-xl); -webkit-backdrop-filter: var(--blur-xl);
          animation: fade-in 0.3s var(--ease-out);
        }
        @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

        /* ── 卷轴容器 (Elegant Scroll) ──── */
        .panel {
          width: min(900px, 100%); max-height: 90vh;
          display: flex; flex-direction: column;
          background: rgba(var(--ink-rgb), 0.6);
          border: 1px solid var(--border-subtle);
          border-radius: var(--r-xl);
          box-shadow: var(--shadow-lg);
          position: relative;
          overflow: hidden;
        }

        /* 内部质感纹理 */
        .inner-bg {
          position: absolute; inset: 0; pointer-events: none; opacity: 0.015;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
          z-index: 0; mix-blend-mode: overlay;
        }

        /* ── 头部 ──── */
        .head {
          flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center;
          padding: 32px 48px 24px; position: relative; z-index: 2;
        }
        .title { 
          font-family: var(--font-title); font-size: 24px; font-weight: 800;
          color: var(--text-primary); letter-spacing: 4px;
          display: flex; align-items: center; gap: 16px;
        }
        .title span { color: var(--text-secondary); font-family: var(--font-brush); font-size: 28px; font-weight: normal; opacity: 0.5; }
        
        .close { 
          color: var(--text-tertiary); font-size: 28px; border: none; background: transparent; 
          cursor: pointer; width: 40px; height: 40px; transition: color 0.2s;
          display: flex; align-items: center; justify-content: center;
          font-family: var(--font-body); font-weight: 300; border-radius: 50%;
        }
        .close:hover { color: var(--text-primary); background: rgba(255,255,255,0.05); }

        /* ── 侧边与内容区 ──── */
        .layout {
          flex: 1 1 auto; min-height: 0; display: flex; flex-direction: row;
          position: relative; z-index: 1; overflow: hidden;
        }
        .sidebar {
          width: 220px; flex-shrink: 0; display: flex; flex-direction: column;
          border-right: 1px solid rgba(255,255,255,0.05); padding: 24px 0;
          overflow-y: auto; scrollbar-width: none; background: rgba(0,0,0,0.2); box-sizing: border-box;
        }
        .sidebar::-webkit-scrollbar { display: none; }
        .tab-btn {
          padding: 16px 32px; text-align: left; background: transparent; border: none;
          color: var(--text-tertiary); font-family: var(--font-title); font-size: 14px;
          cursor: pointer; transition: all 0.2s; position: relative; letter-spacing: 2px;
        }
        .tab-btn:hover { color: var(--text-primary); background: rgba(255,255,255,0.02); }
        .tab-btn.active { color: var(--text-primary); font-weight: 800; background: rgba(255,255,255,0.05); }
        .tab-btn:disabled { cursor: default; opacity: .46; }
        .tab-btn:disabled:hover { color: var(--text-tertiary); background: transparent; }
        .tab-btn.active:disabled { color: var(--text-primary); background: rgba(255,255,255,0.05); opacity: .72; }
        .tab-btn.active::before {
          content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
          background: var(--c-shuiro);
          box-shadow: 0 0 8px var(--c-shuiro); /* 激活指示辉光 */
        }
        
        .content {
          flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden;
          padding: 32px 48px 40px; scrollbar-width: none;
        }
        .content::-webkit-scrollbar { display: none; }
        
        .tab-pane { display: none; animation: fade-in-up 0.3s var(--ease-out); }
        .tab-pane.active { display: block; }
        @keyframes fade-in-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .pane-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); column-gap: 60px; row-gap: 48px; align-content: start; }


        section { position: relative; }

        h3 {
          margin: 0 0 24px; padding-bottom: 12px; padding-left: 12px; position: relative;
          color: var(--text-primary); font-size: 14px; font-family: var(--font-title); font-weight: 800;
          letter-spacing: 2px; border-bottom: 1px solid var(--border-subtle);
        }
        h3::before {
          content: ''; position: absolute; left: 0; top: 3px; width: 3px; height: 12px;
          border-radius: 2px;
          background: linear-gradient(180deg, var(--c-shuiro), color-mix(in srgb, var(--c-shuiro) 25%, transparent));
        }

        .grid { display: grid; grid-template-columns: 120px 1fr; gap: 24px 16px; align-items: center; }
        label { color: var(--text-secondary); font-size: 13px; letter-spacing: 1px; font-family: var(--font-title); }

        /* ── 高级表单控件 (Custom Form Controls) ──── */
        
        /* 文本框 & 下拉框 */
        input[type="text"], input[type="password"], input[type="number"], select, textarea {
          width: 100%; box-sizing: border-box; 
          background: rgba(255,255,255,0.02); color: var(--text-primary); 
          border: 1px solid var(--border-subtle); border-radius: var(--r-sm);
          padding: 10px 12px; font: inherit; font-size: 13px;
          outline: none; transition: all 0.2s var(--ease-out);
        }
        input:focus, select:focus, textarea:focus { 
          border-color: var(--text-primary); 
          background: rgba(255,255,255,0.05);
        }
        
        /* 针对 Select 隐藏默认箭头并替换 */
        select {
          appearance: none; -webkit-appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg width='10' height='6'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23ffffff' stroke-opacity='0.5' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 12px center;
          padding-right: 32px;
          cursor: pointer;
        }
        select option { background: #0b0e13; color: var(--text-primary); }

        /* 颜色选择器 (Ink Swatch) */
        .color-picker-wrap {
          display: flex; align-items: center; gap: 12px;
        }
        input[type="color"] { 
          appearance: none; -webkit-appearance: none; border: none; 
          width: 28px; height: 28px; border-radius: 50%; cursor: pointer; 
          padding: 0; background: transparent;
          box-shadow: 0 0 0 1px var(--border-subtle);
        }
        input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
        input[type="color"]::-webkit-color-swatch { border: none; border-radius: 50%; }

        /* 开关切换 (Toggle Switch) */
        input[type="checkbox"] {
          appearance: none; -webkit-appearance: none; width: 44px; height: 24px;
          border-radius: 12px; background: rgba(255,255,255,0.1); position: relative;
          cursor: pointer; border: none;
          transition: 0.2s; margin: 0; justify-self: start;
        }
        input[type="checkbox"]::after {
          content: ''; position: absolute; width: 18px; height: 18px;
          border-radius: 50%; top: 3px; left: 3px; background: var(--text-secondary);
          transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        input[type="checkbox"]:checked {
          background: linear-gradient(135deg, #f07452, var(--c-shuiro));
          box-shadow: 0 0 12px -2px color-mix(in srgb, var(--c-shuiro) 55%, transparent);
        }
        input[type="checkbox"]:checked::after { left: 23px; background: #fff; }

        /* 文件上传 */
        .file-input { padding: 8px 0 !important; font-size: 12px !important; color: var(--text-tertiary) !important; cursor: pointer; border: none !important; background: transparent !important; }
        .file-input::-webkit-file-upload-button {
          background: rgba(255,255,255,0.05); border: 1px solid var(--border-subtle); color: var(--text-primary);
          padding: 6px 14px; border-radius: var(--r-sm); cursor: pointer; margin-right: 12px;
          font-family: var(--font-title); transition: 0.2s; font-size: 12px;
        }
        .file-input::-webkit-file-upload-button:hover { background: rgba(255,255,255,0.1); border-color: var(--border-strong); }

        textarea { min-height: 80px; resize: vertical; padding: 12px !important; }

        .setting-note { margin: -8px 0 22px; color: var(--text-tertiary); font-size: 12px; line-height: 1.7; }

        /* ── 开关卡片（游玩与输出等布尔项） ──── */
        .setting-cards { display: flex; flex-direction: column; gap: 12px; max-width: 640px; }
        .setting-card {
          display: flex; align-items: center; gap: 14px; cursor: pointer;
          padding: 15px 17px; border-radius: 12px;
          background: rgba(var(--paper-rgb), 0.02);
          border: 1px solid var(--border-hairline);
          box-shadow: inset 0 1px 0 rgba(var(--paper-rgb), 0.04);
          transition: all 0.25s var(--ease-out);
        }
        .setting-card:hover {
          background: rgba(var(--paper-rgb), 0.04);
          border-color: var(--border-subtle);
          transform: translateY(-1px);
        }
        .setting-card:has(input:checked) {
          border-color: color-mix(in srgb, var(--c-shuiro) 30%, transparent);
          background:
            linear-gradient(120deg, color-mix(in srgb, var(--c-shuiro) 6%, transparent), transparent 55%),
            rgba(var(--paper-rgb), 0.025);
        }
        .setting-card .sc-icon {
          flex-shrink: 0; width: 38px; height: 38px; border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          color: var(--text-tertiary);
          background: rgba(var(--paper-rgb), 0.035);
          border: 1px solid var(--border-hairline);
          transition: all 0.25s;
        }
        .setting-card .sc-icon svg { width: 18px; height: 18px; }
        .setting-card:has(input:checked) .sc-icon {
          color: var(--c-shuiro);
          background: color-mix(in srgb, var(--c-shuiro) 10%, transparent);
          border-color: color-mix(in srgb, var(--c-shuiro) 30%, transparent);
          box-shadow: 0 0 14px -4px color-mix(in srgb, var(--c-shuiro) 60%, transparent);
        }
        .setting-card .sc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .setting-card .sc-title { font-size: 13px; font-weight: 700; color: var(--text-primary); letter-spacing: 1px; font-family: var(--font-title); }
        .setting-card .sc-desc { font-size: 11px; color: var(--text-tertiary); line-height: 1.6; }
        .setting-card input[type="checkbox"] { flex-shrink: 0; }
        .storage-section { margin-top: 34px; padding-top: 30px; border-top: 1px solid rgba(255,255,255,.065); }
        .storage-tool {
          overflow: hidden; border: 1px solid var(--border-hairline); border-radius: 8px;
          background: rgba(var(--paper-rgb), .018);
          box-shadow: inset 0 1px 0 rgba(var(--paper-rgb), .035);
        }
        .archive-toggle-row {
          display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 12px;
          min-width: 0; padding: 16px 17px; cursor: pointer;
          border-bottom: 1px solid var(--border-hairline);
        }
        .archive-toggle-row:hover { background: rgba(var(--paper-rgb), .025); }
        .storage-tool-icon {
          width: 38px; height: 38px; display: grid; place-items: center; border-radius: 8px;
          color: var(--c-shuiro); background: color-mix(in srgb, var(--c-shuiro) 9%, transparent);
          border: 1px solid color-mix(in srgb, var(--c-shuiro) 22%, transparent);
        }
        .storage-toggle-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .storage-toggle-copy strong { color: var(--text-primary); font: 700 13px/1.35 var(--font-title); letter-spacing: 0; }
        .storage-toggle-copy span { color: var(--text-tertiary); font: 400 11px/1.55 var(--font-body); letter-spacing: 0; }
        .storage-status {
          min-height: 39px; display: flex; align-items: center; padding: 0 17px;
          color: var(--text-secondary); font-size: 11px; letter-spacing: 0;
          border-bottom: 1px solid var(--border-hairline); background: rgba(0,0,0,.1);
        }
        .storage-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 12px; }
        .storage-actions .btn {
          min-height: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          padding: 8px 11px; border-radius: 7px; font-size: 11px; letter-spacing: 0;
        }
        .storage-actions .btn:disabled { cursor: wait; opacity: .5; }
        .support-tab { margin-top: auto; }
        .support-section { max-width: 640px; }
        .support-badge { border-color: rgba(198,156,109,.24); color: var(--c-kin-bright, #d8b27a); }
        .support-story { display: grid; gap: 11px; margin-bottom: 26px; }
        .support-story p { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.85; letter-spacing: 0; }
        .support-story .support-lead { color: var(--text-primary); font-size: 13px; line-height: 1.75; }
        .support-meta {
          display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
          margin: 0 0 3px; padding: 0 0 15px; border-bottom: 1px solid rgba(255,255,255,.06);
        }
        .support-meta span { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 11px; letter-spacing: 0; }
        .support-meta svg { color: rgba(198,156,109,.82); }
        .support-impact { margin-bottom: 22px; }
        .support-block-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
        .support-block-heading span { color: rgba(198,156,109,.68); font-size: 9px; line-height: 1.2; letter-spacing: 1.5px; }
        .support-block-heading h4 { margin: 0; color: var(--text-primary); font: 700 12px/1.4 var(--font-title); letter-spacing: 0; }
        .support-use-list {
          display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
          margin: 0; padding: 0; list-style: none; border-top: 1px solid rgba(255,255,255,.065);
        }
        .support-use-list li {
          min-width: 0; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 10px;
          min-height: 58px; padding: 10px 12px; box-sizing: border-box;
          color: var(--text-secondary); font-size: 11px; line-height: 1.5; letter-spacing: 0;
          border-bottom: 1px solid rgba(255,255,255,.065);
        }
        .support-use-list li:nth-child(odd) { border-right: 1px solid rgba(255,255,255,.065); }
        .support-use-icon {
          width: 30px; height: 30px; display: grid; place-items: center; color: var(--c-shuiro);
          border-radius: 7px; background: color-mix(in srgb, var(--c-shuiro) 7%, transparent);
        }
        .support-recognition {
          margin: 0 0 27px; padding: 11px 0 11px 14px; color: var(--text-primary);
          font-size: 12px; line-height: 1.75; letter-spacing: 0;
          border-left: 2px solid color-mix(in srgb, var(--c-shuiro) 72%, transparent);
          background: linear-gradient(90deg, color-mix(in srgb, var(--c-shuiro) 5%, transparent), transparent 72%);
        }
        .support-options-heading { margin-bottom: 12px; }
        .support-methods { display: grid; gap: 12px; }
        .support-method {
          min-width: 0; padding: 17px; border: 1px solid var(--border-hairline); border-radius: 8px;
          background: rgba(var(--paper-rgb), .02); box-shadow: inset 0 1px 0 rgba(var(--paper-rgb), .035);
        }
        .support-method-afdian {
          display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; align-items: center; gap: 14px;
        }
        .support-method-wechat {
          display: grid; grid-template-columns: minmax(150px, 1fr) minmax(230px, 290px); align-items: center; gap: 20px;
        }
        .support-method-overview { display: flex; align-items: flex-start; gap: 14px; min-width: 0; }
        .support-method-icon {
          flex: 0 0 42px; width: 42px; height: 42px; display: grid; place-items: center;
          color: var(--c-shuiro); border: 1px solid color-mix(in srgb, var(--c-shuiro) 24%, transparent);
          border-radius: 8px; background: color-mix(in srgb, var(--c-shuiro) 8%, transparent);
        }
        .support-method-copy { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
        .support-method-kicker { color: var(--text-secondary); font-size: 11px; line-height: 1.3; letter-spacing: 0; }
        .support-method-copy strong { color: var(--text-primary); font: 700 13px/1.4 var(--font-title); letter-spacing: 0; }
        .support-method-copy p { margin: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.6; letter-spacing: 0; }
        .support-primary-link {
          min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          padding: 8px 12px; border-radius: 7px; text-decoration: none; font-size: 11px; letter-spacing: 0;
        }
        .support-qr { min-width: 0; }
        .support-qr-frame {
          display: block; overflow: hidden; padding: 5px; border: 1px solid rgba(255,255,255,.16);
          border-radius: 7px; background: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.2);
        }
        .support-qr-frame:focus-visible, .support-image-actions a:focus-visible, .support-primary-link:focus-visible {
          outline: 2px solid var(--c-shuiro); outline-offset: 2px;
        }
        .support-qr-frame img { display: block; width: 100%; height: auto; aspect-ratio: 1; object-fit: contain; }
        .support-image-actions { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 9px; }
        .support-image-actions a {
          min-height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
          color: var(--text-secondary); font-size: 11px; line-height: 1; letter-spacing: 0; text-decoration: none;
        }
        .support-image-actions a:hover { color: var(--text-primary); }
        .support-community { margin-top: 27px; padding-top: 22px; border-top: 1px solid rgba(255,255,255,.065); }
        .support-community p { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.8; letter-spacing: 0; }
        .support-community-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
        .support-community-actions .support-community-link {
          min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          padding: 8px 11px; border: 1px solid var(--border-hairline); border-radius: 7px;
          color: var(--text-secondary); text-decoration: none; font-size: 10px; letter-spacing: 0;
        }
        .support-community-actions .support-community-link:hover { color: var(--text-primary); border-color: var(--border-subtle); }
        .support-gratitude {
          margin: 22px 0 4px; color: var(--text-secondary); font: 500 11px/1.7 var(--font-body);
          letter-spacing: 0; text-align: center;
        }
        .variable-grid { grid-template-columns: 110px minmax(0, 1fr); }
        .inline-field { display: flex; gap: 8px; min-width: 0; }
        .inline-field input { flex: 1; min-width: 0; }
        .prompt-preset-card {
          display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
          padding: 20px; border: 1px solid rgba(235,97,63,0.22); border-radius: var(--r-md);
          background: rgba(0,0,0,0.22);
        }
        .prompt-preset-card strong { color: var(--text-primary); font-family: var(--font-title); letter-spacing: 1px; }
        .prompt-preset-card span { color: var(--text-tertiary); font-size: 11px; }
        .prompt-preset-card p { margin: 2px 0 8px; color: var(--text-secondary); font-size: 12px; line-height: 1.7; }

        /* ── 配置卡片（管线/知识库等区块统一容器） ──── */
        .config-card {
          position: relative; overflow: hidden;
          padding: 20px; border-radius: 12px;
          background:
            radial-gradient(ellipse 90% 70% at 12% -20%, rgba(198,156,109,0.06), transparent 55%),
            rgba(var(--paper-rgb), 0.02);
          border: 1px solid var(--border-hairline);
          box-shadow: inset 0 1px 0 rgba(var(--paper-rgb), 0.05);
        }
        .config-card + .config-card { margin-top: 12px; }
        .config-card-center { text-align: center; }
        .config-card-toggle { display: flex; align-items: center; gap: 12px; color: var(--text-primary); cursor: pointer; }
        .config-card-toggle strong { font-family: var(--font-title); letter-spacing: 1px; font-size: 13px; }
        .config-card-title { margin: 0 0 10px; font-size: 13px; color: var(--text-primary); font-weight: 700; font-family: var(--font-title); letter-spacing: 1px; }
        .config-card-note { margin: 0 0 16px; font-size: 12px; color: var(--text-tertiary); line-height: 1.7; }
        .config-card-estimate {
          display: inline-block; margin-top: 4px;
          font-size: 11px; color: var(--c-kin-bright); letter-spacing: 0.5px;
          padding: 5px 12px; border-radius: var(--r-full);
          background: rgba(198,156,109,0.08); border: 1px solid rgba(198,156,109,0.22);
        }
        .config-card-blocked { margin-top: 8px; font-size: 11px; color: var(--text-tertiary); }
        .config-card-blocked:empty { display: none; }
        .config-card-grid { grid-template-columns: auto minmax(0, 1fr); gap: 12px 16px; align-items: center; }
        .config-label-sub { color: var(--text-tertiary) !important; font-size: 11px !important; }

        /* ── 音乐播放器专区 (Shinobi Music Player) ──── */
        .music-panel {
          grid-column: 1 / -1;
          display: flex; flex-direction: column; gap: 20px;
          padding-top: 10px;
        }
        
        .music-player-bar {
          display: flex; align-items: center; justify-content: space-between; gap: 24px;
          background: rgba(255,255,255,0.02); padding: 20px 24px; border-radius: var(--r-md);
          border: 1px solid var(--border-subtle);
        }
        
        .database-summary {
          min-height: 220px; display: flex; flex-direction: column; align-items: flex-start; justify-content: space-between; gap: 28px;
          padding: 24px 0;
        }
        .database-metrics {
          width: 100%; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
          border-top: 1px solid var(--border-subtle); border-bottom: 1px solid var(--border-subtle);
        }
        .database-metrics span {
          min-width: 0; padding: 18px 12px; display: flex; flex-direction: column; gap: 6px;
          color: var(--text-tertiary); font-size: 11px; border-right: 1px solid var(--border-subtle);
        }
        .database-metrics span:last-child { border-right: 0; }
        .database-metrics strong { color: var(--text-primary); font-size: 20px; font-weight: 700; }

        .music-info {
          display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0;
        }
        .music-now { font-family: var(--font-title); font-size: 15px; font-weight: 800; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 1px; }
        .music-status { font-size: 11px; color: var(--text-tertiary); letter-spacing: 1px; }

        .music-controls {
          display: flex; align-items: center; gap: 24px; flex-wrap: wrap; justify-content: flex-end;
        }
        
        .music-controls label { display: flex; align-items: center; gap: 10px; cursor: pointer; white-space: nowrap; font-size: 12px; color: var(--text-secondary); }
        
        .music-sync-status { font-size: 11px; color: var(--text-tertiary); min-width: 80px; white-space: nowrap; }
        
        input[type="range"] {
          -webkit-appearance: none; appearance: none; width: 100px; height: 4px;
          background: rgba(255,255,255,0.1); border-radius: 2px; outline: none; border: none; padding: 0;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none; width: 14px; height: 14px;
          border-radius: 50%; background: var(--text-primary); cursor: pointer;
        }

        .music-search-row {
          display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center;
        }
        
        .music-result-list {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
          min-height: 0; max-height: 240px; overflow-y: auto; padding-right: 8px;
          scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
        }
        .music-empty-hint { text-align: center; color: var(--text-tertiary); padding: 32px 16px; font-family: var(--font-body); font-size: 12px; line-height: 1.7; grid-column: 1/-1; }
        
        .music-item {
          display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;
          background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle);
          border-radius: var(--r-sm); transition: all 0.2s var(--ease-out); cursor: pointer;
        }
        .music-item:hover { background: rgba(255,255,255,0.05); border-color: var(--border-strong); transform: translateX(2px); }
        .music-item-info { display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
        .music-item-name { font-family: var(--font-title); font-size: 13px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .music-item-artist { font-size: 11px; color: var(--text-tertiary); }
        .music-play-icon { color: var(--text-primary); font-size: 14px; opacity: 0.3; transition: 0.2s; }
        .music-item:hover .music-play-icon { opacity: 1; transform: scale(1.1); }
        .music-item-fav { color: var(--text-tertiary); font-size: 14px; cursor: pointer; transition: 0.2s; padding: 4px; opacity: 0.3; }
        .music-item:hover .music-item-fav { opacity: 1; }
        .music-item-fav.favorited { color: var(--text-primary); opacity: 1; }
        .music-item-fav:hover { transform: scale(1.2); }

        .music-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border-subtle); }
        .music-tab { flex: 1; padding: 12px 8px; background: transparent; color: var(--text-tertiary); cursor: pointer; font-family: var(--font-title); font-size: 12px; letter-spacing: 1px; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: 0.2s; }
        .music-tab:hover { color: var(--text-secondary); }
        .music-tab.active { color: var(--text-primary); border-bottom-color: var(--text-primary); font-weight: bold; }
        


        /* ── 底部操作栏 (Elegant Footer) ──── */
        .actions { 
          flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; 
          padding: 24px 48px 32px; background: transparent; 
          border-top: 1px solid var(--border-subtle); position: relative; z-index: 2;
        }
        
        .btn {
          background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle);
          color: var(--text-primary); border-radius: var(--r-md); padding: 10px 28px; cursor: pointer; 
          font-family: var(--font-title); font-size: 13px; font-weight: 600; letter-spacing: 1px; 
          transition: all 0.2s; white-space: nowrap;
        }
        .btn:hover { background: rgba(255,255,255,0.08); border-color: var(--border-strong); }
        
        .btn.primary { 
          background: var(--text-primary); border-color: var(--text-primary); color: var(--c-void); box-shadow: 0 2px 8px rgba(255,255,255,0.15);
        }
        .btn.primary:hover { background: #ffffff; color: var(--c-void); box-shadow: 0 4px 12px rgba(255,255,255,0.25); transform: translateY(-1px); }

        .btn.ghost { border: none; color: var(--text-tertiary); padding: 10px 16px; background: transparent; }
        .btn.ghost:hover { background: rgba(255,255,255,0.05); color: var(--text-primary); border-color: transparent; }
        .btn-xs { padding: 4px 10px !important; font-size: 11px !important; }
        .preset-label { font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .preset-editor-overlay {
          position: absolute; inset: 0; z-index: 20;
          background: rgba(var(--ink-deep-rgb),0.95); backdrop-filter: var(--blur-lg);
          display: none; flex-direction: column; padding: 40px;
        }
        .preset-editor-overlay.active { display: flex; }
        .preset-editor-header {
          display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;
        }
        .preset-editor-title { color: var(--text-primary); font-size: 16px; font-family: var(--font-title); letter-spacing: 2px; font-weight: 800; }
        .preset-editor-close { background: transparent; border: none; color: var(--text-tertiary); font-size: 24px; cursor: pointer; transition: 0.2s; }
        .preset-editor-close:hover { color: var(--text-primary); }
        .preset-editor-textarea {
          flex: 1; width: 100%; box-sizing: border-box; resize: none;
          background: rgba(0,0,0,0.2); border: 1px solid var(--border-subtle); border-radius: var(--r-md);
          color: var(--text-primary); font: 14px/1.8 'JetBrains Mono', 'Fira Code', monospace;
          padding: 20px; outline: none; min-height: 300px;
        }
        .preset-editor-textarea:focus { border-color: var(--text-primary); background: rgba(255,255,255,0.02); }
        .preset-editor-actions { display: flex; gap: 16px; justify-content: flex-end; margin-top: 24px; }
        .preset-editor-hint { font-size: 12px; color: var(--text-tertiary); margin-top: 12px; }

        /* ── 2026 数字墨色设置壳 ──── */
        .backdrop {
          justify-content: flex-end; padding: 16px;
          background:
            radial-gradient(circle at 82% 12%, rgba(198,156,109,.09), transparent 30%),
            rgba(3,4,6,.82);
        }
        .panel {
          width: min(760px, calc(100vw - 32px)); height: calc(100vh - 32px); height: calc(100dvh - 32px); max-height: none;
          box-sizing: border-box;
          border-radius: 14px; border-color: rgba(232,228,217,.13);
          background:
            linear-gradient(145deg, rgba(255,255,255,.025), transparent 34%),
            rgba(10,13,18,.96);
          box-shadow: -24px 0 80px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.018) inset;
        }
        .panel::before {
          content: ''; position: absolute; inset: 0 auto 0 0; width: 2px; z-index: 3; pointer-events: none;
          background: linear-gradient(180deg, transparent, rgba(235,97,63,.78) 18%, rgba(198,156,109,.46) 72%, transparent);
        }
        .panel.creator {
          width: calc(100vw - 24px); height: calc(100vh - 24px); height: calc(100dvh - 24px); max-width: 1680px;
          margin: auto; border-radius: 12px;
          box-shadow: 0 28px 100px rgba(0,0,0,.56), 0 0 0 1px rgba(255,255,255,.02) inset;
        }
        .inner-bg {
          opacity: .035;
          background-image:
            linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px);
          background-size: 28px 28px;
          mask-image: linear-gradient(90deg, transparent, #000 22%, #000);
        }
        .head { min-height: 72px; padding: 14px 18px 14px 22px; border-bottom: 1px solid rgba(255,255,255,.055); box-sizing: border-box; }
        .title { gap: 11px; font-size: 18px; letter-spacing: 2px; line-height: 1.15; }
        .title span { font-size: 22px; opacity: .66; color: var(--c-shuiro); }
        .title small { display: block; margin-top: 5px; color: var(--text-tertiary); font: 500 10px/1.2 var(--font-body); letter-spacing: 1px; }
        .head-actions { display: flex; align-items: center; gap: 8px; }
        .workbench-link {
          min-height: 34px; padding: 7px 12px; border: 1px solid rgba(198,156,109,.22); border-radius: 7px;
          background: rgba(198,156,109,.055); color: var(--text-secondary); cursor: pointer;
          font: 600 11px/1.2 var(--font-title); letter-spacing: .5px;
        }
        .workbench-link:hover { color: var(--text-primary); border-color: rgba(198,156,109,.48); background: rgba(198,156,109,.1); }
        .close { width: 36px; height: 36px; font-size: 23px; }
        .layout { background: rgba(0,0,0,.08); }
        .sidebar {
          width: 176px; padding: 14px 10px; gap: 3px;
          background: rgba(0,0,0,.17); border-right-color: rgba(255,255,255,.055);
        }
        .creator .sidebar { width: 204px; padding-top: 18px; }
        .tab-btn {
          min-height: 42px; padding: 11px 14px; border-radius: 7px;
          font-family: var(--font-body); font-size: 12px; letter-spacing: .5px;
        }
        .tab-btn.active { background: linear-gradient(90deg, rgba(235,97,63,.115), rgba(255,255,255,.025)); }
        .tab-btn.active::before { top: 8px; bottom: 8px; width: 2px; border-radius: 9px; box-shadow: 0 0 12px rgba(235,97,63,.45); }
        .content { padding: 24px 28px 36px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.14) transparent; }
        .content::-webkit-scrollbar { display: block; width: 6px; }
        .content::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 8px; }
        .creator .content { padding: 22px 32px 42px; }
        .tab-pane.active ~ .tab-pane.active { margin-top: 38px; padding-top: 32px; border-top: 1px solid rgba(255,255,255,.07); }
        .pane-grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); column-gap: 36px; row-gap: 32px; }
        h3 { margin-bottom: 18px; padding-bottom: 10px; font-size: 13px; letter-spacing: 1px; }
        .grid { grid-template-columns: 116px minmax(0, 1fr); gap: 15px 14px; }
        .compact-grid { max-width: 560px; }
        input[type="text"], input[type="password"], input[type="number"], select, textarea { padding: 9px 10px; }
        .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
        .section-heading h3 { margin: 2px 0 12px; }
        .eyebrow { color: rgba(198,156,109,.72); font-size: 9px; letter-spacing: 1.8px; }
        .owner-badge { padding: 5px 8px; border: 1px solid rgba(129,199,132,.2); border-radius: 999px; color: #9dcc9f; font-size: 9px; white-space: nowrap; }
        .connection-section { max-width: 620px; }
        .connection-strip {
          position: sticky; top: -22px; z-index: 8; display: flex; align-items: center; gap: 8px;
          margin: -22px -32px 24px; padding: 10px 32px;
          border-bottom: 1px solid rgba(255,255,255,.065); background: rgba(9,12,16,.92); backdrop-filter: blur(14px);
          color: var(--text-tertiary); font-size: 11px;
        }
        .connection-strip button { margin-left: auto; border: 0; background: transparent; color: var(--c-shuiro); cursor: pointer; font-size: 11px; }
        .connection-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef5350; box-shadow: 0 0 8px rgba(239,83,80,.35); }
        .connection-dot.online { background: #81c784; box-shadow: 0 0 8px rgba(129,199,132,.4); }
        .media-image-section { margin-bottom: 32px; padding-bottom: 30px; border-bottom: 1px solid rgba(255,255,255,.065); }
        .actions {
          min-height: 64px; justify-content: flex-end; align-items: center; gap: 8px;
          padding: 10px 18px max(10px, env(safe-area-inset-bottom));
          background: rgba(8,11,15,.94); border-top-color: rgba(255,255,255,.07); backdrop-filter: blur(16px);
        }
        .actions .save-state { margin-right: auto; color: var(--text-tertiary); font-size: 10px; letter-spacing: .4px; }
        .actions .btn { min-width: 82px; padding: 9px 16px; border-radius: 7px; }
        .actions .btn.primary { grid-column: auto; background: linear-gradient(180deg, #f07452, #eb613f); border-color: rgba(235,97,63,.78); color: #fff; }
        .actions .btn.primary:hover { background: linear-gradient(180deg, #f48365, #eb613f); color: #fff; }
        .settings-toast {
          position: absolute; z-index: 60; left: 50%; bottom: 76px; max-width: min(420px, calc(100% - 32px));
          transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
          padding: 9px 13px; border: 1px solid rgba(232,228,217,.16); border-radius: 7px;
          background: rgba(10,13,18,.96); color: var(--text-primary); box-shadow: 0 10px 32px rgba(0,0,0,.38);
          font-size: 11px; line-height: 1.5; text-align: center; transition: opacity .18s ease, transform .18s ease;
        }
        .settings-toast.visible { opacity: 1; transform: translate(-50%, 0); }
        .workbench-editor-layer {
          display: none; position: absolute; z-index: 30;
          inset: 0 0 0 204px; min-width: 0; min-height: 0;
          background: #090d12;
        }
        .workbench-editor-layer.active { display: block; }
        .workbench-editor-layer > * { width: 100%; height: 100%; }

        @media(min-width: 769px) and (max-width: 1100px) {
          .workbench-editor-layer { inset: 0; }
          .storage-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .storage-actions .btn { width: 100%; }
        }

        @media(max-width: 768px) {
          .panel, .panel.creator { width: 100vw; height: 100vh; height: 100dvh; max-height: 100vh; max-height: 100dvh; margin: 0; border-radius: 0; border: none; }
          .backdrop { padding: 0; }
          .head { min-height: 64px; padding: max(8px, env(safe-area-inset-top)) 10px 8px 14px; }
          .title { font-size: 16px; gap: 8px; }
          .title span { font-size: 19px; }
          .title small { margin-top: 3px; font-size: 9px; letter-spacing: .4px; }
          .head-actions { gap: 5px; }
          .workbench-link { min-height: 44px; padding: 8px 10px; font-size: 10px; }
          .close { width: 44px; height: 44px; }
          /* One touch scroller keeps navigation and fields reachable even when
             the Android keyboard leaves only a short WebView viewport. */
          .layout { display: block; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
          .layout.editor-open { overflow: hidden; }
          .sidebar, .creator .sidebar {
            width: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
            flex: 0 0 auto; border-right: none; border-bottom: 1px solid rgba(255,255,255,.06);
            padding: 7px 8px; overflow: visible; gap: 4px;
          }
          .creator .sidebar { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          .tab-btn { min-height: 44px; white-space: normal; padding: 9px 5px; text-align: center; font-size: 10px; letter-spacing: 0; }
          .support-tab { margin-top: 0; }
          .tab-btn.active::before { width: 100%; height: 3px; top: auto; bottom: 0; left: 0; }
          .content, .creator .content { padding: 18px 16px 26px; overflow: visible; }
          .connection-strip { top: -18px; margin: -18px -16px 18px; padding: 9px 16px; }
          .pane-grid { grid-template-columns: 1fr; }
          .variable-grid { grid-template-columns: 1fr; gap: 10px; }
          .music-player-bar { flex-direction: column; align-items: stretch; gap: 16px; }
          .music-controls { flex-wrap: wrap; justify-content: space-between; }
          .music-result-list { grid-template-columns: 1fr; max-height: 220px; }
          .database-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .database-metrics span:nth-child(2) { border-right: 0; }
          .database-metrics span:nth-child(-n+2) { border-bottom: 1px solid var(--border-subtle); }
          .actions { min-height: 64px; padding-left: 12px; padding-right: 12px; }
          .actions .save-state { max-width: 45%; line-height: 1.35; }
          .actions .btn { min-width: 72px; min-height: 44px; padding: 9px 12px; }
          .workbench-editor-layer { inset: 0; }
          .storage-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .storage-actions .btn { width: 100%; min-height: 44px; }
          .support-meta { gap: 12px 16px; }
          .support-use-list { grid-template-columns: minmax(0, 1fr); }
          .support-use-list li:nth-child(odd) { border-right: 0; }
          .support-method-afdian, .support-method-wechat { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
          .support-method-afdian { gap: 12px; }
          .support-primary-link { width: 100%; min-height: 45px; box-sizing: border-box; }
          .support-method-wechat { gap: 16px; }
          .support-qr { width: min(100%, 360px); margin: 0 auto; }
          .support-image-actions a { min-height: 45px; }
          .support-community-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .support-community-actions .support-community-link { min-height: 45px; width: 100%; box-sizing: border-box; }
        }

        @media(max-width: 520px) {
          .grid, .variable-grid { grid-template-columns: minmax(0, 1fr); gap: 7px; }
          .grid > label:not(:first-child), .variable-grid > label:not(:first-child) { margin-top: 7px; }
          .grid input[type="checkbox"] { margin-bottom: 5px; }
          .section-heading { gap: 10px; }
          .section-heading .btn { padding-left: 9px; padding-right: 9px; }
          .music-search-row { grid-template-columns: minmax(0, 1fr) auto; }
          .music-controls { gap: 12px; }
          .actions .save-state { font-size: 9px; }
          .archive-toggle-row { grid-template-columns: 38px minmax(0, 1fr) auto; padding: 14px 12px; gap: 10px; }
          .storage-status { padding: 8px 12px; line-height: 1.5; }
          .support-community-actions { grid-template-columns: minmax(0, 1fr); }
        }
      </style>

`;
