export const timelineStyles = `
        :host { display: block; min-width: 0; height: 100%; overflow: hidden; position: relative; }
        .tl {
          display: flex; flex-direction: column; min-width: 0; height: 100%;
          overflow-x: hidden; overflow-y: auto; padding: 24px 16px;
          box-sizing: border-box;
          padding-bottom: calc(24px + var(--statusbar-h, 30px));
          background: transparent;
          scrollbar-width: none;
        }
        .tl::-webkit-scrollbar { display: none; }
        
        .tl-title {
          font-size: 18px; text-align: center; margin-bottom: 32px; letter-spacing: 10px; 
          font-family: var(--font-brush); font-weight: normal; 
          background: linear-gradient(135deg, #e8e4d9 0%, #c69c6d 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
          display: flex; align-items: center; justify-content: center; gap: 12px;
          text-shadow: 0 2px 10px rgba(198,156,109,0.1);
        }
        .tl-title::before, .tl-title::after {
          content: ''; height: 1px; width: 40px; 
          background: linear-gradient(90deg, transparent, rgba(198,156,109,0.5), transparent);
        }

        .branch {
          font-size: 12px; color: var(--text-secondary); padding: 0 0 8px 0; font-weight: normal; 
          font-family: var(--font-title); margin-top: 24px; margin-bottom: 16px;
          letter-spacing: 4px; border-bottom: 1px solid rgba(255,255,255,0.03);
          display: flex; align-items: center; gap: 10px; position: relative;
          min-width: 0; overflow-wrap: anywhere; word-break: break-word;
        }
        .branch::before {
          content: ''; width: 12px; height: 1px; background: var(--c-shuiro);
          box-shadow: 0 0 8px var(--c-shuiro);
        }
        
        .list {
          display: flex; flex-direction: column; gap: 6px; position: relative;
          min-width: 0; padding-left: 20px; margin-bottom: 32px;
        }
        .list::before {
          content: ''; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px;
          background: linear-gradient(to bottom, rgba(198,156,109,0.4) 0%, rgba(255,255,255,0.05) 100%);
        }
        
        .node {
          --node-accent: var(--c-shuiro);
          display: flex; flex-direction: column; min-width: 0;
          border-radius: 4px; overflow: hidden;
          transition: background 0.2s ease, box-shadow 0.2s ease;
          font-family: var(--font-title); position: relative;
          background: transparent; margin-left: 8px;
        }
        
        .node::before {
          content: ''; position: absolute; left: -20px; top: 18px;
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--surface-0); border: 1.5px solid rgba(198,156,109,0.3);
          box-shadow: 0 0 8px rgba(198,156,109,0.1);
          z-index: 2; transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
          box-sizing: border-box;
        }

        .node-toggle {
          appearance: none; width: 100%; min-width: 0; padding: 12px;
          border: 0; border-radius: 4px; background: transparent; color: inherit;
          display: flex; flex-direction: column; gap: 7px; text-align: left;
          font: inherit; cursor: pointer; overflow: hidden;
          transition: background 0.2s ease, box-shadow 0.2s ease;
        }
        .node-toggle:hover { background: rgba(255,255,255,0.035); }
        .node-toggle:focus-visible {
          outline: 2px solid var(--node-accent); outline-offset: -2px;
        }
        .node:hover::before {
          border-color: var(--node-accent); background: var(--node-accent);
          box-shadow: 0 0 10px color-mix(in srgb, var(--node-accent) 55%, transparent);
        }
        .node.cur {
          background: rgba(235,97,63,0.045);
        }
        .node.cur::before {
          border-color: var(--c-shuiro); background: var(--c-shuiro);
          box-shadow: 0 0 12px rgba(235,97,63,0.55);
        }
        .node.sel {
          background: rgba(255,255,255,0.025);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.055);
        }

        .node-heading {
          width: 100%; min-width: 0; display: flex; align-items: center;
          justify-content: space-between; gap: 8px;
        }
        .node-chapter {
          flex: 0 0 auto; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; font-size: 13px; font-weight: 600;
          color: var(--node-accent, var(--text-secondary)); letter-spacing: 0;
          font-family: var(--font-title); transition: color 0.2s;
        }
        .node.cur .node-chapter { color: var(--c-shuiro); }
        .node-statuses {
          min-width: 0; display: flex; justify-content: flex-end; align-items: center;
          flex-wrap: wrap; gap: 4px;
        }
        .node-status {
          min-width: 0; max-width: 100%; padding: 2px 5px; border-radius: 3px;
          border: 1px solid rgba(255,255,255,0.09); color: var(--text-tertiary);
          font: 10px/1.3 var(--font-body); letter-spacing: 0;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .current-status {
          color: var(--c-shuiro); border-color: rgba(235,97,63,0.32);
          background: rgba(235,97,63,0.08);
        }
        .compressed-status {
          color: #8fa4b8; border-color: rgba(143,164,184,0.28);
          background: rgba(143,164,184,0.08);
        }
        .maintenance-status {
          display: inline-flex; align-items: center; gap: 4px;
          color: #c9b893; border-color: rgba(198,156,109,0.22);
          background: rgba(198,156,109,0.055);
        }
        .maintenance-status svg { flex: 0 0 auto; }

        .node-meta {
          width: 100%; min-width: 0; display: flex; flex-wrap: wrap;
          align-items: center; gap: 4px 10px; color: var(--text-tertiary);
          font: 10px/1.45 var(--font-body); letter-spacing: 0;
        }
        .node-meta-item {
          min-width: 0; max-width: 100%; display: inline-flex; align-items: center; gap: 4px;
        }
        .node-meta-item svg { flex: 0 0 auto; opacity: 0.7; }
        .node-meta-item > span {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .node-summary {
          display: block; width: 100%; min-width: 0; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap;
          font: 12px/1.55 var(--font-body); color: var(--text-secondary); letter-spacing: 0;
        }

        .node-details {
          min-width: 0; margin: 0 12px; padding: 12px 0 14px;
          border-top: 1px solid rgba(255,255,255,0.07);
          animation: fade-down 0.2s ease-out;
        }
        .detail-heading {
          margin-bottom: 6px; color: var(--text-tertiary);
          font: 10px/1.4 var(--font-title); letter-spacing: 0;
        }

        .node-full-summary {
          max-width: 100%; color: var(--text-primary); opacity: 0.84;
          font: 12px/1.7 var(--font-body); letter-spacing: 0;
          overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap;
        }

        .maintenance-section {
          min-width: 0; margin-top: 14px; padding-top: 12px;
          border-top: 1px solid rgba(198,156,109,0.16);
        }
        .maintenance-heading {
          min-width: 0; display: flex; align-items: center; justify-content: space-between;
          gap: 8px; margin-bottom: 5px; color: #c9b893;
          font: 11px/1.4 var(--font-title); letter-spacing: 0;
        }
        .maintenance-heading > span:first-child {
          min-width: 0; display: inline-flex; align-items: center; gap: 5px;
          overflow-wrap: anywhere;
        }
        .maintenance-count {
          flex: 0 0 auto; color: var(--text-tertiary);
          font: 10px/1.4 var(--font-body); letter-spacing: 0;
        }
        .maintenance-list { min-width: 0; }
        .maintenance-entry {
          min-width: 0; padding: 9px 0;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .maintenance-entry:last-child { border-bottom: 0; padding-bottom: 2px; }
        .maintenance-entry-head {
          min-width: 0; display: flex; align-items: baseline; justify-content: space-between;
          gap: 8px; margin-bottom: 4px;
        }
        .maintenance-label {
          min-width: 0; color: var(--text-primary); font: 11px/1.45 var(--font-title);
          letter-spacing: 0; overflow-wrap: anywhere; word-break: break-word;
        }
        .maintenance-time {
          flex: 0 0 auto; color: var(--text-tertiary);
          font: 9px/1.45 var(--font-body); letter-spacing: 0; white-space: nowrap;
        }
        .maintenance-reason {
          max-width: 100%; color: var(--text-secondary); font: 11px/1.55 var(--font-body);
          letter-spacing: 0; overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap;
        }

        .node-actions {
          min-width: 0; display: flex; flex-wrap: wrap; gap: 8px;
          align-items: stretch; margin-top: 14px;
        }
        .jump-btn, .reroll-btn, .fork-btn {
          flex: 1 1 118px; min-width: 0; padding: 9px 8px; background: transparent;
          border: 1px solid rgba(255,255,255,0.15); border-radius: 2px;
          font: 11px/1.35 var(--font-title); font-weight: normal; letter-spacing: 0;
          white-space: normal; overflow-wrap: anywhere;
          cursor: pointer; transition: background 0.2s, border-color 0.2s, color 0.2s;
        }
        .jump-btn { color: var(--text-secondary); }
        .reroll-btn { color: var(--c-shuiro); border-color: rgba(235,97,63,0.3); }
        .jump-btn:hover { background: rgba(255,255,255,0.05); color: var(--text-primary); }
        .reroll-btn:hover { background: rgba(235,97,63,0.1); color: var(--text-primary); }
        .fork-btn { color: #bfc6ee; border-color: #aab8e740; }
        .fork-btn:hover { background: #aab8e711; }
        
        .cur-text {
          flex: 1 1 118px; min-width: 0; color: var(--c-shuiro);
          font: 11px/1.4 var(--font-title); letter-spacing: 0;
          display: flex; align-items: center; justify-content: center; gap: 8px; opacity: 0.8;
        }
        .cur-text::before, .cur-text::after { content: ''; flex: 1; height: 1px; background: rgba(235,97,63,0.2); }

        @media (max-width: 480px) {
          .tl { padding-left: 10px; padding-right: 10px; }
          .list { padding-left: 14px; }
          .node { margin-left: 4px; }
          .node::before { left: -14px; }
          .node-toggle { padding: 10px; }
          .node-details { margin-left: 10px; margin-right: 10px; }
          .node-heading, .maintenance-entry-head { align-items: flex-start; flex-direction: column; gap: 4px; }
          .node-statuses { justify-content: flex-start; }
          .maintenance-time { white-space: normal; }
          .node-actions { flex-direction: column; }
          .jump-btn, .reroll-btn, .fork-btn, .cur-text { flex-basis: auto; width: 100%; }
        }

        .empty {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 64px 24px; text-align: center; gap: 16px; margin: 32px 16px;
          background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 100%);
          border-radius: var(--r-md); border: 1px dashed rgba(255,255,255,0.08);
          position: relative; overflow: hidden;
        }
        .empty::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, rgba(198,156,109,0.4), transparent);
        }
        .empty-icon {
          width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;
          border-radius: 50%; background: rgba(198,156,109,0.05);
          color: var(--c-shuiro); font-size: 20px; font-family: var(--font-brush);
          box-shadow: 0 0 24px rgba(235,97,63,0.1), inset 0 0 12px rgba(198,156,109,0.1);
          margin-bottom: 8px; border: 1px solid rgba(198,156,109,0.15);
        }
        .empty-title {
          font-size: 16px; font-family: var(--font-brush); letter-spacing: 6px;
          color: var(--text-primary); text-shadow: 0 0 12px rgba(255,255,255,0.1);
        }
        .empty-desc {
          font-size: 12px; font-family: var(--font-body); letter-spacing: 2px;
          color: var(--text-tertiary); line-height: 1.8;
        }
        .empty-desc em {
          font-style: normal; color: var(--c-shuiro); opacity: 0.8;
        }

        .control-bento {
          margin-top: 48px; display: flex; flex-direction: column; gap: 8px;
          padding: 0;
        }
        .btn-ghost {
          padding: 12px 16px; font-size: 13px; color: var(--text-secondary); text-align: center;
          border: 1px solid rgba(255,255,255,0.05); border-radius: 2px;
          background: rgba(255,255,255,0.01); font-family: var(--font-title); font-weight: normal; letter-spacing: 4px;
          cursor: pointer; transition: all 0.2s;
        }
        .btn-ghost:hover { border-color: rgba(255,255,255,0.2); color: var(--text-primary); background: rgba(255,255,255,0.05); }
        
        .btn-ghost.danger { color: var(--c-kokihi); border-color: rgba(201,23,30,0.15); background: rgba(201,23,30,0.02); }
        .btn-ghost.danger:hover { border-color: rgba(201,23,30,0.4); background: rgba(201,23,30,0.08); }

        .modal-overlay {
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(3,4,6,0.8); backdrop-filter: var(--blur-lg); z-index: 100;
          display: none; flex-direction: column; align-items: center; justify-content: center; padding: 24px;
        }
        .modal-overlay.active { display: flex; animation: modal-fade-in 0.2s ease-out; }
        @keyframes modal-fade-in { from{opacity:0; backdrop-filter:blur(0);} to{opacity:1; backdrop-filter:var(--blur-lg);} }
        
        .modal-content {
          background: rgba(15, 18, 24, 0.95); border: 1px solid rgba(255,255,255,0.1);
          width: 100%; max-width: 320px; padding: 32px 24px; border-radius: var(--r-md);
          display: flex; flex-direction: column; gap: 16px;
          box-shadow: 0 24px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
          position: relative;
        }
        .modal-content::before {
          content: ''; position: absolute; top: 0; left: 24px; right: 24px; height: 1px;
          background: linear-gradient(90deg, transparent, var(--c-shuiro), transparent); opacity: 0.5;
        }
        
        .modal-title { font-size: 16px; color: var(--text-primary); text-align: center; font-weight: 900; letter-spacing: 2px; font-family: var(--font-title); margin-bottom: 8px;}
        .branch-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid rgba(255,255,255,0.05); border-radius: var(--r-sm); background: rgba(255,255,255,0.02); }
        .branch-name { font-size: 12px; color: var(--text-primary); font-weight: 800; }
        .branch-actions { display: flex; gap: 8px; }
        .promote-branch-btn { padding: 4px 10px; font-size: 10px; background: rgba(255,255,255,0.05); border: none; color: var(--text-primary); cursor: pointer; border-radius: 2px;}
        .promote-branch-btn:hover { background: rgba(255,255,255,0.15); }
        .del-branch-btn { padding: 4px 10px; font-size: 10px; background: rgba(201,23,30,0.1); border: none; color: var(--c-kokihi); cursor: pointer; border-radius: 2px;}
        .del-branch-btn:hover { background: rgba(201,23,30,0.25); }
        .modal-close { margin-top: 16px; padding: 12px; text-align: center; font-size: 11px; font-weight: 800; cursor: pointer; background: rgba(255,255,255,0.05); border: none; color: var(--text-secondary); border-radius: var(--r-sm); transition: 0.2s; letter-spacing: 2px; }
        .modal-close:hover { color: var(--text-primary); background: rgba(255,255,255,0.1); }
      </style>

`;

