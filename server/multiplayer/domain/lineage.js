import {
  assertJsonSafe,
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from './canonical-json.js';
import { DomainError, domainInvariant } from './errors.js';
import {
  PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA,
  ROOM_CHECKPOINT_SCHEMA,
  ROOM_EPOCH_SCHEMA,
  assertForkFromLatestSourceSave,
  assertOriginalActorBindingBijection,
  assertPersonalSingleplayerExport,
  assertResumeRoomCheckpoint,
  assertRoomActorBinding,
  assertRoomCheckpoint,
  assertRoomEpoch,
  assertRoomEpochCollection,
  assertRoomOrigin,
  assertSourceImport
} from '../contracts/lineage-contracts.js';
import {
  assertMultiplayerRoomState,
  assertStableRoomActorIds
} from '../contracts/state-contracts.js';

export const ROOM_LINEAGE_STATE_SCHEMA = 'naruto.multiplayer-room-lineage-state/v1';
export const PERSONAL_PLAYABLE_BRANCH_SCHEMA = 'naruto.multiplayer-personal-playable-branch/v1';
export const LATEST_SOURCE_PRIVACY_NORMALIZER_VERSION = 'latest-source-privacy-v1';

const SEATS = Object.freeze(['A', 'B']);
const NARRATIVE_MODES = new Set(['shared', 'dual_pov']);
const FORBIDDEN_PRIVATE_NAMESPACE_KEYS = new Set([
  'guest_private',
  'npc_private',
  'private_goals',
  'private_pov'
]);
const REFERENCE_KEY = /(?:^|_)(?:id|ids|ref|refs)$/u;
const COUNTERPART_PRIVATE_PLAYER_KEYS =
  /(?:^|_)(?:background|backstory|biography|goal|hidden|objective|private|secret)(?:_|$)/u;

function immutable(value) {
  return freezeDeep(canonicalizeJson(value));
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return canonicalizeJson(value);
}

function hash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPlainObject(value, code, label) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (!value || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw new DomainError(code, `${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, allowed, code, label) {
  assertPlainObject(value, code, label);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new DomainError(code, `${label} contains an unknown property`, { property: key });
    }
  }
  for (const key of allowed) {
    if (!own(value, key)) {
      throw new DomainError(code, `${label} is missing a required property`, { property: key });
    }
  }
  return value;
}

function assertIdentifier(value, field) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 256) {
    throw new DomainError('INVALID_LINEAGE_FIELD', `${field} must be a non-empty identifier`, { field });
  }
  return value;
}

function assertTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new DomainError('INVALID_LINEAGE_FIELD', `${field} must be an ISO timestamp`, { field });
  }
  return value;
}

function assertSafeRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError('INVALID_LINEAGE_FIELD', `${field} must be a non-negative safe integer`, { field });
  }
  return value;
}

function oppositeSeat(seat) {
  return seat === 'A' ? 'B' : 'A';
}

function seatForUser(membersBySeat, userId) {
  return SEATS.find(seat => membersBySeat[seat] === userId) ?? null;
}

function assertMembersBySeat(value) {
  assertExactKeys(value, SEATS, 'INVALID_LINEAGE_MEMBERS', 'members_by_seat');
  for (const seat of SEATS) assertIdentifier(value[seat], `members_by_seat.${seat}`);
  domainInvariant(
    value.A !== value.B,
    'INVALID_LINEAGE_MEMBERS',
    'A and B must be distinct original members'
  );
  return value;
}

function roomStateContent(roomState) {
  const normalized = assertMultiplayerRoomState(roomState);
  const content = clone(normalized);
  delete content.meta;
  return content;
}

/**
 * A checkpoint content hash intentionally excludes state_revision. This lets
 * a resumed genesis receive a new monotonic revision while remaining exactly
 * the same canonical state as its selected checkpoint (section 23.1/26.5).
 */
export function roomCheckpointStateHash(roomState, actorControlBySeat) {
  assertExactKeys(
    actorControlBySeat,
    SEATS,
    'INVALID_ACTOR_CONTROL',
    'actor_control_by_seat'
  );
  return hash({
    actor_control_by_seat: actorControlBySeat,
    room_state: roomStateContent(roomState)
  });
}

function assertActorControl(actorControlBySeat, roomState, bindingsBySeat) {
  assertExactKeys(
    actorControlBySeat,
    SEATS,
    'INVALID_ACTOR_CONTROL',
    'actor_control_by_seat'
  );
  for (const seat of SEATS) {
    const expectedActor = bindingsBySeat[seat].room_actor_id;
    domainInvariant(
      actorControlBySeat[seat] === expectedActor,
      'RETURN_ACTOR_BINDING_INVALID',
      'actor control must use the immutable original binding',
      { seat, expected_room_actor_id: expectedActor }
    );
    domainInvariant(
      roomState.actors[seat].room_actor_id === expectedActor,
      'RETURN_ACTOR_BINDING_INVALID',
      'room state actor slot must match its immutable binding',
      { seat, expected_room_actor_id: expectedActor }
    );
  }
}

function indexBy(values, field) {
  return new Map(values.map(value => [value[field], value]));
}

function snapshotFor(lineage, checkpointId) {
  const snapshot = lineage.snapshots.find(value => value.checkpoint_id === checkpointId);
  if (!snapshot) {
    throw new DomainError('CHECKPOINT_NOT_COMMITTED', 'checkpoint snapshot is missing', {
      checkpoint_id: checkpointId
    });
  }
  return snapshot;
}

function checkpointFor(lineage, checkpointId) {
  const checkpoint = lineage.checkpoints.find(value => value.checkpoint_id === checkpointId);
  if (!checkpoint) {
    throw new DomainError('CHECKPOINT_NOT_COMMITTED', 'checkpoint does not belong to this lineage', {
      checkpoint_id: checkpointId
    });
  }
  return checkpoint;
}

function activeEpoch(lineage) {
  if (lineage.active_epoch_id === null) return null;
  return lineage.epochs.find(epoch => epoch.epoch_id === lineage.active_epoch_id) ?? null;
}

function assertUniqueId(lineage, field, value, collections) {
  for (const collection of collections) {
    if (lineage[collection].some(item => item[field] === value)) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', `${field} is already present in the lineage`, {
        [field]: value
      });
    }
  }
}

function assertTurnRecord(value, expected = {}) {
  assertJsonSafe(value, { maxDepth: 24, maxNodes: 20_000 });
  assertExactKeys(value, [
    'turn_id',
    'action_text_by_seat',
    'narrative_mode',
    'shared_narrative',
    'pov_narrative_by_seat'
  ], 'INVALID_TURN_RECORD', 'turn_record');
  assertIdentifier(value.turn_id, 'turn_record.turn_id');
  if (expected.turn_id !== undefined && value.turn_id !== expected.turn_id) {
    throw new DomainError('INVALID_TURN_RECORD', 'turn_record turn_id does not match the commit');
  }
  assertExactKeys(
    value.action_text_by_seat,
    SEATS,
    'INVALID_TURN_RECORD',
    'turn_record.action_text_by_seat'
  );
  for (const seat of SEATS) {
    if (typeof value.action_text_by_seat[seat] !== 'string') {
      throw new DomainError('INVALID_TURN_RECORD', 'both committed action texts are required');
    }
  }
  if (!NARRATIVE_MODES.has(value.narrative_mode)) {
    throw new DomainError('INVALID_TURN_RECORD', 'narrative_mode must be shared or dual_pov');
  }
  if (value.narrative_mode === 'shared') {
    if (typeof value.shared_narrative !== 'string' || value.pov_narrative_by_seat !== null) {
      throw new DomainError('INVALID_TURN_RECORD', 'shared turn requires one shared narrative only');
    }
  } else {
    if (value.shared_narrative !== null) {
      throw new DomainError('INVALID_TURN_RECORD', 'dual_pov turn cannot contain a shared narrative');
    }
    assertExactKeys(
      value.pov_narrative_by_seat,
      SEATS,
      'INVALID_TURN_RECORD',
      'turn_record.pov_narrative_by_seat'
    );
    for (const seat of SEATS) {
      if (typeof value.pov_narrative_by_seat[seat] !== 'string') {
        throw new DomainError('INVALID_TURN_RECORD', 'dual_pov turn requires A and B narratives');
      }
    }
  }
  return immutable(value);
}

export function assertRoomLineageState(value) {
  assertJsonSafe(value, { maxDepth: 64, maxNodes: 500_000 });
  assertExactKeys(value, [
    'schema',
    'origin',
    'members_by_seat',
    'actor_bindings',
    'state_revision',
    'control_revision',
    'active_epoch_id',
    'archived_checkpoint_id',
    'epochs',
    'checkpoints',
    'snapshots',
    'turn_records',
    'used_proposal_ids',
    'personal_exports',
    'source_owner_timeline'
  ], 'INVALID_LINEAGE_STATE', 'room lineage state');
  domainInvariant(
    value.schema === ROOM_LINEAGE_STATE_SCHEMA,
    'INVALID_LINEAGE_STATE',
    `schema must be ${ROOM_LINEAGE_STATE_SCHEMA}`
  );
  const origin = assertRoomOrigin(value.origin);
  const members = assertMembersBySeat(value.members_by_seat);
  const bindingResult = assertOriginalActorBindingBijection(value.actor_bindings, {
    lineage_id: origin.lineage_id,
    expected_members_by_seat: members
  });
  const bindingsBySeat = bindingResult.bindings_by_seat;
  assertSafeRevision(value.state_revision, 'state_revision');
  assertSafeRevision(value.control_revision, 'control_revision');
  if (value.active_epoch_id !== null) assertIdentifier(value.active_epoch_id, 'active_epoch_id');
  if (value.archived_checkpoint_id !== null) {
    assertIdentifier(value.archived_checkpoint_id, 'archived_checkpoint_id');
  }

  const epochs = assertRoomEpochCollection(value.epochs, { origin_type: origin.origin_type });
  const checkpoints = value.checkpoints.map(assertRoomCheckpoint);
  domainInvariant(
    new Set(checkpoints.map(item => item.checkpoint_id)).size === checkpoints.length,
    'INVALID_LINEAGE_STATE',
    'checkpoint IDs must be unique'
  );
  const epochById = indexBy(epochs, 'epoch_id');
  const checkpointById = indexBy(checkpoints, 'checkpoint_id');
  const active = epochs.filter(epoch => epoch.state === 'ACTIVE');
  for (const epoch of epochs) {
    domainInvariant(
      epoch.room_id === origin.room_id && epoch.lineage_id === origin.lineage_id,
      'INVALID_LINEAGE_STATE',
      'every epoch must belong to the immutable Room origin'
    );
  }
  for (const checkpoint of checkpoints) {
    domainInvariant(
      checkpoint.room_id === origin.room_id
        && checkpoint.lineage_id === origin.lineage_id
        && epochById.has(checkpoint.epoch_id),
      'INVALID_LINEAGE_STATE',
      'every checkpoint must belong to a known epoch in this Room lineage'
    );
  }
  domainInvariant(
    active.length === (value.active_epoch_id === null ? 0 : 1),
    'INVALID_LINEAGE_STATE',
    'active_epoch_id must match the unique ACTIVE epoch'
  );
  if (active.length === 1) {
    domainInvariant(
      active[0].epoch_id === value.active_epoch_id && value.archived_checkpoint_id === null,
      'INVALID_LINEAGE_STATE',
      'active lineage cannot also have an archived checkpoint'
    );
  } else {
    domainInvariant(
      value.archived_checkpoint_id !== null,
      'INVALID_LINEAGE_STATE',
      'an inactive lineage must identify its archived checkpoint'
    );
    const latestArchivedEpoch = [...epochs].sort((left, right) => right.epoch_no - left.epoch_no)[0];
    domainInvariant(
      value.archived_checkpoint_id === latestArchivedEpoch.head_checkpoint_id,
      'INVALID_LINEAGE_STATE',
      'archived checkpoint must be the latest epoch head'
    );
  }

  for (const epoch of epochs) {
    domainInvariant(
      checkpointById.has(epoch.genesis_checkpoint_id) && checkpointById.has(epoch.head_checkpoint_id),
      'INVALID_LINEAGE_STATE',
      'epoch checkpoint references must resolve'
    );
    domainInvariant(
      checkpointById.get(epoch.genesis_checkpoint_id).epoch_id === epoch.epoch_id
        && checkpointById.get(epoch.head_checkpoint_id).epoch_id === epoch.epoch_id,
      'INVALID_LINEAGE_STATE',
      'epoch checkpoint references cannot cross epoch ownership'
    );
    domainInvariant(
      checkpointById.get(epoch.genesis_checkpoint_id).state_hash === epoch.base.state_hash,
      'BASE_HASH_MISMATCH',
      'epoch base hash must equal its genesis checkpoint content hash'
    );
  }

  domainInvariant(
    Array.isArray(value.snapshots) && value.snapshots.length === checkpoints.length,
    'INVALID_LINEAGE_STATE',
    'every checkpoint must have exactly one immutable snapshot'
  );
  const snapshotIds = new Set();
  for (const snapshot of value.snapshots) {
    assertExactKeys(snapshot, [
      'checkpoint_id',
      'room_state',
      'actor_control_by_seat'
    ], 'INVALID_LINEAGE_STATE', 'checkpoint snapshot');
    domainInvariant(
      !snapshotIds.has(snapshot.checkpoint_id),
      'INVALID_LINEAGE_STATE',
      'checkpoint snapshot IDs must be unique'
    );
    snapshotIds.add(snapshot.checkpoint_id);
    const checkpoint = checkpointById.get(snapshot.checkpoint_id);
    domainInvariant(Boolean(checkpoint), 'INVALID_LINEAGE_STATE', 'snapshot checkpoint must resolve');
    const roomState = assertMultiplayerRoomState(snapshot.room_state);
    domainInvariant(
      roomState.meta.state_revision === checkpoint.state_revision,
      'INVALID_LINEAGE_STATE',
      'snapshot and checkpoint state revisions must match'
    );
    assertActorControl(snapshot.actor_control_by_seat, roomState, bindingsBySeat);
    domainInvariant(
      roomCheckpointStateHash(roomState, snapshot.actor_control_by_seat) === checkpoint.state_hash,
      'BASE_HASH_MISMATCH',
      'checkpoint state hash does not match its immutable snapshot'
    );
  }

  const turnRecordCheckpointIds = new Set();
  for (const record of value.turn_records) {
    assertExactKeys(record, [
      'checkpoint_id',
      'epoch_id',
      'turn_no',
      'record'
    ], 'INVALID_LINEAGE_STATE', 'stored turn record');
    const checkpoint = checkpointById.get(record.checkpoint_id);
    domainInvariant(
      !turnRecordCheckpointIds.has(record.checkpoint_id),
      'INVALID_LINEAGE_STATE',
      'a committed checkpoint may have only one turn record'
    );
    turnRecordCheckpointIds.add(record.checkpoint_id);
    domainInvariant(
      checkpoint?.kind === 'turn_commit'
        && checkpoint.epoch_id === record.epoch_id
        && checkpoint.turn_no === record.turn_no,
      'INVALID_LINEAGE_STATE',
      'turn record must bind one committed checkpoint'
    );
    assertTurnRecord(record.record, { turn_id: checkpoint.turn_id });
  }
  domainInvariant(Array.isArray(value.used_proposal_ids), 'INVALID_LINEAGE_STATE', 'used_proposal_ids must be an array');
  for (const proposalId of value.used_proposal_ids) assertIdentifier(proposalId, 'used_proposal_ids');
  domainInvariant(
    new Set(value.used_proposal_ids).size === value.used_proposal_ids.length,
    'INVALID_LINEAGE_STATE',
    'continuation proposal IDs are append-only and unique'
  );
  domainInvariant(Array.isArray(value.personal_exports), 'INVALID_LINEAGE_STATE', 'personal_exports must be an array');
  const exportIds = new Set();
  const exportScopes = new Set();
  for (const record of value.personal_exports) {
    assertExactKeys(record, [
      'export_id',
      'exporting_member_user_id',
      'idempotency_key',
      'request_hash',
      'manifest',
      'content'
    ], 'INVALID_LINEAGE_STATE', 'personal export record');
    domainInvariant(!exportIds.has(record.export_id), 'INVALID_LINEAGE_STATE', 'personal export IDs must be unique');
    exportIds.add(record.export_id);
    const scope = `${record.exporting_member_user_id}:${record.idempotency_key}`;
    domainInvariant(!exportScopes.has(scope), 'INVALID_LINEAGE_STATE', 'personal export idempotency scope must be unique');
    exportScopes.add(scope);
    const exportingSeat = seatForUser(members, record.exporting_member_user_id);
    domainInvariant(exportingSeat !== null, 'INVALID_LINEAGE_STATE', 'personal export owner must be an original member');
    const checkpoint = checkpointById.get(record.manifest.checkpoint_id);
    domainInvariant(Boolean(checkpoint), 'INVALID_LINEAGE_STATE', 'personal export checkpoint must resolve');
    const manifest = assertPersonalSingleplayerExport(record.manifest, {
      origin_type: origin.origin_type,
      origin_owner_user_id: origin.origin_owner_user_id,
      authenticated_user_id: record.exporting_member_user_id,
      expected_members_by_seat: members,
      checkpoint,
      actor_bindings: value.actor_bindings
    });
    const sourceDocument = validatePersonalBranchDocument(record.content);
    assertOriginalActorBindingBijection(value.actor_bindings, {
      lineage_id: origin.lineage_id,
      expected_members_by_seat: members,
      source_actor_matches: sourceDocument.matches
    });
    domainInvariant(
      manifest.export_id === record.export_id
        && manifest.exporting_member_user_id === record.exporting_member_user_id
        && manifest.idempotency_key === record.idempotency_key
        && manifest.request_hash === record.request_hash
        && manifest.output_hash === hash(record.content),
      'INVALID_LINEAGE_STATE',
      'personal export manifest/content authority binding is invalid'
    );
  }
  domainInvariant(epochById.size === epochs.length, 'INVALID_LINEAGE_STATE', 'epoch IDs must be unique');

  const latestEpoch = [...epochs].sort((left, right) => right.epoch_no - left.epoch_no)[0];
  domainInvariant(
    latestEpoch.state_revision === value.state_revision
      && latestEpoch.control_revision === value.control_revision,
    'INVALID_LINEAGE_STATE',
    'room revisions must match the latest epoch revisions'
  );
  assertJsonSafe(value.source_owner_timeline, { maxDepth: 64, maxNodes: 100_000 });
  return immutable(value);
}

export function createRoomLineage(config) {
  assertJsonSafe(config, { maxDepth: 64, maxNodes: 200_000 });
  assertPlainObject(config, 'INVALID_LINEAGE_CONFIG', 'lineage config');
  const origin = assertRoomOrigin(config.origin);
  const members = assertMembersBySeat(config.members_by_seat);
  const roomState = assertMultiplayerRoomState(config.room_state);
  const stateRevision = config.state_revision ?? roomState.meta.state_revision;
  const controlRevision = config.control_revision ?? 0;
  assertSafeRevision(stateRevision, 'state_revision');
  assertSafeRevision(controlRevision, 'control_revision');
  domainInvariant(
    roomState.meta.state_revision === stateRevision,
    'STALE_STATE_REVISION',
    'initial room state revision must match the lineage revision'
  );
  const epochId = assertIdentifier(config.epoch_id, 'epoch_id');
  const checkpointId = assertIdentifier(config.genesis_checkpoint_id, 'genesis_checkpoint_id');
  const snapshotRef = assertIdentifier(config.snapshot_ref, 'snapshot_ref');
  const activatedAt = assertTimestamp(config.activated_at, 'activated_at');
  const bindings = config.actor_bindings.map(assertRoomActorBinding);
  const bindingResult = assertOriginalActorBindingBijection(bindings, {
    lineage_id: origin.lineage_id,
    expected_members_by_seat: members
  });
  const bindingsBySeat = bindingResult.bindings_by_seat;
  for (const seat of SEATS) {
    domainInvariant(
      bindingsBySeat[seat].room_id === origin.room_id
        && bindingsBySeat[seat].genesis_checkpoint_id === checkpointId,
      'RETURN_ACTOR_BINDING_INVALID',
      'initial binding must reference this room and genesis checkpoint',
      { seat }
    );
  }
  const actorControl = Object.fromEntries(
    SEATS.map(seat => [seat, bindingsBySeat[seat].room_actor_id])
  );
  assertActorControl(actorControl, roomState, bindingsBySeat);
  const stateHash = roomCheckpointStateHash(roomState, actorControl);
  const checkpoint = assertRoomCheckpoint({
    schema: ROOM_CHECKPOINT_SCHEMA,
    checkpoint_id: checkpointId,
    room_id: origin.room_id,
    lineage_id: origin.lineage_id,
    epoch_id: epochId,
    turn_no: 0,
    kind: 'genesis',
    parent_checkpoint_id: null,
    turn_id: null,
    commit_id: null,
    state_revision: stateRevision,
    state_hash: stateHash,
    snapshot_ref: snapshotRef,
    created_at: activatedAt
  });
  const epoch = assertRoomEpoch({
    schema: ROOM_EPOCH_SCHEMA,
    epoch_id: epochId,
    room_id: origin.room_id,
    lineage_id: origin.lineage_id,
    epoch_no: 1,
    base: {
      type: 'origin_snapshot',
      ref_id: origin.origin_snapshot_id,
      state_hash: stateHash
    },
    genesis_checkpoint_id: checkpointId,
    head_checkpoint_id: checkpointId,
    state_revision: stateRevision,
    control_revision: controlRevision,
    state: 'ACTIVE',
    created_from_proposal_id: null,
    activated_at: activatedAt
  }, { origin_type: origin.origin_type });

  return assertRoomLineageState({
    schema: ROOM_LINEAGE_STATE_SCHEMA,
    origin,
    members_by_seat: members,
    actor_bindings: bindings,
    state_revision: stateRevision,
    control_revision: controlRevision,
    active_epoch_id: epochId,
    archived_checkpoint_id: null,
    epochs: [epoch],
    checkpoints: [checkpoint],
    snapshots: [{
      checkpoint_id: checkpointId,
      room_state: roomState,
      actor_control_by_seat: actorControl
    }],
    turn_records: [],
    used_proposal_ids: [],
    personal_exports: [],
    source_owner_timeline: config.source_owner_timeline ?? []
  });
}

export function commitRoomCheckpoint(lineageValue, command) {
  const lineage = assertRoomLineageState(lineageValue);
  assertPlainObject(command, 'INVALID_CHECKPOINT_COMMIT', 'checkpoint commit');
  const epoch = activeEpoch(lineage);
  domainInvariant(Boolean(epoch), 'EPOCH_ALREADY_ACTIVE', 'an ACTIVE epoch is required for commit');
  if (command.expected_state_revision !== lineage.state_revision) {
    throw new DomainError('STALE_STATE_REVISION', 'commit state revision is stale');
  }
  if (command.expected_control_revision !== lineage.control_revision) {
    throw new DomainError('STALE_CONTROL_REVISION', 'commit control revision is stale');
  }
  const checkpointId = assertIdentifier(command.checkpoint_id, 'checkpoint_id');
  const turnId = assertIdentifier(command.turn_id, 'turn_id');
  const commitId = assertIdentifier(command.commit_id, 'commit_id');
  assertUniqueId(lineage, 'checkpoint_id', checkpointId, ['checkpoints']);
  domainInvariant(
    !lineage.checkpoints.some(item => item.turn_id === turnId || item.commit_id === commitId),
    'IDEMPOTENCY_KEY_REUSED',
    'turn_id and commit_id must be unique'
  );
  const parent = checkpointFor(lineage, epoch.head_checkpoint_id);
  const nextStateRevision = lineage.state_revision + 1;
  const nextControlRevision = lineage.control_revision + 1;
  const candidateState = clone(assertMultiplayerRoomState(command.room_state));
  candidateState.meta.state_revision = nextStateRevision;
  const roomState = assertStableRoomActorIds(snapshotFor(lineage, parent.checkpoint_id).room_state, candidateState);
  const actorControl = snapshotFor(lineage, parent.checkpoint_id).actor_control_by_seat;
  const stateHash = roomCheckpointStateHash(roomState, actorControl);
  const createdAt = assertTimestamp(command.created_at, 'created_at');
  const checkpoint = assertRoomCheckpoint({
    schema: ROOM_CHECKPOINT_SCHEMA,
    checkpoint_id: checkpointId,
    room_id: lineage.origin.room_id,
    lineage_id: lineage.origin.lineage_id,
    epoch_id: epoch.epoch_id,
    turn_no: parent.turn_no + 1,
    kind: 'turn_commit',
    parent_checkpoint_id: parent.checkpoint_id,
    turn_id: turnId,
    commit_id: commitId,
    state_revision: nextStateRevision,
    state_hash: stateHash,
    snapshot_ref: assertIdentifier(command.snapshot_ref, 'snapshot_ref'),
    created_at: createdAt
  });
  const turnRecord = assertTurnRecord(command.turn_record, { turn_id: turnId });
  const nextEpoch = assertRoomEpoch({
    ...epoch,
    head_checkpoint_id: checkpointId,
    state_revision: nextStateRevision,
    control_revision: nextControlRevision
  }, { origin_type: lineage.origin.origin_type });

  return assertRoomLineageState({
    ...lineage,
    state_revision: nextStateRevision,
    control_revision: nextControlRevision,
    epochs: lineage.epochs.map(item => item.epoch_id === epoch.epoch_id ? nextEpoch : item),
    checkpoints: [...lineage.checkpoints, checkpoint],
    snapshots: [...lineage.snapshots, {
      checkpoint_id: checkpointId,
      room_state: roomState,
      actor_control_by_seat: actorControl
    }],
    turn_records: [...lineage.turn_records, {
      checkpoint_id: checkpointId,
      epoch_id: epoch.epoch_id,
      turn_no: checkpoint.turn_no,
      record: turnRecord
    }]
  });
}

export function archiveRoomLineage(lineageValue, command) {
  const lineage = assertRoomLineageState(lineageValue);
  const epoch = activeEpoch(lineage);
  domainInvariant(Boolean(epoch), 'ROOM_NOT_AT_CHECKPOINT', 'room is already archived');
  if (command.expected_control_revision !== lineage.control_revision) {
    throw new DomainError('STALE_CONTROL_REVISION', 'archive control revision is stale');
  }
  domainInvariant(
    command.safe_boundary === 'checkpoint',
    'ROOM_NOT_AT_CHECKPOINT',
    'archive is only allowed at a genesis or committed checkpoint boundary'
  );
  domainInvariant(
    command.checkpoint_id === epoch.head_checkpoint_id,
    'ROOM_NOT_AT_CHECKPOINT',
    'archive must select the active epoch head checkpoint'
  );
  checkpointFor(lineage, command.checkpoint_id);
  assertTimestamp(command.archived_at, 'archived_at');
  const nextControlRevision = lineage.control_revision + 1;
  const archivedEpoch = assertRoomEpoch({
    ...epoch,
    state: 'ARCHIVED',
    control_revision: nextControlRevision
  }, { origin_type: lineage.origin.origin_type });
  return assertRoomLineageState({
    ...lineage,
    control_revision: nextControlRevision,
    active_epoch_id: null,
    archived_checkpoint_id: command.checkpoint_id,
    epochs: lineage.epochs.map(item => item.epoch_id === epoch.epoch_id ? archivedEpoch : item)
  });
}

function assertContinuationTargetIds(lineage, command) {
  const epochId = assertIdentifier(command.new_epoch_id, 'new_epoch_id');
  const checkpointId = assertIdentifier(command.new_genesis_checkpoint_id, 'new_genesis_checkpoint_id');
  assertUniqueId(lineage, 'epoch_id', epochId, ['epochs']);
  assertUniqueId(lineage, 'checkpoint_id', checkpointId, ['checkpoints']);
  return { epochId, checkpointId };
}

function assertProposalUnused(lineage, proposalId) {
  if (lineage.used_proposal_ids.includes(proposalId)) {
    throw new DomainError('EPOCH_ALREADY_ACTIVE', 'accepted continuation proposal was already consumed', {
      proposal_id: proposalId
    });
  }
}

export function resumeArchivedCheckpoint(lineageValue, command) {
  const lineage = assertRoomLineageState(lineageValue);
  domainInvariant(lineage.active_epoch_id === null, 'EPOCH_ALREADY_ACTIVE', 'room already has an ACTIVE epoch');
  if (command.proposal.expected_control_revision !== lineage.control_revision) {
    throw new DomainError('STALE_CONTROL_REVISION', 'resume proposal control revision is stale');
  }
  const sourceCheckpoint = checkpointFor(lineage, command.proposal.checkpoint_id);
  const proposal = assertResumeRoomCheckpoint(command.proposal, {
    room_archived: true,
    expected_members_by_seat: lineage.members_by_seat,
    checkpoint: sourceCheckpoint
  });
  domainInvariant(
    proposal.room_id === lineage.origin.room_id && proposal.lineage_id === lineage.origin.lineage_id,
    'CHECKPOINT_NOT_COMMITTED',
    'resume proposal belongs to another room lineage'
  );
  assertProposalUnused(lineage, proposal.proposal_id);
  const { epochId, checkpointId } = assertContinuationTargetIds(lineage, command);
  const sourceSnapshot = snapshotFor(lineage, sourceCheckpoint.checkpoint_id);
  const nextStateRevision = lineage.state_revision + 1;
  const nextControlRevision = lineage.control_revision + 1;
  const roomStateCandidate = clone(sourceSnapshot.room_state);
  roomStateCandidate.meta.state_revision = nextStateRevision;
  const roomState = assertMultiplayerRoomState(roomStateCandidate);
  const actorControl = sourceSnapshot.actor_control_by_seat;
  const stateHash = roomCheckpointStateHash(roomState, actorControl);
  domainInvariant(
    stateHash === sourceCheckpoint.state_hash,
    'BASE_HASH_MISMATCH',
    'checkpoint resume must preserve canonical state content exactly'
  );
  const activatedAt = assertTimestamp(command.activated_at, 'activated_at');
  const checkpoint = assertRoomCheckpoint({
    schema: ROOM_CHECKPOINT_SCHEMA,
    checkpoint_id: checkpointId,
    room_id: lineage.origin.room_id,
    lineage_id: lineage.origin.lineage_id,
    epoch_id: epochId,
    turn_no: 0,
    kind: 'genesis',
    parent_checkpoint_id: null,
    turn_id: null,
    commit_id: null,
    state_revision: nextStateRevision,
    state_hash: stateHash,
    snapshot_ref: assertIdentifier(command.snapshot_ref, 'snapshot_ref'),
    created_at: activatedAt
  });
  const epoch = assertRoomEpoch({
    schema: ROOM_EPOCH_SCHEMA,
    epoch_id: epochId,
    room_id: lineage.origin.room_id,
    lineage_id: lineage.origin.lineage_id,
    epoch_no: Math.max(...lineage.epochs.map(item => item.epoch_no)) + 1,
    base: {
      type: 'room_checkpoint',
      ref_id: sourceCheckpoint.checkpoint_id,
      state_hash: sourceCheckpoint.state_hash
    },
    genesis_checkpoint_id: checkpointId,
    head_checkpoint_id: checkpointId,
    state_revision: nextStateRevision,
    control_revision: nextControlRevision,
    state: 'ACTIVE',
    created_from_proposal_id: proposal.proposal_id,
    activated_at: activatedAt
  }, { origin_type: lineage.origin.origin_type });

  return assertRoomLineageState({
    ...lineage,
    state_revision: nextStateRevision,
    control_revision: nextControlRevision,
    active_epoch_id: epochId,
    archived_checkpoint_id: null,
    epochs: [...lineage.epochs, epoch],
    checkpoints: [...lineage.checkpoints, checkpoint],
    snapshots: [...lineage.snapshots, {
      checkpoint_id: checkpointId,
      room_state: roomState,
      actor_control_by_seat: actorControl
    }],
    used_proposal_ids: [...lineage.used_proposal_ids, proposal.proposal_id]
  });
}

function emptyLike(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object') {
    if (typeof value.schema === 'string' && Array.isArray(value.entries)) {
      return { schema: value.schema, entries: [] };
    }
    return {};
  }
  return null;
}

function redactCounterpartPlayer(value) {
  if (Array.isArray(value)) return value.map(redactCounterpartPlayer);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (COUNTERPART_PRIVATE_PLAYER_KEYS.test(key)) continue;
    result[key] = redactCounterpartPlayer(child);
  }
  return result;
}

/** Project a room snapshot into the exporting member's playable state. */
export function projectPersonalRoomState(roomStateValue, exportingSeat) {
  if (!SEATS.includes(exportingSeat)) {
    throw new DomainError('INVALID_SEAT', 'exporting seat must be A or B');
  }
  const source = assertMultiplayerRoomState(roomStateValue);
  const counterpartSeat = oppositeSeat(exportingSeat);
  const projected = clone(source);
  const counterpart = projected.actors[counterpartSeat];
  counterpart.player = redactCounterpartPlayer(counterpart.player);
  counterpart.skills = emptyLike(counterpart.skills);
  counterpart.equipment = emptyLike(counterpart.equipment);
  counterpart.missions = emptyLike(counterpart.missions);
  counterpart.private_knowledge = emptyLike(counterpart.private_knowledge);
  projected.memories.canonical = emptyLike(projected.memories.canonical);
  projected.memories[`actor:${counterpartSeat}`] = emptyLike(
    projected.memories[`actor:${counterpartSeat}`]
  );
  projected.memories.npc_private = emptyLike(projected.memories.npc_private);
  projected.agent_internal = { story_plan: null, audit_state: {} };
  projected.shared_world.continuity_ledger = emptyLike(projected.shared_world.continuity_ledger);
  // Access is defined by authoritative namespaces, not by string uniqueness.
  // The same public value may legitimately also appear in a private audit or
  // memory record (for example the era label). Substring scanning would reject
  // that safe projection, while all private namespaces above are removed by
  // structure before the contract is revalidated.
  return assertMultiplayerRoomState(projected);
}

function checkpointAncestorChain(lineage, checkpointId, visiting = new Set()) {
  if (visiting.has(checkpointId)) {
    throw new DomainError('INVALID_LINEAGE_STATE', 'checkpoint ancestry contains a cycle');
  }
  visiting.add(checkpointId);
  const checkpoint = checkpointFor(lineage, checkpointId);
  const epoch = lineage.epochs.find(item => item.epoch_id === checkpoint.epoch_id);
  let prefix = [];
  if (checkpoint.parent_checkpoint_id !== null) {
    prefix = checkpointAncestorChain(lineage, checkpoint.parent_checkpoint_id, visiting);
  } else if (epoch.base.type === 'room_checkpoint') {
    prefix = checkpointAncestorChain(lineage, epoch.base.ref_id, visiting);
  }
  visiting.delete(checkpointId);
  return [...prefix, checkpoint];
}

function responseForSeat(record, seat) {
  return record.narrative_mode === 'shared'
    ? record.shared_narrative
    : record.pov_narrative_by_seat[seat];
}

function buildPersonalBranchContent(lineage, checkpoint, exportingSeat) {
  const chain = checkpointAncestorChain(lineage, checkpoint.checkpoint_id);
  const exportingUser = lineage.members_by_seat[exportingSeat];
  const counterpartSeat = oppositeSeat(exportingSeat);
  const bindingResult = assertOriginalActorBindingBijection(lineage.actor_bindings, {
    lineage_id: lineage.origin.lineage_id,
    expected_members_by_seat: lineage.members_by_seat
  });
  const bindings = bindingResult.bindings_by_seat;
  const nodes = [];
  const multiplayerRecords = [];
  let parentNodeId = null;
  for (const item of chain) {
    const snapshot = snapshotFor(lineage, item.checkpoint_id);
    const projectedState = projectPersonalRoomState(snapshot.room_state, exportingSeat);
    const nodeId = `singleplayer:${item.checkpoint_id}:${exportingSeat}`;
    if (item.kind === 'genesis') {
      nodes.push({
        node_id: nodeId,
        parent_node_id: parentNodeId,
        kind: 'genesis',
        input: null,
        response: null,
        state: projectedState
      });
    } else {
      const stored = lineage.turn_records.find(record => record.checkpoint_id === item.checkpoint_id);
      domainInvariant(Boolean(stored), 'INVALID_LINEAGE_STATE', 'committed checkpoint lacks turn record');
      nodes.push({
        node_id: nodeId,
        parent_node_id: parentNodeId,
        kind: 'turn',
        input: stored.record.action_text_by_seat[exportingSeat],
        response: responseForSeat(stored.record, exportingSeat),
        state: projectedState
      });
      multiplayerRecords.push({
        turn_id: stored.record.turn_id,
        counterpart_seat: counterpartSeat,
        counterpart_action_text: stored.record.action_text_by_seat[counterpartSeat],
        inject_to_agent: false
      });
    }
    parentNodeId = nodeId;
  }
  const projectedHead = projectPersonalRoomState(
    snapshotFor(lineage, checkpoint.checkpoint_id).room_state,
    exportingSeat
  );
  const actorBindings = SEATS.map(seat => ({
    source_entity_id: projectedHead.actors[seat].room_actor_id,
    opaque_binding_token: bindings[seat].opaque_binding_token,
    inject_to_agent: false
  }));
  const sourcePrefix = exportingUser === lineage.origin.origin_owner_user_id
    ? lineage.source_owner_timeline
    : [];
  const content = {
    schema: PERSONAL_PLAYABLE_BRANCH_SCHEMA,
    codec: 'naruto.multiplayer-to-singleplayer/v1',
    playable_state: projectedHead,
    timeline: {
      source_owner_prefix: sourcePrefix,
      nodes,
      branch_head_node_id: parentNodeId
    },
    non_agent_sidecar: {
      inject_to_agent: false,
      actor_bindings: actorBindings,
      multiplayer_records: multiplayerRecords
    }
  };
  const agentPayload = { playable_state: content.playable_state, timeline: content.timeline };
  for (const entry of actorBindings) {
    domainInvariant(
      !canonicalStringify(agentPayload).includes(entry.opaque_binding_token),
      'RETURN_ACTOR_BINDING_INVALID',
      'opaque binding token leaked into Agent-injected export content'
    );
  }
  return immutable(content);
}

export function exportPersonalSingleplayer(lineageValue, request) {
  const lineage = assertRoomLineageState(lineageValue);
  if (lineage.origin.origin_type !== 'existing_save_derived') {
    throw new DomainError(
      'PLAYABLE_EXPORT_NOT_ALLOWED',
      'new_multiplayer_save cannot produce a playable singleplayer export'
    );
  }
  const authenticatedUserId = assertIdentifier(
    request.authenticated_user_id,
    'authenticated_user_id'
  );
  const exportingSeat = seatForUser(lineage.members_by_seat, authenticatedUserId);
  if (exportingSeat === null) {
    throw new DomainError('SOURCE_OWNER_REQUIRED', 'only an original room member can export');
  }
  const checkpoint = checkpointFor(lineage, request.checkpoint_id);
  const idempotencyKey = assertIdentifier(request.idempotency_key, 'idempotency_key');
  const projectionVersion = request.projection_version
    ?? 'projection-v1';
  const outputFormat = request.output_format ?? 'timeline-json-v1';
  const requestHash = hash({
    checkpoint_id: checkpoint.checkpoint_id,
    output_format: outputFormat,
    projection_version: projectionVersion
  });
  const existing = lineage.personal_exports.find(item => (
    item.exporting_member_user_id === authenticatedUserId
      && item.idempotency_key === idempotencyKey
  ));
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REUSED',
        'export idempotency key was reused with different canonical parameters'
      );
    }
    return immutable({ lineage, manifest: existing.manifest, content: existing.content, replayed: true });
  }

  const content = buildPersonalBranchContent(lineage, checkpoint, exportingSeat);
  const outputHash = hash(content);
  const bindingBySeat = Object.fromEntries(
    lineage.actor_bindings.map(binding => [binding.original_seat, binding])
  );
  const counterpartSeat = oppositeSeat(exportingSeat);
  const manifest = assertPersonalSingleplayerExport({
    schema: PERSONAL_SINGLEPLAYER_EXPORT_SCHEMA,
    export_id: assertIdentifier(request.export_id, 'export_id'),
    room_id: lineage.origin.room_id,
    lineage_id: lineage.origin.lineage_id,
    checkpoint_id: checkpoint.checkpoint_id,
    exporting_member_user_id: authenticatedUserId,
    exporting_seat: exportingSeat,
    codec: 'naruto.multiplayer-to-singleplayer/v1',
    projection_version: projectionVersion,
    output_format: outputFormat,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    output_hash: outputHash,
    timeline_origin: authenticatedUserId === lineage.origin.origin_owner_user_id
      ? 'source_owner_branch'
      : 'guest_audience_safe_genesis',
    actor_mappings: [
      {
        room_actor_id: bindingBySeat[exportingSeat].room_actor_id,
        export_role: 'player',
        opaque_binding_token: bindingBySeat[exportingSeat].opaque_binding_token,
        inject_binding_to_agent: false
      },
      {
        room_actor_id: bindingBySeat[counterpartSeat].room_actor_id,
        export_role: 'npc_or_companion',
        opaque_binding_token: bindingBySeat[counterpartSeat].opaque_binding_token,
        inject_binding_to_agent: false
      }
    ],
    multiplayer_record_sidecar: {
      counterpart_actions_included: content.non_agent_sidecar.multiplayer_records.length > 0,
      inject_to_agent: false,
      counterpart_private_pov_included: false
    },
    created_at: assertTimestamp(request.created_at, 'created_at')
  }, {
    origin_type: lineage.origin.origin_type,
    origin_owner_user_id: lineage.origin.origin_owner_user_id,
    authenticated_user_id: authenticatedUserId,
    expected_members_by_seat: lineage.members_by_seat,
    checkpoint,
    actor_bindings: lineage.actor_bindings
  });
  const record = immutable({
    export_id: manifest.export_id,
    exporting_member_user_id: authenticatedUserId,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    manifest,
    content
  });
  const nextLineage = assertRoomLineageState({
    ...lineage,
    personal_exports: [...lineage.personal_exports, record]
  });
  return immutable({ lineage: nextLineage, manifest, content, replayed: false });
}

export function readPersonalSingleplayerExport(lineageValue, request) {
  const lineage = assertRoomLineageState(lineageValue);
  const record = lineage.personal_exports.find(item => item.export_id === request.export_id);
  if (!record || record.exporting_member_user_id !== request.authenticated_user_id) {
    throw new DomainError('EXPORT_NOT_FOUND', 'personal export is not available to this member');
  }
  return immutable({ manifest: record.manifest, content: record.content });
}

function validatePersonalBranchDocument(value) {
  assertJsonSafe(value, { maxDepth: 64, maxNodes: 300_000 });
  assertExactKeys(value, [
    'schema',
    'codec',
    'playable_state',
    'timeline',
    'non_agent_sidecar'
  ], 'GUEST_PRIVATE_DATA_FORBIDDEN', 'latest source document');
  domainInvariant(
    value.schema === PERSONAL_PLAYABLE_BRANCH_SCHEMA
      && value.codec === 'naruto.multiplayer-to-singleplayer/v1',
    'SOURCE_IMPORT_CHANGED',
    'latest source document uses an unsupported codec'
  );
  const roomState = assertMultiplayerRoomState(value.playable_state);
  assertPlainObject(value.timeline, 'SOURCE_IMPORT_CHANGED', 'latest source timeline');
  assertExactKeys(value.non_agent_sidecar, [
    'inject_to_agent',
    'actor_bindings',
    'multiplayer_records'
  ], 'RETURN_ACTOR_BINDING_INVALID', 'latest source binding sidecar');
  domainInvariant(
    value.non_agent_sidecar.inject_to_agent === false,
    'RETURN_ACTOR_BINDING_INVALID',
    'binding sidecar must remain non-Agent data'
  );
  domainInvariant(
    Array.isArray(value.non_agent_sidecar.actor_bindings)
      && value.non_agent_sidecar.actor_bindings.length === 2,
    'ROOM_ACTOR_BINDING_NOT_BIJECTIVE',
    'latest source must carry exactly two actor bindings'
  );
  const matches = value.non_agent_sidecar.actor_bindings.map((entry, index) => {
    assertExactKeys(entry, [
      'source_entity_id',
      'opaque_binding_token',
      'inject_to_agent'
    ], 'RETURN_ACTOR_BINDING_INVALID', `actor binding sidecar ${index}`);
    assertIdentifier(entry.source_entity_id, `actor_bindings.${index}.source_entity_id`);
    domainInvariant(
      typeof entry.opaque_binding_token === 'string' && entry.opaque_binding_token.length >= 16,
      'RETURN_ACTOR_BINDING_INVALID',
      'opaque binding token is malformed'
    );
    domainInvariant(
      entry.inject_to_agent === false,
      'RETURN_ACTOR_BINDING_INVALID',
      'opaque binding cannot be injected into Agent context'
    );
    return {
      source_entity_id: entry.source_entity_id,
      opaque_binding_token: entry.opaque_binding_token
    };
  });
  return { roomState, matches };
}

function collectReferenceValues(value, output = new Set(), key = '') {
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceValues(item, output, key);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectReferenceValues(child, output, childKey);
    }
  } else if (REFERENCE_KEY.test(key)) {
    if (typeof value === 'string') output.add(value);
  }
  return output;
}

function stripKnownPrivateNamespaces(value, ownerSeat, removedValues, path = '$') {
  if (Array.isArray(value)) {
    return value.map((item, index) => (
      stripKnownPrivateNamespaces(item, ownerSeat, removedValues, `${path}[${index}]`)
    ));
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PRIVATE_NAMESPACE_KEYS.has(key)) {
      removedValues.push(child);
      continue;
    }
    if (key === 'private_by_seat') {
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        throw new DomainError(
          'GUEST_PRIVATE_DATA_FORBIDDEN',
          'private_by_seat namespace is structurally invalid',
          { path: `${path}.${key}` }
        );
      }
      const guestSeat = oppositeSeat(ownerSeat);
      removedValues.push(child[guestSeat]);
      result[key] = {
        [ownerSeat]: stripKnownPrivateNamespaces(
          child[ownerSeat] ?? null,
          ownerSeat,
          removedValues,
          `${path}.${key}.${ownerSeat}`
        ),
        [guestSeat]: null
      };
      continue;
    }
    result[key] = stripKnownPrivateNamespaces(
      child,
      ownerSeat,
      removedValues,
      `${path}.${key}`
    );
  }
  return result;
}

function assertNoRemovedReferences(value, removedValues) {
  const removedRefs = new Set();
  for (const removed of removedValues) collectReferenceValues(removed, removedRefs);
  if (removedRefs.size === 0) return;
  const remainingRefs = collectReferenceValues(value);
  for (const reference of removedRefs) {
    if (remainingRefs.has(reference)) {
      throw new DomainError(
        'GUEST_PRIVATE_DATA_FORBIDDEN',
        'privacy normalization cannot safely detach a cross-namespace reference',
        { reference }
      );
    }
  }
}

/**
 * Versioned LatestSourcePrivacyNormalizer used by both the in-memory lineage
 * prototype and the production latest-source import workflow. The caller may
 * only choose the immutable source-owner seat; all fields removed here are
 * structural namespaces, never name/fuzzy-match based guesses.
 */
export function normalizeLatestSourcePrivacy(roomStateValue, {
  owner_seat,
  guest_state_slot = oppositeSeat(owner_seat)
} = {}) {
  if (!SEATS.includes(owner_seat) || !SEATS.includes(guest_state_slot)) {
    throw new DomainError(
      'SOURCE_IMPORT_CHANGED',
      'latest-source privacy normalization requires the immutable owner seat'
    );
  }
  const source = clone(assertMultiplayerRoomState(roomStateValue));
  const removedValues = [];
  let normalized = stripKnownPrivateNamespaces(source, owner_seat, removedValues);
  removedValues.push(normalized.actors[guest_state_slot].private_knowledge);
  normalized.actors[guest_state_slot].private_knowledge = emptyLike(
    normalized.actors[guest_state_slot].private_knowledge
  );
  removedValues.push(normalized.memories[`actor:${guest_state_slot}`]);
  normalized.memories[`actor:${guest_state_slot}`] = emptyLike(
    normalized.memories[`actor:${guest_state_slot}`]
  );
  removedValues.push(normalized.memories.canonical);
  normalized.memories.canonical = emptyLike(normalized.memories.canonical);
  removedValues.push(normalized.memories.npc_private);
  normalized.memories.npc_private = emptyLike(normalized.memories.npc_private);
  removedValues.push(normalized.agent_internal);
  normalized.agent_internal = { story_plan: null, audit_state: {} };
  assertNoRemovedReferences(normalized, removedValues);
  return immutable(assertMultiplayerRoomState(normalized));
}

function replaceActorReferences(value, replacements, key = '') {
  if (Array.isArray(value)) return value.map(item => replaceActorReferences(item, replacements, key));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /(?:^|_)actor_id$/u.test(key) && replacements.has(value)) {
      return replacements.get(value);
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      replaceActorReferences(child, replacements, childKey)
    ])
  );
}

/**
 * Deterministically strips the known guest/NPC-private partitions, then
 * rebinds exactly the two signed entities to their original seats. It never
 * reads or merges an archived checkpoint.
 */
export function prepareLatestSourceBasis(lineageValue, sourceDocument, options = {}) {
  const lineage = assertRoomLineageState(lineageValue);
  if (lineage.origin.origin_type !== 'existing_save_derived') {
    throw new DomainError(
      'CONTINUATION_MODE_NOT_ALLOWED',
      'new_multiplayer_save cannot use a latest source save'
    );
  }
  const authenticatedUserId = options.authenticated_user_id;
  if (authenticatedUserId !== lineage.origin.origin_owner_user_id) {
    throw new DomainError('SOURCE_OWNER_REQUIRED', 'only the immutable origin owner may upload latest source');
  }
  const ownerSeat = seatForUser(lineage.members_by_seat, lineage.origin.origin_owner_user_id);
  const guestSeat = oppositeSeat(ownerSeat);
  const { roomState: sourceRoomState, matches } = validatePersonalBranchDocument(sourceDocument);
  const bijection = assertOriginalActorBindingBijection(lineage.actor_bindings, {
    lineage_id: lineage.origin.lineage_id,
    expected_members_by_seat: lineage.members_by_seat,
    source_actor_matches: matches,
    verify_binding_token: options.verify_binding_token
  });
  const sourceSeatByEntity = new Map();
  for (const seat of SEATS) {
    sourceSeatByEntity.set(sourceRoomState.actors[seat].room_actor_id, seat);
  }
  for (const seat of SEATS) {
    const sourceEntityId = bijection.source_entity_by_seat[seat];
    if (!sourceSeatByEntity.has(sourceEntityId)) {
      throw new DomainError('RETURN_ACTOR_NOT_FOUND', 'bound latest-source actor is absent from playable state', {
        seat,
        source_entity_id: sourceEntityId
      });
    }
  }

  const guestSourceSlot = sourceSeatByEntity.get(bijection.source_entity_by_seat[guestSeat]);
  let normalized = normalizeLatestSourcePrivacy(sourceRoomState, {
    owner_seat: ownerSeat,
    guest_state_slot: guestSourceSlot
  });
  const normalizedSourceHash = hash(roomStateContent(normalized));

  const actorByOriginalSeat = {};
  const sourceMemoryByOriginalSeat = {};
  const replacements = new Map();
  const rebindEntries = [];
  for (const seat of SEATS) {
    const sourceEntityId = bijection.source_entity_by_seat[seat];
    const sourceSlot = sourceSeatByEntity.get(sourceEntityId);
    const binding = bijection.bindings_by_seat[seat];
    actorByOriginalSeat[seat] = clone(normalized.actors[sourceSlot]);
    actorByOriginalSeat[seat].room_actor_id = binding.room_actor_id;
    sourceMemoryByOriginalSeat[seat] = clone(normalized.memories[`actor:${sourceSlot}`]);
    replacements.set(sourceEntityId, binding.room_actor_id);
    rebindEntries.push({
      original_seat: seat,
      source_entity_id: sourceEntityId,
      room_actor_id: binding.room_actor_id
    });
  }
  const targetRevision = options.target_state_revision ?? (lineage.state_revision + 1);
  assertSafeRevision(targetRevision, 'target_state_revision');
  domainInvariant(
    targetRevision > lineage.state_revision,
    'STALE_STATE_REVISION',
    'latest-source genesis must allocate a new monotonic state revision'
  );
  let rebound = clone(normalized);
  rebound.actors = actorByOriginalSeat;
  rebound.memories['actor:A'] = sourceMemoryByOriginalSeat.A;
  rebound.memories['actor:B'] = sourceMemoryByOriginalSeat.B;
  rebound.meta.state_revision = targetRevision;
  rebound = replaceActorReferences(rebound, replacements);
  rebound = assertMultiplayerRoomState(rebound);
  const actorControl = Object.fromEntries(
    SEATS.map(seat => [seat, bijection.bindings_by_seat[seat].room_actor_id])
  );
  const rebindDiff = immutable({
    schema: 'naruto.multiplayer-control-rebind-diff/v1',
    actor_rebinds: rebindEntries,
    from_state_revision: sourceRoomState.meta.state_revision,
    to_state_revision: targetRevision
  });
  return immutable({
    privacy_normalizer_version: LATEST_SOURCE_PRIVACY_NORMALIZER_VERSION,
    raw_source_hash: hash(sourceDocument),
    normalized_source_hash: normalizedSourceHash,
    normalization_and_rebind_diff_hash: hash(rebindDiff),
    genesis_state_hash: roomCheckpointStateHash(rebound, actorControl),
    normalized_room_state: normalized,
    genesis_room_state: rebound,
    actor_control_by_seat: actorControl,
    source_actor_matches: matches,
    rebind_diff: rebindDiff
  });
}

export function forkArchivedFromLatestSource(lineageValue, command) {
  const lineage = assertRoomLineageState(lineageValue);
  domainInvariant(lineage.active_epoch_id === null, 'EPOCH_ALREADY_ACTIVE', 'room already has an ACTIVE epoch');
  if (command.proposal.expected_control_revision !== lineage.control_revision) {
    throw new DomainError('STALE_CONTROL_REVISION', 'latest-source proposal control revision is stale');
  }
  const sourceImport = assertSourceImport(command.source_import, {
    authenticated_user_id: command.authenticated_user_id,
    origin_owner_user_id: lineage.origin.origin_owner_user_id
  });
  if (sourceImport.derived_from_export_id !== null) {
    const derivedExport = lineage.personal_exports.find(record => (
      record.export_id === sourceImport.derived_from_export_id
    ));
    if (!derivedExport
      || derivedExport.exporting_member_user_id !== lineage.origin.origin_owner_user_id) {
      throw new DomainError(
        'SOURCE_OWNER_REQUIRED',
        'a guest personal export cannot become the original Room latest source'
      );
    }
  }
  const basis = prepareLatestSourceBasis(lineage, command.source_document, {
    authenticated_user_id: command.authenticated_user_id,
    verify_binding_token: command.verify_binding_token,
    target_state_revision: lineage.state_revision + 1
  });
  const hashChecks = [
    ['raw_source_hash', basis.raw_source_hash],
    ['normalized_source_hash', basis.normalized_source_hash],
    ['normalization_and_rebind_diff_hash', basis.normalization_and_rebind_diff_hash],
    ['genesis_state_hash', basis.genesis_state_hash]
  ];
  for (const [field, expected] of hashChecks) {
    if (sourceImport[field] !== expected) {
      throw new DomainError('SOURCE_IMPORT_CHANGED', `source import ${field} no longer matches`, { field });
    }
  }
  if (sourceImport.privacy_normalizer_version !== LATEST_SOURCE_PRIVACY_NORMALIZER_VERSION) {
    throw new DomainError('SOURCE_IMPORT_CHANGED', 'privacy normalizer version changed');
  }
  const proposal = assertForkFromLatestSourceSave(command.proposal, {
    origin_type: lineage.origin.origin_type,
    origin_owner_user_id: lineage.origin.origin_owner_user_id,
    authenticated_user_id: command.authenticated_user_id,
    room_archived: true,
    expected_members_by_seat: lineage.members_by_seat,
    source_import: sourceImport,
    actor_bindings: lineage.actor_bindings,
    source_actor_matches: basis.source_actor_matches,
    verify_binding_token: command.verify_binding_token
  });
  domainInvariant(
    proposal.room_id === lineage.origin.room_id && proposal.lineage_id === lineage.origin.lineage_id,
    'SOURCE_IMPORT_CHANGED',
    'latest-source proposal belongs to another room lineage'
  );
  assertProposalUnused(lineage, proposal.proposal_id);
  const { epochId, checkpointId } = assertContinuationTargetIds(lineage, command);
  const nextStateRevision = lineage.state_revision + 1;
  const nextControlRevision = lineage.control_revision + 1;
  const activatedAt = assertTimestamp(command.activated_at, 'activated_at');
  const checkpoint = assertRoomCheckpoint({
    schema: ROOM_CHECKPOINT_SCHEMA,
    checkpoint_id: checkpointId,
    room_id: lineage.origin.room_id,
    lineage_id: lineage.origin.lineage_id,
    epoch_id: epochId,
    turn_no: 0,
    kind: 'genesis',
    parent_checkpoint_id: null,
    turn_id: null,
    commit_id: null,
    state_revision: nextStateRevision,
    state_hash: basis.genesis_state_hash,
    snapshot_ref: assertIdentifier(command.snapshot_ref, 'snapshot_ref'),
    created_at: activatedAt
  });
  const epoch = assertRoomEpoch({
    schema: ROOM_EPOCH_SCHEMA,
    epoch_id: epochId,
    room_id: lineage.origin.room_id,
    lineage_id: lineage.origin.lineage_id,
    epoch_no: Math.max(...lineage.epochs.map(item => item.epoch_no)) + 1,
    base: {
      type: 'latest_source_import',
      ref_id: sourceImport.source_import_id,
      state_hash: basis.genesis_state_hash
    },
    genesis_checkpoint_id: checkpointId,
    head_checkpoint_id: checkpointId,
    state_revision: nextStateRevision,
    control_revision: nextControlRevision,
    state: 'ACTIVE',
    created_from_proposal_id: proposal.proposal_id,
    activated_at: activatedAt
  }, { origin_type: lineage.origin.origin_type });
  return assertRoomLineageState({
    ...lineage,
    state_revision: nextStateRevision,
    control_revision: nextControlRevision,
    active_epoch_id: epochId,
    archived_checkpoint_id: null,
    epochs: [...lineage.epochs, epoch],
    checkpoints: [...lineage.checkpoints, checkpoint],
    snapshots: [...lineage.snapshots, {
      checkpoint_id: checkpointId,
      room_state: basis.genesis_room_state,
      actor_control_by_seat: basis.actor_control_by_seat
    }],
    used_proposal_ids: [...lineage.used_proposal_ids, proposal.proposal_id],
    source_owner_timeline: command.source_document.timeline
  });
}
