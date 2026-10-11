export const DEFAULT_HISTORY_VIEW_TURNS = 100;

export function normalizeHistoryViewTurns(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : DEFAULT_HISTORY_VIEW_TURNS;
}
