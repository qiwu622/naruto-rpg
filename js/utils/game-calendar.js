export const GAME_TIME_PERIODS = Object.freeze(['清晨', '上午', '正午', '午后', '傍晚', '夜晚', '深夜']);
// Keep the same 30-day story calendar as canon-database and old saves.
export const GAME_DAYS_PER_MONTH = 30;

// One reader for the two date formats accepted by the variable DSL. Preserve
// the authored clock/period instead of silently replacing it with dawn.
export function parseGameCalendar(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = text.match(/^K(\d{3,4})-(\d{2})-(\d{2})(?:[T·\s](.*))?$/i)
    || text.match(/^木叶\s*(\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:[·\s](.*))?$/);
  if (!match) return null;
  const [, year, month, day, period = ''] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +day > 31) return null;
  return { year: `木叶${Number(year)}年`, month: +month, day: +day, time_of_day: period.trim() };
}

export function gameTimePosition(value) {
  const text = String(value || '');
  const clock = text.match(/(?:^|\D)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/);
  if (clock) {
    const hour = Number(clock[1]);
    const index = hour < 5 || hour >= 23 ? 6 : hour < 8 ? 0 : hour < 12 ? 1
      : hour < 13 ? 2 : hour < 17 ? 3 : hour < 19 ? 4 : 5;
    return { index, beforeDawn: hour < 5 };
  }
  const aliases = [
    ['凌晨', 6, true], ['黎明', 0], ['早晨', 0], ['中午', 2], ['下午', 3],
    ['黄昏', 4], ['晚上', 5], ['午夜', 6]
  ];
  const alias = aliases.find(([label]) => text.includes(label));
  if (alias) return { index: alias[1], beforeDawn: alias[2] === true };
  const index = GAME_TIME_PERIODS.findIndex(period => text.includes(period));
  return { index: Math.max(0, index), beforeDawn: false };
}
