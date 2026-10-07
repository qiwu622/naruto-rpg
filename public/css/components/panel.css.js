import { gradeEffectStyles } from './grade-effects.css.js';
export { gradeEffectStyles } from './grade-effects.css.js';

export const panelStyles = `
        :host { display: block; height: 100%; }
        .panel {
          display: flex; flex-direction: column; height: 100%; overflow: hidden;
          background: transparent;
          color: var(--text-primary);
          position: relative;
        }

        /* ── Mobile Panel Header ──── */
        .panel-header-mobile {
          display: flex; justify-content: space-between; align-items: center;
          padding: 14px 16px 12px 20px; border-bottom: 1px solid var(--border-hairline);
          background: rgba(255,255,255,0.02);
        }
        .panel-title-mobile {
          font-family: var(--font-title); font-size: 13px; font-weight: 800;
          color: var(--text-primary); letter-spacing: 2px;
        }
        .panel-close-btn-mobile {
          background: transparent; border: none; color: var(--text-secondary);
          font-size: 18px; cursor: pointer; padding: 8px; min-width: 40px; min-height: 40px; display: flex;
          align-items: center; justify-content: center; transition: all 0.2s;
          line-height: 1;
        }
        .panel-close-btn-mobile:hover {
          color: var(--text-primary); transform: scale(1.1);
        }

        /* ── 标签页 (Shinobi Tanzaku) ──── */
        .tabs {
          display: flex; gap: 8px; padding: 0 16px;
          border-bottom: 1px solid var(--border-hairline);
          z-index: 5;
        }
        .tab {
          flex: 1; padding: 16px 2px 12px; font-size: 12px; text-align: center; color: var(--text-secondary);
          cursor: pointer; border: none; background: transparent; border-bottom: 2px solid transparent;
          transition: color 0.2s, border-color 0.2s; letter-spacing: 1px;
          font-family: var(--font-title); margin-bottom: -1px;
        }
        .tab:hover { color: var(--text-primary); }
        .tab.on { 
          color: var(--c-kin-bright); font-weight: 700; border-bottom-color: var(--c-kin);
        }

        @keyframes content-enter {
          from { opacity: 0.6; }
          to { opacity: 1; }
        }
        .content { 
          flex: 1; min-height: 0; overflow-y: auto; padding: 24px 20px;
          scrollbar-width: thin; scrollbar-color: rgba(198,156,109,0.45) transparent;
          scrollbar-gutter: stable;
          mask-image: linear-gradient(to bottom, transparent, #000 24px, #000 calc(100% - 24px), transparent);
          -webkit-mask-image: linear-gradient(to bottom, transparent, #000 24px, #000 calc(100% - 24px), transparent);
          animation: content-enter 0.18s ease-out forwards;
        }
        .content::-webkit-scrollbar { width: 5px; }
        .content::-webkit-scrollbar-track { background: transparent; }
        .content::-webkit-scrollbar-thumb { background: rgba(198,156,109,0.35); border-radius: 3px; }
        .content::-webkit-scrollbar-thumb:hover { background: rgba(198,156,109,0.6); }

        /* ── 章节容器 (Scroll Section) ──── */
        .sec {
          margin-bottom: 32px; position: relative;
        }
        
        .sec-title {
          font-size: 11px; font-weight: 600; color: var(--c-kin); text-transform: uppercase;
          letter-spacing: 2px; margin-bottom: 16px; font-family: var(--font-title);
          display: flex; align-items: center; gap: 12px;
        }
        .sec-title::after {
          content: ''; flex: 1; height: 1px; 
          background: var(--border-hairline);
        }

        /* ── 数据行 (Shinobi Stats) ──── */
        .row { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 0; border-bottom: 1px solid var(--border-hairline); position: relative; }
        .row-l { 
          font-size: 11px; color: var(--text-tertiary); font-family: var(--font-title); 
          letter-spacing: 2px; text-transform: uppercase;
        }
        .row-v {
          font-size: 13px; color: var(--text-primary); font-family: var(--font-body); font-weight: 500; letter-spacing: 1px;
        }

        /* ── 属性面板 (Attribute Bento) ──── */
        .chakra-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; margin-bottom: 8px; }
        .chakra-badge { 
          display: inline-flex; align-items: center; justify-content: center;
          padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 800; letter-spacing: 2px;
          border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
          background: color-mix(in srgb, currentColor 7%, transparent);
        }

        .attr-bento { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
        .attr-card {
          background: rgba(var(--paper-rgb),0.025); box-shadow: inset 0 0 0 1px rgba(var(--paper-rgb),0.07);
          border-radius: var(--r-md); padding: 16px; position: relative; overflow: hidden;
          display: flex; flex-direction: column; justify-content: center;
        }
        .attr-card.full-span { grid-column: 1 / -1; }
        .attr-card:hover { background: var(--surface-bento-hover); }
        .attr-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
        .attr-value { font-family: var(--font-title); font-size: 16px; font-weight: 700; color: var(--text-primary); letter-spacing: 1px; font-variant-numeric: tabular-nums; }
        
        .attr-id-badge {
          display: flex; justify-content: space-between; align-items: center; flex-direction: row;
          padding: 22px; background: linear-gradient(135deg, rgba(var(--paper-rgb),0.045), rgba(var(--paper-rgb),0.015));
          border-left: 2px solid var(--c-kin);
        }
        .attr-id-name { 
          font-family: var(--font-title); font-size: 28px; font-weight: 600; color: var(--text-primary); line-height: 1.3; margin-top: 4px;
          letter-spacing: 2px; overflow-wrap: anywhere;
        }
        
        .attr-id-rank { font-size: 12px; font-weight: 600; letter-spacing: 2px; color: var(--text-secondary); }
        
        .attr-threat { 
          position: absolute; inset: 0; background: radial-gradient(circle at right bottom, var(--threat-color, rgba(255,255,255,0.1)) 0%, transparent 70%); 
          opacity: 0.06; pointer-events: none;
        }
        
        .attr-threat-val { 
          font-family: var(--font-mono); font-size: 24px; font-weight: 700; color: var(--threat-color, var(--text-primary));
          display: flex; align-items: baseline; gap: 4px;
          white-space: nowrap; font-variant-numeric: tabular-nums;
        }
        .attr-bar-wrap { margin-bottom: 16px; }
        .attr-bar-label { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 12px; margin-bottom: 8px; color: var(--text-secondary); letter-spacing: 0.5px; font-variant-numeric: tabular-nums; }
        .attr-bar-label > span { white-space: nowrap; }
        .attr-bars-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 8px; }
        .attr-bars-pair .attr-bar-label { flex-direction: column; align-items: flex-start; gap: 6px; }
        .attr-bar-track { height: 3px; background: rgba(var(--paper-rgb),0.07); border-radius: 3px; overflow: hidden; }
        .attr-bar-fill { height: 100%; border-radius: inherit; transition: width 0.4s var(--ease-out); }

        /* ── 查克拉条 (Liquid Chakra Bars - Old fallback) ──── */
        .bar-wrap { margin: 12px 0 20px; position: relative; }
        .bar { 
          height: 2px; background: rgba(255,255,255,0.05);
          overflow: hidden; 
        }
        .bar-fill { 
          height: 100%; border-radius: 0; 
          transition: width 1s var(--ease-out); 
        }

        /* ── 技能与装备卡片 (Bento Grid Items) ──── */
        .grid-list { display: grid; grid-template-columns: 1fr; gap: 12px; }
        .item-card {
          padding: 16px; border-radius: var(--r-md);
          box-shadow: inset 0 0 0 1px rgba(var(--paper-rgb),0.07); background: rgba(var(--paper-rgb),0.025);
          transition: all 0.3s var(--ease-out); position: relative; overflow: hidden;
        }
        .item-card:hover { 
          background: var(--surface-bento-hover); box-shadow: var(--shadow-inner-hover);
          transform: translateY(-1px);
        }
        /* 法阵边缘装饰 */
        .item-card::before {
          content: ''; position: absolute; top: 0; left: 0; width: 12px; height: 12px;
          border-top: 1.5px solid var(--c-shuiro); border-left: 1.5px solid var(--c-shuiro);
          border-top-left-radius: var(--r-md); opacity: 0; transition: opacity 0.3s; pointer-events: none;
        }
        .item-card:hover::before { opacity: 0.8; }
        .item-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
        .item-name { font-family: var(--font-title); font-size: 16px; font-weight: 800; color: var(--text-primary); letter-spacing: 1px; }
        .item-tag { font-size: 9px; color: var(--text-secondary); padding: 2px 6px; border: 1px solid var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; }
        .item-desc { font-size: 12px; color: var(--text-secondary); line-height: 1.7; font-family: var(--font-body); }

        /* ── 任务勋章 (Mission Seals) ──── */
        .mission-seal {
          position: relative;
          padding: 16px; margin-bottom: 0; display: grid; grid-template-columns: 32px 1fr; gap: 16px; align-items: start;
          box-shadow: var(--shadow-inner); background: var(--surface-bento); border-radius: var(--r-md); transition: all 0.2s;
        }
        .mission-seal:hover { background: var(--surface-bento-hover); box-shadow: var(--shadow-inner-hover); transform: translateY(-1px); }
        .mission-seal .rank-badge {
          font-family: var(--font-title); font-size: 20px; font-weight: 800; opacity: 0.8;
          text-align: center; border-bottom: 2px solid currentColor; padding-bottom: 4px;
        }
        /* ── 技能与天赋 (Skills) ──── */
        .skill-card {
          background: var(--surface-bento); box-shadow: var(--shadow-inner);
          border-radius: var(--r-md); padding: 16px; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          position: relative; overflow: hidden; border-left: 2px solid var(--border-subtle);
        }
        .skill-card:hover { transform: translateY(-2px); background: var(--surface-bento-hover); border-left-color: var(--text-primary); }
        .bloodline-list { display: grid; grid-template-columns: 1fr; gap: 12px; }
        .skill-card.bloodline {
          /* 每张卡由 --bl / --bl-rgb 决定主题色（写轮眼绯红、冰遁冰蓝、木遁翠绿…），默认绯红 */
          --bl: var(--c-quality-legendary);
          --bl-rgb: 239,83,80;
          text-align: center; border-left: none; padding: 26px 24px 24px;
          background:
            radial-gradient(ellipse at 50% 0%, rgba(var(--bl-rgb),0.14) 0%, transparent 60%),
            var(--surface-bento);
          box-shadow: inset 0 0 0 1px rgba(var(--bl-rgb),0.22), inset 0 0 40px rgba(var(--bl-rgb),0.05), var(--shadow-inner);
        }
        .skill-card.bloodline:hover {
          transform: translateY(-2px); border-left-color: transparent;
          box-shadow: inset 0 0 0 1px rgba(var(--bl-rgb),0.4), inset 0 0 48px rgba(var(--bl-rgb),0.09), var(--shadow-inner-hover);
        }
        /* 血脉苏醒环：呼吸的封印光晕 */
        .bloodline-aura {
          position: absolute; top: 50%; left: 50%; width: 190px; height: 190px;
          transform: translate(-50%, -50%);
          border: 1px solid rgba(var(--bl-rgb),0.18); border-radius: 50%;
          pointer-events: none;
          animation: bloodline-breath 4.5s ease-in-out infinite alternate;
        }
        .bloodline-aura::before {
          content: ''; position: absolute; inset: 14px;
          border: 1px dashed rgba(var(--bl-rgb),0.14); border-radius: 50%;
          animation: bloodline-spin 36s linear infinite;
        }
        @keyframes bloodline-breath {
          from { opacity: 0.45; transform: translate(-50%, -50%) scale(0.96); }
          to { opacity: 1; transform: translate(-50%, -50%) scale(1.03); }
        }
        @keyframes bloodline-spin { to { transform: rotate(360deg); } }
        /* 印记水印：写轮眼「瞳」、冰遁「冰」、木遁「木」… */
        .bloodline-glyph {
          position: absolute; right: -4%; bottom: -22%; font-family: var(--font-brush);
          font-size: 96px; font-weight: 900; color: var(--bl);
          opacity: 0.08; transform: rotate(-12deg); pointer-events: none; line-height: 1;
        }
        .bloodline-rank {
          position: absolute; top: 12px; left: 12px;
          font-size: 9px; font-weight: 800; letter-spacing: 2px; padding: 3px 9px;
          color: var(--bl); border: 1px solid rgba(var(--bl-rgb),0.35);
          border-radius: 4px; background: rgba(var(--bl-rgb),0.08);
          font-family: var(--font-title);
        }
        .bloodline .skill-title {
          position: relative; font-size: 22px; letter-spacing: 6px; line-height: 1.3;
          color: var(--bl);
          background: linear-gradient(100deg, var(--bl) 20%, #fff 50%, var(--bl) 80%);
          background-size: 200% auto;
          -webkit-background-clip: text; background-clip: text;
          -webkit-text-fill-color: transparent;
          filter: drop-shadow(0 0 12px rgba(var(--bl-rgb),0.45));
          animation: bloodline-shine 5s linear infinite;
        }
        @keyframes bloodline-shine { to { background-position: 200% center; } }
        .bloodline-divider {
          margin: 10px auto 0; font-size: 7px; color: rgba(var(--bl-rgb),0.55);
          display: flex; align-items: center; gap: 10px; justify-content: center; width: 70%;
        }
        .bloodline-divider::before, .bloodline-divider::after {
          content: ''; flex: 1; height: 1px;
          background: linear-gradient(to right, transparent, rgba(var(--bl-rgb),0.35), transparent);
        }
        .bloodline-sync { position: relative; margin: 14px auto 0; max-width: 240px; }
        .bloodline-sync-label {
          display: flex; justify-content: space-between; font-size: 9px; letter-spacing: 2px;
          color: var(--text-tertiary); margin-bottom: 6px; font-family: var(--font-title);
        }
        .bloodline-sync-label span:last-child { color: var(--bl); font-family: var(--font-mono); letter-spacing: 0; }
        .bloodline-sync-track { height: 3px; border-radius: 2px; background: rgba(var(--bl-rgb),0.12); overflow: hidden; }
        .bloodline-sync-fill {
          height: 100%; border-radius: 2px;
          background: linear-gradient(90deg, rgba(var(--bl-rgb),0.55), var(--bl));
          box-shadow: 0 0 10px rgba(var(--bl-rgb),0.6); transition: width 1s var(--ease-out);
        }
        .bloodline-desc {
          position: relative; margin: 12px auto 0; max-width: 300px;
          font-size: 11px; line-height: 1.7; color: var(--text-secondary);
        }
        .skill-card.bloodline.normal { background: var(--surface-bento); box-shadow: var(--shadow-inner); }
        .skill-card.bloodline.normal:hover { box-shadow: var(--shadow-inner-hover); }
        .bloodline.normal .skill-title {
          color: var(--text-secondary); background: none;
          -webkit-text-fill-color: currentColor; filter: none; animation: none;
          letter-spacing: 3px; font-size: 18px;
        }
        .bloodline.normal .bloodline-glyph { color: var(--text-primary); opacity: 0.04; }
        .bloodline.normal .bloodline-desc { color: var(--text-tertiary); }
        @media (prefers-reduced-motion: reduce) {
          .bloodline-aura, .bloodline-aura::before, .bloodline .skill-title { animation: none; }
        }
        .skill-title { font-family: var(--font-title); font-size: 16px; font-weight: 800; letter-spacing: 1px; color: var(--text-primary); }
        
        .skill-mastery-tag {
          font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; letter-spacing: 1px;
          background: rgba(198,156,109,0.1); color: var(--c-kin-bright); border: 1px solid rgba(198,156,109,0.3);
        }

        .skill-technique-stats {
          display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px;
        }
        .skill-technique-stat {
          display: inline-flex; align-items: baseline; gap: 6px; min-width: 88px;
          padding: 6px 9px; border-radius: 6px;
          background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.05);
          font-family: var(--font-mono);
        }
        .skill-technique-stat-label { font-size: 9px; color: var(--text-tertiary); letter-spacing: 0.5px; }
        .skill-technique-stat strong { font-size: 12px; color: var(--text-primary); }
        .skill-technique-stat[data-stat="power"] strong { color: #ff8a80; }
        .skill-technique-stat[data-stat="cost"] strong { color: #80deea; }
        .skill-technique-stats.compact { flex-wrap: nowrap; gap: 4px; margin: 0; }
        .skill-technique-stats.compact .skill-technique-stat { min-width: 0; padding: 3px 6px; gap: 4px; }
        .skill-technique-stats.compact .skill-technique-stat-label { font-size: 8px; }
        .skill-technique-stats.compact .skill-technique-stat strong { font-size: 10px; }
        
        .skill-empty {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 12px; padding: 32px 16px; min-height: 100px;
          background: rgba(0,0,0,0.2); border-radius: var(--r-md); box-shadow: inset 0 2px 10px rgba(0,0,0,0.5);
          color: var(--text-tertiary); font-size: 11px; letter-spacing: 1px;
        }
        .skill-empty svg { width: 32px; height: 32px; opacity: 0.15; color: var(--text-primary); }
        .skill-empty em { font-style: normal; color: var(--text-secondary); font-weight: bold; }

        .skill-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
        .skill-search { flex: 1; min-width: 120px; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.2); color: var(--text-primary); font-size: 12px; outline: none; }
        .skill-search:focus { border-color: rgba(198,156,109,0.5); }
        .skill-btn { padding: 4px 10px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.08); background: transparent; color: var(--text-tertiary); font-size: 10px; cursor: pointer; transition: all 0.15s; white-space: nowrap; letter-spacing: 1px; }
        .skill-btn:hover { border-color: rgba(255,255,255,0.2); color: var(--text-secondary); }
        .skill-btn.active { border-color: var(--c-kin-bright); color: var(--c-kin-bright); background: rgba(198,156,109,0.08); }
        .skill-summary { font-size: 10px; color: var(--text-tertiary); margin-bottom: 12px; padding-left: 4px; }

        .skill-collapse-title { cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none; }
        .skill-collapse-title .arrow { transition: transform 0.2s; font-size: 10px; color: var(--text-tertiary); }
        .skill-collapse-title .arrow.open { transform: rotate(90deg); }
        .skill-collapse-badge { font-size: 10px; color: var(--text-tertiary); font-weight: normal; margin-left: 4px; }
        .skill-section-body { overflow: visible; }
        .skill-section-body.collapsed { max-height: 0; opacity: 0; overflow: hidden; pointer-events: none; }

        .skill-compact-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 8px 12px; border-radius: 6px; background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.03); cursor: pointer; transition: all 0.15s; font-size: 12px; }
        .skill-compact-row:hover { background: rgba(255,255,255,0.03); border-color: rgba(255,255,255,0.06); }
        .skill-compact-row .skill-name { font-weight: 600; color: var(--text-primary); flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
        .skill-compact-row .skill-meta { font-size: 10px; color: var(--text-secondary); display: flex; gap: 8px; align-items: center; }
        .skill-compact-row .skill-mastery-num { margin-left: auto; font-size: 11px; color: var(--text-tertiary); white-space: nowrap; }

        .skill-detail { display: none; padding: 10px 0 2px; }
        .skill-card.expanded .skill-detail { display: block; }
        .skill-detail-desc { font-size: 11px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 8px; }
        .skill-detail-mastery { height: 3px; border-radius: 2px; background: rgba(255,255,255,0.05); margin: 8px 0; overflow: hidden; }
        .skill-detail-mastery div { height: 100%; border-radius: 2px; background: var(--c-kin-bright); transition: width 0.4s; }

        .mission-seal { border-left: 4px solid var(--border-subtle); padding-left: 12px; }

        /* ── 关系印记 (Fate Link) ──── */
        .rel-card-wrap {
          background: var(--surface-bento); box-shadow: var(--shadow-inner);
          border-radius: var(--r-md); padding: 16px; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          position: relative; overflow: hidden; cursor: pointer;
        }
        .rel-card-wrap:hover { transform: translateY(-2px); background: var(--surface-bento-hover); }
        .rel-card-wrap.rel-pinned {
          border-left: 3px solid #c69c6d;
          background: linear-gradient(135deg, rgba(198,156,109,0.06), var(--surface-bento));
        }
        .rel-card-wrap.rel-pinned:hover { background: linear-gradient(135deg, rgba(198,156,109,0.1), var(--surface-bento-hover)); }
        .rel-pin-tag {
          font-size: 13px; margin-left: 6px; filter: none; line-height: 1;
        }
        .rel-expand-hint { text-align: center; font-size: 10px; color: var(--text-tertiary); margin-top: 12px; opacity: 0.5; transition: opacity 0.2s; }
        .rel-card-wrap:hover .rel-expand-hint { opacity: 0.8; }
        
        .rel-actions {
          position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; opacity: 0; transition: opacity 0.2s;
        }
        .rel-card-wrap:hover .rel-actions,
        .rel-card-wrap:focus-within .rel-actions,
        .ema-card:hover .rel-actions,
        .ema-card:focus-within .rel-actions { opacity: 1; }
        @media (hover: none) { .rel-actions { opacity: 1; } }
        .rel-action-btn {
          width: 26px; height: 26px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.35); font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s;
        }
        .rel-action-btn:hover { background: rgba(255,255,255,0.1); color: #fff; border-color: rgba(255,255,255,0.15); }
        .rel-action-btn.pin-active { color: #c69c6d; border-color: rgba(198,156,109,0.3); }
        .rel-action-btn.del-hover:hover { background: rgba(239,83,80,0.15); color: #ef5350; border-color: rgba(239,83,80,0.3); }
        
        .rel-header {
          display: flex; gap: 16px; align-items: center; margin-bottom: 16px;
        }
        
        /* Hexagon Avatar */
        .rel-avatar-ring {
          position: relative; width: 56px; height: 56px;
          display: flex; align-items: center; justify-content: center;
          filter: drop-shadow(0 0 8px rgba(198,156,109,0.2));
        }
        .rel-avatar-ring::before {
          content: ''; position: absolute; inset: 0;
          background: conic-gradient(from 0deg, transparent, rgba(198,156,109,0.8), transparent);
          clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
          padding: 1px; -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
          animation: spin 6s linear infinite;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
        
        .rel-avatar {
          width: 50px; height: 50px; background: var(--surface-0);
          clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
          display: flex; align-items: center; justify-content: center;
          font-family: var(--font-brush); color: var(--c-kin-bright); font-size: 24px; font-weight: bold;
        }
        
        .rel-info { min-width: 0; flex: 1; }
        .rel-info-title { font-size: 16px; font-family: var(--font-title); font-weight: 800; color: var(--text-primary); letter-spacing: 1px; }
        .rel-info-sub { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; display: flex; gap: 8px; align-items: center; }
        
        /* Dashboard Stats */
        .rel-dashboard {
          display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
          background: rgba(0,0,0,0.2); padding: 12px; border-radius: var(--r-sm);
          box-shadow: inset 0 2px 4px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.02);
        }
        .dash-stat { display: flex; flex-direction: column; gap: 6px; }
        .dash-label { font-size: 10px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 1px; }
        .dash-value { font-size: 16px; font-family: var(--font-mono); font-weight: 700; color: var(--text-primary); display: flex; align-items: baseline; gap: 4px; }
        .dash-bar-bg { height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; }
        .dash-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease-out; }
        
        /* Glass Pill Tags */
        .rel-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; }
        .glass-pill {
          padding: 4px 10px; font-size: 10px; font-weight: 600; letter-spacing: 1px;
          background: rgba(255,255,255,0.05); color: var(--text-secondary);
          border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);
          backdrop-filter: blur(4px); display: inline-flex; align-items: center;
        }

        .tag {
          display: inline-block; padding: 2px 0; font-size: 10px; border-radius: 0; border-bottom: 1px solid var(--border-subtle);
          background: transparent; color: var(--text-secondary);
          font-family: var(--font-title); font-weight: 600; letter-spacing: 1px; text-transform: uppercase; margin-right: 8px;
        }
        .gold { color: var(--c-kin-bright); }
        .empty { padding: 40px 20px; text-align: center; color: var(--text-tertiary); font-family: var(--font-body); font-size: 12px; line-height: 1.8; opacity: 0.8; }
        .empty em { font-style: normal; color: var(--text-primary); font-family: var(--font-title); }

        /* ═══════════ 羁绊绘卷 v2 · Bond Scroll ═══════════ */
        /* 情感温度七级色阶已上移至 tokens.css :root（供星图与 NPC 角色卡共用） */

        /* ── 概览统计条 ──── */
        .bond-overview {
          display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
          margin-bottom: 18px; padding: 12px 14px;
          background: rgba(0,0,0,0.25); border-radius: var(--r-md);
          border: 1px solid var(--border-hairline);
        }
        .bond-ov-title {
          font-family: var(--font-title); font-size: 11px; font-weight: 800;
          color: var(--text-secondary); letter-spacing: 3px; margin-right: 4px;
        }
        .bond-pill {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 11px; border-radius: var(--r-full);
          font-size: 10px; font-weight: 700; letter-spacing: 1px;
          background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle);
          color: var(--text-secondary); transition: all var(--dur-fast) var(--ease-out);
        }
        .bond-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pc, #888); box-shadow: 0 0 6px var(--pc, #888); }
        .bond-pill b { font-family: var(--font-mono); color: var(--text-primary); font-size: 11px; }
        .bond-pill:hover { background: rgba(255,255,255,0.06); border-color: var(--border-default); }
        .bond-pill.on { background: color-mix(in srgb, var(--pc, #888) 14%, transparent); border-color: color-mix(in srgb, var(--pc, #888) 45%, transparent); color: var(--text-primary); }

        /* ── 视图切换 ──── */
        .bond-view-toggle {
          display: flex; gap: 4px; margin-left: auto;
          background: rgba(0,0,0,0.3); border-radius: var(--r-sm); padding: 3px;
          border: 1px solid var(--border-hairline);
        }
        .bond-vt-btn {
          padding: 5px 12px; font-size: 10px; font-weight: 700; letter-spacing: 1px;
          color: var(--text-tertiary); background: transparent; border: none;
          border-radius: 4px; cursor: pointer; transition: all var(--dur-fast);
          font-family: var(--font-title);
        }
        .bond-vt-btn:hover { color: var(--text-secondary); }
        .bond-vt-btn.on { background: rgba(255,255,255,0.09); color: var(--text-primary); }

        /* ── 绘马卡片网格 ──── */
        .ema-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 16px;
        }
        @media (max-width: 768px) { .ema-grid { grid-template-columns: 1fr; } }

        /* 绘马卡片本体 */
        .ema-card {
          position: relative; cursor: pointer; overflow: hidden;
          background:
            radial-gradient(ellipse 120% 55% at 50% -8%, color-mix(in srgb, var(--tc) 16%, transparent), transparent 68%),
            var(--surface-bento);
          border-radius: var(--r-md); padding: 22px 18px 14px;
          box-shadow: var(--shadow-inner);
          transition: transform 0.35s var(--ease-out), box-shadow 0.35s var(--ease-out), background 0.5s;
          animation: ema-enter 0.5s var(--ease-out) backwards;
        }
        .ema-card:nth-child(2n) { animation-delay: 0.05s; }
        .ema-card:nth-child(3n) { animation-delay: 0.1s; }
        @keyframes ema-enter { from { opacity: 0; transform: translateY(14px); } }
        .ema-card:hover {
          transform: translateY(-3px);
          box-shadow: var(--shadow-inner-hover), 0 12px 32px -12px color-mix(in srgb, var(--tc) 45%, transparent);
        }
        /* 绘马顶部木片 + 系绳 */
        .ema-card::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 12px;
          background:
            radial-gradient(circle 3px at 24% 6px, rgba(0,0,0,0.55) 98%, transparent),
            radial-gradient(circle 3px at 76% 6px, rgba(0,0,0,0.55) 98%, transparent),
            linear-gradient(to bottom, color-mix(in srgb, var(--tc) 22%, rgba(20,16,12,0.9)), rgba(20,16,12,0.9));
          border-bottom: 1px solid color-mix(in srgb, var(--tc) 30%, transparent);
        }
        .ema-card::after {
          content: ''; position: absolute; top: 0; left: 8%; right: 8%; height: 1px;
          background: linear-gradient(to right, transparent, rgba(var(--paper-rgb), 0.12), transparent);
          pointer-events: none;
        }
        /* 置顶卡：绳结换金色 */
        .ema-card.pinned::before {
          background:
            radial-gradient(circle 3px at 24% 6px, rgba(0,0,0,0.55) 98%, transparent),
            radial-gradient(circle 3px at 76% 6px, rgba(0,0,0,0.55) 98%, transparent),
            linear-gradient(to bottom, color-mix(in srgb, var(--c-kin) 40%, rgba(20,16,12,0.9)), rgba(20,16,12,0.9));
          border-bottom-color: color-mix(in srgb, var(--c-kin) 50%, transparent);
        }

        /* 头部：六边形头像 + 名 + 温度印记（右留白容纳悬停操作钮） */
        .ema-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; padding-right: 66px; }
        .ema-avatar {
          flex-shrink: 0; width: 36px; height: 36px;
          clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
          display: flex; align-items: center; justify-content: center;
          font-family: var(--font-brush); font-size: 17px; font-weight: 900;
          color: var(--tc); background: color-mix(in srgb, var(--tc) 10%, rgba(0,0,0,0.45));
          box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--tc) 40%, transparent);
          text-shadow: 0 0 10px color-mix(in srgb, var(--tc) 60%, transparent);
        }
        .ema-head-main { flex: 1; min-width: 0; }
        .ema-name {
          font-family: var(--font-brush); font-size: 18px; font-weight: 900;
          color: var(--text-primary); letter-spacing: 1.5px; line-height: 1.25;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }
        .ema-pin-mark { font-size: 11px; filter: none; margin-left: 6px; }
        .ema-meta {
          display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 5px;
          font-size: 10px; color: var(--text-tertiary); letter-spacing: 1px;
        }
        .ema-meta > span:not(.ema-faction) {
          padding: 2px 8px; border-radius: var(--r-full);
          background: rgba(var(--paper-rgb), 0.03); border: 1px solid var(--border-hairline);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
        }
        .ema-faction {
          padding: 2px 8px; border-radius: var(--r-full);
          background: rgba(198,156,109,0.1); color: var(--c-kin-bright);
          border: 1px solid rgba(198,156,109,0.2); font-weight: 600; white-space: nowrap;
        }
        /* 温度印章（圆形等级印） */
        .ema-seal {
          flex-shrink: 0; width: 40px; height: 40px; border-radius: 50%;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          background: color-mix(in srgb, var(--tc) 12%, rgba(0,0,0,0.4));
          border: 1.5px solid color-mix(in srgb, var(--tc) 55%, transparent);
          box-shadow: 0 0 12px -2px color-mix(in srgb, var(--tc) 40%, transparent), inset 0 0 8px color-mix(in srgb, var(--tc) 15%, transparent);
          transform: rotate(-4deg);
        }
        .ema-seal-lv { font-family: var(--font-brush); font-size: 12px; font-weight: 900; color: var(--tc); line-height: 1.15; }
        .ema-seal-val { font-family: var(--font-mono); font-size: 8px; color: color-mix(in srgb, var(--tc) 75%, transparent); }

        /* 三维温度计 */
        .ema-thermo { display: flex; flex-direction: column; gap: 9px; margin-bottom: 12px; }
        .thermo-row { display: flex; align-items: center; gap: 8px; }
        .thermo-label {
          width: 30px; font-size: 10px; font-weight: 700; color: var(--text-tertiary);
          letter-spacing: 2px; flex-shrink: 0;
        }
        .thermo-track {
          flex: 1; height: 5px; border-radius: 3px; position: relative;
          background: rgba(0,0,0,0.45); box-shadow: inset 0 1px 2px rgba(0,0,0,0.6);
        }
        .thermo-track::before { /* 中线刻度 */
          content: ''; position: absolute; left: 50%; top: -1px; bottom: -1px; width: 1px;
          background: rgba(255,255,255,0.12);
        }
        .thermo-fill {
          position: absolute; top: 0; bottom: 0; border-radius: 3px;
          transition: width 0.6s var(--ease-out), left 0.6s var(--ease-out);
          box-shadow: 0 0 6px color-mix(in srgb, var(--fc) 60%, transparent);
        }
        .thermo-fill.pos { left: 50%; background: linear-gradient(90deg, color-mix(in srgb, var(--fc) 55%, transparent), var(--fc)); }
        .thermo-fill.neg { right: 50%; background: linear-gradient(270deg, color-mix(in srgb, var(--fc) 55%, transparent), var(--fc)); }
        .thermo-val {
          width: 30px; text-align: right; font-family: var(--font-mono);
          font-size: 11px; font-weight: 700; color: var(--text-secondary); flex-shrink: 0;
        }

        /* 羁绊标签 + 趋势 */
        .ema-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 20px; }
        .ema-tag {
          font-size: 9px; padding: 3px 9px; border-radius: var(--r-full); letter-spacing: 1px;
          background: rgba(255,255,255,0.04); color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
        }
        .ema-trend {
          margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
          font-size: 9px; font-family: var(--font-mono); letter-spacing: 0.5px;
        }
        .ema-trend.up { color: var(--tmp-warm); }
        .ema-trend.down { color: var(--tmp-hostile); }
        .ema-trend.flat { color: var(--text-tertiary); }

        /* 悬停操作钮（沿用旧类，无需改） */

        /* ── 装备栏 · 忍具行囊 v2 ──── */
        .eq-svg { width: 1.2em; height: 1.2em; display: inline-block; vertical-align: middle; }

        /* 顶部:标题 + 资金印 */
        .eq-topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
        .eq-ryo {
          display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
          padding: 5px 13px; border-radius: var(--r-full);
          font-family: var(--font-mono); font-size: 13px; font-weight: 700; letter-spacing: 1px;
          color: var(--c-kin-bright);
          background: linear-gradient(135deg, rgba(198,156,109,0.16), rgba(198,156,109,0.04));
          border: 1px solid rgba(198,156,109,0.3);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 0 16px -6px rgba(198,156,109,0.5);
        }

        /* 战斗武装区(loadout) */
        .eq-loadout {
          position: relative; overflow: hidden;
          padding: 16px; border-radius: var(--r-lg);
          background:
            radial-gradient(ellipse 90% 60% at 50% -10%, rgba(198,156,109,0.07), transparent 60%),
            rgba(var(--paper-rgb), 0.015);
          box-shadow: var(--shadow-inner);
        }
        .eq-loadout::after {
          content: ''; position: absolute; top: 0; left: 8%; right: 8%; height: 1px;
          background: linear-gradient(to right, transparent, rgba(var(--paper-rgb), 0.14), transparent);
          pointer-events: none;
        }
        .eq-loadout-head {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
          margin-bottom: 14px; padding-bottom: 12px;
          border-bottom: 1px solid var(--border-hairline);
        }
        .eq-loadout-title {
          font-family: var(--font-title); font-size: 11px; font-weight: 800;
          letter-spacing: 3px; color: var(--text-secondary); margin-right: 2px;
        }
        .eq-bonus-pill {
          font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
          padding: 3px 9px; border-radius: var(--r-full);
          color: #f0a58f; background: rgba(235,97,63,0.1);
          border: 1px solid rgba(235,97,63,0.28);
        }
        .eq-slot-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }

        /* 槽位卡:空槽 / 已装备 */
        .eq-slot {
          position: relative; min-height: 96px; border-radius: 12px; padding: 11px 12px;
          display: flex; flex-direction: column; overflow: hidden;
          transition: all 0.3s var(--ease-out);
        }
        .eq-slot-tag {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 9px; letter-spacing: 1.5px; color: var(--text-tertiary);
        }
        .eq-slot-tag .eq-svg { width: 12px; height: 12px; opacity: 0.7; }

        .eq-slot.empty {
          background: rgba(0,0,0,0.25);
          border: 1px dashed rgba(var(--paper-rgb), 0.09);
          box-shadow: inset 0 2px 8px rgba(0,0,0,0.35);
        }
        .eq-slot.empty:hover { border-color: rgba(var(--paper-rgb), 0.18); background: rgba(0,0,0,0.32); }
        .eq-slot-void {
          flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 5px; margin-top: 2px; color: var(--text-tertiary);
        }
        .eq-slot-void .eq-svg { width: 22px; height: 22px; opacity: 0.16; }
        .eq-slot-void span { font-size: 9px; letter-spacing: 2px; opacity: 0.5; }

        .eq-slot.filled {
          background:
            radial-gradient(ellipse 120% 80% at 100% 0%, color-mix(in srgb, var(--qc, #e8e4d9) 13%, transparent), transparent 60%),
            var(--surface-bento);
          box-shadow: var(--shadow-inner), inset 3px 0 0 -1px color-mix(in srgb, var(--qc, #e8e4d9) 55%, transparent);
        }
        .eq-slot.filled:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-inner-hover), inset 3px 0 0 -1px var(--qc, #e8e4d9),
            0 10px 24px -10px color-mix(in srgb, var(--qc, #e8e4d9) 40%, transparent);
        }
        .eq-slot-name {
          margin: auto 0 2px; font-family: var(--font-title); font-size: 15px; font-weight: 800;
          letter-spacing: 1px; color: var(--text-primary); line-height: 1.3;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }
        .eq-slot-quality { font-size: 10px; letter-spacing: 1px; color: var(--qc, var(--text-tertiary)); }
        .eq-slot-unequip {
          position: absolute; top: 8px; right: 8px; z-index: 3;
          width: 24px; height: 24px; border-radius: 8px; padding: 0;
          font-size: 11px; line-height: 1;
          opacity: 0; transform: scale(0.9);
        }
        .eq-slot:hover .eq-slot-unequip, .eq-slot:focus-within .eq-slot-unequip { opacity: 1; transform: none; }
        @media (hover: none) { .eq-slot-unequip { opacity: 1; transform: none; } }
        .eq-slot-unequip:hover { border-color: rgba(239,83,80,0.45); color: #ef5350; background: rgba(239,83,80,0.12); }

        /* 分类标题:图标 + 名 + 计数 + 引线 */
        .eq-cat-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .eq-cat-head > .eq-svg { width: 13px; height: 13px; color: var(--text-tertiary); flex-shrink: 0; }
        .eq-cat-title {
          font-family: var(--font-title); font-size: 10px; font-weight: 800;
          letter-spacing: 3px; color: var(--text-tertiary); text-transform: uppercase;
        }
        .eq-cat-count {
          font-family: var(--font-mono); font-size: 9px; color: var(--text-tertiary);
          padding: 1px 7px; border-radius: var(--r-full);
          background: rgba(var(--paper-rgb), 0.04); border: 1px solid var(--border-subtle);
        }
        .eq-cat-head::after { content: ''; flex: 1; height: 1px; background: var(--border-hairline); }

        /* 物品卡:徽章 + 信息 + 操作 */
        .eq-item-list { display: flex; flex-direction: column; gap: 10px; }
        .eq-item {
          position: relative; overflow: hidden;
          display: flex; gap: 12px; align-items: flex-start;
          padding: 13px 14px; border-radius: 12px;
          background:
            linear-gradient(120deg, color-mix(in srgb, var(--qc, transparent) 5%, transparent), transparent 45%),
            var(--surface-bento);
          box-shadow: var(--shadow-inner), inset 2.5px 0 0 -0.5px color-mix(in srgb, var(--qc, #6a6a6a) 45%, transparent);
          transition: all 0.3s var(--ease-out);
        }
        .eq-item:hover {
          transform: translateY(-1px);
          background:
            linear-gradient(120deg, color-mix(in srgb, var(--qc, transparent) 8%, transparent), transparent 50%),
            var(--surface-bento-hover);
          box-shadow: var(--shadow-inner-hover), inset 2.5px 0 0 -0.5px var(--qc, #6a6a6a);
        }
        .eq-item-badge {
          flex-shrink: 0; width: 38px; height: 38px; border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          color: color-mix(in srgb, var(--qc, #a39f98) 85%, #fff);
          background: color-mix(in srgb, var(--qc, #808080) 10%, rgba(0,0,0,0.3));
          border: 1px solid color-mix(in srgb, var(--qc, #808080) 25%, transparent);
          box-shadow: inset 0 0 10px color-mix(in srgb, var(--qc, #808080) 12%, transparent);
        }
        .eq-item-badge .eq-svg { width: 17px; height: 17px; }
        .eq-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; position: relative; z-index: 2; }
        .eq-item-name {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
          font-family: var(--font-title); font-size: 14px; font-weight: 800;
          letter-spacing: 1px; color: var(--text-primary);
        }
        .eq-item-on {
          font-size: 8px; font-weight: 800; letter-spacing: 1px; padding: 2px 6px; border-radius: 3px;
          background: var(--text-primary); color: var(--c-void);
        }
        .eq-item-meta { display: flex; gap: 10px; font-size: 10px; color: var(--text-tertiary); letter-spacing: 0.5px; }
        .eq-item-meta .q { color: var(--qc, var(--text-secondary)); font-weight: 700; }
        .eq-item-desc {
          font-size: 11px; color: var(--text-secondary); line-height: 1.6;
          margin-top: 4px; padding-top: 7px; border-top: 1px dashed rgba(var(--paper-rgb), 0.06);
        }
        .eq-item-ops { flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; position: relative; z-index: 2; }
        .eq-op {
          min-width: 56px; padding: 5px 12px; border-radius: 8px;
          font-size: 10px; font-weight: 700; letter-spacing: 1px; font-family: var(--font-body);
          background: rgba(var(--paper-rgb), 0.04); border: 1px solid var(--border-subtle);
          color: var(--text-secondary); cursor: pointer; transition: all 0.2s;
        }
        .eq-op:hover { background: rgba(var(--paper-rgb), 0.1); color: var(--text-primary); border-color: var(--border-default); }
        .eq-op.primary { background: var(--text-primary); color: var(--c-void); border-color: transparent; }
        .eq-op.primary:hover { background: #fff; color: var(--c-void); }
        .eq-op.danger { color: #b96a66; border-color: rgba(239,83,80,0.22); background: transparent; }
        .eq-op.danger:hover { color: #ef5350; background: rgba(239,83,80,0.1); border-color: rgba(239,83,80,0.4); }

        /* 空分类占位 */
        .eq-cat-empty {
          display: flex; align-items: center; justify-content: center; gap: 10px;
          padding: 18px 16px; border-radius: 10px;
          border: 1px dashed rgba(var(--paper-rgb), 0.06);
          background: rgba(0,0,0,0.16);
          color: var(--text-tertiary); font-size: 11px; letter-spacing: 1px;
        }
        .eq-cat-empty .eq-svg { width: 15px; height: 15px; opacity: 0.25; }

        .eq-watermark {
          position: absolute; right: -10%; bottom: -20%; font-family: var(--font-brush);
          font-size: 64px; color: currentColor; opacity: 0.04; pointer-events: none;
          transform: rotate(-15deg); font-weight: 900; z-index: 1;
        }
        .eq-slot.filled[data-quality="史诗"] .eq-watermark, .eq-item[data-quality="史诗"] .eq-watermark { opacity: 0.08; color: var(--c-quality-epic); }
        .eq-slot.filled[data-quality="传说"] .eq-watermark, .eq-item[data-quality="传说"] .eq-watermark { opacity: 0.12; color: var(--c-quality-legendary); font-size: 80px; }
        
        .btn-sleek {
          background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle);
          color: var(--text-secondary); border-radius: var(--r-md);
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; transition: all 0.2s; font-size: 11px; font-weight: 700;
        }
        .btn-sleek:hover { background: rgba(255,255,255,0.08); color: var(--text-primary); border-color: rgba(255,255,255,0.2); }
        .btn-sleek.active { background: rgba(255,255,255,0.1); border-color: var(--text-primary); color: var(--c-void); background: var(--text-primary); }

        /* ── Bento 统一顶部高光（微光切割线，提升卡片存在感） ──── */
        .attr-card::after, .item-card::after, .skill-card::after,
        .rel-card-wrap::after, .eq-card::after, .mission-seal::after {
          content: ''; position: absolute; top: 0; left: 8%; right: 8%; height: 1px;
          background: linear-gradient(to right, transparent, rgba(var(--paper-rgb), 0.12), transparent);
          pointer-events: none;
        }

        /* 数值变化时平滑过渡；常驻进度条不闪烁，便于读数。 */
        .attr-bar-fill, .dash-bar-fill, .skill-detail-mastery div { position: relative; overflow: hidden; }
        @media (prefers-reduced-motion: reduce) {
          .content { animation: none; }
          .attr-bar-fill, .dash-bar-fill, .skill-detail-mastery div { transition: none; }
        }

        ${gradeEffectStyles}
`;

