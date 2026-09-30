import { canonicalizeJson } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

export function normalizeNarrativePreset(value) {
  const bad = () => { throw new DomainError('NARRATIVE_PRESET_INVALID', '正文预设格式无效，最多 256 条、共 180000 字符。'); };
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160
    || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 256) bad();
  const entries = value.entries.map(entry => {
    if (!entry || (entry.content != null && typeof entry.content !== 'string') || (entry.content?.length ?? 0) > 100_000) bad();
    return {
      id: String(entry.id ?? '').slice(0,160), name: String(entry.name ?? '').slice(0,160),
      role: ['system','user','assistant'].includes(entry.role) ? entry.role : 'system',
      content: entry.content ?? '', enabled: entry.enabled !== false, isMarker: entry.isMarker === true,
      activation: String(entry.activation ?? 'always').slice(0,80),
      tavernPosition: String(entry.tavernPosition ?? '').slice(0,80)
    };
  });
  const result = { name: value.name.trim(), entries,
    assistantPrefill: typeof value.assistantPrefill === 'string' ? value.assistantPrefill : '' };
  if (JSON.stringify(result).length > 180_000) bad();
  return canonicalizeJson(result);
}

export function narrativePresetSummary(room) {
  const presets = JSON.parse(room.narrative_presets_json ?? '{}');
  return { source_seat: room.narrative_preset_seat ?? 'A',
    bindings: Object.fromEntries(['A','B'].map(seat => [seat, presets[seat]
      ? { name: presets[seat].name, hash: presets[seat].hash, updated_at: presets[seat].updated_at } : null])) };
}

export function snapshotNarrativePreset(room) {
  const source_seat = room.narrative_preset_seat ?? 'A';
  return { source_seat, preset: JSON.parse(room.narrative_presets_json ?? '{}')[source_seat] ?? null };
}
