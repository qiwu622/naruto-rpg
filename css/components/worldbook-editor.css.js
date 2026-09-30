export const worldbookStyles = `
        :host { display:flex; position:fixed; inset:0; background:rgba(var(--ink-deep-rgb),0.95); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); z-index:100002; font-family:'Noto Sans SC',system-ui,sans-serif; color:#e8e4d9; justify-content:center; align-items:center; padding:20px; }
        :host([embedded]) { position:relative; inset:auto; z-index:auto; width:100%; height:100%; padding:0; background:transparent; backdrop-filter:none; -webkit-backdrop-filter:none; }
        :host([embedded]) .wb-container { max-width:none; max-height:none; border-radius:0; border:0; }
        .wb-container { width:100%; max-width:1200px; height:100%; max-height:800px; background:#111418; border:1px solid rgba(198,156,109,0.2); border-radius:12px; box-shadow:0 20px 50px rgba(0,0,0,0.5); display:flex; flex-direction:column; overflow:hidden; }
        .wb-header { padding:14px 20px; border-bottom:1px solid rgba(198,156,109,0.15); display:flex; justify-content:space-between; align-items:center; background:linear-gradient(180deg, rgba(20,25,30,0.8), rgba(17,20,24,0.8)); }
        .wb-title { margin:0; font-size:16px; font-weight:700; color:#f4efe4; font-family:'Noto Serif SC',serif; letter-spacing:1px; }
        .wb-title span { font-size:12px; color:#c69c6d; font-weight:400; }
        .wb-actions { display:flex; gap:8px; }
        .btn { padding:6px 14px; background:rgba(232,228,217,0.05); color:#e8e4d9; border:1px solid rgba(232,228,217,0.15); border-radius:6px; cursor:pointer; font-size:12px; transition:all 0.2s; }
        .btn:hover { background:rgba(232,228,217,0.1); border-color:rgba(198,156,109,0.5); }
        .btn.primary { background:#eb613f; border-color:#eb613f; color:#fff; font-weight:600; }
        .btn.primary:hover { background:#d65130; }
        .btn.danger { background:transparent; border-color:#ef5350; color:#ef5350; }
        .btn.danger:hover { background:rgba(239,83,80,0.1); }
        .btn.sm { padding:3px 8px; font-size:11px; }
        .btn.good { background:rgba(129,199,132,0.1); border-color:rgba(129,199,132,0.3); color:#81c784; }
        .wb-body { display:flex; flex:1; min-height:0; }
        .wb-sidebar { width:300px; border-right:1px solid rgba(255,255,255,0.03); display:flex; flex-direction:column; background:rgba(0,0,0,0.2); }
        .wb-search-bar { padding:10px; border-bottom:1px solid rgba(255,255,255,0.03); }
        .wb-search-input { width:100%; box-sizing:border-box; padding:8px 12px; background:transparent; border:none; border-bottom:1px solid rgba(255,255,255,0.1); border-radius:0; color:#e8e4d9; font-size:13px; outline:none; }
        .wb-search-input:focus { border-bottom-color:#eb613f; }
        .wb-list { flex:1; overflow-y:auto; padding:4px; }
        .wb-list::-webkit-scrollbar { width:5px; }
        .wb-list::-webkit-scrollbar-thumb { background:rgba(232,228,217,0.15); border-radius:3px; }
        .wb-section-hdr { padding:8px 10px; font-size:11px; font-weight:700; color:#c69c6d; letter-spacing:2px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; border-bottom:1px solid rgba(198,156,109,0.1); }
        .wb-section-hdr:hover { background:rgba(198,156,109,0.05); }
        .wb-section-hdr .count { font-size:10px; color:rgba(232,228,217,0.4); font-weight:400; }
        .wb-item { padding:8px 10px; cursor:pointer; border-left:2px solid transparent; transition:all 0.15s; font-size:13px; display:flex; align-items:center; gap:8px; }
        .wb-item:hover { background:rgba(255,255,255,0.02); }
        .wb-item.active { background:rgba(255,255,255,0.04); border-left-color:#eb613f; }
        .wb-item-title { font-weight:600; color:#f4efe4; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .wb-item-meta { font-size:10px; color:rgba(232,228,217,0.3); white-space:nowrap; }
        .wb-item-meta[data-mode="keyword"] { color:#81c784; }
        .wb-item-meta[data-mode="always"] { color:#8cbcf0; }
        .wb-item-toggle { width:28px; height:16px; border-radius:8px; background:rgba(255,255,255,0.1); position:relative; cursor:pointer; flex-shrink:0; transition:background 0.2s; }
        .wb-item-toggle.on { background:#81c784; }
        .wb-item-toggle::after { content:''; position:absolute; top:2px; left:2px; width:12px; height:12px; border-radius:50%; background:#fff; transition:left 0.2s; }
        .wb-item-toggle.on::after { left:14px; }
        .wb-builtin-tag { font-size:10px; background:rgba(255,255,255,0.04); color:rgba(232,228,217,0.3); padding:1px 5px; border-radius:3px; flex-shrink:0; }
        .wb-editor { flex:1; display:flex; flex-direction:column; padding:20px 24px; overflow-y:auto; background:#070a0e; }
        .wb-editor::-webkit-scrollbar { width:5px; }
        .wb-editor::-webkit-scrollbar-thumb { background:rgba(232,228,217,0.15); border-radius:3px; }
        .wb-form-group { margin-bottom:14px; }
        .wb-form-label { display:block; font-size:11px; font-weight:700; color:#c69c6d; margin-bottom:4px; letter-spacing:1px; }
        .wb-input { width:100%; box-sizing:border-box; padding:8px 10px; background:rgba(0,0,0,0.15); border:none; border-bottom:1px solid rgba(255,255,255,0.1); border-radius:4px 4px 0 0; color:#e8e4d9; font-size:13px; outline:none; font-family:inherit; }
        .wb-input:focus { border-bottom-color:#eb613f; }
        .wb-input:disabled { opacity:0.4; cursor:not-allowed; }
        .wb-textarea { resize:vertical; min-height:220px; font-family:'JetBrains Mono','Consolas',monospace; line-height:1.5; font-size:12px; }
        .wb-readonly-banner { padding:8px 12px; background:rgba(198,156,109,0.08); border:1px solid rgba(198,156,109,0.15); border-radius:6px; font-size:12px; color:rgba(232,228,217,0.5); margin-bottom:14px; }
        .wb-editor-empty { display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; color:#6e6a65; font-size:14px; }
        .wb-sidebar-foot { padding:8px; border-top:1px solid rgba(232,228,217,0.04); display:flex; gap:6px; flex-wrap:wrap; }
        @media (max-width:768px) { .wb-body { flex-direction:column; } .wb-sidebar { width:100%; height:220px; border-right:none; border-bottom:1px solid rgba(198,156,109,0.15); } .wb-editor { padding:14px; } }
        @media (max-width:600px) {
          .wb-header { flex-direction:column; align-items:stretch; gap:10px; padding:12px; }
          .wb-title { min-width:0; font-size:15px; line-height:1.35; overflow-wrap:anywhere; }
          .wb-title span { display:block; margin-top:3px; font-size:11px; line-height:1.4; letter-spacing:0; overflow-wrap:anywhere; }
          .wb-actions { width:100%; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
          .wb-actions .btn { width:100%; min-width:0; min-height:44px; padding:9px 10px; }
        }
      </style>

`;

