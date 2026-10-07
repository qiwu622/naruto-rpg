import { eventBus } from './event-bus.js';
import { formatTokenUsage } from './deepseek-mode.js';

// Session-only display, never a player save or a stored prompt/key.
let lastReport = '';
eventBus.on('ai:usage', usage => {
  if (usage) lastReport = `${usage.model ? `${usage.model} · ` : ''}${formatTokenUsage(usage)}`;
});
export const getLastAIUsageReport = () => lastReport;
