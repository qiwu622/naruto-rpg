import { multiplayerTheme } from './multiplayer-theme.css.js';

export const multiplayerPanelStyles = `
  :host {
    ${multiplayerTheme}
    display:block; min-width:0; container:multiplayer / inline-size; color-scheme:dark;
    color:var(--mp-text); font:400 14px/1.65 var(--mp-font); -webkit-font-smoothing:antialiased;
    --panel-accent:var(--mp-accent); --panel-muted:var(--mp-muted); --panel-text-2:var(--mp-secondary);
  }
  *, *::before, *::after { box-sizing:border-box; }
  [hidden] { display:none!important; }
  svg { flex-shrink:0; }
  h2,h3,p { margin:0; }
  h3 { font-size:15px; font-weight:650; }
  button,input,textarea,select { font:inherit; }
  button { cursor:pointer; }
  .panel { min-width:0; border:1px solid var(--mp-border); border-radius:16px; background:var(--mp-bg); box-shadow:var(--mp-shadow); overflow:hidden; }
  .panel-header { display:flex; justify-content:space-between; gap:24px; align-items:center; padding:28px 32px; border-bottom:1px solid var(--mp-border); position:relative; }
  .panel-header::before { content:''; position:absolute; width:3px; top:30px; bottom:30px; left:0; background:var(--mp-gold); border-radius:0 3px 3px 0; }
  .brand { display:flex; gap:16px; align-items:center; min-width:0; }
  .brand-icon { display:grid; place-items:center; flex:none; width:48px; height:48px; border-radius:14px; color:var(--mp-gold); background:rgba(198,156,109,.08); border:1px solid rgba(198,156,109,.22); }
  .eyebrow { display:block; color:var(--mp-gold); font-size:10px; font-weight:650; letter-spacing:2.4px; margin-bottom:6px; }
  .panel-header h2 { font:650 27px/1.3 var(--font-title, var(--mp-font)); letter-spacing:1px; }
  .panel-header .muted { margin-top:7px; }
  .header-aside { display:grid; gap:4px; text-align:right; flex:none; }
  .header-aside strong { color:var(--mp-secondary); font-size:13px; font-weight:500; }
  .header-aside span { color:var(--mp-muted); font-size:12px; }
  .setup { padding:24px 32px 32px; display:grid; gap:24px; }
  .setup-intro { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .setup-intro h3 { font-size:16px; }
  .setup-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; align-items:stretch; }
  .card { min-width:0; padding:22px; border:1px solid var(--mp-border); border-radius:var(--mp-radius); background:var(--mp-card); }
  .card-title { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .card-title svg { color:var(--mp-gold); }
  .card-title h3 { margin:0; }
  .setup-grid > .card { display:flex; flex-direction:column; gap:16px; position:relative; }
  .setup-grid .card-title { margin:0; }
  .setup-grid .card-title h3 { font-size:18px; }
  .setup-grid .card-title > svg { width:22px; height:22px; }
  .setup-grid .field { margin:0; }
  .setup-grid .card > .btn-primary { margin-top:auto; width:100%; }
  .setup-grid .card > .toolbar { margin-top:auto; }
  .setup-grid .card > .toolbar button { width:100%; }
  .card-index { margin-left:auto; font:400 26px/1.2 var(--font-title,serif); color:#555b64; }
  .muted { color:var(--mp-muted); font-size:13px; line-height:1.75; overflow-wrap:anywhere; }
  .field,label { display:grid; gap:7px; margin:12px 0; color:var(--mp-secondary); font-size:13px; min-width:0; }
  .field > span { font-weight:550; }
  input,textarea,select { display:block; width:100%; min-width:0; max-width:100%; min-height:40px; padding:9px 12px; border:1px solid var(--mp-border); border-radius:8px; background:var(--mp-input); color:var(--mp-text); font-size:14px; outline:none; transition:border-color .18s,box-shadow .18s; }
  input::placeholder,textarea::placeholder { color:#858d99; }
  input:hover,textarea:hover,select:hover { border-color:var(--mp-border-strong); }
  input:focus,textarea:focus,select:focus { border-color:var(--mp-gold); box-shadow:0 0 0 3px rgba(198,156,109,.12); }
  input:disabled,textarea:disabled,select:disabled { opacity:.75; cursor:default; }
  input[type=file] { padding:7px; font-size:12px; }
  input::file-selector-button { border:0; border-radius:5px; padding:6px 8px; margin-right:8px; background:var(--mp-raised); color:var(--mp-secondary); }
  textarea { min-height:84px; resize:vertical; }
  select { padding-right:30px; cursor:pointer; text-overflow:ellipsis; }
  button,.btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:40px; max-width:100%; padding:9px 14px; color:var(--mp-text); border:1px solid var(--mp-border); border-radius:8px; background:var(--mp-raised); font:550 13px/1.5 var(--mp-font); transition:background .18s,border-color .18s,color .18s; overflow-wrap:anywhere; }
  button:hover { background:#293039; border-color:var(--mp-border-strong); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button:focus-visible,summary:focus-visible { outline:2px solid var(--mp-gold); outline-offset:3px; }
  .btn-primary { background:var(--mp-accent); border-color:var(--mp-accent); color:#150b07; font-weight:700; }
  .btn-primary:hover { background:#f17c60; border-color:#f17c60; }
  .btn-danger { background:transparent; color:var(--mp-danger); border-color:rgba(247,154,151,.26); }
  .btn-danger:hover { background:rgba(247,154,151,.1); border-color:rgba(247,154,151,.45); }
  .btn-sm { min-height:34px; padding:6px 11px; font-size:12px; }
  .toolbar,.row { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
  .toolbar { margin-top:14px; }
  .row { margin:10px 0; }
  .segmented { display:flex; gap:4px; padding:4px; border:1px solid var(--mp-border); border-radius:10px; background:var(--mp-input); }
  .segmented button { min-width:0; flex:1; background:transparent; border:1px solid transparent; color:var(--mp-muted); padding:7px 10px; min-height:36px; }
  .segmented button[aria-pressed=true] { background:var(--mp-raised); color:var(--mp-text); border-color:var(--mp-border-strong); }
  .segmented button[aria-pressed=true] svg { color:var(--mp-gold); }
  .visually-hidden { position:absolute!important; width:1px!important; height:1px!important; min-height:0!important; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  .history-card { padding:0; overflow:hidden; }
  .history-head { display:flex; gap:12px; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--mp-border); }
  .history-head .card-title { margin:0; }
  .history-head button { flex:none; }
  #local-room-history { padding:4px 20px; }
  .history-row { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:14px 0; border-bottom:1px solid var(--mp-border); }
  .history-row:last-child { border-bottom:0; }
  .history-copy { display:grid; min-width:0; gap:3px; }
  .history-copy strong { color:var(--mp-text); font-size:14px; overflow-wrap:anywhere; }
  .history-copy small { color:var(--mp-muted); font-size:12px; }
  .history-row button { flex:none; }
  .history-empty { display:flex; align-items:center; gap:12px; min-height:92px; padding:16px 0; }
  .history-empty svg { color:var(--mp-gold); opacity:.8; }
  .history-empty strong { display:block; color:var(--mp-secondary); font-weight:500; }
  .history-caption { padding:12px 20px; border-top:1px solid var(--mp-border); font-size:12px; color:var(--mp-muted); }
  #room-workspace { padding:24px 32px 32px; }
  .room-status { padding:0; background:transparent; border:0; }
  .room-meta { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .room-id-line { display:flex; align-items:center; gap:10px; min-width:0; }
  .room-id-line svg { color:var(--mp-gold); }
  .room-id-line strong { overflow-wrap:anywhere; font:600 15px/1.5 var(--font-mono,ui-monospace,monospace); }
  .pills { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
  .pill { display:inline-flex; align-items:center; gap:6px; max-width:100%; border:1px solid var(--mp-border); border-radius:6px; background:rgba(255,255,255,.025); color:var(--mp-secondary); padding:4px 8px; font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
  .pill::before { content:''; flex:none; width:5px; height:5px; border-radius:50%; background:var(--mp-muted); }
  .pill[data-state=ready],.pill[data-state=open] { color:var(--mp-success); border-color:rgba(128,203,166,.24); background:rgba(128,203,166,.06); }
  .pill[data-state=ready]::before,.pill[data-state=open]::before { background:var(--mp-success); }
  .pill[data-state=waiting],.pill[data-state=reconnecting] { color:var(--mp-warning); }
  .pill[data-state=waiting]::before,.pill[data-state=reconnecting]::before { background:var(--mp-warning); }
  .member-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin:20px 0 0; }
  .member-card { display:flex; gap:12px; align-items:center; min-width:0; padding:16px; background:var(--mp-card); border:1px solid var(--mp-border); border-radius:var(--mp-radius); }
  .member-card[data-empty=true] { border-style:dashed; background:transparent; }
  .member-avatar { flex:none; display:grid; place-items:center; width:42px; height:42px; border-radius:12px; background:rgba(198,156,109,.12); border:1px solid rgba(198,156,109,.26); color:#dec3a0; font:600 20px/1 var(--mp-font); }
  .member-card[data-seat=B] .member-avatar { background:rgba(122,163,203,.12); border-color:rgba(122,163,203,.24); color:#adcae7; }
  .member-copy { min-width:0; display:grid; gap:4px; }
  .member-name { color:var(--mp-text); font-weight:650; font-size:15px; overflow-wrap:anywhere; }
  .member-meta { color:var(--mp-muted); font-size:12px; }
  .member-card[data-state=ready] .member-meta { color:var(--mp-success); }
  .room-actions { justify-content:space-between; padding:16px 0 20px; margin:0; }
  .room-actions .btn-primary { min-width:220px; }
  .notice { padding:12px 14px; border:1px solid var(--mp-border); border-radius:10px; background:rgba(255,255,255,.025); color:var(--mp-secondary); font-size:13px; line-height:1.75; overflow-wrap:anywhere; }
  .notice.good { border-color:rgba(128,203,166,.26); background:rgba(128,203,166,.06); }
  .notice.error { color:#ffc3bc; border-color:rgba(247,154,151,.5); background:rgba(199,58,58,.12); }
  #invite-box,#genesis-review { margin-top:16px; }
  .share-grid { display:grid; gap:8px; margin:12px 0; }
  .share-row { display:grid; grid-template-columns:64px minmax(0,1fr) auto; gap:10px; align-items:center; }
  .share-row code { min-width:0; overflow-wrap:anywhere; font-size:14px; color:var(--mp-text); }
  .share-actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .member-alert { margin-top:12px; padding:12px 14px; color:var(--mp-warning); border:1px solid rgba(232,189,118,.3); background:rgba(232,189,118,.07); border-radius:10px; }
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--mp-border); margin:0 0 20px; }
  .tabs button { border:0; border-radius:0; border-bottom:2px solid transparent; padding:12px 16px; background:transparent; color:var(--mp-muted); }
  .tabs button[aria-selected=true] { border-bottom-color:var(--mp-gold); color:var(--mp-text); background:linear-gradient(0deg,rgba(198,156,109,.07),transparent); }
  .tabs button[aria-selected=true] svg { color:var(--mp-gold); }
  [data-view=turn] { display:grid; gap:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr)); gap:16px; }
  .turn-settings-grid { grid-template-columns:minmax(0,.72fr) minmax(0,1.28fr); align-items:start; }
  .narrative-card,.narrative-mode,.narrative-presets { display:grid; gap:14px; min-width:0; align-content:start; }
  .narrative-card .card-title { margin:0; }
  .narrative-card .toolbar,.narrative-card .row { margin:0; }
  .narrative-card .subsection { border-top:1px solid var(--mp-border); padding-top:16px; }
  button[aria-pressed=true]:not(.segmented button) { color:#ecd0a9; background:rgba(198,156,109,.09); border-color:rgba(198,156,109,.45); }
  .ai-settings-card,.ai-settings-editor { display:grid; gap:16px; align-content:start; }
  .ai-settings-card .card-title { margin:0; }
  .ai-settings-summary { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:14px; border:1px solid rgba(128,203,166,.25); border-radius:10px; background:rgba(128,203,166,.055); }
  .ai-settings-summary > div { min-width:0; overflow-wrap:anywhere; }
  .ai-settings-summary button { flex:none; }
  @container multiplayer (min-width:861px) {
    .turn-settings-grid:has(#ai-settings-editor[hidden]) { grid-template-columns:minmax(0,1fr); }
    .turn-settings-grid:has(#ai-settings-editor[hidden]) .narrative-card { grid-template-columns:minmax(0,.72fr) minmax(0,1.28fr); gap:24px; }
    .turn-settings-grid:has(#ai-settings-editor[hidden]) .narrative-presets { padding-left:24px; border-left:1px solid var(--mp-border); }
    .turn-settings-grid:has(#ai-settings-editor[hidden]) .subsection { padding-top:0; border-top:0; }
    .turn-settings-grid:has(#ai-settings-editor[hidden]) .ai-settings-card { grid-template-columns:auto minmax(0,1fr); align-items:center; gap:24px; }
  }
  .ai-settings-grid { display:grid; gap:16px; }
  .ai-section-label { color:var(--mp-secondary); font-size:13px; font-weight:600; }
  .credential-policy-options { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-top:10px; }
  .credential-policy-options button { display:grid; align-content:start; justify-items:start; gap:6px; text-align:left; padding:12px; background:var(--mp-input); }
  .credential-policy-options strong { font-size:13px; }
  .credential-policy-options span { color:var(--mp-muted); font-weight:400; font-size:12px; }
  .credential-policy-options button[aria-checked=true] { border-color:var(--mp-gold); background:rgba(198,156,109,.075); }
  .credential-policy-options button[aria-checked=true] strong { color:#e5c49b; }
  .ai-profile-field { padding:14px; background:var(--mp-input); border:1px solid var(--mp-border); border-radius:10px; }
  .ai-profile-field label:first-child { margin-top:0; }
  .ai-profile-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; }
  .scheme-import { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:8px; margin:12px 0; }
  .scheme-import label { margin:0; }
  .scheme-import .btn-sm { min-height:40px; }
  .ai-current-turn { display:flex; align-items:center; gap:9px; padding:12px; border:1px solid var(--mp-border); border-radius:9px; color:var(--mp-secondary); font-size:13px; overflow-wrap:anywhere; }
  .ai-current-turn svg { color:var(--mp-gold); }
  .ai-confirmation-status { color:var(--mp-secondary); font-size:13px; }
  .policy-binding-status { display:flex; flex-wrap:wrap; gap:6px; }
  .ai-primary-action { width:100%; }
  .ai-disclosure { padding-top:12px; border-top:1px solid var(--mp-border); }
  .ai-disclosure summary { color:var(--mp-muted); cursor:pointer; font-size:12px; }
  .ai-disclosure p { margin-top:10px; color:var(--mp-muted); font-size:12px; line-height:1.8; }
  .opening-workspace { min-width:0; }
  .opening-intro { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:16px; }
  .opening-intro h3 { margin-bottom:5px; font-size:17px; }
  .opening-intro > .pill { flex:none; }
  #opening-shared-time { margin:0 0 16px; padding:12px 18px 16px; min-inline-size:0; }
  #opening-shared-time legend { color:var(--mp-gold); padding:0 6px; font-size:13px; }
  .opening-time-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
  .opening-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
  .opening-card { margin:0; }
  .opening-card[data-own=false] { background:rgba(255,255,255,.015); }
  .opening-card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding-bottom:14px; border-bottom:1px solid var(--mp-border); margin-bottom:4px; }
  .opening-card-head > div { display:flex; align-items:center; gap:9px; }
  .seat-mark { display:inline-grid; place-items:center; width:30px; height:30px; border-radius:8px; border:1px solid rgba(198,156,109,.24); background:rgba(198,156,109,.08); color:var(--mp-gold); font-weight:650; }
  .opening-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 12px; }
  .opening-wide { grid-column:1 / -1; }
  .opening-card textarea { min-height:76px; }
  .opening-save,.opening-detailed { width:100%; margin-top:10px; }
  .opening-readonly-note { padding:10px 0; }
  [data-opening-detail-summary] { margin-top:10px; font-size:12px; }
  .opening-conflicts { display:grid; gap:8px; margin-bottom:16px; }
  .opening-conflicts:empty { display:none; }
  .opening-conflict { padding:10px 14px; border:1px solid var(--mp-border); border-radius:9px; font-size:13px; color:var(--mp-secondary); }
  .opening-conflict[data-severity=blocking] { color:var(--mp-danger); border-color:rgba(247,154,151,.35); background:rgba(247,154,151,.06); }
  .opening-conflict[data-severity=warning] { color:var(--mp-warning); border-color:rgba(232,189,118,.3); }
  .opening-conflict[data-severity=info] { color:#a9caeb; border-color:rgba(169,202,235,.22); }
  .generation-full { margin-bottom:20px; }
  .generation-card { padding:18px; border:1px solid var(--mp-border); border-radius:var(--mp-radius); background:var(--mp-card); position:relative; overflow:hidden; }
  .generation-card[data-tone=running] { border-color:rgba(232,189,118,.45); }
  .generation-card[data-tone=running]::after { content:''; position:absolute; pointer-events:none; top:0; left:0; width:42%; height:2px; background:linear-gradient(90deg,transparent,var(--mp-gold),#fff3cf,transparent); animation:mp-progress-light 3.6s linear infinite; }
  .generation-card[data-tone=error] { border-color:var(--mp-danger); background:#2b1b1e; }
  .generation-card[data-tone=warning] { border-color:rgba(232,189,118,.5); background:#25211a; }
  .generation-card[data-tone=success] { border-color:rgba(128,203,166,.4); }
  .generation-heading { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .generation-heading strong { flex:1; font-size:15px; min-width:0; }
  .generation-indicator { width:10px; height:10px; flex:none; border-radius:50%; background:var(--mp-muted); }
  [data-tone=running] .generation-indicator { width:13px; height:13px; background:transparent; border:2px solid rgba(232,189,118,.2); border-top-color:var(--mp-warning); animation:mp-spin 1s linear infinite; }
  [data-tone=error] .generation-indicator { background:var(--mp-danger); border-radius:3px; }
  [data-tone=warning] .generation-indicator { background:var(--mp-warning); }
  [data-tone=success] .generation-indicator { background:var(--mp-success); }
  .generation-time { font-size:12px; font-variant-numeric:tabular-nums; color:var(--mp-gold); }
  .generation-steps { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); list-style:none; padding:0; margin:16px 0; gap:8px; counter-reset:phase; }
  .generation-steps li { counter-increment:phase; border-top:2px solid var(--mp-border); padding-top:8px; color:var(--mp-muted); font-size:12px; }
  .generation-steps li::before { content:counter(phase,decimal-leading-zero); margin-right:6px; font:11px var(--font-mono,monospace); opacity:.7; }
  .generation-steps li[data-state=done] { color:var(--mp-success); border-color:var(--mp-success); }
  .generation-steps li[data-state=active] { color:var(--mp-warning); border-color:var(--mp-warning); }
  .generation-steps li[data-state=paused] { color:var(--mp-danger); border-color:var(--mp-danger); }
  .generation-detail { color:var(--mp-secondary); font-size:13px; line-height:1.8; margin-bottom:14px; overflow-wrap:anywhere; }
  .generation-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .generation-diagnostics { margin-top:14px; color:var(--mp-muted); font-size:12px; }
  .generation-diagnostics summary { cursor:pointer; }
  pre { margin:10px 0 0; max-height:280px; overflow:auto; padding:12px; border:1px solid var(--mp-border); border-radius:8px; background:var(--mp-input); color:var(--mp-secondary); white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.7 var(--font-mono,monospace); }
  [data-view=chat] { display:grid; gap:16px; }
  #load-chat-history { justify-self:center; }
  .messages { display:flex; flex-direction:column; gap:14px; min-height:220px; max-height:440px; overflow:auto; padding:20px; color:var(--mp-muted); }
  .message { max-width:85%; align-self:flex-start; padding:12px 14px; border:1px solid var(--mp-border); border-radius:3px 12px 12px 12px; background:var(--mp-raised); color:var(--mp-text); overflow-wrap:anywhere; }
  .message small { display:block; margin-bottom:5px; color:var(--mp-muted); font-size:11px; }
  .message[data-own=true] { align-self:flex-end; border-radius:12px 3px 12px 12px; background:rgba(198,156,109,.085); border-color:rgba(198,156,109,.24); }
  #chat-form { display:grid; grid-template-columns:minmax(0,1fr) auto; margin:0; gap:10px; }
  .chat-empty { margin:auto; display:grid; place-items:center; gap:8px; padding:24px; text-align:center; }
  .chat-empty svg { color:var(--mp-gold); margin-bottom:4px; }
  .chat-empty strong { color:var(--mp-secondary); font-weight:500; }
  .chat-empty span { font-size:12px; }
  .details-group { margin-top:20px; border:1px solid var(--mp-border); border-radius:var(--mp-radius); background:var(--mp-card); }
  .details-group > summary { display:flex; align-items:center; gap:10px; padding:16px 18px; cursor:pointer; list-style:none; color:var(--mp-secondary); font-weight:550; }
  .details-group > summary::-webkit-details-marker { display:none; }
  .details-group > summary svg:first-child { color:var(--mp-gold); }
  .details-group > summary svg:last-child { margin-left:auto; transition:transform .2s; }
  .details-group[open] > summary { border-bottom:1px solid var(--mp-border); }
  .details-group[open] > summary svg:last-child { transform:rotate(180deg); }
  .details-body { display:grid; gap:16px; padding:18px; }
  .room-tool-grid .card { background:var(--mp-input); padding:16px; }
  .room-tool-grid h3 { margin-bottom:12px; }
  .custom-codes { margin:0; }
  .custom-codes summary { cursor:pointer; color:var(--mp-secondary); font-size:13px; }
  .active-session { min-width:0; }
  .active-head { display:flex; align-items:center; flex-wrap:wrap; justify-content:space-between; gap:12px; padding:18px; border-bottom:1px solid var(--mp-border); }
  .active-title { display:flex; align-items:center; gap:10px; min-width:0; }
  .active-title strong { font-size:16px; font-weight:650; }
  .live-dot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--mp-success); box-shadow:0 0 0 4px rgba(128,203,166,.08); }
  .active-turn-label { color:var(--mp-muted); font-size:12px; margin-top:3px; }
  .active-body { padding:16px; display:grid; gap:14px; }
  #active-generation { padding:14px; }
  .compact-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .compact-action { padding:12px; border:1px solid var(--mp-border); border-radius:10px; background:var(--mp-card); min-width:0; }
  .compact-action strong { display:block; color:var(--mp-muted); font-size:12px; font-weight:500; }
  .compact-action span { display:block; margin-top:6px; font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .compact-action[data-state=sent] { border-color:rgba(128,203,166,.26); }
  .compact-action[data-state=sent] strong { color:var(--mp-success); }
  .compact-toolbar { display:flex; align-items:end; flex-wrap:wrap; gap:8px; }
  .compact-toolbar label { display:grid; flex:1; margin:0; font-size:12px; min-width:140px; }
  .chat-toggle { flex:none; }
  .unread-badge { display:inline-grid; place-items:center; min-width:18px; height:18px; padding:0 5px; border-radius:8px; background:var(--mp-accent); color:#180d08; font:700 11px/1 var(--mp-font); }
  .active-chat { display:grid; gap:10px; }
  .active-chat .messages { min-height:140px; max-height:220px; padding:10px; border:1px solid var(--mp-border); border-radius:10px; }
  .active-chat-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; }
  .active-footer { display:grid; gap:10px; padding-top:12px; border-top:1px solid var(--mp-border); }
  .active-footer .toolbar { margin:0; justify-content:space-between; }
  .active-footer > .muted { font-size:12px; }
  #operation-status:empty,#error-output:empty { display:none; }
  #operation-status { padding:12px 20px; border-top:1px solid var(--mp-border); }
  #error-output { margin:12px; }
  @keyframes mp-spin { to { transform:rotate(360deg); } }
  @keyframes mp-progress-light { from { transform:translateX(-100%); } to { transform:translateX(350%); } }
  @container multiplayer (max-width:860px) {
    .turn-settings-grid,.opening-grid { grid-template-columns:minmax(0,1fr); }
    .header-aside { display:none; }
  }
  @container multiplayer (max-width:640px) {
    .panel-header { padding:22px 20px; }
    .panel-header h2 { font-size:23px; }
    .brand-icon { width:42px; height:42px; }
    .brand { gap:12px; }
    .setup,#room-workspace { padding:20px; }
    .setup-grid { grid-template-columns:minmax(0,1fr); gap:16px; }
    .setup-intro { display:grid; gap:4px; }
    .card { padding:18px; }
    .history-card,.room-status { padding:0; }
    .room-meta { align-items:flex-start; }
    .pills { width:100%; }
    .member-list { gap:8px; margin-top:16px; }
    .member-card { align-items:flex-start; gap:8px; padding:12px; }
    .member-avatar { width:30px; height:30px; border-radius:8px; font-size:16px; }
    .member-name { font-size:13px; }
    .member-meta { font-size:11px; }
    .room-actions .btn-primary { min-width:0; flex:1; }
    .credential-policy-options { grid-template-columns:1fr; }
    .credential-policy-options button { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:54px; }
    .credential-policy-options span { text-align:right; }
    .opening-intro { flex-wrap:wrap; }
    .opening-time-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .scheme-import { grid-template-columns:minmax(0,1fr); }
    .share-row { grid-template-columns:64px minmax(0,1fr); }
    .share-row button { grid-column:2; justify-self:start; }
    .history-head { padding:14px 16px; flex-wrap:wrap; }
    #local-room-history { padding:4px 16px; }
    .history-row { align-items:flex-start; }
    .room-tool-grid { grid-template-columns:minmax(0,1fr); }
    .message { max-width:93%; }
  }
  @container multiplayer (max-width:380px) {
    .panel-header { padding:18px 16px; }
    .panel-header .muted { font-size:12px; }
    .brand-icon { display:none; }
    .setup,#room-workspace { padding:16px; }
    .card { padding:16px; }
    .history-card,.room-status { padding:0; }
    .member-list { grid-template-columns:1fr; }
    .member-meta { font-size:12px; }
    .member-avatar { width:34px; height:34px; }
    .active-head,.active-body { padding:12px; }
    .active-head { gap:10px; }
    .generation-steps { grid-template-columns:repeat(2,minmax(0,1fr)); row-gap:12px; }
    .generation-heading strong { font-size:14px; }
    .generation-time { width:100%; padding-left:20px; }
    .generation-time:empty { display:none; }
    .generation-actions { gap:6px; }
    .generation-actions .btn-sm { flex:1; padding-inline:6px; }
    .active-footer .toolbar { gap:6px; }
    .active-footer .btn-sm { padding-inline:8px; }
    .opening-card-head { flex-wrap:wrap; }
    .segmented button { padding:7px; font-size:12px; }
    .room-actions { align-items:stretch; }
    .room-actions .btn-primary { flex-basis:100%; }
  }
  @media (prefers-reduced-motion:reduce) {
    *,*::before,*::after { animation:none!important; transition:none!important; scroll-behavior:auto!important; }
  }
`;
