import { eventBus } from './event-bus.js';

export const VARIABLE_UPDATER_ATTEMPTS_KEY = 'naruto_variable_updater_attempts';
const MAX_ATTEMPTS = 8;
const MAX_OUTPUT_CHARS = 40000;
let attempts = [];

export function clearVariableUpdaterAttempts() {
  attempts = [];
  try { globalThis.localStorage?.removeItem(VARIABLE_UPDATER_ATTEMPTS_KEY); } catch {}
}

export function getVariableUpdaterAttempts() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(VARIABLE_UPDATER_ATTEMPTS_KEY) || 'null');
    if (Array.isArray(saved)) return saved.slice(-MAX_ATTEMPTS);
  } catch { /* Storage is optional; diagnostics must never block a turn. */ }
  return attempts.slice();
}

export function recordVariableUpdaterAttempt({ stage, model, rawOutput, error, warnings = [], finishReason = null }) {
  const output = String(rawOutput || '');
  const attempt = {
    id: `updater-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    stage, model, status: error ? 'failed' : 'validated',
    failureKind: error?.failureKind || null,
    errors: error?.validation?.errors || (error ? [String(error.message)] : []),
    warnings: [...warnings], finishReason,
    output: output.slice(0, MAX_OUTPUT_CHARS), truncated: output.length > MAX_OUTPUT_CHARS
  };
  attempts = [...getVariableUpdaterAttempts(), attempt].slice(-MAX_ATTEMPTS);
  try { globalThis.localStorage?.setItem(VARIABLE_UPDATER_ATTEMPTS_KEY, JSON.stringify(attempts)); } catch {}
  eventBus.emit('debug:variable-updater-attempt', attempt);
  return attempt;
}
