import { multiplayerTheme } from './multiplayer-theme.css.js';

export const multiplayerOverlayStyles = `
  [data-multiplayer-overlay] { ${multiplayerTheme} box-sizing:border-box; transition-property:none; color:var(--mp-text); font-family:var(--mp-font); scrollbar-width:thin; scrollbar-color:var(--mp-border-strong) transparent; }
  [data-multiplayer-overlay] *, [data-multiplayer-overlay] *::before, [data-multiplayer-overlay] *::after { box-sizing:border-box; }
  [data-multiplayer-overlay] .mp-overlay-toolbar { gap:8px; align-items:center; }
  [data-multiplayer-overlay][data-presentation="full"] { scroll-padding-top:76px; }
  [data-multiplayer-overlay][data-presentation="full"] .mp-overlay-toolbar { padding:8px 10px; background:var(--mp-bg); border:1px solid var(--mp-border); border-radius:12px; }
  [data-multiplayer-overlay] .mp-overlay-heading { display:flex; align-items:center; gap:10px; margin-right:auto; min-width:0; color:var(--mp-secondary); font-size:13px; font-weight:600; letter-spacing:.03em; }
  [data-multiplayer-overlay] .mp-overlay-heading svg { color:var(--mp-gold); }
  [data-multiplayer-overlay] .mp-overlay-button { min-height:40px; display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:0 13px; flex-shrink:0; border:1px solid var(--mp-border); border-radius:10px; background:var(--mp-card); color:var(--mp-secondary); font:600 13px/1.3 var(--mp-font); cursor:pointer; transition:background .15s ease,border-color .15s ease,color .15s ease; }
  [data-multiplayer-overlay] .mp-overlay-button:hover { color:var(--mp-text); border-color:var(--mp-border-strong); background:var(--mp-raised); }
  [data-multiplayer-overlay] .mp-overlay-button:focus-visible, [data-multiplayer-overlay] .mp-overlay-launcher:focus-visible { outline:2px solid var(--mp-gold); outline-offset:3px; }
  [data-multiplayer-overlay] .mp-overlay-button svg { flex-shrink:0; }
  [data-multiplayer-overlay] [data-multiplayer-drag] { flex:1; min-width:0; justify-content:flex-start; padding:0 8px; border-color:transparent; background:transparent; color:var(--mp-text); cursor:grab; touch-action:none; user-select:none; }
  [data-multiplayer-overlay] [data-multiplayer-drag]:active { cursor:grabbing; }
  [data-multiplayer-overlay] .mp-grip { color:var(--mp-muted); }
  [data-multiplayer-overlay] .mp-icon-button { width:40px; padding:0; }
  [data-multiplayer-overlay] [data-multiplayer-resize] { cursor:nwse-resize; touch-action:none; }
  [data-multiplayer-overlay] .mp-overlay-launcher { pointer-events:auto; display:none; align-items:center; gap:10px; min-height:44px; padding:0 15px; border:1px solid var(--mp-border-strong); border-radius:12px; background:var(--mp-card); color:var(--mp-text); font:600 13px/1.4 var(--mp-font); box-shadow:0 8px 28px rgba(0,0,0,.28); cursor:pointer; }
  [data-multiplayer-overlay] .mp-overlay-launcher:hover { background:var(--mp-raised); }
  [data-multiplayer-overlay] .mp-launcher-dot { width:7px; height:7px; border-radius:50%; background:var(--mp-success); box-shadow:0 0 0 4px rgba(128,203,166,.09); flex-shrink:0; }
  [data-multiplayer-overlay] .mp-overlay-launcher[data-tone="error"] .mp-launcher-dot { background:var(--mp-danger); box-shadow:0 0 0 4px rgba(247,154,151,.1); }
  [data-multiplayer-overlay] .mp-overlay-launcher[data-tone="warning"] .mp-launcher-dot { background:var(--mp-warning); box-shadow:0 0 0 4px rgba(232,189,118,.1); }
  [data-multiplayer-overlay] .mp-overlay-launcher[data-running="true"] .mp-launcher-dot { background:var(--mp-gold); box-shadow:0 0 0 4px rgba(198,156,109,.12); }
  [data-multiplayer-overlay] .mp-unread { display:inline-grid; place-items:center; min-width:20px; height:20px; padding:0 6px; border-radius:6px; background:var(--mp-accent); color:white; font-size:11px; }
  [data-multiplayer-overlay][data-presentation="compact"] .mp-overlay-toolbar { padding:6px; gap:4px; border:1px solid var(--mp-border); border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,.16); }
  [data-multiplayer-overlay][data-presentation="compact"] .mp-overlay-button:not([data-multiplayer-drag]) { background:transparent; border-color:transparent; }
  [data-multiplayer-overlay][data-presentation="compact"] .mp-overlay-button:hover { background:var(--mp-raised); }
  [data-multiplayer-overlay][data-presentation="compact"] .mp-overlay-close { padding:0 9px; }
  @media (max-width:480px) {
    [data-multiplayer-overlay] .mp-overlay-heading { font-size:12px; }
    [data-multiplayer-overlay] .mp-overlay-button { font-size:12px; }
  }
  @media (prefers-reduced-motion:reduce) { [data-multiplayer-overlay] .mp-overlay-button { transition:none; } }
`;

export const multiplayerRoomExitStyles = `
  :host { ${multiplayerTheme} font-family:var(--mp-font); }
  .overlay { padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left)); }
  .modal { box-sizing:border-box; width:min(100%,500px); max-height:calc(100dvh - max(16px,env(safe-area-inset-top)) - max(16px,env(safe-area-inset-bottom))); background:var(--mp-bg); border:1px solid var(--mp-border-strong); border-radius:var(--mp-radius); box-shadow:var(--mp-shadow); }
  .modal::before { display:none; }
  .title { padding:25px 24px 15px; color:var(--mp-text); font:650 20px/1.4 var(--mp-font); letter-spacing:0; }
  .body { padding:0 24px 24px; color:var(--mp-secondary); font:400 13px/1.8 var(--mp-font); }
  .mp-exit-summary { margin-bottom:20px!important; }
  .mp-exit-save { display:flex; gap:13px; padding:16px; border:1px solid rgba(198,156,109,.24); border-radius:12px; background:rgba(198,156,109,.055); }
  .mp-exit-icon { display:grid; place-items:center; width:36px; height:36px; flex:0 0 36px; border:1px solid rgba(198,156,109,.2); border-radius:10px; background:rgba(198,156,109,.08); color:var(--mp-gold); }
  .mp-exit-save strong { display:block; margin:0 0 4px; color:var(--mp-text); font-size:13px; font-weight:600; }
  .mp-exit-save p { color:var(--mp-secondary); font-size:12px; line-height:1.75; }
  .mp-exit-note { margin-top:14px!important; color:var(--mp-muted); font-size:12px; }
  .btns { gap:8px; padding:16px 24px; background:var(--mp-card); border-top:1px solid var(--mp-border); }
  .btn { box-sizing:border-box; min-height:40px; padding:0 14px; border:1px solid var(--mp-border); border-radius:10px; background:transparent; color:var(--mp-secondary); font:600 13px/1.3 var(--mp-font); }
  .btn:first-child { margin-right:auto; }
  .btn:hover { background:var(--mp-raised); border-color:var(--mp-border-strong); color:var(--mp-text); }
  .btn-p { background:var(--mp-accent); border-color:var(--mp-accent); color:white; box-shadow:none; }
  .btn-p:hover { background:var(--mp-accent); border-color:var(--mp-accent); color:white; filter:brightness(1.08); }
  .btn:focus-visible { outline:2px solid var(--mp-gold); outline-offset:3px; }
  @media (max-width:480px) {
    .title { padding:22px 20px 12px; font-size:19px; }
    .body { padding:0 20px 20px; }
    .btns { padding:14px 20px; display:grid; grid-template-columns:1fr 1fr; }
    .btn:first-child { margin:0; }
    .btn-p { grid-column:1 / -1; grid-row:1; }
  }
  @media (prefers-reduced-motion:reduce) { .overlay,.modal { animation:none; } .btn { transition:none; } }
`;
