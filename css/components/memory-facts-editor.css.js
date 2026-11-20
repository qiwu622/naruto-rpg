export const memoryFactsEditorStyles = `
  memory-facts-editor{
    --mf-gold: var(--ui-gold, #c69c6d);
    --mf-ink: var(--ui-surface-1, #12161d);
    --mf-surface: var(--ui-surface-2, #181d26);
    --mf-elevated: var(--ui-surface-elevated, #1e2430);
    --mf-paper: var(--ui-ink, #f0ece2);
    --mf-muted: var(--ui-ink-muted, #aba69b);
    --mf-faint: var(--ui-ink-faint, #757168);
    --mf-border: var(--ui-border, rgba(244,241,234,.10));
    --mf-border-strong: var(--ui-border-strong, rgba(244,241,234,.20));
    --mf-accent: var(--ui-accent, #eb613f);
    --mf-danger: var(--ui-state-danger, #e2645a);
    display:block;min-width:0;margin:0 0 24px;color:var(--mf-paper);font:13px/1.65 var(--font-body,system-ui,sans-serif)
  }
  memory-facts-editor *{box-sizing:border-box}
  memory-facts-editor .mf-shell{border:1px solid color-mix(in srgb, var(--mf-gold) 22%, transparent);border-radius:14px;background:linear-gradient(145deg,color-mix(in srgb, var(--mf-gold) 5%, transparent),transparent 40%),var(--mf-ink);overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,.14)}
  memory-facts-editor .mf-header{display:flex;gap:14px;align-items:center;padding:20px 22px 18px;border-bottom:1px solid var(--mf-border)}
  memory-facts-editor .mf-emblem{display:grid;place-items:center;flex:none;width:44px;height:46px;border:1px solid color-mix(in srgb, var(--mf-gold) 32%, transparent);border-radius:11px;color:var(--mf-gold);background:color-mix(in srgb, var(--mf-gold) 8%, transparent)}
  memory-facts-editor .mf-heading{min-width:0;flex:1}memory-facts-editor .mf-eyebrow{font-size:10px;letter-spacing:.12em;color:var(--mf-gold);margin:0 0 3px}
  memory-facts-editor h3{font:700 20px/1.35 var(--font-title,serif);letter-spacing:.03em;color:var(--mf-paper);margin:0}
  memory-facts-editor .mf-description{font-size:12px;color:var(--mf-muted);margin:5px 0 0;line-height:1.65}
  memory-facts-editor .mf-count{font-variant-numeric:tabular-nums;display:flex;flex-direction:column;align-items:flex-end;flex:none;color:var(--mf-muted);font-size:11px;padding-left:10px}
  memory-facts-editor .mf-count strong{font:700 26px/1.2 var(--font-title,serif);color:var(--mf-paper)}
  memory-facts-editor .mf-content{padding:18px 22px 4px}
  memory-facts-editor .mf-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  memory-facts-editor .mf-search{position:relative;display:flex;align-items:center;flex:1 1 220px;min-width:0}
  memory-facts-editor .mf-search-icon{position:absolute;left:13px;color:var(--mf-faint);display:flex;pointer-events:none}
  memory-facts-editor .mf-group{display:flex;gap:10px;align-items:center;flex:0 1 190px;min-width:0;white-space:nowrap;color:var(--mf-muted);font-size:12px}
  memory-facts-editor input,memory-facts-editor select,memory-facts-editor textarea{font:inherit;max-width:100%;min-width:0;color:var(--mf-paper);background:var(--mf-surface);border:1px solid var(--mf-border-strong);border-radius:8px;padding:9px 12px;min-height:42px;box-shadow:none;transition:border-color .15s,background .15s}
  memory-facts-editor input::placeholder,memory-facts-editor textarea::placeholder{color:var(--mf-faint)}
  memory-facts-editor input{width:100%;padding-left:38px}memory-facts-editor select{flex:1;color-scheme:var(--ui-color-scheme, dark)}
  memory-facts-editor select option{background:var(--mf-elevated);color:var(--mf-paper)}
  memory-facts-editor input:focus,memory-facts-editor textarea:focus,memory-facts-editor select:focus{border-color:var(--mf-gold);background:var(--mf-elevated);outline:none}
  memory-facts-editor .mf-result-info{display:flex;justify-content:space-between;gap:8px;margin:14px 0 4px;font-size:11px;color:var(--mf-faint);flex-wrap:wrap}
  memory-facts-editor .mf-list{max-height:560px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--mf-gold) 35%, transparent) transparent;padding-right:4px;margin-right:-4px}
  memory-facts-editor h4{display:flex;align-items:center;gap:10px;margin:14px 0 8px;font-size:11px;font-weight:600;color:var(--mf-gold);letter-spacing:.08em}
  memory-facts-editor h4:after{content:'';height:1px;background:linear-gradient(90deg,color-mix(in srgb, var(--mf-gold) 24%, transparent),transparent);flex:1}
  memory-facts-editor .mf-card{position:relative;padding:15px 16px 9px;border:1px solid var(--mf-border);border-radius:10px;margin-bottom:10px;min-width:0;background:var(--mf-surface);transition:background .15s,border-color .15s}
  memory-facts-editor .mf-card:hover{border-color:color-mix(in srgb, var(--mf-gold) 34%, transparent);background:var(--mf-elevated)}
  memory-facts-editor .mf-card.is-pinned{border-left:3px solid var(--mf-gold);background:color-mix(in srgb, var(--mf-gold) 7%, var(--mf-surface))}
  memory-facts-editor .mf-card.is-editing{border-color:color-mix(in srgb, var(--mf-gold) 50%, transparent);background:var(--mf-elevated)}
  memory-facts-editor .mf-text,memory-facts-editor .mf-history-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;margin:0;color:var(--mf-paper);font-size:13px}
  memory-facts-editor .mf-meta{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:7px 0 8px;font-size:11px;color:var(--mf-faint);overflow-wrap:anywhere}
  memory-facts-editor .mf-pinned{display:inline-flex;align-items:center;gap:4px;color:var(--mf-gold)}
  memory-facts-editor .mf-hint{font-size:12px;color:var(--mf-muted);overflow-wrap:anywhere;line-height:1.75}
  memory-facts-editor .mf-actions{display:flex;gap:4px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--mf-border);margin:10px -4px 0;padding-top:5px}
  memory-facts-editor button{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:normal;min-height:40px;padding:7px 11px;border-radius:7px;border:1px solid transparent;font:500 12px/1.4 var(--font-body,system-ui,sans-serif);color:var(--mf-muted);background:transparent;cursor:pointer;box-shadow:none;text-transform:none;letter-spacing:0;transition:color .15s,background .15s,border-color .15s}
  memory-facts-editor button .icon{width:14px;height:14px;flex:none;display:block}
  memory-facts-editor button:hover:not(:disabled){color:var(--mf-paper);background:color-mix(in srgb, var(--mf-paper) 6%, transparent)}
  memory-facts-editor button[data-action=edit],memory-facts-editor button[data-action=source]{color:var(--mf-gold)}
  memory-facts-editor button[data-action=source]{margin-left:auto}
  memory-facts-editor button[data-action=reject]:hover:not(:disabled){color:var(--mf-danger);background:color-mix(in srgb, var(--mf-danger) 10%, transparent)}
  memory-facts-editor button[data-action=save]{color:var(--ui-btn-primary-ink, #f6f1e7);border-color:var(--ui-btn-primary-border, #9e5341);background:var(--ui-btn-primary-bg, #6c3326);box-shadow:var(--ui-btn-primary-shadow, 0 1px 2px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.11));padding-inline:16px;border-radius:6px;transition:background .16s ease,border-color .16s ease,box-shadow .16s ease,transform .12s ease}
  memory-facts-editor button[data-action=save]:hover:not(:disabled){color:var(--ui-btn-primary-ink, #f6f1e7);background:var(--ui-btn-primary-bg-hover, #7f3b2c);border-color:var(--ui-btn-primary-border-hover, #b8624d);box-shadow:var(--ui-btn-primary-shadow-hover, 0 2px 6px rgba(0,0,0,.44),inset 0 1px 0 rgba(255,255,255,.15))}
  memory-facts-editor button[data-action=save]:active:not(:disabled){background:var(--ui-btn-primary-bg-active, #5a2a1f);box-shadow:var(--ui-btn-primary-shadow-active, inset 0 1px 2px rgba(0,0,0,.38));transform:translateY(1px)}
  memory-facts-editor button{min-width:44px}
  memory-facts-editor button:disabled{opacity:.4;cursor:default}
  memory-facts-editor button[data-action=pin]:disabled{color:var(--mf-gold);opacity:.72}
  memory-facts-editor .mf-edit-label{display:block;margin-top:12px;font-size:12px;color:var(--mf-gold)}
  memory-facts-editor textarea{display:block;width:100%;min-height:110px;resize:vertical;margin:8px 0;line-height:1.8}
  memory-facts-editor .mf-pagination{display:flex;align-items:center;justify-content:center;gap:16px;padding:12px 0 16px;font-size:12px;font-variant-numeric:tabular-nums;color:var(--mf-muted)}
  memory-facts-editor .mf-pagination button{min-width:74px;border-color:var(--mf-border-strong)}
  memory-facts-editor .mf-history-wrap{border-top:1px solid var(--mf-border);background:var(--mf-surface);padding:0 22px}
  memory-facts-editor summary{list-style:none;display:flex;align-items:center;gap:9px;cursor:pointer;min-height:52px;color:var(--mf-muted);font-size:12px}
  memory-facts-editor summary::-webkit-details-marker{display:none}
  memory-facts-editor .mf-history-chevron{margin-left:auto;display:flex;transition:transform .15s}
  memory-facts-editor details[open] .mf-history-chevron{transform:rotate(180deg)}
  memory-facts-editor .mf-history{max-height:300px;overflow:auto;scrollbar-width:thin;padding:0 0 14px}
  memory-facts-editor .mf-history-item{padding:12px 0 8px 16px;border-left:1px solid color-mix(in srgb, var(--mf-gold) 32%, transparent);margin-left:4px;position:relative}
  memory-facts-editor .mf-history-item:before{content:'';position:absolute;left:-3px;top:22px;width:5px;height:5px;border-radius:50%;background:var(--mf-gold)}
  memory-facts-editor .mf-history-text{font-size:12px}memory-facts-editor .mf-history-before{color:var(--mf-faint)}memory-facts-editor .mf-history-after{display:block;color:var(--mf-paper);margin-top:4px}
  memory-facts-editor .mf-history-item button{padding-left:0;color:var(--mf-muted)}
  memory-facts-editor [role=alert]:not(:empty){margin:12px 0 0;padding:10px 12px;border:1px solid color-mix(in srgb, var(--mf-danger) 40%, transparent);background:color-mix(in srgb, var(--mf-danger) 10%, transparent);border-radius:8px;color:var(--mf-danger);white-space:pre-wrap;overflow-wrap:anywhere}
  memory-facts-editor [data-memory-status]:not(:empty){margin:10px 0;color:var(--mf-gold);font-size:12px}
  memory-facts-editor .mf-empty{padding:36px 16px;text-align:center;border:1px dashed var(--mf-border-strong);border-radius:10px;margin:14px 0;color:var(--mf-muted)}
  memory-facts-editor .mf-empty-icon{display:block;color:var(--mf-gold);margin-bottom:8px}
  memory-facts-editor .mf-empty p{margin:4px 0;font-size:12px}memory-facts-editor .mf-empty strong{font-weight:600;color:var(--mf-paper);font-size:14px}
  memory-facts-editor :focus-visible{outline:2px solid var(--mf-gold);outline-offset:3px}
  @media(max-width:540px){memory-facts-editor .mf-header{padding:16px 14px;gap:11px}memory-facts-editor h3{font-size:19px}memory-facts-editor .mf-count strong{font-size:22px}memory-facts-editor .mf-emblem{width:38px;height:42px}memory-facts-editor .mf-content{padding:14px 14px 2px}memory-facts-editor .mf-search{flex-basis:100%}memory-facts-editor .mf-group{flex:1}memory-facts-editor .mf-card{padding:13px 12px 7px}memory-facts-editor .mf-history-wrap{padding-inline:14px}memory-facts-editor .mf-description{font-size:11px}memory-facts-editor .mf-text{font-size:13px}memory-facts-editor button{padding-inline:8px}memory-facts-editor .mf-actions{gap:2px}}
  @media(prefers-reduced-motion:reduce){memory-facts-editor *{transition:none!important}}
`;
