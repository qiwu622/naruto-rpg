// Shared visual treatment only. A moving light follows the existing rank's rim;
// the rank mapping and saved character/item data remain in their own modules.
export const gradeEffectStyles = `
  :is(.grade-badge, .grade-surface)[data-grade-tier] {
    --grade-color: var(--qc, #a39f98);
    --grade-halo: 0px; --grade-light: 0%; --grade-rim: 22%;
    --grade-trail-opacity: .4; --grade-trail-length: 14px;
    --grade-trail-duration: 12s; --grade-sweep-duration: 10s;
    --grade-trail-radius: 5px; --grade-sweep-strength: 10%;
  }
  :is(.grade-badge, .grade-surface)[data-grade-tier="1"] { --grade-color: var(--qc, #e8e4d9); }
  :is(.grade-badge, .grade-surface)[data-grade-tier="2"] {
    --grade-color: var(--qc, #81c784); --grade-halo: 5px; --grade-light: 8%; --grade-rim: 32%;
  }
  :is(.grade-badge, .grade-surface)[data-grade-tier="3"] {
    --grade-color: var(--qc, #78b7e8); --grade-halo: 7px; --grade-light: 11%; --grade-rim: 42%;
    --grade-trail-duration: 9s; --grade-trail-length: 18px; --grade-trail-opacity: .6;
  }
  :is(.grade-badge, .grade-surface)[data-grade-tier="4"] {
    --grade-color: var(--qc, #c5a2ec); --grade-halo: 9px; --grade-light: 13%; --grade-rim: 46%;
    --grade-trail-duration: 7s; --grade-trail-length: 23px; --grade-trail-opacity: .8;
    --grade-sweep-duration: 8s; --grade-sweep-strength: 13%;
  }
  :is(.grade-badge, .grade-surface)[data-grade-tier="5"] {
    --grade-color: var(--qc, #e2bd79); --grade-halo: 11px; --grade-light: 16%; --grade-rim: 58%;
    --grade-trail-duration: 5.5s; --grade-trail-length: 28px; --grade-trail-opacity: .95;
    --grade-sweep-duration: 6s; --grade-sweep-strength: 17%;
  }
  :is(.grade-badge, .grade-surface)[data-grade-tier="6"] {
    --grade-color: var(--qc, #ef7770); --grade-halo: 13px; --grade-light: 20%; --grade-rim: 68%;
    --grade-trail-duration: 4s; --grade-trail-length: 34px; --grade-trail-opacity: 1;
    --grade-sweep-duration: 4.5s; --grade-sweep-strength: 21%;
  }
  :is(.grade-badge, .grade-surface)[data-grade-variant="special"] {
    --grade-color: #a9aadf; --grade-trail-duration: 8s; --grade-sweep-duration: 9s;
  }
  .grade-badge[data-grade-tier] {
    box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    position: relative; isolation: isolate; overflow: hidden; vertical-align: middle;
    min-width: 26px; min-height: 24px; padding: 2px 8px; border-radius: 5px;
    max-width: 100%; font-weight: 600; line-height: 1.4; letter-spacing: .5px; white-space: nowrap;
    color: var(--grade-color); text-shadow: none;
    border: 1px solid color-mix(in srgb, var(--grade-color) var(--grade-rim), transparent);
    background: color-mix(in srgb, var(--grade-color) 7%, rgba(var(--ink-deep-rgb, 12,14,18), .85));
    box-shadow: inset 0 1px rgba(var(--paper-rgb, 232,228,217), .04),
      0 0 var(--grade-halo) color-mix(in srgb, var(--grade-color) var(--grade-light), transparent);
  }
  .jutsu-rank.grade-badge { width: 28px; height: 28px; padding: 0; }
  .grade-surface[data-grade-tier] {
    --grade-trail-radius: 11px;
    position: relative; isolation: isolate; overflow: hidden;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--grade-color) var(--grade-rim), transparent),
      inset 2px 0 color-mix(in srgb, var(--grade-color) 65%, transparent),
      0 0 var(--grade-halo) color-mix(in srgb, var(--grade-color) var(--grade-light), transparent);
  }
  .grade-surface[data-grade-tier]:is(:hover, :focus-within) {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--grade-color) 70%, transparent),
      inset 2px 0 var(--grade-color),
      0 0 var(--grade-halo) color-mix(in srgb, var(--grade-color) var(--grade-light), transparent);
  }
  .grade-surface[data-grade-tier] :is(.eq-slot-name, .eq-item-name) {
    color: color-mix(in srgb, var(--grade-color) 36%, var(--text-primary, #f2eee6));
  }
  .grade-surface[data-grade-tier] .eq-item-badge {
    box-shadow: inset 0 0 8px color-mix(in srgb, var(--grade-color) 10%, transparent);
  }
  /* A real travelling rim light, not opacity breathing. The path is relative to
     each card, so wide weapons and small rank badges follow their own outline.
     Browsers without motion paths retain the static quality border. */
  @supports (offset-path: inset(1px round 5px)) {
    :is(.grade-badge, .grade-surface):is([data-grade-tier="2"], [data-grade-tier="3"], [data-grade-tier="4"], [data-grade-tier="5"], [data-grade-tier="6"])::before {
      content: ''; position: absolute; top: 0; left: 0;
      width: var(--grade-trail-length); height: 2px; border-radius: 999px;
      pointer-events: none; z-index: 1; opacity: var(--grade-trail-opacity);
      offset-path: inset(1px round var(--grade-trail-radius));
      offset-anchor: 100% 50%; offset-rotate: auto; offset-distance: 0%;
      background: linear-gradient(90deg, transparent, var(--grade-color) 65%, #fff5dc);
      box-shadow: 0 0 4px color-mix(in srgb, var(--grade-color) 65%, transparent);
      animation: grade-border-travel var(--grade-trail-duration) linear infinite;
    }
    .grade-surface:is([data-grade-tier="4"], [data-grade-tier="5"], [data-grade-tier="6"])::before {
      width: calc(var(--grade-trail-length) * 1.6);
    }
  }
  :is(.grade-badge, .grade-surface):is([data-grade-tier="4"], [data-grade-tier="5"], [data-grade-tier="6"])::after {
    content: ''; position: absolute; inset: 0; border-radius: inherit;
    pointer-events: none; z-index: -1;
    background: linear-gradient(110deg, transparent 30%, color-mix(in srgb, var(--grade-color) var(--grade-sweep-strength), transparent) 48%, rgba(255,255,255,.08) 50%, transparent 69%);
    transform: translateX(-130%);
    animation: grade-sweep-travel var(--grade-sweep-duration) linear infinite;
  }
  @keyframes grade-border-travel { from { offset-distance: 0%; } to { offset-distance: 100%; } }
  @keyframes grade-sweep-travel { 0% { transform: translateX(-130%); } 80%, 100% { transform: translateX(130%); } }
  @media (prefers-reduced-motion: reduce) {
    :is(.grade-badge, .grade-surface)[data-grade-tier]::before,
    :is(.grade-badge, .grade-surface)[data-grade-tier]::after { animation: none; content: none; }
  }
`;
