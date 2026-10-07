const combatHeroImage = new URL('../../img/combat/moonlit-training-ground.png', import.meta.url).href;

export const combatStyles = `
  :host { display:block; min-width:0; container-type:inline-size; color:#efece3; font:13px/1.5 var(--font-body,system-ui,sans-serif); --paper:#eee9dd; --ink:#24333a; --red:#a74035; }
  * { box-sizing:border-box; }
  h2,h3,p { margin:0; }
  button { min-width:44px; min-height:44px; font:inherit; cursor:pointer; -webkit-tap-highlight-color:transparent; }
  button:focus-visible,summary:focus-visible { outline:2px solid #b64536; outline-offset:3px; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .scene { margin:20px 0; overflow:hidden; border:1px solid #b6c7cb30; border-radius:8px; background:#111c24; box-shadow:0 20px 60px #02080e66; }
  .panel-controls { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:44px; padding:0 16px; border-bottom:1px solid #b6c7cb20; color:#bac8ca; font-size:11px; }
  .close-panel { display:inline-flex; align-items:center; gap:6px; padding:0 6px; border:0; color:#cbd6d4; background:transparent; font-size:12px; }
  .close-panel:hover { color:#fff9e8; }
  .waiting-copy { padding:32px 28px; }
  .waiting-copy h2 { font-size:clamp(32px,7cqi,52px); letter-spacing:4px; }
  .waiting-copy p { color:#d2d9d6; margin-top:14px; }
  .waiting-note { padding:18px 24px; color:#d3dcd8; line-height:1.8; }
  .waiting-note span { display:block; margin-top:4px; color:#a3b5b8; font-size:12px; }
  .hero { position:relative; isolation:isolate; background:#132833; background-image:linear-gradient(90deg,#06141cd9,#0a1b2459 55%,#06111bb0),linear-gradient(0deg,#09151efa 0%,#08182426 90%),url("${combatHeroImage}"); background-size:cover; background-position:center 47%; }
  .hero::after { content:''; position:absolute; inset:0; z-index:-1; pointer-events:none; background:linear-gradient(0deg,#07141aca,transparent 85%); }
  .masthead { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:24px 28px 14px; min-height:133px; }
  .eyebrow { display:flex; align-items:center; gap:8px; color:#bbced1; font-size:9px; font-weight:600; letter-spacing:3px; }
  .eyebrow span { width:16px; height:2px; background:#d77161; }
  h2 { font:700 64px/1.02 'STKaiti','KaiTi','Kaiti SC',var(--font-title,'Noto Serif SC',serif); color:#fff9e8; letter-spacing:9px; margin-top:8px; text-shadow:0 3px 16px #0008; }
  .hero-caption { color:#c4d0cf; margin-top:8px; font-size:11px; letter-spacing:2px; }
  .round { display:flex; flex-direction:column; align-items:center; flex:none; padding:0 0 0 24px; border-left:1px solid #d4e0d82c; }
  .round span { font-size:9px; letter-spacing:3px; color:#b8c4c5; }
  .round strong { font:300 55px/1.05 'Georgia',serif; color:#f3f0e7; font-variant-numeric:tabular-nums; }
  .round small { color:#b1bec1; font-size:9px; }
  .battlefield { display:grid; grid-template-columns:minmax(0,1fr) 56px minmax(0,1fr); gap:16px; padding:8px 28px 10px; align-items:stretch; }
  .fighter { min-width:0; }
  .fighter-top { display:flex; gap:9px; align-items:center; margin-bottom:7px; }
  .fighter-side { display:grid; place-items:center; color:#bbd6cc; background:#0c211db0; border:1px solid #91bda64a; width:30px; height:30px; flex:none; font:15px var(--font-title,serif); transform:rotate(-4deg); }
  .enemy .fighter-side { color:#e9c8be; border-color:#c488764f; background:#351c18a0; }
  .fighter-name { font:600 20px/1.3 var(--font-title,serif); letter-spacing:1px; overflow-wrap:anywhere; }
  .fighter-rank { font-size:11px; color:#bac8ca; margin-top:2px; }
  .versus { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:#bdcccc; }
  .versus span { font:19px var(--font-title,serif); }
  .versus i { display:block; width:1px; height:38px; background:linear-gradient(#b6c7c080,transparent); }
  .resource { margin-top:6px; min-width:0; }
  .resource-text { display:flex; justify-content:space-between; gap:5px; font-size:11px; color:#c3d0d2; }
  .resource-text strong { color:#edf3ef; font-size:12px; font-weight:500; font-variant-numeric:tabular-nums; }
  .bar { height:5px; overflow:hidden; margin-top:3px; background:#beced21b; }
  .bar i { display:block; height:100%; width:var(--fill,0%); background:var(--bar-color,#96c8b5); transition:width .3s ease; }
  .resource.low .bar i { background:#e99684; }
  .resource.low .resource-text strong { color:#efb3a5; }
  .minor-resources { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
  .minor-resources .resource-text { flex-wrap:wrap; gap:0 3px; }
  .minor-resources .resource-text strong { font-size:11px; }
  .minor-resources .bar { height:2px; }
  .status-row { display:flex; flex-wrap:wrap; gap:4px; margin-top:8px; min-height:18px; }
  .status-tag { color:#d5e2dc; background:#6b948928; border:1px solid #a4bfa126; padding:1px 5px; font-size:11px; }
  .enemy .status-tag { color:#e2c7b9; background:#97694c22; border-color:#c299732e; }
  .status-tag.muted { color:#93a9af; border:0; background:none; padding-left:0; }
  .context { display:flex; align-items:center; flex-wrap:wrap; gap:5px 17px; padding:7px 28px 13px; font-size:11px; color:#d4dfdc; }
  .context span { min-width:0; overflow-wrap:anywhere; }
  .context b { margin-right:5px; color:#95a5a9; font-weight:400; }
  .phase { display:flex; align-items:center; flex-wrap:wrap; gap:6px 9px; min-height:40px; padding:8px 24px; border-top:1px solid #b0c7ce20; color:#cdd9d5; background:#14262f; }
  .phase-dot { width:5px; height:5px; border-radius:50%; background:#a5c8ac; flex:none; }
  .phase strong { font-size:12px; font-weight:500; }
  .phase-guide { margin-left:auto; color:#9baeb3; font-size:10px; letter-spacing:1px; }
  .phase p { color:#bfcccf; font-size:11px; }
  .phase.error { background:#3a2425; color:#f5c4ba; }
  .phase.error p { color:#d2b1a9; }
  .phase.error .phase-dot { background:#eb9b85; }
  .phase.busy .phase-dot { animation:pulse 1.5s ease-in-out infinite; }
  .command { color:var(--ink); padding:20px 24px 12px; background-color:var(--paper); background-image:repeating-linear-gradient(4deg,#483f3003 0 1px,transparent 1px 4px),radial-gradient(ellipse at top left,#fff9ebaa,transparent 75%); }
  .command-board { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(245px,.85fr); gap:22px; }
  .move-deck { min-width:0; }
  .command-detail { min-width:0; border-left:1px solid #263a3c20; padding-left:20px; }
  .section-heading { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px; }
  .section-index { font-size:8px; letter-spacing:2px; color:#7d8784; }
  h3 { color:#283b41; font:700 19px/1.4 var(--font-title,serif); letter-spacing:1px; }
  .hint { color:#607068; font-size:11px; }
  .quiet { border:1px solid #31494b22; background:#fcfaf128; color:#53675e; padding:6px 9px; border-radius:3px; font-size:12px; }
  .quiet:hover { border-color:#a64e3f77; color:#923d32; background:#fffdf755; }
  .expand-moves { display:inline-flex; align-items:center; gap:5px; border:0; padding-right:0; white-space:nowrap; }
  .expand-moves span { color:#9b6b5a; }
  .filters { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px; }
  .filter { padding:5px 9px; color:#53685d; font-size:12px; background:none; border:1px solid transparent; border-radius:3px; }
  .filter.active { color:#903a2f; border-color:#a857453d; background:#a8473510; }
  .move-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .move-grid.expanded { max-height:355px; overflow-y:auto; padding:3px; margin:-3px; scrollbar-width:thin; scrollbar-color:#68797255 transparent; }
  .move { --move-color:#526b68; display:grid; grid-template-columns:30px minmax(0,1fr); align-items:center; column-gap:9px; position:relative; min-width:0; min-height:110px; padding:12px; text-align:left; color:#28393d; border:1px solid #667a772d; border-radius:4px; background:linear-gradient(135deg,#fffdf78a,#ffffff18); transition:border-color .15s,background .15s,transform .15s; }
  .move[data-element="火"] { --move-color:#aa4e38; }
  .move[data-element="水"] { --move-color:#467e98; }
  .move[data-element="雷"] { --move-color:#927922; }
  .move[data-element="风"] { --move-color:#417b69; }
  .move[data-element="土"] { --move-color:#88613e; }
  .move:hover { border-color:#7b8d8280; background:#fffef89c; transform:translateY(-1px); }
  .move.selected { border-color:#a44335; box-shadow:inset 0 -3px #a44335; background:#fff9ed; }
  .move.unavailable { opacity:.58; }
  .move.unavailable.selected { opacity:1; }
  .move-glyph { grid-row:1/3; display:flex; color:var(--move-color); }
  .move-name { grid-column:2; min-width:0; color:#263c42; font:600 15px/1.4 var(--font-title,serif); padding-right:9px; overflow-wrap:anywhere; }
  .slot { position:absolute; top:5px; right:7px; font-size:8px; color:#90988e; }
  .move-tags { grid-column:2; display:flex; gap:5px; flex-wrap:wrap; font-size:11px; color:#647264; padding-top:4px; }
  .element { color:var(--move-color); }
  .move-cost { grid-column:1/-1; margin-top:8px; padding-top:6px; border-top:1px solid #52696212; color:#536c5e; font-size:11px; }
  .tactics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; margin-top:12px; padding-top:11px; border-top:1px solid #415c4820; }
  .tactic { display:flex; flex-direction:column; justify-content:center; align-items:center; gap:4px; min-width:44px; min-height:52px; padding:5px 2px; border:1px solid transparent; border-radius:3px; background:none; color:#53685d; font-size:11px; }
  .tactic:hover,.tactic.selected { color:#923d32; background:#a443350b; border-color:#a4433526; }
  .selection { display:flex; flex-direction:column; min-height:100%; position:relative; isolation:isolate; }
  .selection[data-element="火"]::before,.selection[data-element="水"]::before,.selection[data-element="雷"]::before,.selection[data-element="风"]::before,.selection[data-element="土"]::before { content:attr(data-element); position:absolute; z-index:-1; top:35px; right:0; font:100px/1 'STKaiti','KaiTi',serif; color:#a34a3910; transform:rotate(-10deg); pointer-events:none; }
  .selection-title { display:flex; align-items:center; gap:8px; justify-content:space-between; }
  .selection-title strong { display:block; font:600 19px/1.5 var(--font-title,serif); color:#233942; overflow-wrap:anywhere; }
  .detail-kicker { color:#8d7669; font-size:8px; letter-spacing:1.8px; }
  .clear-selection { flex:none; display:grid; place-items:center; border:0; margin-right:-8px; color:#7a857d; }
  .selection p { font-size:13px; line-height:1.7; color:#596f61; overflow-wrap:anywhere; }
  .move-description { margin-top:8px; max-height:68px; overflow-y:auto; scrollbar-width:thin; }
  .metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; padding:13px 0 11px; margin-top:10px; border-top:1px solid #3149441c; border-bottom:1px solid #3149441c; }
  .metric { min-width:0; }
  .metric span { display:block; color:#627362; font-size:11px; margin-bottom:4px; }
  .metric strong { color:#263d45; font:500 17px/1.25 'Georgia',var(--font-body,serif); overflow-wrap:anywhere; }
  .metric small { display:block; color:#65765f; font:11px/1.5 var(--font-body,sans-serif); }
  .effect-note { margin-top:8px; color:#914a35!important; font-size:12px!important; }
  .preview-note { margin-top:6px; font-size:12px!important; }
  .selection-footer { margin-top:auto; padding-top:14px; }
  .primary { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; padding:10px 14px; color:#fff6e9; border:1px solid #9b392f; border-radius:3px; background:#a44035; box-shadow:0 3px 0 #802b2522; font-size:14px; font-weight:600; }
  .primary:hover { background:#b14b3c; }
  .pin-controls { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:3px; }
  .pin-button { border:0; background:none; padding-left:0; }
  .pin-controls .hint { font-size:11px; }
  .pin-picker { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; background:#d4dace50; padding:8px; border-radius:3px; }
  .pin-picker p { grid-column:1/-1; font-size:12px; }
  .pin-picker button { min-width:44px; text-align:left; overflow-wrap:anywhere; }
  .pin-notice { font-size:11px!important; }
  .selection-idle { display:flex; align-items:center; justify-content:center; text-align:center; min-height:280px; gap:8px; }
  .idle-glyph { color:#93a399; margin-bottom:10px; }
  .selection-idle h3 { font-size:19px; }
  .selection-idle p { color:#8b9285; }
  .idle-rule { width:26px; height:1px; background:#aab2a3; margin:7px 0; }
  .empty { padding:25px 12px; border:1px dashed #667a7733; color:#859084; font-size:11px; text-align:center; }
  .freeform { display:flex; align-items:center; gap:6px; color:#637461; font-size:11px; padding-top:13px; }
  .finished-note { color:#6c7c72; background:var(--paper); padding:20px 24px; font-size:12px; }
  .report { padding:0 24px; background:#e8e4d8; color:#52645f; border-top:1px solid #415b4922; }
  .report summary { cursor:pointer; min-height:44px; padding:12px 0; font-size:11px; }
  .report summary span { float:right; color:#899184; font-size:9px; letter-spacing:.5px; }
  .report-list { margin:0; padding:0 0 12px; list-style:none; }
  .report-list li { position:relative; padding:5px 0 5px 13px; color:#556e5c; font-size:12px; overflow-wrap:anywhere; }
  .report-list li::before { content:''; position:absolute; left:0; top:12px; width:3px; height:3px; background:#aa5b49; }
  @keyframes pulse { 50% { opacity:.3; } }
  @container(max-width:650px) {
    .masthead { padding:20px 18px 13px; min-height:115px; }
    h2 { font-size:42px; }
    .round strong { font-size:46px; }
    .battlefield { grid-template-columns:minmax(0,1fr) 30px minmax(0,1fr); padding:8px 18px 10px; gap:10px; }
    .fighter-name { font-size:17px; }
    .fighter-side { width:23px; height:26px; font-size:12px; }
    .minor-resources { grid-template-columns:1fr; gap:0; }
    .minor-resources .resource { margin-top:5px; }
    .minor-resources .resource-text { flex-wrap:nowrap; font-size:11px; }
    .minor-resources .bar { display:none; }
    .context { padding:6px 18px 12px; font-size:11px; gap:4px 13px; }
    .context .environment { flex-basis:100%; }
    .phase { padding:8px 16px; }
    .phase-guide { display:none; }
    .command { padding:16px 16px 11px; }
    .command-board { grid-template-columns:minmax(0,1fr); gap:15px; }
    .command-detail { padding:14px 0 0; border-left:0; border-top:1px solid #31494425; }
    .selection-idle { min-height:0; padding:4px 0; }
    .selection-idle .idle-glyph,.selection-idle .detail-kicker,.selection-idle .idle-rule,.selection-idle .hint { display:none; }
    .selection-idle h3 { font-size:15px; }
    .selection-idle p { font-size:12px; }
    .selection-idle p br { display:none; }
    .selection-title strong { font-size:19px; }
    .section-heading { margin-bottom:9px; }
    .move { min-height:110px; padding:10px; grid-template-columns:25px minmax(0,1fr); gap:0 7px; }
    .move-name { font-size:15px; }
    .move-glyph svg { width:25px; height:25px; }
    .move-tags { font-size:11px; gap:3px 5px; }
    .tactics { margin-top:9px; padding-top:8px; }
    .selection-main { display:grid; grid-template-columns:1fr; }
    .move-description { margin-top:5px; max-height:66px; }
    .metrics { padding:10px 0; margin-top:9px; }
    .metric strong { font-size:19px; }
    .metric small { display:inline; margin-left:4px; }
    .selection-footer { padding-top:10px; }
    .freeform { padding-top:3px; font-size:11px; }
    .report { padding:0 16px; }
    .finished-note { padding:16px; }
  }
  @container(max-width:370px) {
    .masthead { padding:17px 14px 12px; }
    .battlefield { padding:8px 14px 9px; grid-template-columns:minmax(0,1fr) 20px minmax(0,1fr); gap:8px; }
    .fighter-top { gap:6px; }
    .fighter-name { font-size:15px; }
    .fighter-rank { font-size:11px; }
    .fighter-side { width:19px; height:23px; }
    .resource-text { font-size:11px; }
    .status-tag { font-size:11px; }
    .command { padding:14px 12px 10px; }
    .phase { padding:8px 14px; }
    .context { padding:5px 14px 11px; }
    .move-grid { gap:7px; }
    .move { padding:9px; grid-template-columns:22px minmax(0,1fr); gap:0 6px; }
    .move-glyph svg { width:22px; height:22px; }
    .move-name { font-size:15px; padding-right:5px; }
    .move-tags,.move-cost { font-size:11px; }
  }
  @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
`;
