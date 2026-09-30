import { createOpeningDraft, normalizeOpeningDraft } from '../systems/opening-draft.js';

/** Reuse the solo editor's data model, without initializing a browser game. */
export function detailedOpeningDraft(opening) {
  const draft = opening.detailed_draft ?? createOpeningDraft('genin_team');
  const time = opening.start_time;
  return normalizeOpeningDraft({ ...draft,
    identity: { ...draft.identity, name: opening.display_name, background: opening.background },
    campaign: { ...draft.campaign, timeline: 'custom', customYear: time.year,
      month: time.month, day: time.day, affiliation: opening.affiliation,
      location: opening.location, goal: opening.goal, openingHook: opening.opening_hook },
    power: { ...draft.power, officialRank: opening.rank }
  });
}

export function multiplayerOpeningDraft(input, { phase = 'DAWN', sharedTime = null } = {}) {
  const draft = normalizeOpeningDraft(input);
  const year = draft.campaign.timeline === 'custom' ? draft.campaign.customYear
    : Number(draft.campaign.timeline.match(/\d+/u)?.[0] ?? draft.campaign.customYear);
  const opening = {
    start_time: sharedTime ?? { year, month: draft.campaign.month, day: draft.campaign.day, phase },
    display_name: draft.identity.name, rank: draft.power.officialRank,
    affiliation: draft.campaign.affiliation || '无所属',
    background: draft.identity.background || '来历尚待揭晓。',
    location: draft.campaign.location || draft.campaign.affiliation || '木叶隐村',
    goal: draft.campaign.goal || '在忍界中写下自己的故事',
    opening_hook: draft.campaign.openingHook || '一位来客带着尚未拆封的委托，在门口停下。',
    detailed_draft: draft
  };
  opening.detailed_draft = detailedOpeningDraft(opening);
  return opening;
}

/** Creation details are shared, but secrets only belong to their author. */
export function visibleOpeningDraft(opening, own = false) {
  if (!opening?.detailed_draft || own) return opening;
  const draft = opening.detailed_draft;
  return { ...opening, detailed_draft: { ...draft,
    identity: { ...draft.identity, secrets: '' },
    relationships: draft.relationships.map(relation => ({ ...relation, secret: '' }))
  } };
}
