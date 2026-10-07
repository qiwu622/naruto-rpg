// Shared by the room workspace, floating session and authoritative character panel.
// Values inherit the game's identity while keeping multiplayer surfaces readable.
export const multiplayerTheme = `
  --mp-bg: #101317;
  --mp-card: #181c22;
  --mp-raised: #20252c;
  --mp-input: #11151a;
  --mp-border: rgba(218, 224, 232, .12);
  --mp-border-strong: rgba(218, 224, 232, .24);
  --mp-text: #f2eee6;
  --mp-secondary: #bcc0c8;
  --mp-muted: #969da9;
  --mp-accent: var(--c-shuiro, #eb613f);
  --mp-gold: var(--c-kin, #c69c6d);
  --mp-success: #80cba6;
  --mp-warning: #e8bd76;
  --mp-danger: #f79a97;
  --mp-radius: 12px;
  --mp-font: var(--font-body, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  --mp-shadow: 0 20px 64px rgba(0, 0, 0, .38);
`;
