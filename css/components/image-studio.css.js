export const imageStudioStyles = `
  :host {
    --is-accent: var(--c-shuiro, #eb613f);
    --is-gold: var(--c-kin, #c69c6d);
    --is-bg: rgba(var(--ink-deep-rgb, 7, 10, 14), 0.78);
    --is-surface: rgba(var(--paper-rgb, 232, 228, 217), 0.035);
    --is-surface-hover: rgba(var(--paper-rgb, 232, 228, 217), 0.065);
    --is-border: rgba(var(--paper-rgb, 232, 228, 217), 0.13);
    --is-text: var(--text-primary, #e8e4d9);
    --is-muted: var(--text-secondary, #a39f98);
    --is-faint: var(--text-tertiary, #716f6b);
    color: var(--is-text);
    font-family: var(--font-body, 'Noto Sans SC', 'Microsoft YaHei UI', system-ui, sans-serif);
    box-sizing: border-box;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; }
  button { color: inherit; }
  [hidden] { display: none !important; }

  .is-card {
    border: 1px solid var(--is-border);
    border-radius: 10px;
    background:
      radial-gradient(circle at 0 0, rgba(198, 156, 109, 0.07), transparent 42%),
      var(--is-bg);
    overflow: hidden;
  }
  .is-section { padding: 18px; border-bottom: 1px solid var(--is-border); }
  .is-section:last-child { border-bottom: 0; }
  .is-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
  .is-section-head h3, .is-section-head h4 { margin: 0; font-family: var(--font-title, serif); letter-spacing: 1px; }
  .is-section-head h3 { font-size: 15px; }
  .is-section-head h4 { font-size: 13px; }
  .is-eyebrow { margin: 0 0 5px; color: var(--is-gold); font-size: 9px; letter-spacing: 2px; text-transform: uppercase; }
  .is-note { margin: 5px 0 0; color: var(--is-faint); font-size: 11px; line-height: 1.65; }
  .is-grid { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 13px 16px; align-items: center; }
  .is-grid label { color: var(--is-muted); font-size: 12px; line-height: 1.4; }
  .is-grid .is-span { grid-column: 1 / -1; }
  .is-inline { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .is-inline > input, .is-inline > select { flex: 1; min-width: 0; }
  .is-field-stack { display: grid; gap: 7px; }
  .is-field-hint { color: var(--is-faint); font-size: 10px; line-height: 1.5; }
  [data-action='use-main-api'], [data-action='fetch-image-models'] { flex: 0 0 auto; white-space: nowrap; }
  input[type='text'], input[type='search'], input[type='password'], input[type='number'], input[type='url'], select, textarea {
    width: 100%; min-width: 0; padding: 9px 11px;
    color: var(--is-text); background: rgba(0, 0, 0, 0.22);
    border: 1px solid var(--is-border); border-radius: 6px; outline: none;
    transition: border-color .16s ease, background .16s ease;
  }
  input:focus, select:focus, textarea:focus { border-color: rgba(235, 97, 63, 0.68); background: rgba(0, 0, 0, 0.35); }
  textarea { resize: vertical; min-height: 82px; line-height: 1.55; }
  select option { color: #e8e4d9; background: #0b0e13; }
  input[type='checkbox'] {
    appearance: none; width: 40px; height: 22px; margin: 0;
    border: 1px solid var(--is-border); border-radius: 999px;
    background: rgba(255, 255, 255, 0.08); cursor: pointer; position: relative;
  }
  input[type='checkbox']::after {
    content: ''; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px;
    border-radius: 50%; background: var(--is-muted); transition: transform .17s ease, background .17s ease;
  }
  input[type='checkbox']:checked { background: rgba(235, 97, 63, .38); border-color: rgba(235, 97, 63, .7); }
  input[type='checkbox']:checked::after { transform: translateX(18px); background: #fff; }
  input[type='file'] { width: 100%; color: var(--is-faint); font-size: 11px; }

  .is-btn {
    min-height: 34px; padding: 7px 13px; border: 1px solid var(--is-border); border-radius: 6px;
    background: var(--is-surface); cursor: pointer; font-size: 12px; line-height: 1.25;
    transition: transform .15s ease, border-color .15s ease, background .15s ease, opacity .15s ease;
  }
  .is-btn:hover:not(:disabled) { border-color: rgba(232, 228, 217, .28); background: var(--is-surface-hover); }
  .is-btn:active:not(:disabled) { transform: translateY(1px); }
  .is-btn:disabled { cursor: not-allowed; opacity: .42; }
  .is-btn--primary { border-color: rgba(235, 97, 63, .68); background: linear-gradient(180deg, #f07452, #eb613f); color: #fff; font-weight: 700; }
  .is-btn--primary:hover:not(:disabled) { border-color: #f08a6d; background: linear-gradient(180deg, #f48365, #eb613f); }
  .is-btn--danger { color: #ff8d89; border-color: rgba(239, 83, 80, .3); }
  .is-btn--small { min-height: 29px; padding: 5px 9px; font-size: 11px; }
  .is-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .is-status { min-height: 18px; margin-top: 9px; color: var(--is-muted); font-size: 11px; line-height: 1.55; }
  .is-status[data-tone='success'] { color: #81c784; }
  .is-status[data-tone='error'] { color: #ff8d89; }
  .is-status[data-tone='working'] { color: #80d8ff; }
  .is-unavailable { padding: 13px 15px; border: 1px dashed var(--is-border); border-radius: 7px; color: var(--is-faint); font-size: 11px; line-height: 1.65; }
  .is-warning { padding: 10px 12px; border-left: 2px solid var(--is-gold); background: rgba(198, 156, 109, .06); color: var(--is-muted); font-size: 11px; line-height: 1.65; }
  .is-metric { display: flex; align-items: baseline; gap: 7px; }
  .is-metric strong { font-size: 18px; }
  .is-metric span { color: var(--is-faint); font-size: 10px; }
  .is-quota-track { height: 5px; margin-top: 9px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.08); }
  .is-quota-track > i { display: block; height: 100%; width: var(--quota, 0%); border-radius: inherit; background: linear-gradient(90deg, var(--is-gold), var(--is-accent)); }

  .is-provider { padding: 13px; border: 1px solid var(--is-border); border-radius: 8px; background: rgba(0,0,0,.14); }
  .is-provider-fields { margin-top: 13px; }
  .is-model-catalog { display: grid; gap: 9px; padding: 10px 12px; border: 1px solid var(--is-border); border-radius: 7px; background: rgba(0,0,0,.13); }
  .is-model-catalog.is-note { padding: 9px 11px; }
  .is-model-search { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
  .is-model-search > span, .is-model-limit { color: var(--is-faint); font-size: 9px; line-height: 1.45; }
  .is-model-group { min-width: 0; }
  .is-model-group-title, .is-model-group summary { color: var(--is-muted); font-size: 11px; line-height: 1.5; }
  .is-model-group summary { cursor: pointer; }
  .is-model-group-title span, .is-model-group summary span { color: var(--is-faint); }
  .is-model-options { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
  .is-model-option { max-width: 100%; padding: 5px 8px; overflow: hidden; border: 1px solid rgba(198,156,109,.22); border-radius: 5px; background: rgba(198,156,109,.055); color: var(--is-muted); cursor: pointer; font-size: 10px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
  .is-model-option:hover, .is-model-option:focus-visible { border-color: rgba(235,97,63,.58); background: rgba(235,97,63,.1); color: var(--is-text); outline: none; }
  .is-code { font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace; font-size: 11px; }
  .is-worldbook-list { display: grid; gap: 9px; margin: 12px 0; }
  .is-worldbook-entry { padding: 12px; border: 1px solid var(--is-border); border-radius: 7px; background: rgba(0,0,0,.16); }
  .is-worldbook-entry-head { display: flex; gap: 8px; margin-bottom: 9px; }
  .is-worldbook-entry-head input { flex: 1; }
  .is-worldbook-entry textarea { min-height: 62px; }
  .is-worldbook-entry .is-grid { grid-template-columns: 92px minmax(0, 1fr); gap: 8px 12px; }
  .is-empty { padding: 24px 15px; color: var(--is-faint); text-align: center; font-size: 11px; border: 1px dashed var(--is-border); border-radius: 7px; }

  /* Turn controls */
  .is-turn { margin-top: 12px; }
  .is-turn-main { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 11px 12px; }
  .is-turn-copy { min-width: 0; }
  .is-turn-title { display: flex; align-items: center; gap: 7px; color: var(--is-muted); font-size: 11px; letter-spacing: 1px; }
  .is-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--is-faint); }
  .is-dot[data-state='working'] { background: #80d8ff; box-shadow: 0 0 9px #80d8ff; animation: is-pulse 1.2s ease-in-out infinite; }
  .is-dot[data-state='success'] { background: #81c784; }
  .is-dot[data-state='error'] { background: #ef5350; }
  @keyframes is-pulse { 50% { opacity: .35; } }
  .is-turn-detail { overflow: hidden; margin-top: 4px; color: var(--is-faint); font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
  .is-preview { position: relative; background: #070a0e; }
  .is-preview img { display: block; width: 100%; max-height: min(62vh, 620px); object-fit: contain; }
  .is-preview-tools { position: absolute; right: 9px; bottom: 9px; display: flex; gap: 6px; opacity: 0; transition: opacity .16s ease; }
  .is-preview:hover .is-preview-tools, .is-preview:focus-within .is-preview-tools { opacity: 1; }
  .is-preview-tools .is-btn { background: rgba(7,10,14,.82); backdrop-filter: blur(8px); }
  .is-versions { display: flex; gap: 7px; padding: 10px 12px; overflow-x: auto; border-top: 1px solid var(--is-border); }
  .is-version { width: 48px; height: 48px; flex: 0 0 auto; padding: 0; overflow: hidden; border: 1px solid var(--is-border); border-radius: 6px; background: rgba(0,0,0,.2); cursor: pointer; }
  .is-version[aria-pressed='true'] { border-color: var(--is-accent); box-shadow: 0 0 0 1px var(--is-accent); }
  .is-version img { width: 100%; height: 100%; object-fit: cover; }

  /* Portrait controls */
  .is-portrait { display: grid; grid-template-columns: 154px minmax(0, 1fr); gap: 18px; align-items: start; }
  .is-portrait-visual { position: relative; width: 154px; aspect-ratio: 1; overflow: hidden; border: 1px solid var(--is-border); border-radius: 12px; background: rgba(0,0,0,.25); }
  .is-portrait-visual img { width: 100%; height: 100%; object-fit: cover; }
  .is-portrait-letter { width: 100%; height: 100%; display: grid; place-items: center; color: var(--is-gold); font-family: var(--font-brush, serif); font-size: 52px; }
  .is-portrait-badge { position: absolute; left: 8px; bottom: 8px; padding: 4px 7px; border-radius: 5px; background: rgba(7,10,14,.8); color: var(--is-muted); font-size: 9px; }
  .is-portrait-copy h4 { margin: 0 0 4px; font-family: var(--font-title, serif); font-size: 15px; }
  .is-profile { margin-top: 13px; }
  .is-profile summary { color: var(--is-muted); cursor: pointer; font-size: 11px; }
  .is-profile .is-grid { margin-top: 11px; grid-template-columns: 90px minmax(0, 1fr); gap: 9px 12px; }

  /* Gallery */
  :host(.is-gallery-host) { position: fixed; inset: 0; z-index: calc(var(--z-fullscreen) + 100); }
  .is-gallery-backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 22px; background: rgba(3,4,6,.86); backdrop-filter: blur(12px); }
  .is-gallery-dialog { width: min(1120px, 100%); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--is-border); border-radius: 12px; background: #0b0f14; box-shadow: 0 32px 100px rgba(0,0,0,.6); }
  .is-gallery-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 19px 22px; border-bottom: 1px solid var(--is-border); }
  .is-gallery-head h2 { margin: 0; font: 700 18px var(--font-title, serif); letter-spacing: 2px; }
  .is-close { width: 36px; height: 36px; border: 0; border-radius: 50%; background: transparent; cursor: pointer; color: var(--is-muted); font-size: 24px; }
  .is-close:hover { color: var(--is-text); background: var(--is-surface); }
  .is-gallery-filters { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)) auto; gap: 10px; padding: 13px 22px; border-bottom: 1px solid var(--is-border); }
  .is-gallery-body { min-height: 260px; padding: 18px 22px 24px; overflow: auto; overflow-anchor: none; }
  .is-gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); gap: 13px; }
  .is-asset { min-width: 0; overflow: hidden; border: 1px solid var(--is-border); border-radius: 9px; background: rgba(255,255,255,.02); }
  .is-asset[aria-current='true'] { border-color: var(--is-accent); box-shadow: 0 0 0 1px var(--is-accent); }
  .is-asset-image { position: relative; aspect-ratio: 1; background: #070a0e; }
  .is-asset-image img { width: 100%; height: 100%; object-fit: cover; }
  .is-asset-protected { position: absolute; top: 7px; right: 7px; padding: 3px 6px; border-radius: 4px; background: rgba(7,10,14,.82); color: var(--is-gold); font-size: 9px; }
  .is-asset-info { padding: 10px; }
  .is-asset-title { overflow: hidden; color: var(--is-muted); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
  .is-asset-meta { margin-top: 4px; color: var(--is-faint); font-size: 9px; }
  .is-asset-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
  .is-asset-actions .is-btn { flex: 1; min-width: 48px; }
  .is-gallery-foot { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 13px 22px; border-top: 1px solid var(--is-border); }

  @media (max-width: 700px) {
    .is-grid { grid-template-columns: 1fr; gap: 7px; }
    .is-grid label:not(:first-child) { margin-top: 5px; }
    .is-turn-main { grid-template-columns: 1fr; }
    .is-turn-main .is-actions { justify-content: flex-start; }
    .is-portrait { grid-template-columns: 104px minmax(0, 1fr); gap: 12px; }
    .is-portrait-visual { width: 104px; }
    .is-gallery-backdrop { padding: 0; }
    .is-gallery-dialog { width: 100%; height: 100%; max-height: none; border-radius: 0; }
    .is-gallery-filters { grid-template-columns: 1fr 1fr; padding: 11px 14px; }
    .is-gallery-head, .is-gallery-body, .is-gallery-foot { padding-left: 14px; padding-right: 14px; }
    .is-gallery-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  }
`;

export default imageStudioStyles;
