import { eventBus } from '../core/event-bus.js';
import { stateManager } from '../core/state-manager.js';
import { worldStateSystem } from '../systems/world-state-system.js';

/**
 * AtmosphereManager
 * 负责管理环境氛围：包括查克拉粒子系统、动态光影、以及基于游戏状态的主题切换
 */
class AtmosphereManager {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.particles = [];
    this.animationId = null;
    this.chakraColor = '#7fb7d8'; // 默认蓝色查克拉
    this.lastState = '';
    this._initialized = false;
    this._resizeHandler = null;
    this._visibilityHandler = null;
  }

  init() {
    if (this._initialized) return;
    this.canvas = document.getElementById('chakra-canvas');
    if (!this.canvas) return;

    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      this.canvas.style.display = 'none';
      this._initialized = true;
      return;
    }

    this.ctx = this.canvas.getContext('2d');

    this._handleResize();
    this._resizeHandler = () => this._handleResize();
    window.addEventListener('resize', this._resizeHandler, { passive: true });

    this._initParticles();
    this._animate();
    this._bindEvents();
    this.updateAtmosphere();

    this._visibilityHandler = () => {
      if (document.hidden) {
        if (this.animationId) { cancelAnimationFrame(this.animationId); this.animationId = null; }
      } else {
        if (!this.animationId) this._animate();
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
    this._initialized = true;
  }

  destroy() {
    if (!this._initialized) return;
    if (this.animationId) { cancelAnimationFrame(this.animationId); this.animationId = null; }
    if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    if (this._visibilityHandler) { document.removeEventListener('visibilitychange', this._visibilityHandler); this._visibilityHandler = null; }
    if (this._unsubState) { this._unsubState(); this._unsubState = null; }
    this.particles = [];
    this._initialized = false;
  }

  _handleResize() {
    if (!this.canvas) return;
    const parentRect = this.canvas.parentElement?.getBoundingClientRect();
    this.canvas.width = parentRect ? parentRect.width : window.innerWidth;
    this.canvas.height = parentRect ? parentRect.height : window.innerHeight;
  }

  _initParticles() {
    this.particles = [];
    const width = this.canvas ? this.canvas.width : window.innerWidth;
    const count = Math.min(Math.floor(width / 40), 30);
    for (let i = 0; i < count; i++) {
      this.particles.push(this._createParticle());
    }
  }

  _createParticle() {
    return {
      x: Math.random() * this.canvas.width,
      y: Math.random() * this.canvas.height,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.8) * 0.6, // 默认向上缓慢漂浮
      size: Math.random() * 2 + 1,
      life: Math.random() * 0.5 + 0.5,
      alpha: Math.random() * 0.4 + 0.1
    };
  }

  _animate() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    this.particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      
      if (p.y < -10) p.y = this.canvas.height + 10;
      if (p.x < -10) p.x = this.canvas.width + 10;
      if (p.x > this.canvas.width + 10) p.x = -10;
      
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fillStyle = this.chakraColor;
      this.ctx.globalAlpha = p.alpha;
      this.ctx.fill();
    });
    
    this.animationId = requestAnimationFrame(() => this._animate());
  }

  _bindEvents() {
    this._unsubState = eventBus.on('state:changed', ({ key }) => {
      if (key && (key.startsWith('世界·') || key.startsWith('_combat'))) {
        this.updateAtmosphere();
      }
    });
  }

  updateAtmosphere() {
    const combat = stateManager.getSub('_combat')?.is_active;
    const cal = worldStateSystem.getCalendar();
    const timeOfDay = cal?.time_of_day || '午后';
    const weather = stateManager.get('世界·天气') || '晴';

    // 1. 确定粒子颜色
    let targetColor = '#7fb7d8'; // 默认蓝色
    if (combat) {
      targetColor = '#eb613f'; // 战斗时呈朱色
    } else if (timeOfDay.includes('晚') || timeOfDay.includes('夜')) {
      targetColor = '#8b6c9c'; // 夜晚呈紫色
    } else if (weather.includes('雨')) {
      targetColor = '#a7bed8'; // 雨天呈灰蓝色
    }
    
    this.chakraColor = targetColor;

    // 2. 更新 CSS 变量
    const root = document.documentElement;
    if (combat) {
      root.style.setProperty('--atmosphere-glow', 'rgba(235,97,63,0.08)');
      document.body.classList.add('is-in-combat');
    } else {
      root.style.setProperty('--atmosphere-glow', 'rgba(127,183,216,0.04)');
      document.body.classList.remove('is-in-combat');
    }
  }

  // 触发视觉特效：如“瞬身”白闪
  flash(color = 'rgba(255,255,255,0.4)', duration = 300) {
    const flashEl = document.createElement('div');
    flashEl.style.cssText = `
      position: fixed; inset: 0; background: ${color}; 
      z-index: var(--z-atmosphere); pointer-events: none; opacity: 1;
      transition: opacity ${duration}ms var(--ease-shunshin);
    `;
    (document.getElementById('app') || document.body).appendChild(flashEl);
    requestAnimationFrame(() => {
      flashEl.style.opacity = '0';
      setTimeout(() => flashEl.remove(), duration);
    });
  }
}

export const atmosphereManager = new AtmosphereManager();
export default atmosphereManager;
