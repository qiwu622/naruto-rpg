export const imageStudioStyles = `
  :host {
    --is-accent: var(--ui-accent, var(--c-shuiro, #eb613f));
    --is-accent-ink: var(--ui-accent-ink, #ffffff);
    --is-gold: var(--ui-gold, var(--c-kin, #c69c6d));
    --is-bg: var(--ui-surface-1, #12161d);
    --is-surface: var(--ui-surface-2, #181d26);
    --is-surface-hover: var(--ui-surface-elevated, #1e2430);
    --is-border: var(--ui-border, rgba(244, 241, 234, 0.12));
    --is-border-strong: var(--ui-border-strong, rgba(244, 241, 234, 0.22));
    --is-text: var(--ui-ink, #f0ece2);
    --is-muted: var(--ui-ink-muted, #aba69b);
    --is-faint: var(--ui-ink-faint, #757168);
    color: var(--is-text);
    font-family: var(--font-body, 'Noto Sans SC', 'Microsoft YaHei UI', system-ui, sans-serif);
    box-sizing: border-box;
    color-scheme: var(--ui-color-scheme, dark);
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; }
  button { color: inherit; }
  [hidden] { display: none !important; }

  .is-card {
    border: 1px solid var(--is-border);
    border-radius: 12px;
    background:
      radial-gradient(circle at 0 0, color-mix(in srgb, var(--is-gold) 7%, transparent), transparent 42%),
      var(--is-bg);
    overflow: hidden;
  }
  .is-section { padding: 18px; border-bottom: 1px solid var(--is-border); }
  .is-section:last-child { border-bottom: 0; }
  .is-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
  .is-section-head h3, .is-section-head h4 { margin: 0; font-family: var(--font-title, serif); letter-spacing: 0.6px; }
  .is-section-head h3 { font-size: 15px; }
  .is-section-head h4 { font-size: 13px; }
  .is-eyebrow { margin: 0 0 4px; color: var(--is-gold); font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; }
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
    width: 100%; min-width: 0; min-height: 36px; padding: 8px 11px;
    color: var(--is-text); background: var(--is-surface);
    border: 1px solid var(--is-border-strong); border-radius: 8px; outline: none;
    transition: border-color .16s ease, background .16s ease, box-shadow .16s ease;
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--is-accent);
    background: var(--is-surface-hover);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--is-accent) 16%, transparent);
  }
  textarea { resize: vertical; min-height: 82px; line-height: 1.55; }
  select option { color: var(--is-text); background: var(--is-surface-hover); }
  input[type='checkbox'] {
    appearance: none; width: 40px; height: 22px; margin: 0;
    border: 1px solid var(--is-border-strong); border-radius: 999px;
    background: var(--is-surface-hover); cursor: pointer; position: relative;
  }
  input[type='checkbox']::after {
    content: ''; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px;
    border-radius: 50%; background: var(--is-muted); transition: transform .17s ease, background .17s ease;
  }
  input[type='checkbox']:checked { background: var(--is-accent); border-color: var(--is-accent); }
  input[type='checkbox']:checked::after { transform: translateX(18px); background: var(--is-accent-ink); }
  input[type='file'] { width: 100%; color: var(--is-faint); font-size: 11px; }

  .is-btn {
    min-height: 34px; padding: 7px 13px; border: 1px solid var(--is-border-strong); border-radius: 6px;
    background: var(--is-surface); color: var(--is-text); cursor: pointer; font-size: 12px; font-weight: 500; letter-spacing: 0.02em; line-height: 1.25;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition: transform .12s ease, border-color .16s ease, background .16s ease, box-shadow .16s ease, opacity .15s ease;
  }
  .is-btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--is-gold) 50%, transparent); background: var(--is-surface-hover); }
  .is-btn:active:not(:disabled) { transform: translateY(1px); }
  .is-btn:disabled { cursor: not-allowed; opacity: .42; box-shadow: none; transform: none; }
  .is-btn--primary {
    border-color: var(--ui-btn-primary-border, #9e5341);
    background: var(--ui-btn-primary-bg, #6c3326);
    color: var(--ui-btn-primary-ink, #f6f1e7); font-weight: 500;
    box-shadow: var(--ui-btn-primary-shadow, 0 1px 2px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.11));
  }
  .is-btn--primary:hover:not(:disabled) {
    border-color: var(--ui-btn-primary-border-hover, #b8624d);
    background: var(--ui-btn-primary-bg-hover, #7f3b2c);
    box-shadow: var(--ui-btn-primary-shadow-hover, 0 2px 6px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.15));
  }
  .is-btn--primary:active:not(:disabled) {
    background: var(--ui-btn-primary-bg-active, #5a2a1f);
    box-shadow: var(--ui-btn-primary-shadow-active, inset 0 1px 2px rgba(0, 0, 0, 0.38));
  }
  .is-btn--danger { color: var(--ui-state-danger, #e2645a); border-color: color-mix(in srgb, var(--ui-state-danger, #e2645a) 40%, transparent); }
  .is-btn--small { min-height: 29px; padding: 5px 9px; font-size: 11px; }
  .is-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .is-status { min-height: 18px; margin-top: 9px; color: var(--is-muted); font-size: 11px; line-height: 1.55; }
  .is-status[data-tone='success'] { color: #81c784; }
  .is-status[data-tone='error'] { color: #ff8d89; }
  .is-status[data-tone='working'] { color: #80d8ff; }
  .is-unavailable { padding: 13px 15px; border: 1px dashed var(--is-border); border-radius: 7px; color: var(--is-faint); font-size: 11px; line-height: 1.65; }
  .is-warning { padding: 10px 12px; border-left: 2px solid var(--is-gold); background: color-mix(in srgb, var(--is-gold) 8%, transparent); color: var(--is-muted); font-size: 11px; line-height: 1.65; }
  .is-metric { display: flex; align-items: baseline; gap: 7px; }
  .is-metric strong { font-size: 18px; }
  .is-metric span { color: var(--is-faint); font-size: 10px; }
  .is-quota-track { height: 5px; margin-top: 9px; overflow: hidden; border-radius: 99px; background: var(--is-border); }
  .is-quota-track > i { display: block; height: 100%; width: var(--quota, 0%); border-radius: inherit; background: linear-gradient(90deg, var(--is-gold), var(--is-accent)); }

  .is-provider { padding: 13px; border: 1px solid var(--is-border); border-radius: 8px; background: var(--is-surface); }
  .is-provider-fields { margin-top: 13px; }
  .is-model-catalog { display: grid; gap: 9px; padding: 10px 12px; border: 1px solid var(--is-border); border-radius: 8px; background: var(--is-surface); }
  .is-model-catalog.is-note { padding: 9px 11px; }
  .is-model-search { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
  .is-model-search > span, .is-model-limit { color: var(--is-faint); font-size: 10px; line-height: 1.45; }
  .is-model-group { min-width: 0; }
  .is-model-group-title, .is-model-group summary { color: var(--is-muted); font-size: 11px; line-height: 1.5; }
  .is-model-group summary { cursor: pointer; }
  .is-model-group-title span, .is-model-group summary span { color: var(--is-faint); }
  .is-model-options { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
  .is-model-option { max-width: 100%; padding: 5px 8px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--is-gold) 28%, transparent); border-radius: 5px; background: color-mix(in srgb, var(--is-gold) 8%, transparent); color: var(--is-muted); cursor: pointer; font-size: 10px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
  .is-model-option:hover, .is-model-option:focus-visible { border-color: var(--is-accent); background: color-mix(in srgb, var(--is-accent) 12%, transparent); color: var(--is-text); outline: none; }
  .is-code { font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace; font-size: 11px; }
  .is-worldbook-list { display: grid; gap: 9px; margin: 12px 0; }
  .is-worldbook-entry { padding: 12px; border: 1px solid var(--is-border); border-radius: 8px; background: var(--is-surface); }
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
  .is-gallery-backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 22px; background: var(--ui-backdrop, rgba(3,4,6,.86)); backdrop-filter: blur(12px); }
  .is-gallery-dialog { width: min(1120px, 100%); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--is-border-strong); border-radius: 14px; background: var(--ui-canvas, #0b0f14); box-shadow: var(--ui-shadow, 0 32px 100px rgba(0,0,0,.6)); }
  .is-gallery-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 18px 22px; border-bottom: 1px solid var(--is-border); background: var(--is-bg); }
  .is-gallery-head h2 { margin: 0; font: 700 18px var(--font-title, serif); letter-spacing: 1px; color: var(--is-text); }
  .is-close { width: 36px; height: 36px; border: 0; border-radius: 50%; background: transparent; cursor: pointer; color: var(--is-muted); font-size: 24px; }
  .is-close:hover { color: var(--is-text); background: var(--is-surface); }
  .is-gallery-filters { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)) auto; gap: 10px; padding: 13px 22px; border-bottom: 1px solid var(--is-border); }
  .is-gallery-body { min-height: 260px; padding: 18px 22px 24px; overflow: auto; overflow-anchor: none; }
  .is-gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); gap: 13px; }
  .is-asset { min-width: 0; overflow: hidden; border: 1px solid var(--is-border); border-radius: 10px; background: var(--is-bg); }
  .is-asset[aria-current='true'] { border-color: var(--is-accent); box-shadow: 0 0 0 1px var(--is-accent); }
  .is-asset-image { position: relative; aspect-ratio: 1; background: var(--is-surface); }
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
