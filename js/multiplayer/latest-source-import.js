import {
  assertTimelineSave,
  sanitizeTimelinePersistenceValue
} from '../core/timeline-save-schema.js';
import {
  assertPathIdentifier,
  createIdempotencyKey
} from './contracts.js';

export const LATEST_SOURCE_SAVE_IMPORT_KIND = 'latest_source_continuation';
export const PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA =
  'naruto.multiplayer-personal-timeline/v1';
export const MULTIPLAYER_TO_SINGLEPLAYER_CODEC =
  'naruto.multiplayer-to-singleplayer/v1';

const MULTIPLAYER_RECORD_SIDECAR_SCHEMA = 'naruto.multiplayer-record-sidecar/v1';
const SERVER_REIMPORT_CAPSULE_SCHEMA = 'naruto.multiplayer-server-reimport-capsule/v1';
const REQUEST_FIELDS = Object.freeze([
  'import_kind',
  'proposal_id',
  'proposal_revision',
  'source_save_id',
  'client_save_instance_id',
  'source_branch_id',
  'source_node_id',
  'cloud_revision',
  'source_document',
  'idempotency_key'
]);
const INTERNAL_TIMELINE_META_FIELD = '_multiplayer_non_agent_metadata';

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function optionalCloudRevision(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 160) {
    throw new TypeError('cloud_revision must be null or a non-empty string');
  }
  return value;
}

function unwrapImportProjection(value) {
  if (!isRecord(value)) return null;
  const projection = value.import ?? value.save_import ?? value;
  if (!isRecord(projection)) return null;
  const sourceImportId = projection.source_import_id ?? projection.import_id;
  if (typeof sourceImportId !== 'string') return null;
  return {
    ...projection,
    source_import_id: sourceImportId,
    source: isRecord(projection.source)
      ? projection.source
      : (isRecord(value.source)
          ? value.source
          : (isRecord(value.client_source_binding) ? value.client_source_binding : null))
  };
}

function lineageImportProjections(lineage) {
  if (!Array.isArray(lineage?.source_imports)) return [];
  return lineage.source_imports.map(unwrapImportProjection).filter(Boolean);
}

function proposalBinding(projection) {
  if (!projection) return null;
  try {
    return Object.freeze({
      source_import_id: assertPathIdentifier(projection.source_import_id, 'source_import_id'),
      proposal_id: assertPathIdentifier(projection.proposal_id, 'proposal_id'),
      proposal_revision: integer(projection.proposal_revision, 'proposal_revision')
    });
  } catch {
    return null;
  }
}

function uniqueBinding(candidates, label) {
  const valid = candidates.map(proposalBinding).filter(Boolean);
  if (valid.length === 0) return null;
  const signatures = new Set(valid.map(binding => (
    `${binding.source_import_id}\u0000${binding.proposal_id}\u0000${binding.proposal_revision}`
  )));
  if (signatures.size !== 1) {
    throw new TypeError(`${label} contains conflicting latest-source proposal bindings`);
  }
  return valid[0];
}

function projectionForExport({ exportId, sourceBranchId, sourceNodeId, lineage, staged }) {
  const rows = lineageImportProjections(lineage);
  const matchesDocument = row => (
    row.source?.derived_from_export_id === exportId
    && row.source?.source_branch_id === sourceBranchId
    && row.source?.source_node_id === sourceNodeId
  );
  const matchingRows = rows.filter(matchesDocument);
  const stagedProjection = unwrapImportProjection(staged);
  if (stagedProjection) {
    const stagedRow = rows.find(row => row.source_import_id === stagedProjection.source_import_id);
    const stagedSource = stagedProjection.source ?? stagedRow?.source;
    if (stagedSource?.derived_from_export_id === exportId
      && stagedSource?.source_branch_id === sourceBranchId
      && stagedSource?.source_node_id === sourceNodeId) {
      matchingRows.push(stagedProjection);
    }
  }
  return uniqueBinding(matchingRows, 'lineage/staged projection');
}

function ownerSourceIdentity({ exportId, lineage }) {
  const rows = lineageImportProjections(lineage).filter(row => isRecord(row.source));
  const exact = rows.filter(row => row.source.derived_from_export_id === exportId);
  const candidates = exact.length > 0
    ? exact
    : rows.filter(row => row.source.derived_from_export_id == null);
  const source = candidates.at(-1)?.source;
  if (!source) return null;
  try {
    return Object.freeze({
      source_save_id: assertPathIdentifier(source.source_save_id, 'source_save_id'),
      client_save_instance_id: assertPathIdentifier(
        source.client_save_instance_id,
        'client_save_instance_id'
      ),
      cloud_revision: optionalCloudRevision(source.cloud_revision)
    });
  } catch {
    return null;
  }
}

function validateSidecar(document, metadata) {
  const sidecar = document.multiplayer_record_sidecar;
  if (!isRecord(sidecar)
    || sidecar.schema !== MULTIPLAYER_RECORD_SIDECAR_SCHEMA
    || sidecar.inject_to_agent !== false
    || sidecar.counterpart_private_pov_included !== false
    || !Array.isArray(sidecar.actor_bindings)
    || sidecar.actor_bindings.length !== 2
    || !Array.isArray(sidecar.multiplayer_records)) {
    throw new TypeError('latest-source multiplayer_record_sidecar is invalid');
  }
  const capsule = sidecar.server_reimport_capsule;
  if (!isRecord(capsule)
    || capsule.schema !== SERVER_REIMPORT_CAPSULE_SCHEMA
    || capsule.inject_to_agent !== false
    || capsule.source_checkpoint_id !== metadata.checkpoint_id
    || capsule.source_exporting_seat !== metadata.exporting_seat) {
    throw new TypeError('latest-source server_reimport_capsule is invalid');
  }
  const entities = new Set();
  const tokens = new Set();
  for (const binding of sidecar.actor_bindings) {
    if (!isRecord(binding)
      || binding.inject_to_agent !== false
      || !['player', 'npc_or_companion'].includes(binding.export_role)
      || typeof binding.opaque_binding_token !== 'string'
      || binding.opaque_binding_token.length < 16) {
      throw new TypeError('latest-source actor binding is invalid');
    }
    entities.add(assertPathIdentifier(binding.source_entity_id, 'source_entity_id'));
    tokens.add(binding.opaque_binding_token);
  }
  if (entities.size !== 2 || tokens.size !== 2) {
    throw new TypeError('latest-source actor bindings must form two distinct opaque entries');
  }
  if (sidecar.multiplayer_records.some(record => (
    !isRecord(record) || record.inject_to_agent !== false
  ))) {
    throw new TypeError('latest-source multiplayer record can never be Agent-injectable');
  }
  const agentVisible = JSON.stringify({
    nodes: document.nodes,
    branches: document.branches,
    meta: document.meta
  });
  if ([...tokens].some(token => agentVisible.includes(token))) {
    throw new TypeError('latest-source actor binding token entered Agent-visible timeline data');
  }
}

export function normalizeLatestSourceDocument(value) {
  if (!isRecord(value)) throw new TypeError('latest-source timeline must be a JSON object');
  if (value.schema !== PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA
    || value.codec !== MULTIPLAYER_TO_SINGLEPLAYER_CODEC) {
    throw new TypeError('latest-source file is not a server personal multiplayer export');
  }
  const metadata = value.multiplayer_export;
  if (!isRecord(metadata)
    || metadata.timeline_origin !== 'source_owner_branch'
    || !['A', 'B'].includes(metadata.exporting_seat)) {
    throw new TypeError('latest-source multiplayer_export metadata is invalid or not owner-derived');
  }
  for (const field of [
    'export_id',
    'room_id',
    'lineage_id',
    'checkpoint_id',
    'multiplayer_branch_id'
  ]) {
    assertPathIdentifier(metadata[field], `multiplayer_export.${field}`);
  }
  if (!Array.isArray(metadata.multiplayer_node_ids)
    || metadata.multiplayer_node_ids.length < 1) {
    throw new TypeError('multiplayer_export.multiplayer_node_ids must be a non-empty array');
  }
  metadata.multiplayer_node_ids.forEach((nodeId, index) => (
    assertPathIdentifier(nodeId, `multiplayer_export.multiplayer_node_ids[${index}]`)
  ));
  const meta = value.meta?.value ?? value.meta;
  if (!isRecord(meta)
    || Object.prototype.hasOwnProperty.call(meta, INTERNAL_TIMELINE_META_FIELD)) {
    throw new TypeError('latest-source timeline meta must contain only exported public timeline metadata');
  }
  const branchId = assertPathIdentifier(meta.active_branch, 'meta.active_branch');
  const nodeId = assertPathIdentifier(meta.current_id, 'meta.current_id');
  const branch = value.branches?.find(item => item?.id === branchId);
  const node = value.nodes?.find(item => item?.id === nodeId);
  if (!branch || !node
    || branch.head_node_id !== nodeId
    || node.branch_id !== branchId) {
    throw new TypeError('latest-source must select the active branch head');
  }
  assertTimelineSave(value);
  validateSidecar(value, metadata);
  return sanitizeTimelinePersistenceValue(value, 'latest_source_document');
}

export function resolveLatestSourceContinuationBinding({
  sourceImportId,
  lineage = null,
  staged = null
} = {}) {
  const expectedId = assertPathIdentifier(sourceImportId, 'source_import_id');
  const candidates = [];
  const stagedProjection = unwrapImportProjection(staged);
  if (stagedProjection?.source_import_id === expectedId) candidates.push(stagedProjection);
  candidates.push(...lineageImportProjections(lineage).filter(row => (
    row.source_import_id === expectedId
  )));
  const binding = uniqueBinding(candidates, 'source import projection');
  if (!binding) {
    throw new TypeError('latest-source proposal binding is unavailable; refresh lineage or restage the file');
  }
  return binding;
}

function exactRequest(value) {
  const unsupported = Object.keys(value).filter(key => !REQUEST_FIELDS.includes(key));
  if (unsupported.length > 0) {
    throw new TypeError(`latest-source candidate contains unsupported fields: ${unsupported.join(', ')}`);
  }
  return value;
}

export function normalizeLatestSourceSaveImportCandidate(candidate, {
  lineage = null,
  staged = null
} = {}) {
  const wrapper = isRecord(candidate?.request) ? candidate.request : candidate;
  const requestInput = isRecord(wrapper) && (
    wrapper.import_kind === LATEST_SOURCE_SAVE_IMPORT_KIND
      || Object.prototype.hasOwnProperty.call(wrapper, 'source_document')
  ) ? exactRequest(wrapper) : null;
  const document = normalizeLatestSourceDocument(requestInput?.source_document ?? wrapper);
  const metadata = document.multiplayer_export;
  const documentMeta = document.meta?.value ?? document.meta;
  const recovered = projectionForExport({
    exportId: metadata.export_id,
    sourceBranchId: documentMeta.active_branch,
    sourceNodeId: documentMeta.current_id,
    lineage,
    staged
  });
  const explicitProposalId = requestInput?.proposal_id;
  const explicitProposalRevision = requestInput?.proposal_revision;
  const proposalId = explicitProposalId
    ?? recovered?.proposal_id
    ?? createIdempotencyKey('continuation');
  const proposalRevision = explicitProposalRevision
    ?? recovered?.proposal_revision
    ?? 1;
  assertPathIdentifier(proposalId, 'proposal_id');
  integer(proposalRevision, 'proposal_revision');
  if (recovered && (recovered.proposal_id !== proposalId
    || recovered.proposal_revision !== Number(proposalRevision))) {
    throw new TypeError('latest-source candidate conflicts with the staged proposal binding');
  }
  const sourceIdentity = ownerSourceIdentity({ exportId: metadata.export_id, lineage });
  const sourceSaveId = requestInput?.source_save_id
    ?? sourceIdentity?.source_save_id
    ?? metadata.export_id;
  const clientSaveInstanceId = requestInput?.client_save_instance_id
    ?? sourceIdentity?.client_save_instance_id
    ?? metadata.lineage_id;
  const cloudRevision = Object.prototype.hasOwnProperty.call(requestInput ?? {}, 'cloud_revision')
    ? optionalCloudRevision(requestInput.cloud_revision)
    : (sourceIdentity?.cloud_revision ?? null);
  const idempotencyKey = requestInput?.idempotency_key
    ?? createIdempotencyKey('latest-source-import');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200) {
    throw new TypeError('latest-source idempotency_key is invalid');
  }
  return Object.freeze({
    import_kind: LATEST_SOURCE_SAVE_IMPORT_KIND,
    proposal_id: proposalId,
    proposal_revision: Number(proposalRevision),
    source_save_id: assertPathIdentifier(sourceSaveId, 'source_save_id'),
    client_save_instance_id: assertPathIdentifier(
      clientSaveInstanceId,
      'client_save_instance_id'
    ),
    source_branch_id: assertPathIdentifier(
      documentMeta.active_branch,
      'source_branch_id'
    ),
    source_node_id: assertPathIdentifier(
      documentMeta.current_id,
      'source_node_id'
    ),
    cloud_revision: cloudRevision,
    source_document: document,
    idempotency_key: idempotencyKey
  });
}
