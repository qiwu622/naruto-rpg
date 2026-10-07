import { multiplayerTheme } from './multiplayer-theme.css.js';
import { gradeEffectStyles } from './grade-effects.css.js';

export const multiplayerCharacterStyles = `
  :host{${multiplayerTheme}display:block;height:100%;min-width:0;color:var(--mp-text);font:13px/1.6 var(--mp-font);color-scheme:dark}
  *{box-sizing:border-box}
  button{font:inherit}
  button:focus-visible{outline:2px solid var(--mp-gold);outline-offset:3px}
  .panel{height:100%;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--mp-bg)}
  .header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:24px 20px 20px;border-bottom:1px solid var(--mp-border)}
  .header-copy{display:flex;flex-direction:column;gap:6px;min-width:0}
  .header-eyebrow{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;letter-spacing:1px;color:var(--mp-gold)}
  .header-eyebrow i{display:block;width:6px;height:6px;border:1px solid currentColor;border-radius:2px;transform:rotate(45deg)}
  .header strong{font:700 22px/1.35 var(--mp-font);letter-spacing:.04em}
  .header button{display:none;flex-shrink:0;width:40px;height:40px;border:1px solid var(--mp-border);border-radius:10px;background:var(--mp-card);color:var(--mp-secondary);font-size:23px;line-height:1;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
  .header button:hover{background:var(--mp-raised);border-color:var(--mp-border-strong);color:var(--mp-text)}
  .tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:3px;padding:9px 12px;border-bottom:1px solid var(--mp-border);background:var(--mp-bg)}
  .tabs button{position:relative;min-width:0;min-height:42px;padding:8px 1px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--mp-muted);font-size:13px;font-weight:600;line-height:1.4;cursor:pointer;transition:color .15s,background .15s,border-color .15s}
  .tabs button:hover{color:var(--mp-text);background:var(--mp-card)}
  .tabs button.active{color:var(--mp-text);background:var(--mp-raised);border-color:var(--mp-border)}
  .tabs button.active::after{content:'';position:absolute;left:36%;right:36%;bottom:4px;height:2px;border-radius:2px;background:var(--mp-gold)}
  .content{flex:1;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;padding:18px 16px 24px;scrollbar-width:thin;scrollbar-color:var(--mp-border-strong) transparent}
  .identity-card{display:flex;flex-direction:column;gap:12px;padding:18px;margin-bottom:12px;border:1px solid var(--mp-border-strong);border-radius:var(--mp-radius);background:linear-gradient(125deg,rgba(198,156,109,.09),transparent 80%),var(--mp-card)}
  .identity-topline{display:flex;justify-content:space-between;align-items:center;gap:10px;min-width:0}
  .eyebrow{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--mp-secondary)}
  .identity-name{display:block;min-width:0;font:700 26px/1.3 var(--mp-font);letter-spacing:.03em;color:var(--mp-text);overflow-wrap:anywhere}
  .identity-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--mp-secondary);font-size:12px}
  .rank-badge{display:inline-flex;align-items:center;min-height:25px;padding:1px 9px;border:1px solid rgba(198,156,109,.24);border-radius:6px;background:rgba(198,156,109,.09);color:var(--mp-gold);font-weight:600}
  .readonly-badge{padding:2px 7px;border:1px solid var(--mp-border);border-radius:6px;background:rgba(255,255,255,.02);color:var(--mp-muted);font-size:12px;white-space:nowrap}
  .quick-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0 0 22px}
  .quick-grid article{min-width:0;padding:11px 12px;border:1px solid var(--mp-border);border-radius:10px;background:var(--mp-card)}
  .quick-grid article.wide{grid-column:1/-1;display:grid;grid-template-columns:60px minmax(0,1fr);align-items:baseline;gap:10px}
  .quick-grid span,.subtle{display:block;margin-bottom:4px;font-size:12px;color:var(--mp-muted)}
  .quick-grid .wide span{margin:0}
  .quick-grid strong{display:block;min-width:0;font-size:13px;line-height:1.55;font-weight:600;color:var(--mp-text);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
  .quick-grid article:not(.wide) strong{font-size:19px;line-height:1.5;letter-spacing:.015em}
  .section{margin:0 0 22px}
  .section h3,.collection-heading h3{margin:0;font-size:13px;line-height:1.5;font-weight:650;color:var(--mp-text)}
  .section h3{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px}
  .section h3>span{font-size:12px;font-weight:400;color:var(--mp-muted)}
  .section.compact{padding:14px;border:1px solid var(--mp-border);border-radius:var(--mp-radius);background:var(--mp-card);margin-bottom:12px}
  .section.compact h3{margin-bottom:8px}
  .section p{margin:0 0 10px;font-size:13px;line-height:1.8;color:var(--mp-secondary);overflow-wrap:anywhere}
  .section p:last-child{margin-bottom:0}
  .section .subtle{margin-bottom:2px}
  .resource-list{display:grid;gap:16px;padding:15px 14px 17px;border:1px solid var(--mp-border);border-radius:var(--mp-radius);background:var(--mp-card)}
  .resource>div{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:12px;margin-bottom:8px;font-size:13px;color:var(--mp-secondary)}
  .resource strong{font-size:12px;font-family:var(--font-mono,ui-monospace,monospace);font-weight:500;color:var(--mp-text);font-variant-numeric:tabular-nums;text-align:right}
  .resource i,.mission-progress{display:block;height:5px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden}
  .resource b,.mission-progress b{display:block;height:100%;border-radius:inherit}
  .collection-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
  .collection-heading>span{color:var(--mp-muted);font-size:12px;font-variant-numeric:tabular-nums}
  .card-list{display:grid;gap:10px}
  .list-card{min-width:0;padding:15px 14px;border:1px solid var(--mp-border);border-radius:var(--mp-radius);background:var(--mp-card)}
  .card-title{display:flex;align-items:flex-start;justify-content:space-between;gap:9px;min-width:0}
  .card-title strong{min-width:0;font-size:14px;font-weight:600;line-height:1.55;overflow-wrap:anywhere}
  .card-title>span{max-width:48%;flex-shrink:0;padding:2px 7px;border:1px solid var(--mp-border);border-radius:6px;background:var(--mp-raised);color:var(--mp-secondary);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
  .card-metrics{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;margin-top:12px;color:var(--mp-muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
  .card-metrics b{font-weight:500;color:var(--mp-text);font-variant-numeric:tabular-nums}
  .card-metrics>span b{margin-left:4px}
  .card-metrics .equipped-label{color:var(--mp-gold)}
  .mission-progress{margin-top:11px}
  .mission-progress b{background:var(--mp-gold)}
  .empty-state{min-height:250px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:22px 12px;text-align:center;color:var(--mp-muted)}
  .empty-state>span{width:52px;height:52px;display:grid;place-items:center;border:1px solid var(--mp-border-strong);border-radius:14px;background:var(--mp-card);font:600 22px/1 var(--font-title,var(--mp-font));color:var(--mp-gold)}
  .empty-state strong{max-width:230px;font-size:13px;font-weight:400;line-height:1.8;overflow-wrap:anywhere}
  .empty,.privacy-note{font-size:12px;line-height:1.8;color:var(--mp-muted);overflow-wrap:anywhere}
  .privacy-note{margin:15px 3px 0;padding-top:13px;border-top:1px solid var(--mp-border)}
  footer{display:flex;align-items:center;gap:8px;flex-shrink:0;padding:12px 16px;border-top:1px solid var(--mp-border);font-size:12px;line-height:1.5;color:var(--mp-muted);background:var(--mp-bg)}
  footer>span:last-child{min-width:0;overflow-wrap:anywhere}
  .live-dot{flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:var(--mp-warning)}
  .live-dot.is-synced{background:var(--mp-success)}
  @media(max-width:768px){.header button{display:grid;place-items:center}.header{padding:18px 16px 16px}.content{padding-bottom:calc(24px + env(safe-area-inset-bottom,0px))}}
  @media(max-width:340px){.content{padding-left:12px;padding-right:12px}.header{padding-left:14px;padding-right:14px}.identity-card{padding:15px}.identity-name{font-size:24px}.tabs{padding-left:8px;padding-right:8px}.quick-grid article.wide{grid-template-columns:56px minmax(0,1fr);gap:8px}}
  ${gradeEffectStyles}
  .card-metrics .grade-badge{margin-block:-2px;font-size:12px}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;
