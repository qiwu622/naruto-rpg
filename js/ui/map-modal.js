import { stateManager } from '../core/state-manager.js';
import { escHtml } from '../utils/format.js';
import { MAP_MARKERS, MAP_BOUNDARIES } from '../data/map-annotations.js';

const VILLAGE_COUNTRY = { '音隐村':'田之国', '雨隐村':'雨之国', '草隐村':'草之国', '砂隐村':'风之国', '木叶隐村':'火之国', '雾隐村':'水之国', '云隐村':'雷之国', '岩隐村':'土之国', '泷隐村':'泷之国', '汤隐村':'汤之国', '霜隐村':'霜之国', '谷隐村':'风之国', '石隐村':'石之国', '匠隐村':'匠之国' };

function findLocation(name) {
  if (!name) return null;
  const n = name.trim();
  let match = MAP_MARKERS.find(m => m.name === n);
  if (match) return match;
  match = MAP_MARKERS.find(m => n.includes(m.name) || m.name.includes(n));
  if (match) return match;
  const country = VILLAGE_COUNTRY[n];
  if (country) {
    match = MAP_MARKERS.find(m => m.name === country);
    if (match) return { ...match, name: n, desc: `位于${country}境内。${match.desc||''}`, fallbackCountry: true };
  }
  return { name: n, x: 0, y: 0, tier: 'unknown', desc: '暂无此地的精确坐标与情报。', noCoords: true };
}

class MapModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._scale = 1;
    this._panX = 0;
    this._panY = 0;
    this._dragging = false;
    this._dragStart = null;
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const s = stateManager.get();
    const currentLoc = stateManager.get('世界·地点') || '木叶隐村';
    const exploredRaw = stateManager.get('世界·已探索区域') || '';
    const explored = exploredRaw ? exploredRaw.split(/[，,]/).map(x => x.trim()).filter(Boolean) : ['火之国', '木叶隐村'];
    const known = Object.create(null);
    const pins = [];
    for (const [k, v] of Object.entries(s)) {
      if (k.startsWith('世界·已知地点·')) known[k.slice(8)] = v;
      if (k.startsWith('世界·标记·')) pins.push(v);
    }
    const locations = s._map?.known_locations;
    if (locations && typeof locations === 'object' && !Array.isArray(locations)) {
      Object.assign(known, locations);
    }

    const currentCoord = findLocation(currentLoc);

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: 'Noto Sans SC', system-ui, sans-serif; color: #e8e4d9; }

        .overlay {
          position: fixed; inset: 0; z-index: 500;
          display: flex;
          background: rgba(5, 8, 12, 0.85);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulseGlow {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          50% { transform: translate(-50%, -50%) scale(1.6); opacity: 0.4; }
        }

        .map-area {
          flex: 1;
          position: relative;
          overflow: hidden;
          cursor: grab;
          background: #1a1e24;
        }
        .map-area:active { cursor: grabbing; }

        .map-container {
          position: absolute;
          top: 0; left: 0;
          width: 100%; height: 100%;
          transform-origin: 0 0;
          will-change: transform;
        }

        .map-container img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: contain;
          pointer-events: none;
          user-select: none;
          -webkit-user-drag: none;
        }

        .map-overlay {
          position: absolute;
          top: 0; left: 0;
          width: 100%; height: 100%;
          pointer-events: none;
        }

        .map-boundary {
          transition: fill 0.3s, stroke 0.3s;
        }
        .map-boundary.explored:hover { fill-opacity: 0.4; }

        #pins-container {
          position: absolute;
          top: 0; left: 0;
          width: 100%; height: 100%;
          pointer-events: none;
        }

        .map-pin {
          position: absolute;
          width: 8px; height: 8px;
          border-radius: 50%;
          transform: translate(-50%, -50%);
          z-index: 10;
          cursor: pointer;
          pointer-events: auto;
          transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
        }
        .map-pin::after {
          content: attr(data-label);
          position: absolute;
          top: 100%; left: 50%;
          transform: translateX(-50%);
          margin-top: 6px;
          font-size: 11px;
          white-space: nowrap;
          color: #fff;
          text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.8);
          pointer-events: none;
          font-weight: 600;
          letter-spacing: 0.5px;
          opacity: 0;
          transition: opacity 0.2s ease;
        }
        .map-pin:hover {
          transform: translate(-50%, -50%) scale(1.6);
          box-shadow: 0 0 12px currentColor;
          z-index: 35;
        }
        .map-pin:hover::after {
          opacity: 1;
        }
        .map-pin.explored {
          background: currentColor;
          border: 1px solid rgba(255, 255, 255, 0.5);
          box-shadow: 0 0 4px currentColor;
        }

        .map-pin.current {
          width: 14px; height: 14px;
          background: radial-gradient(circle, #ffd54f 30%, transparent 70%);
          border: 2px solid #ffd54f;
          box-shadow: 0 0 16px rgba(255, 213, 79, 0.8), 0 0 32px rgba(255, 213, 79, 0.4);
          z-index: 30;
        }
        .map-pin.current::before {
          content: '';
          position: absolute; inset: -6px;
          border-radius: 50%;
          border: 2px solid rgba(255, 213, 79, 0.4);
          animation: pulseGlow 2s ease-in-out infinite;
        }
        .map-pin.current::after { opacity: 1; font-size: 12px; color: #ffd54f; }

        .zoom-controls {
          position: absolute;
          bottom: 20px; right: 20px;
          display: flex; flex-direction: column; gap: 4px;
          z-index: 40;
        }
        .zoom-btn {
          width: 36px; height: 36px;
          display: flex; align-items: center; justify-content: center;
          background: rgba(16, 22, 29, 0.85);
          border: 1px solid rgba(232, 228, 217, 0.12);
          border-radius: 6px;
          color: #e8e4d9;
          font-size: 18px;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
          backdrop-filter: blur(8px);
        }
        .zoom-btn:hover { background: rgba(232, 228, 217, 0.08); border-color: rgba(232, 228, 217, 0.25); }

        .close-btn {
          position: absolute; top: 16px; right: 16px;
          width: 40px; height: 40px;
          display: flex; align-items: center; justify-content: center;
          background: rgba(16, 22, 29, 0.8);
          border: 1px solid rgba(232, 228, 217, 0.12);
          border-radius: 50%;
          color: #e8e4d9;
          font-size: 18px;
          cursor: pointer;
          z-index: 50;
          transition: all 0.15s;
          backdrop-filter: blur(8px);
        }
        .close-btn:hover { background: rgba(239, 83, 80, 0.3); border-color: rgba(239, 83, 80, 0.5); }

        .intel-sidebar {
          width: 320px;
          min-width: 280px;
          background: linear-gradient(180deg, rgba(16, 22, 29, 0.98), rgba(10, 14, 20, 0.98));
          border-left: 1px solid rgba(232, 228, 217, 0.08);
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          animation: slideUp 0.3s ease 0.1s both;
        }

        .intel-header {
          padding: 20px 20px 16px;
          border-bottom: 1px solid rgba(232, 228, 217, 0.06);
        }
        .intel-header h2 {
          margin: 0; font-size: 14px; font-weight: 700; color: rgba(232, 228, 217, 0.4);
          letter-spacing: 3px; font-family: 'Noto Serif SC', serif;
        }

        .intel-section {
          padding: 16px 20px;
          border-bottom: 1px solid rgba(232, 228, 217, 0.04);
        }
        .intel-section-title {
          font-size: 11px; font-weight: 600; color: rgba(232, 228, 217, 0.3);
          letter-spacing: 2px; margin-bottom: 12px;
        }

        .intel-item {
          display: flex; align-items: flex-start; gap: 10px; padding: 8px 0;
        }
        .intel-dot {
          width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex-shrink: 0;
        }
        .intel-dot.explored { opacity: 1; }
        .intel-dot.locked { opacity: 0.2; background: #555 !important; }

        .intel-name { font-size: 13px; font-weight: 600; color: #e8e4d9; }
        .intel-name.locked { color: rgba(232, 228, 217, 0.25); }
        .intel-desc { font-size: 11px; color: rgba(232, 228, 217, 0.45); line-height: 1.5; margin-top: 2px; }

        .intel-known {
          padding: 10px 14px;
          background: rgba(232, 228, 217, 0.02);
          border: 1px solid rgba(232, 228, 217, 0.05);
          border-radius: 6px;
          margin-bottom: 8px;
        }
        .intel-known-name { font-size: 12px; font-weight: 600; color: #e8e4d9; margin-bottom: 4px; }
        .intel-known-desc { font-size: 11px; color: rgba(232,228,217,0.4); line-height: 1.5; }

        .empty-intel { text-align: center; padding: 32px 20px; color: rgba(232, 228, 217, 0.15); font-size: 12px; }

        #selected-intel:empty { display: none; }

        @media (max-width: 768px) {
          .overlay { flex-direction: column; }
          .map-area { flex: 0 0 55%; min-height: 0; }
          .intel-sidebar {
            width: 100%; min-width: 100%; height: 45%; flex: 1;
            border-left: none; border-top: 1px solid rgba(232, 228, 217, 0.08);
          }
          .close-btn { top: 12px; right: 12px; width: 36px; height: 36px; font-size: 16px; }
          .zoom-controls { bottom: 12px; right: 12px; display: flex; flex-direction: column; gap: 8px; transform: scale(0.9); transform-origin: bottom right; }
          .intel-header { padding: 12px 16px 8px; }
          .intel-section { padding: 12px 16px; }
        }
      </style>

      <div class="overlay">
        <div class="map-area" id="map-area">
          <div class="map-container" id="map-container">
            <img src="assets/map.jpg" alt="忍界大陆全景地图" draggable="false" id="map-img" />
            <svg class="map-overlay" id="map-overlay" preserveAspectRatio="none" style="display:none;"></svg>
            <div id="pins-container"></div>
          </div>

          <div class="zoom-controls">
            <button class="zoom-btn" id="zoom-in" title="放大">＋</button>
            <button class="zoom-btn" id="zoom-out" title="缩小">－</button>
            <button class="zoom-btn" id="zoom-reset" title="重置">⟲</button>
          </div>

          <button class="close-btn" id="close-map" title="关闭地图">✕</button>
        </div>

        <div class="intel-sidebar">
          <div class="intel-header">
            <h2>地缘情报库</h2>
          </div>
          <div id="selected-intel"></div>
          ${this._renderCurrentIntel(currentLoc, currentCoord)}
          ${this._renderExplored(explored)}
          ${this._renderKnown(known)}
        </div>
      </div>
    `;

    const img = this.shadowRoot.getElementById('map-img');
    const overlay = this.shadowRoot.getElementById('map-overlay');
    const pinsContainer = this.shadowRoot.getElementById('pins-container');

    if (img.complete) {
      this._initMapOverlays(img, overlay, pinsContainer, currentLoc, explored, pins);
    } else {
      img.addEventListener('load', () => {
        this._initMapOverlays(img, overlay, pinsContainer, currentLoc, explored, pins);
      });
    }

    this._bindMapEvents();
  }

  _initMapOverlays(img, svg, pinsContainer, currentLoc, explored, missionPins) {
    const nw = img.naturalWidth || 6000;
    const nh = img.naturalHeight || 4000;
    
    svg.setAttribute('viewBox', `0 0 ${nw} ${nh}`);
    svg.style.display = 'block';

    let svgHtml = '';
    
    for (const boundary of MAP_BOUNDARIES) {
      const isExplored = explored.some(e => e.includes(boundary.name));
      const pointsStr = boundary.points.map(p => `${p.x},${p.y}`).join(' ');
      
      let bFill = 'rgba(0, 0, 0, 0.1)';
      let bStroke = 'rgba(255, 255, 255, 0.15)';
      
      if (isExplored) {
        if (boundary.name.includes('火')) { bFill = 'rgba(232, 116, 97, 0.2)'; bStroke = 'rgba(232, 116, 97, 0.6)'; }
        else if (boundary.name.includes('风')) { bFill = 'rgba(161, 136, 127, 0.2)'; bStroke = 'rgba(161, 136, 127, 0.6)'; }
        else if (boundary.name.includes('土')) { bFill = 'rgba(198, 156, 109, 0.2)'; bStroke = 'rgba(198, 156, 109, 0.6)'; }
        else if (boundary.name.includes('雷')) { bFill = 'rgba(255, 183, 77, 0.2)'; bStroke = 'rgba(255, 183, 77, 0.6)'; }
        else if (boundary.name.includes('水')) { bFill = 'rgba(129, 212, 250, 0.2)'; bStroke = 'rgba(129, 212, 250, 0.6)'; }
        else { bFill = 'rgba(176, 190, 197, 0.2)'; bStroke = 'rgba(176, 190, 197, 0.6)'; }
      }

      svgHtml += `<polygon points="${pointsStr}" fill="${bFill}" stroke="${bStroke}" stroke-width="4" class="map-boundary ${isExplored ? 'explored' : ''}"></polygon>`;
    }
    svg.innerHTML = svgHtml;

    pinsContainer.innerHTML = this._renderPins(nw, nh, currentLoc, explored, missionPins);
  }

  _getPinColor(tier, name) {
    if (name.includes('火') || name.includes('木叶')) return '#e87461';
    if (name.includes('风') || name.includes('砂')) return '#a1887f';
    if (name.includes('土') || name.includes('岩')) return '#c69c6d';
    if (name.includes('雷') || name.includes('云')) return '#FFB74D';
    if (name.includes('水') || name.includes('雾')) return '#81d4fa';
    return '#b0bec5';
  }

  _pointInPolygon(point, vs) {
    let x = point.x, y = point.y;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      let xi = vs[i].x, yi = vs[i].y;
      let xj = vs[j].x, yj = vs[j].y;
      let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  _renderPins(nw, nh, currentLoc, explored, missionPins) {
    let html = '';
    const currentCoord = findLocation(currentLoc);
    const rendered = new Set();

    const exploredBoundaries = MAP_BOUNDARIES.filter(b => explored.some(e => e.includes(b.name) || b.name.includes(e)));

    for (const marker of MAP_MARKERS) {
      let isVisible = explored.some(e => e.includes(marker.name) || marker.name.includes(e));
      let parentCountry = marker.name;

      if (!isVisible) {
        for (const b of exploredBoundaries) {
          if (this._pointInPolygon(marker, b.points)) {
            isVisible = true;
            parentCountry = b.name;
            break;
          }
        }
      }

      if (isVisible) {
        if (rendered.has(marker.x + ',' + marker.y)) continue;
        rendered.add(marker.x + ',' + marker.y);
        
        const px = (marker.x / nw) * 100;
        const py = (marker.y / nh) * 100;
        const isCurrent = currentCoord && Math.abs(marker.x - currentCoord.x) < 5 && Math.abs(marker.y - currentCoord.y) < 5;
        
        if (isCurrent) continue;
        
        const color = this._getPinColor(marker.tier, parentCountry);
        html += `<div class="map-pin explored" style="left:${px}%;top:${py}%;color:${color};" data-label="${escHtml(marker.name)}"></div>`;
      }
    }

    if (currentCoord && !currentCoord.noCoords) {
      const px = (currentCoord.x / nw) * 100;
      const py = (currentCoord.y / nh) * 100;
      html += `<div class="map-pin current" style="left:${px}%;top:${py}%;" data-label="${escHtml(currentLoc)}"></div>`;
    }

    return html;
  }

  _renderCurrentIntel(currentLoc, coord) {
    const desc = coord?.desc || '目前尚未掌握该地区的详细情报背景。';
    const noCoords = coord?.noCoords;
    return `
      <div class="intel-section">
        <div class="intel-section-title">当前所在区域${noCoords ? ' (无精确坐标)' : ''}</div>
        <div class="intel-item">
          <div class="intel-dot explored" style="background: ${noCoords ? '#b0bec5' : '#ffd54f'};"></div>
          <div>
            <div class="intel-name">${escHtml(currentLoc)}</div>
            <div class="intel-desc">${escHtml(desc)}</div>
          </div>
        </div>
      </div>`;
  }

  _renderSelectedIntel(loc) {
    if (!loc) return '';
    return `
      <div class="intel-section" style="background: rgba(255,213,79,0.05); border-left: 2px solid #ffd54f;">
        <div class="intel-section-title" style="color: #ffd54f;">查阅地点情报</div>
        <div class="intel-item">
          <div class="intel-dot explored" style="background: #ffd54f;"></div>
          <div>
            <div class="intel-name" style="color: #ffd54f;">${escHtml(loc.name)}</div>
            <div class="intel-desc">${escHtml(loc.desc || '目前尚未掌握该地区的详细情报背景。')}</div>
          </div>
        </div>
      </div>`;
  }

  _renderExplored(explored) {
    const fiveNations = [
      { name: '火之国', color: '#e87461' },
      { name: '土之国', color: '#c69c6d' },
      { name: '风之国', color: '#a1887f' },
      { name: '雷之国', color: '#FFB74D' },
      { name: '水之国', color: '#81d4fa' },
    ];
    return `
      <div class="intel-section">
        <div class="intel-section-title">五大国探索进度</div>
        ${fiveNations.map(n => {
          const isExplored = explored.some(e => e.includes(n.name));
          const loc = findLocation(n.name);
          return `
            <div class="intel-item">
              <div class="intel-dot ${isExplored ? 'explored' : 'locked'}" style="background: ${n.color};"></div>
              <div>
                <div class="intel-name ${isExplored ? '' : 'locked'}">${n.name}</div>
                ${isExplored
                  ? `<div class="intel-desc">${escHtml(loc?.desc || '已踏足')}</div>`
                  : `<div class="intel-desc" style="color: rgba(232,228,217,0.15);">尚未探访该国版图</div>`}
              </div>
            </div>`;
        }).join('')}
      </div>`;
  }

  _renderKnown(known) {
    const entries = Object.entries(known || {});
    if (!entries.length) {
      return `
        <div class="intel-section">
          <div class="intel-section-title">打探到的情报</div>
          <div class="empty-intel">尚未打探到相关地标情报<br/>请在跑团历练中探寻</div>
        </div>`;
    }
    return `
      <div class="intel-section">
        <div class="intel-section-title">打探到的情报 (${entries.length})</div>
        ${entries.map(([name, location]) => `
          <div class="intel-known">
            <div class="intel-known-name">${escHtml(name)}</div>
            <div class="intel-known-desc">${escHtml(String(location && typeof location === 'object' ? location.desc ?? location.description ?? '' : location ?? ''))}</div>
          </div>`).join('')}
      </div>`;
  }

  _bindMapEvents() {
    const area = this.shadowRoot.getElementById('map-area');
    const container = this.shadowRoot.getElementById('map-container');
    const pinsContainer = this.shadowRoot.getElementById('pins-container');
    const img = this.shadowRoot.getElementById('map-img');
    if (!area || !container) return;

    this.shadowRoot.getElementById('close-map')?.addEventListener('click', () => this.remove());
    this.shadowRoot.querySelector('.overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.remove();
    });

    const applyTransform = () => {
      container.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._scale})`;
    };

    this.shadowRoot.getElementById('zoom-in')?.addEventListener('click', () => {
      this._scale = Math.min(this._scale * 1.3, 5);
      applyTransform();
    });
    this.shadowRoot.getElementById('zoom-out')?.addEventListener('click', () => {
      this._scale = Math.max(this._scale / 1.3, 0.5);
      applyTransform();
    });
    this.shadowRoot.getElementById('zoom-reset')?.addEventListener('click', () => {
      this._scale = 1; this._panX = 0; this._panY = 0;
      applyTransform();
    });

    area.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this._scale = Math.max(0.5, Math.min(5, this._scale * delta));
      applyTransform();
    }, { passive: false });

    // Pin click event
    pinsContainer.addEventListener('click', (e) => {
      const pin = e.target.closest('.map-pin');
      if (!pin) return;
      const name = pin.getAttribute('data-label');
      const loc = findLocation(name);
      if (loc) {
        this.shadowRoot.getElementById('selected-intel').innerHTML = this._renderSelectedIntel(loc);
      }
    });

    area.addEventListener('mousedown', (e) => {
      if (e.target.closest('.zoom-controls') || e.target.closest('.close-btn') || e.target.closest('.map-pin') || e.target.closest('.loc-badge')) return;
      this._dragging = true;
      this._dragStart = { x: e.clientX - this._panX, y: e.clientY - this._panY };
    });
    window.addEventListener('mousemove', this._onMouseMove = (e) => {
      if (!this._dragging) return;
      this._panX = e.clientX - this._dragStart.x;
      this._panY = e.clientY - this._dragStart.y;
      applyTransform();
    });
    window.addEventListener('mouseup', this._onMouseUp = () => {
      this._dragging = false;
    });

    area.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (e.target.closest('.map-pin')) return;
      const t = e.touches[0];
      this._dragging = true;
      this._dragStart = { x: t.clientX - this._panX, y: t.clientY - this._panY };
    }, { passive: true });
    area.addEventListener('touchmove', (e) => {
      if (!this._dragging || e.touches.length !== 1) return;
      const t = e.touches[0];
      this._panX = t.clientX - this._dragStart.x;
      this._panY = t.clientY - this._dragStart.y;
      applyTransform();
    }, { passive: true });
    area.addEventListener('touchend', () => { this._dragging = false; }, { passive: true });

    this._onKeyDown = (e) => { if (e.key === 'Escape') this.remove(); };
    window.addEventListener('keydown', this._onKeyDown);
  }

  disconnectedCallback() {
    if (this._onMouseMove) window.removeEventListener('mousemove', this._onMouseMove);
    if (this._onMouseUp) window.removeEventListener('mouseup', this._onMouseUp);
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
  }
}

customElements.define('map-modal', MapModal);
export { MapModal, findLocation };
