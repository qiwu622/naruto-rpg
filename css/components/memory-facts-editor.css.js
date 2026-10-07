export const memoryFactsEditorStyles = `
  memory-facts-editor{--mf-gold:#d8b477;--mf-ink:#10161d;--mf-paper:#e8e4d9;--mf-muted:#aca99f;display:block;min-width:0;margin:0 0 24px;color:var(--mf-paper);font:13px/1.65 var(--font-body,system-ui,sans-serif)}
  memory-facts-editor *{box-sizing:border-box}
  memory-facts-editor .mf-shell{border:1px solid #d8b47726;border-radius:16px;background:linear-gradient(145deg,#d8b47709,transparent 40%),var(--mf-ink);overflow:hidden;box-shadow:0 14px 40px #0000001c}
  memory-facts-editor .mf-header{display:flex;gap:14px;align-items:center;padding:24px 24px 20px;border-bottom:1px solid #ffffff0b}
  memory-facts-editor .mf-emblem{display:grid;place-items:center;flex:none;width:44px;height:48px;border:1px solid #d8b47740;border-radius:11px;color:var(--mf-gold);background:#d8b47709}
  memory-facts-editor .mf-heading{min-width:0;flex:1}memory-facts-editor .mf-eyebrow{font-size:10px;letter-spacing:.16em;color:var(--mf-gold);margin:0 0 4px}
  memory-facts-editor h3{font:600 23px/1.4 var(--font-title,serif);letter-spacing:.05em;color:var(--mf-paper);margin:0}
  memory-facts-editor .mf-description{font-size:12px;color:var(--mf-muted);margin:7px 0 0;line-height:1.7}
  memory-facts-editor .mf-count{font-variant-numeric:tabular-nums;display:flex;flex-direction:column;align-items:flex-end;flex:none;color:var(--mf-muted);font-size:11px;padding-left:10px}
  memory-facts-editor .mf-count strong{font:500 28px/1.2 var(--font-title,serif);color:var(--mf-paper)}
  memory-facts-editor .mf-content{padding:20px 24px 4px}
  memory-facts-editor .mf-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  memory-facts-editor .mf-search{position:relative;display:flex;align-items:center;flex:1 1 220px;min-width:0}
  memory-facts-editor .mf-search-icon{position:absolute;left:13px;color:#b9ac96;display:flex;pointer-events:none}
  memory-facts-editor .mf-group{display:flex;gap:10px;align-items:center;flex:0 1 190px;min-width:0;white-space:nowrap;color:var(--mf-muted);font-size:12px}
  memory-facts-editor input,memory-facts-editor select,memory-facts-editor textarea{font:inherit;max-width:100%;min-width:0;color:var(--mf-paper);background:#080c1280;border:1px solid #ffffff18;border-radius:9px;padding:10px 12px;min-height:44px;box-shadow:none;transition:border-color .15s,background .15s}
  memory-facts-editor input::placeholder,memory-facts-editor textarea::placeholder{color:#848b92}
  memory-facts-editor input{width:100%;padding-left:39px}memory-facts-editor select{flex:1;color-scheme:dark}
  memory-facts-editor input:focus,memory-facts-editor textarea:focus,memory-facts-editor select:focus{border-color:#d8b47790;background:#111b25;outline:none}
  memory-facts-editor .mf-result-info{display:flex;justify-content:space-between;gap:8px;margin:16px 0 2px;font-size:11px;color:#939ba2;flex-wrap:wrap}
  memory-facts-editor .mf-list{max-height:560px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#d8b47740 transparent;padding-right:4px;margin-right:-4px}
  memory-facts-editor h4{display:flex;align-items:center;gap:10px;margin:16px 0 10px;font-size:11px;font-weight:500;color:var(--mf-gold);letter-spacing:.1em}
  memory-facts-editor h4:after{content:'';height:1px;background:linear-gradient(90deg,#d8b47722,transparent);flex:1}
  memory-facts-editor .mf-card{position:relative;padding:16px 18px 10px;border:1px solid #ffffff0c;border-radius:11px;margin-bottom:10px;min-width:0;background:#ffffff03;transition:background .15s,border-color .15s}
  memory-facts-editor .mf-card:hover{border-color:#d8b47730;background:#ffffff05}
  memory-facts-editor .mf-card.is-pinned{border-left:2px solid var(--mf-gold);background:linear-gradient(110deg,#d8b47709,transparent)}
  memory-facts-editor .mf-card.is-editing{border-color:#d8b47750;background:#d8b47704}
  memory-facts-editor .mf-text,memory-facts-editor .mf-history-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.85;margin:0;color:var(--mf-paper);font-size:14px}
  memory-facts-editor .mf-meta{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:8px 0 10px;font-size:11px;color:#929b9f;overflow-wrap:anywhere}
  memory-facts-editor .mf-pinned{display:inline-flex;align-items:center;gap:4px;color:var(--mf-gold)}
  memory-facts-editor .mf-hint{font-size:12px;color:var(--mf-muted);overflow-wrap:anywhere;line-height:1.8}
  memory-facts-editor .mf-actions{display:flex;gap:4px;flex-wrap:wrap;align-items:center;border-top:1px solid #ffffff08;margin:10px -5px 0;padding-top:5px}
  memory-facts-editor button{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:normal;min-height:44px;padding:8px 11px;border-radius:7px;border:1px solid transparent;font:500 12px/1.4 var(--font-body,system-ui,sans-serif);color:#babcb7;background:transparent;cursor:pointer;box-shadow:none;text-transform:none;letter-spacing:0;transition:color .15s,background .15s,border-color .15s}
  memory-facts-editor button .icon{width:14px;height:14px;flex:none;display:block}
  memory-facts-editor button:hover:not(:disabled){color:var(--mf-paper);background:#ffffff07}
  memory-facts-editor button[data-action=edit],memory-facts-editor button[data-action=source]{color:var(--mf-gold)}
  memory-facts-editor button[data-action=source]{margin-left:auto}
  memory-facts-editor button[data-action=reject]:hover:not(:disabled){color:#efaaa0;background:#d9675c12}
  memory-facts-editor button[data-action=save]{color:#171b1d;border-color:#d8b477;background:#d8b477;padding-inline:16px}
  memory-facts-editor button[data-action=save]:hover:not(:disabled){background:#e8c58b;color:#171b1d}
  memory-facts-editor button{min-width:44px}
  memory-facts-editor button:disabled{opacity:.4;cursor:default}
  memory-facts-editor button[data-action=pin]:disabled{color:var(--mf-gold);opacity:.72}
  memory-facts-editor .mf-edit-label{display:block;margin-top:14px;font-size:12px;color:var(--mf-gold)}
  memory-facts-editor textarea{display:block;width:100%;min-height:110px;resize:vertical;margin:8px 0;line-height:1.8}
  memory-facts-editor .mf-pagination{display:flex;align-items:center;justify-content:center;gap:18px;padding:12px 0 16px;font-size:12px;font-variant-numeric:tabular-nums;color:#a4aaa9}
  memory-facts-editor .mf-pagination button{min-width:74px;border-color:#ffffff14}
  memory-facts-editor .mf-history-wrap{border-top:1px solid #d8b4771c;background:#080c122e;padding:0 24px}
  memory-facts-editor summary{list-style:none;display:flex;align-items:center;gap:9px;cursor:pointer;min-height:56px;color:#c8bea9;font-size:12px}
  memory-facts-editor summary::-webkit-details-marker{display:none}
  memory-facts-editor .mf-history-chevron{margin-left:auto;display:flex;transition:transform .15s}
  memory-facts-editor details[open] .mf-history-chevron{transform:rotate(180deg)}
  memory-facts-editor .mf-history{max-height:300px;overflow:auto;scrollbar-width:thin;padding:0 0 14px}
  memory-facts-editor .mf-history-item{padding:14px 0 8px 16px;border-left:1px solid #d8b47730;margin-left:4px;position:relative}
  memory-facts-editor .mf-history-item:before{content:'';position:absolute;left:-3px;top:24px;width:5px;height:5px;border-radius:50%;background:var(--mf-gold)}
  memory-facts-editor .mf-history-text{font-size:12px}memory-facts-editor .mf-history-before{color:#939998}memory-facts-editor .mf-history-after{display:block;color:#d7d7c6;margin-top:4px}
  memory-facts-editor .mf-history-item button{padding-left:0;color:var(--mf-muted)}
  memory-facts-editor [role=alert]:not(:empty){margin:12px 0 0;padding:10px 12px;border:1px solid #e88b7f40;background:#e88b7f09;border-radius:8px;color:#efb1a6;white-space:pre-wrap;overflow-wrap:anywhere}
  memory-facts-editor [data-memory-status]:not(:empty){margin:10px 0;color:var(--mf-gold);font-size:12px}
  memory-facts-editor .mf-empty{padding:38px 16px;text-align:center;border:1px dashed #d8b47722;border-radius:10px;margin:14px 0;color:var(--mf-muted)}
  memory-facts-editor .mf-empty-icon{display:block;color:#d8b47790;margin-bottom:8px}
  memory-facts-editor .mf-empty p{margin:4px 0;font-size:12px}memory-facts-editor .mf-empty strong{font-weight:500;color:#d4cbbc;font-size:14px}
  memory-facts-editor :focus-visible{outline:2px solid var(--mf-gold);outline-offset:3px}
  @media(max-width:540px){memory-facts-editor .mf-header{padding:18px 16px;gap:11px}memory-facts-editor h3{font-size:21px}memory-facts-editor .mf-count strong{font-size:24px}memory-facts-editor .mf-emblem{width:38px;height:44px}memory-facts-editor .mf-content{padding:16px 14px 2px}memory-facts-editor .mf-search{flex-basis:100%}memory-facts-editor .mf-group{flex:1}memory-facts-editor .mf-card{padding:14px 13px 7px}memory-facts-editor .mf-history-wrap{padding-inline:16px}memory-facts-editor .mf-description{font-size:11px}memory-facts-editor .mf-text{font-size:13px}memory-facts-editor button{padding-inline:8px}memory-facts-editor .mf-actions{gap:2px}}
  @media(prefers-reduced-motion:reduce){memory-facts-editor *{transition:none!important}}
`;
