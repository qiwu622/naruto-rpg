import { projectAudienceViews } from './audience-projector.js';
import { canonicalStringify, sha256Hex } from './canonical-json.js';
import { DomainError } from './errors.js';

export const AUTHORITATIVE_CALENDAR_PUBLIC_FACT_PREFIX =
  'public:authority:calendar:';

const BASELINE_FACT_SCHEMA = 'naruto.multiplayer-authoritative-calendar-public-fact/v1';

function invalidCalendar(message, details = {}) {
  throw new DomainError('WORLD_PUBLIC_BASELINE_UNAVAILABLE', message, details);
}

function authoritativeCalendarFact(state) {
  const calendar = state?.shared_world?.calendar;
  if (!calendar || typeof calendar !== 'object' || Array.isArray(calendar)) {
    invalidCalendar('authoritative state has no public calendar baseline');
  }
  if (typeof calendar.calendar_id !== 'string' || calendar.calendar_id.length === 0) {
    invalidCalendar('authoritative calendar has no stable ID');
  }
  if (!Number.isSafeInteger(calendar.version) || calendar.version < 0
    || !Number.isSafeInteger(calendar.ordinal_minutes) || calendar.ordinal_minutes < 0
    || typeof calendar.display_date !== 'string' || calendar.display_date.length === 0
    || typeof calendar.phase !== 'string' || calendar.phase.length === 0) {
    invalidCalendar('authoritative calendar cannot produce a deterministic public baseline', {
      calendar_id: calendar.calendar_id
    });
  }

  const identity = {
    schema: BASELINE_FACT_SCHEMA,
    calendar_id: calendar.calendar_id,
    version: calendar.version,
    ordinal_minutes: calendar.ordinal_minutes,
    display_date: calendar.display_date,
    phase: calendar.phase
  };
  const factId = `${AUTHORITATIVE_CALENDAR_PUBLIC_FACT_PREFIX}${
    sha256Hex(canonicalStringify(identity)).slice(0, 32)
  }`;

  return Object.freeze({
    fact_id: factId,
    title: '当前公开纪年',
    summary: `权威世界状态确认当前公开纪年为“${calendar.display_date}”。`
      + '该基线只证明纪年，不证明任何离屏事件、任务、天气或地区动态。',
    canonical_source_ref: calendar.calendar_id,
    audiences: Object.freeze(['seat:A', 'seat:B']),
    world_public: true
  });
}

/**
 * Produce the normal audience projections and guarantee that the mandatory
 * Shinobi Daily has one authoritative public source even when this turn has
 * no public event and no public fact provider result. The fallback is derived
 * only from the frozen room calendar; it never creates a canonical event.
 */
export function projectAudienceViewsWithPublicBaseline({
  turn_id,
  events,
  facts = [],
  state
}) {
  const source = { turn_id, events, facts };
  const projections = projectAudienceViews(source);
  if (projections.world_public.events.length > 0
    || projections.world_public.facts.length > 0) {
    return projections;
  }

  return projectAudienceViews({
    ...source,
    facts: [...facts, authoritativeCalendarFact(state)]
  });
}
