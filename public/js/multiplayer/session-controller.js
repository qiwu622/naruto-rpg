import { MultiplayerApiClient, MultiplayerApiError } from './api-client.js';
import {
  ACTION_VISIBILITIES,
  CREDENTIAL_USAGE_POLICIES,
  GUEST_CHARACTER_IMPORT_SCHEMA,
  NARRATION_PREFERENCES,
  NARRATIVE_MODES,
  ROOM_ORIGIN_TYPES,
  assertPathIdentifier,
  createIdempotencyKey
} from './contracts.js';
import { MultiplayerRoomEventStream } from './room-event-stream.js';
import { MultiplayerRoomStore } from './room-store.js';
import {
  actionSubmissionUnavailableMessage,
  canSubmitProjectedAction,
  isGeneratingTurnStatus
} from './ui-projection.js';
import {
  LATEST_SOURCE_SAVE_IMPORT_KIND,
  MULTIPLAYER_TO_SINGLEPLAYER_CODEC,
  PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA,
  normalizeLatestSourceSaveImportCandidate,
  resolveLatestSourceContinuationBinding
} from './latest-source-import.js';

const SAVE_IMPORT_FIELDS = Object.freeze([
  'source_save_id',
  'client_save_instance_id',
  'source_branch_id',
  'source_node_id',
  'cloud_revision',
  'state',
  'source_timeline',
  'idempotency_key'
]);
const GUEST_CHARACTER_FIELDS = Object.freeze(['schema', 'state_snapshot']);

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const unsupported = Object.keys(value).filter(key => !fields.includes(key));
  if (unsupported.length > 0) {
    throw new TypeError(`${label} contains unsupported fields: ${unsupported.join(', ')}`);
  }
  return Object.fromEntries(fields
    .filter(field => Object.prototype.hasOwnProperty.call(value, field))
    .map(field => [field, value[field]]));
}

export function normalizeSaveImportCandidate(candidate) {
  const source = candidate?.request ?? candidate;
  const request = exactFields(source, SAVE_IMPORT_FIELDS, 'save import candidate');
  for (const field of [
    'source_save_id',
    'client_save_instance_id',
    'source_branch_id',
    'source_node_id',
    'state'
  ]) {
    if (!Object.prototype.hasOwnProperty.call(request, field)) {
      throw new TypeError(`save import candidate is missing ${field}`);
    }
  }
  return Object.freeze({
    ...request,
    idempotency_key: request.idempotency_key ?? createIdempotencyKey('save-import')
  });
}

/**
 * Normalizes the one-way guest character envelope used by the existing Room
 * join route. The nested single-player snapshot stays opaque to the browser;
 * the authoritative server codec imports only the permitted actor fields.
 */
export function normalizeGuestCharacterCandidate(candidate) {
  const source = candidate?.request?.guest_character
    ?? candidate?.guest_character
    ?? candidate?.request
    ?? candidate;
  const request = exactFields(source, GUEST_CHARACTER_FIELDS, 'guest character candidate');
  for (const field of GUEST_CHARACTER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(request, field)) {
      throw new TypeError(`guest character candidate is missing ${field}`);
    }
  }
  if (request.schema !== GUEST_CHARACTER_IMPORT_SCHEMA) {
    throw new TypeError(`guest character schema must be ${GUEST_CHARACTER_IMPORT_SCHEMA}`);
  }
  if (!request.state_snapshot
    || typeof request.state_snapshot !== 'object'
    || Array.isArray(request.state_snapshot)) {
    throw new TypeError('guest character state_snapshot must be an object');
  }
  return Object.freeze({
    schema: GUEST_CHARACTER_IMPORT_SCHEMA,
    state_snapshot: request.state_snapshot
  });
}

function importId(result) {
  const value = result?.source_import_id
    ?? result?.import_id
    ?? result?.import?.source_import_id
    ?? result?.import?.import_id
    ?? result?.save_import?.source_import_id
    ?? result?.save_import?.import_id;
  if (typeof value !== 'string') {
    throw new MultiplayerApiError({
      code: 'SAVE_IMPORT_RESPONSE_INVALID',
      message: '服务端没有返回可用于建房的不可变导入 ID',
      status: 500
    });
  }
  return value;
}

function roomValue(result) {
  return result?.room ?? result;
}

export function unwrapProfile(result) {
  return result?.profile ?? result;
}

function selectionRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function roomCreationCodes({ roomCode = '', inviteCode = '' } = {}) {
  const room = String(roomCode ?? '').trim().toUpperCase();
  const invite = String(inviteCode ?? '').trim();
  return Object.freeze({
    ...(room ? { room_code: room } : {}),
    ...(invite ? { invite_code: invite } : {})
  });
}

/**
 * Reconstruct the active turn route from member-safe Room/Lineage projections.
 * This is what makes an already joined room recoverable from its Room ID alone:
 * the browser never needs to retain a turn body, chat page or sidecar locally.
 */
export function deriveActiveTurnContext(room, lineage, previous = null) {
  const activeEpochId = room?.active_epoch_id ?? lineage?.active_epoch_id ?? null;
  if (typeof activeEpochId !== 'string' || !activeEpochId) return null;
  const epoch = lineage?.epochs?.find(candidate => candidate?.epoch_id === activeEpochId);
  const epochNo = positiveInteger(epoch?.epoch_no)
    ?? (previous?.epochId === activeEpochId ? positiveInteger(previous?.epochNo) : null);
  const currentTurnId = typeof room?.current_turn_id === 'string' && room.current_turn_id
    ? room.current_turn_id
    : null;
  if (!currentTurnId) {
    return Object.freeze({ epochId: activeEpochId, epochNo, turnId: null, turnNo: null });
  }

  let turnNo = positiveInteger(room?.current_turn_no);
  if (turnNo === null && previous?.turnId === currentTurnId) {
    turnNo = positiveInteger(previous.turnNo);
  }
  const checkpoints = Array.isArray(lineage?.checkpoints)
    ? lineage.checkpoints.filter(checkpoint => checkpoint?.epoch_id === activeEpochId)
    : [];
  if (turnNo === null) {
    turnNo = positiveInteger(checkpoints.find(checkpoint => (
      checkpoint?.turn_id === currentTurnId
    ))?.turn_no);
  }
  if (turnNo === null) {
    const headTurnNo = checkpoints.reduce((maximum, checkpoint) => (
      Math.max(maximum, positiveInteger(checkpoint?.turn_no) ?? 0)
    ), 0);
    turnNo = headTurnNo + 1;
  }
  return Object.freeze({
    epochId: activeEpochId,
    epochNo,
    turnId: currentTurnId,
    turnNo
  });
}

/**
 * Orchestrates browser transport only. Canonical resolution, reducers,
 * memory/daily updates and commit recovery remain exclusively on the server.
 */
export class MultiplayerSessionController {
  constructor({
    apiClient = new MultiplayerApiClient(),
    store = new MultiplayerRoomStore(),
    eventStreamFactory = options => new MultiplayerRoomEventStream(options),
    eventStreamOptions = {},
    committedRetryDelayMs = 500,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis)
  } = {}) {
    if (!apiClient || typeof apiClient.getRoom !== 'function') {
      throw new TypeError('a multiplayer API client is required');
    }
    if (!store || typeof store.patch !== 'function' || typeof store.applyEvent !== 'function') {
      throw new TypeError('a multiplayer projection store is required');
    }
    if (typeof eventStreamFactory !== 'function') {
      throw new TypeError('eventStreamFactory must be a function');
    }
    this.api = apiClient;
    this.store = store;
    this.eventStreamFactory = eventStreamFactory;
    this.eventStreamOptions = eventStreamOptions;
    this.stream = null;
    this.streamUnsubscribers = [];
    this.roomGeneration = 0;
    this.pendingRefreshes = new Set();
    this.refreshScheduled = false;
    this._latestSourceRequestBinding = null;
    this._nextTurnInFlight = null;
    this._pendingCommittedTurnId = null;
    this._committedRetryTimer = null;
    this._progressRefreshTimer = null;
    this._committedRetryDelayMs = committedRetryDelayMs;
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
  }

  subscribe(listener, options) {
    return this.store.subscribe(listener, options);
  }

  get state() {
    return this.store.state;
  }

  async connectRoom(roomId, context = {}) {
    const roomLocator = String(roomId ?? '').trim();
    if (roomLocator === '') throw new TypeError('请输入房间号');
    this.disconnect({ reset: true });
    const generation = ++this.roomGeneration;
    this.store.patch({ roomId: roomLocator, lastError: null });
    try {
      if (context.epochNo || context.turnNo || context.epochId || context.turnId) {
        this.store.setTurnContext(context);
      }
      const room = await this.api.getRoom(roomLocator);
      if (generation !== this.roomGeneration) return this.state;
      const resolvedRoomId = assertPathIdentifier(roomValue(room)?.room_id, 'roomId');
      this.store.setRoom(room);

      this.stream = this.eventStreamFactory({
        apiClient: this.api,
        ...this.eventStreamOptions
      });
      this.streamUnsubscribers = [
        this.stream.on('status', status => {
          if (generation === this.roomGeneration) this.store.setConnection(status);
        }),
        this.stream.on('event', event => {
          if (generation !== this.roomGeneration) return;
          if (this.store.applyEvent(event)) this._handleRoomEvent(event);
        }),
        this.stream.on('protocol-error', error => {
          if (generation !== this.roomGeneration) return;
          this.store.setError({ code: 'SSE_PROTOCOL_ERROR', message: error.message });
        })
      ];
      this.stream.start(resolvedRoomId);
      const lineage = await this.api.getLineage(resolvedRoomId);
      if (generation !== this.roomGeneration) return this.state;
      this.store.setLineage(lineage);
      this._syncActiveTurnContext();
      this._resolveEpochNumber();
      await this._recoverLatestCommittedProjection();
      await Promise.allSettled([
        this.refreshProfiles(),
        this.refreshCredentials(),
        this.refreshChat({ replace: true }),
        this.refreshTurn({ silent: true })
      ]);
      if (this.state.turn?.status === 'COMMITTED') {
        await this._advanceCommittedTurn(this.state.turn.turn_id);
      }
      this._scheduleProgressRefresh(generation);
      return this.state;
    } catch (error) {
      if (generation === this.roomGeneration) {
        this.disconnect({ reset: true });
        this.store.setError(error);
      }
      throw error;
    }
  }

  disconnect({ reset = false } = {}) {
    this.roomGeneration += 1;
    this.pendingRefreshes.clear();
    this.refreshScheduled = false;
    this._latestSourceRequestBinding = null;
    this._nextTurnInFlight = null;
    this._pendingCommittedTurnId = null;
    if (this._committedRetryTimer !== null) this._clearTimeout?.(this._committedRetryTimer);
    this._committedRetryTimer = null;
    if (this._progressRefreshTimer !== null) this._clearTimeout?.(this._progressRefreshTimer);
    this._progressRefreshTimer = null;
    this.streamUnsubscribers.forEach(unsubscribe => unsubscribe?.());
    this.streamUnsubscribers = [];
    this.stream?.stop?.({ preserveListeners: false });
    this.stream = null;
    if (reset) this.store.reset();
  }

  _scheduleProgressRefresh(generation) {
    if (generation !== this.roomGeneration || !this.state.roomId || !this._setTimeout) return;
    this._progressRefreshTimer = this._setTimeout(async () => {
      this._progressRefreshTimer = null;
      if (generation !== this.roomGeneration) return;
      try {
        if (isGeneratingTurnStatus(this.state.turn?.status)) await this.refreshTurn({ silent: true });
      } catch {
        // Keep the last verified state. Its heartbeat expires visibly in the UI.
      } finally {
        this._scheduleProgressRefresh(generation);
      }
    }, 10_000);
    this._progressRefreshTimer?.unref?.();
  }

  _requireRoom() {
    const roomId = this.state.roomId;
    if (!roomId) throw new TypeError('connect to a multiplayer room first');
    return roomId;
  }

  _requireTurn() {
    const roomId = this._requireRoom();
    const context = this.state.turnContext;
    if (!context
      || !Number.isSafeInteger(context.epochNo)
      || !Number.isSafeInteger(context.turnNo)) {
      throw new TypeError('the authoritative epoch/turn context is not available yet');
    }
    return { roomId, ...context };
  }

  _resolveEpochNumber() {
    const context = this.state.turnContext;
    if (!context?.epochId || context.epochNo) return;
    const epoch = this.state.lineage?.epochs?.find(item => item.epoch_id === context.epochId);
    if (epoch) this.store.setTurnContext({ ...context, epochNo: epoch.epoch_no });
  }

  _syncActiveTurnContext() {
    const context = deriveActiveTurnContext(
      this.state.room,
      this.state.lineage,
      this.state.turnContext
    );
    if (context) this.store.setTurnContext(context);
  }

  _handleRoomEvent(event) {
    if (event.epoch_id && !this.state.turnContext?.epochId) {
      this.store.setTurnContext({ epochId: event.epoch_id });
    }
    this._resolveEpochNumber();
    const type = event.event_type;
    if (type === 'chat.message_created') return;
    if (type === 'turn.opened') {
      this._queueRefresh('lineage');
      this._queueRefresh('turn');
      return;
    }
    if (type.startsWith('action.')
      || type.startsWith('turn.')
      || type === 'resolution.progress') {
      this._queueRefresh('turn');
    }
    if (type.startsWith('billing.')) this._queueRefresh('billing');
    if (type === 'billing.payer_selection_changed') this._queueRefresh('turn');
    if (type === 'billing.credential_policy_changed') {
      this._queueRefresh('room');
      this._queueRefresh('turn');
    }
    if (type.startsWith('room.')
      || type.startsWith('member.')
      || type.startsWith('narrative_mode.')) {
      this._queueRefresh('room');
    }
    if (type === 'turn.committed'
      || type === 'room.archived'
      || type === 'room.epoch_activated'
      || type === 'room.continuation_prepared') {
      this._queueRefresh('lineage');
    }
    if (type === 'turn.committed') {
      const turnId = event.turn_id ?? event.payload?.turn_id ?? null;
      this._pendingCommittedTurnId = typeof turnId === 'string' && turnId
        ? Object.freeze({
            turnId,
            epochNo: positiveInteger(event.payload?.epoch_no)
              ?? positiveInteger(this.state.turnContext?.epochNo),
            turnNo: positiveInteger(event.payload?.turn_no)
              ?? positiveInteger(this.state.turn?.turn_no)
              ?? positiveInteger(this.state.turnContext?.turnNo)
          })
        : null;
      this._queueRefresh('advance-turn');
    }
    if (type.startsWith('lineage.')) {
      this._queueRefresh('room');
      this._queueRefresh('lineage');
    }
  }

  _queueRefresh(kind) {
    this.pendingRefreshes.add(kind);
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    queueMicrotask(async () => {
      this.refreshScheduled = false;
      const pending = [...this.pendingRefreshes];
      this.pendingRefreshes.clear();
      for (const item of pending) {
        try {
          if (item === 'room') await this.refreshRoom();
          if (item === 'lineage') await this.refreshLineage();
          if (item === 'turn') await this.refreshTurn({ silent: true });
          if (item === 'billing') await this.refreshBillingPlan({ silent: true });
          if (item === 'advance-turn' && this._pendingCommittedTurnId) {
            const pending = this._pendingCommittedTurnId;
            await this._advanceCommittedTurn(pending);
            if (this._pendingCommittedTurnId === pending) {
              this._pendingCommittedTurnId = null;
            }
          }
        } catch (error) {
          this.store.setError(error);
          if (item === 'advance-turn') this._scheduleCommittedTurnRetry();
        }
      }
    });
  }

  async refreshRoom() {
    const roomId = this._requireRoom();
    const generation = this.roomGeneration;
    const room = await this.api.getRoom(roomId);
    if (generation === this.roomGeneration && roomId === this.state.roomId) {
      this.store.setRoom(room);
      this._syncActiveTurnContext();
    }
    return room;
  }

  async refreshLineage() {
    const roomId = this._requireRoom();
    const generation = this.roomGeneration;
    const lineage = await this.api.getLineage(roomId);
    if (generation === this.roomGeneration && roomId === this.state.roomId) {
      this.store.setLineage(lineage);
      this._syncActiveTurnContext();
      this._resolveEpochNumber();
    }
    return lineage;
  }

  async refreshTurn({ silent = false } = {}) {
    let context;
    try {
      context = this._requireTurn();
    } catch (error) {
      if (silent) return null;
      throw error;
    }
    const generation = this.roomGeneration;
    const turn = await this.api.getTurn(context.roomId, context.epochNo, context.turnNo);
    if (generation === this.roomGeneration) this.store.setTurn(turn);
    return turn;
  }

  _scheduleCommittedTurnRetry() {
    if (!this._pendingCommittedTurnId || this._committedRetryTimer !== null
      || typeof this._setTimeout !== 'function') return;
    const generation = this.roomGeneration;
    this._committedRetryTimer = this._setTimeout(() => {
      this._committedRetryTimer = null;
      if (generation === this.roomGeneration && this._pendingCommittedTurnId) {
        this._queueRefresh('advance-turn');
      }
    }, this._committedRetryDelayMs);
  }

  async _recoverLatestCommittedProjection() {
    const roomId = this.state.roomId;
    const currentTurnId = this.state.room?.current_turn_id;
    const epochId = this.state.room?.active_epoch_id ?? this.state.lineage?.active_epoch_id;
    const epochNo = positiveInteger(this.state.lineage?.epochs?.find(epoch => (
      epoch?.epoch_id === epochId
    ))?.epoch_no);
    if (!roomId || !currentTurnId || !epochId || epochNo === null) return null;
    const latest = (this.state.lineage?.checkpoints ?? [])
      .filter(checkpoint => (
        checkpoint?.epoch_id === epochId
          && typeof checkpoint?.turn_id === 'string'
          && checkpoint.turn_id !== currentTurnId
          && positiveInteger(checkpoint.turn_no) !== null
      ))
      .sort((left, right) => right.turn_no - left.turn_no)[0];
    if (!latest) return null;
    const committed = await this.api.getTurn(roomId, epochNo, latest.turn_no);
    if (committed?.turn_id !== latest.turn_id || committed?.status !== 'COMMITTED') {
      throw new MultiplayerApiError({
        code: 'COMMITTED_TURN_PROJECTION_INVALID',
        message: '服务端未返回最近已提交回合的正式正文',
        status: 409
      });
    }
    this.store.setTurn(committed);
    this._syncActiveTurnContext();
    this._resolveEpochNumber();
    return committed;
  }

  async refreshBillingPlan({ silent = false } = {}) {
    let context;
    try {
      context = this._requireTurn();
    } catch (error) {
      if (silent) return null;
      throw error;
    }
    try {
      const plan = await this.api.getBillingPlan(context.roomId, context.epochNo, context.turnNo);
      this.store.setBillingPlan(plan);
      return plan;
    } catch (error) {
      if (silent && [404, 409].includes(error?.status)) return null;
      throw error;
    }
  }

  async _advanceCommittedTurn(pendingValue) {
    const pending = typeof pendingValue === 'string'
      ? {
          turnId: pendingValue,
          epochNo: positiveInteger(this.state.turnContext?.epochNo),
          turnNo: positiveInteger(this.state.turn?.turn_no)
            ?? positiveInteger(this.state.turnContext?.turnNo)
        }
      : pendingValue;
    const previousTurnId = pending?.turnId;
    if (typeof previousTurnId !== 'string'
      || !previousTurnId
      || positiveInteger(pending?.epochNo) === null
      || positiveInteger(pending?.turnNo) === null
      || this.state.room?.lifecycle !== 'ACTIVE'
      || typeof this.api.openNextTurn !== 'function') {
      return null;
    }
    if (this._nextTurnInFlight?.previousTurnId === previousTurnId) {
      return this._nextTurnInFlight.promise;
    }
    const roomId = this._requireRoom();
    const generation = this.roomGeneration;
    const promise = (async () => {
      const committed = await this.api.getTurn(
        roomId,
        pending.epochNo,
        pending.turnNo
      );
      if (committed?.turn_id !== previousTurnId || committed?.status !== 'COMMITTED') {
        throw new MultiplayerApiError({
          code: 'COMMITTED_TURN_PROJECTION_INVALID',
          message: '正式正文尚未可读取，暂不进入下一回合',
          status: 409
        });
      }
      if (generation !== this.roomGeneration || roomId !== this.state.roomId) return null;
      this.store.setTurn(committed);
      const result = await this.api.openNextTurn(roomId, previousTurnId);
      if (generation !== this.roomGeneration || roomId !== this.state.roomId) return result;
      const [room, lineage] = await Promise.all([
        this.api.getRoom(roomId),
        this.api.getLineage(roomId)
      ]);
      if (generation !== this.roomGeneration || roomId !== this.state.roomId) return result;
      this.store.setRoom(room);
      this.store.setLineage(lineage);
      this._syncActiveTurnContext();
      this._resolveEpochNumber();
      await this.refreshTurn({ silent: true });
      return result;
    })();
    this._nextTurnInFlight = { previousTurnId, promise };
    try {
      return await promise;
    } finally {
      if (this._nextTurnInFlight?.promise === promise) this._nextTurnInFlight = null;
    }
  }

  async refreshProfiles() {
    const value = await this.api.listModelEndpointProfiles({ includeRevoked: false });
    this.store.setProfiles(value);
    return value;
  }

  async refreshCredentials() {
    const value = await this.api.listModelCredentials({ includeRevoked: false });
    this.store.setCredentials(value);
    return value;
  }

  async refreshChat({ replace = false, before = null } = {}) {
    const roomId = this._requireRoom();
    const value = await this.api.listChatMessages(roomId, { before, limit: 50 });
    this.store.setChatPage(value, { replace });
    return value;
  }

  loadOlderChat() {
    const before = this.state.chat.nextBefore;
    return before ? this.refreshChat({ before }) : Promise.resolve(null);
  }

  _latestSourceStagedContext() {
    const staged = this.state.latestSourceImport;
    if (!this._latestSourceRequestBinding) return staged;
    return Object.freeze({
      ...(staged ?? {}),
      client_source_binding: this._latestSourceRequestBinding.source
    });
  }

  normalizeLatestSourceCandidate(candidate) {
    return normalizeLatestSourceSaveImportCandidate(candidate, {
      lineage: this.state.lineage,
      staged: this._latestSourceStagedContext()
    });
  }

  async stageSaveImport(candidate) {
    const source = candidate?.request ?? candidate;
    const latestSource = source?.import_kind === LATEST_SOURCE_SAVE_IMPORT_KIND
      || Object.prototype.hasOwnProperty.call(source ?? {}, 'source_document')
      || (source?.schema === PERSONAL_SINGLEPLAYER_TIMELINE_SCHEMA
        && source?.codec === MULTIPLAYER_TO_SINGLEPLAYER_CODEC);
    const request = latestSource
      ? this.normalizeLatestSourceCandidate(candidate)
      : normalizeSaveImportCandidate(candidate);
    const value = await this.api.createSaveImport(request);
    if (latestSource) {
      this._latestSourceRequestBinding = Object.freeze({
        source_import_id: importId(value),
        proposal_id: request.proposal_id,
        proposal_revision: request.proposal_revision,
        source: Object.freeze({
          derived_from_export_id: request.source_document.multiplayer_export.export_id,
          source_save_id: request.source_save_id,
          client_save_instance_id: request.client_save_instance_id,
          source_branch_id: request.source_branch_id,
          source_node_id: request.source_node_id,
          cloud_revision: request.cloud_revision
        })
      });
    }
    this.store.patch({ latestSourceImport: value });
    return value;
  }

  async createExistingSaveRoom(candidate, {
    narrativeMode = 'shared',
    roomCode = '',
    inviteCode = ''
  } = {}) {
    if (!NARRATIVE_MODES.includes(narrativeMode)) throw new TypeError('invalid narrative mode');
    const staged = await this.stageSaveImport(candidate);
    const result = await this.api.createRoom({
      origin_type: 'existing_save_derived',
      source_import_id: importId(staged),
      default_narrative_mode: narrativeMode,
      ...roomCreationCodes({ roomCode, inviteCode })
    });
    await this.connectRoom(roomValue(result).room_id);
    this.store.patch({ invite: result.invite ?? null, genesis: result.genesis ?? null });
    return result;
  }

  async createNewMultiplayerRoom(newWorldProfile, {
    narrativeMode = 'shared',
    roomCode = '',
    inviteCode = ''
  } = {}) {
    if (!NARRATIVE_MODES.includes(narrativeMode)) throw new TypeError('invalid narrative mode');
    const result = await this.api.createRoom({
      origin_type: 'new_multiplayer_save',
      new_world_profile: newWorldProfile,
      default_narrative_mode: narrativeMode,
      ...roomCreationCodes({ roomCode, inviteCode })
    });
    await this.connectRoom(roomValue(result).room_id);
    this.store.patch({ invite: result.invite ?? null, genesis: result.genesis ?? null });
    return result;
  }

  async joinRoom(roomId, token, guestCharacter = null) {
    const request = { token };
    if (guestCharacter !== null && guestCharacter !== undefined) {
      request.guest_character = normalizeGuestCharacterCandidate(guestCharacter);
    }
    const result = await this.api.joinRoom(roomId, request);
    await this.connectRoom(roomValue(result).room_id ?? roomId);
    this.store.patch({
      genesis: result.genesis ?? this.state.genesis,
      genesisReview: result.genesis_review
        ?? result.room?.genesis_review
        ?? this.state.genesisReview
    });
    return result;
  }

  async markReady() {
    const roomId = this._requireRoom();
    if (this.state.room?.credential_policy
      && this.state.room.credential_policy.ready !== true) {
      throw new TypeError('请先完成联机 AI 设置，并等待双方确认凭证方式与所需模型');
    }
    if (typeof this.api.changeNarrativePreset === 'function') await this.syncNarrativePreset();
    const request = {
      expected_control_revision: this.state.room?.control_revision
    };
    if (this.state.room?.origin_type === 'existing_save_derived') {
      const review = this.state.genesisReview ?? this.state.room?.genesis_review;
      const proposalRevision = positiveInteger(review?.proposal_revision);
      const commitment = review?.audience_diff_commitment;
      if (proposalRevision === null || typeof commitment !== 'string' || !commitment) {
        throw new TypeError('请先等待并查看服务端返回的本人起点导入差异');
      }
      request.proposal_revision = proposalRevision;
      request.audience_diff_commitment = commitment;
    } else if (this.state.room?.opening) {
      const seat = this.state.room.viewer_seat;
      const own = this.state.room.opening.drafts?.[seat];
      if (!own || !Number.isSafeInteger(own.revision) || !own.commitment) {
        throw new TypeError('请先保存并检查你的最新开局');
      }
      if (this.state.room.opening.blocking) {
        throw new TypeError('开局仍有阻断冲突，请先统一双方时间');
      }
      request.opening_revision = own.revision;
      request.opening_commitment = own.commitment;
    }
    const result = await this.api.markRoomReady(roomId, request);
    this.store.setRoom(result.room);
    this.store.setGenesisReview(
      result.genesis_review ?? result.room?.genesis_review ?? this.state.genesisReview
    );
    if (result.turn) {
      this.store.setTurnContext(result.turn);
      await this.refreshLineage();
      this._resolveEpochNumber();
      await this.refreshTurn({ silent: true });
    }
    return result;
  }

  async saveOpening(draft) {
    const roomId = this._requireRoom();
    const seat = this.state.room?.viewer_seat;
    const own = this.state.room?.opening?.drafts?.[seat];
    if (!own || !Number.isSafeInteger(own.revision)) {
      throw new TypeError('当前房间没有可编辑的席位开局');
    }
    const result = await this.api.saveRoomOpening(roomId, {
      expected_revision: own.revision,
      draft
    });
    this.store.setRoom(result.room ?? {
      ...this.state.room,
      opening: result.opening
    });
    return result;
  }

  async changeNarrativeMode(mode) {
    if (!NARRATIVE_MODES.includes(mode)) throw new TypeError('invalid narrative mode');
    const roomId = this._requireRoom();
    const result = await this.api.changeNarrativeMode(roomId, {
      expected_control_revision: this.state.room?.control_revision,
      mode,
      idempotency_key: createIdempotencyKey('narrative-mode')
    });
    await this.refreshRoom();
    await this.refreshTurn({ silent: true });
    return result;
  }

  async changeNarrativePreset(sourceSeat, preset = undefined) {
    const roomId = this._requireRoom();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.api.changeNarrativePreset(roomId, {
          expected_control_revision: this.state.room?.control_revision,
          ...(sourceSeat ? { source_seat: sourceSeat } : {}),
          ...(preset ? { preset } : {})
        });
        if (result.room) this.store.setRoom(result.room);
        await this.refreshRoom();
        return result;
      } catch (error) {
        if (error.code !== 'STALE_CONTROL_REVISION' || attempt) throw error;
        await this.refreshRoom();
      }
    }
  }

  async syncNarrativePreset() {
    const { getMainPreset } = await import('../data/default-preset.js');
    const preset = getMainPreset();
    return this.changeNarrativePreset(null, { name: preset.name, entries: preset.entries,
      assistantPrefill: preset.assistantPrefill ?? '' });
  }

  async createCredential({ endpointOrigin, plaintext }) {
    const value = await this.api.createModelCredential({
      endpoint_origin: endpointOrigin,
      plaintext
    });
    await this.refreshCredentials();
    return value;
  }

  async rotateCredential(credentialId, {
    expectedCredentialRevision,
    endpointOrigin,
    plaintext
  }) {
    const value = await this.api.rotateModelCredential(credentialId, {
      expected_credential_revision: expectedCredentialRevision,
      endpoint_origin: endpointOrigin,
      plaintext
    });
    await this.refreshCredentials();
    return value;
  }

  async revokeCredential(credentialId, credentialRevision) {
    const value = await this.api.revokeModelCredential(credentialId, {
      credential_revision: credentialRevision
    });
    await this.refreshCredentials();
    return value;
  }

  async createProfile(request) {
    const value = await this.api.createModelEndpointProfile(request);
    await this.refreshProfiles();
    return value;
  }

  async updateProfile(profileId, request) {
    const value = await this.api.updateModelEndpointProfile(profileId, request);
    await this.refreshProfiles();
    return value;
  }

  async revokeProfile(profileId, configRevision) {
    const value = await this.api.revokeModelEndpointProfile(profileId, {
      config_revision: configRevision
    });
    await this.refreshProfiles();
    return value;
  }

  async selectSharedPayer(profileId, expectedSelectionRevision = 0) {
    const context = this._requireTurn();
    const result = await this.api.selectSharedStagePayer(
      context.roomId,
      context.epochNo,
      context.turnNo,
      {
        expected_control_revision: this.state.room?.control_revision,
        expected_selection_revision: selectionRevision(expectedSelectionRevision),
        endpoint_profile_id: profileId,
        idempotency_key: createIdempotencyKey('shared-payer')
      }
    );
    this.store.patch({
      payerSelections: Object.freeze({
        ...this.state.payerSelections,
        shared: result.selection ?? result
      })
    });
    await this.refreshRoom();
    return result;
  }

  async bindRoomModelProfile(profileId) {
    const roomId = this._requireRoom();
    const policy = this.state.room?.credential_policy;
    const viewerSeat = this.state.room?.viewer_seat;
    const bindingRevision = policy?.bindings?.[viewerSeat]?.binding_revision ?? 0;
    const result = await this.api.bindRoomModelProfile(roomId, {
      endpoint_profile_id: profileId,
      expected_binding_revision: selectionRevision(bindingRevision),
      expected_control_revision: this.state.room?.control_revision
    });
    await Promise.all([
      this.refreshRoom(),
      this.refreshTurn({ silent: true })
    ]);
    return result;
  }

  async chooseCredentialUsagePolicy(policy) {
    if (!CREDENTIAL_USAGE_POLICIES.includes(policy)) {
      throw new TypeError('invalid credential usage policy');
    }
    const roomId = this._requireRoom();
    const result = await this.api.chooseCredentialUsagePolicy(roomId, {
      policy,
      expected_policy_revision: selectionRevision(
        this.state.room?.credential_policy?.policy_revision
      ),
      expected_control_revision: this.state.room?.control_revision
    });
    await Promise.all([
      this.refreshRoom(),
      this.refreshTurn({ silent: true })
    ]);
    return result;
  }

  async selectPovWriter(audienceSeat, profileId, expectedSelectionRevision = 0) {
    const context = this._requireTurn();
    const result = await this.api.selectPovWriter(
      context.roomId,
      context.epochNo,
      context.turnNo,
      audienceSeat,
      {
        expected_control_revision: this.state.room?.control_revision,
        expected_selection_revision: selectionRevision(expectedSelectionRevision),
        endpoint_profile_id: profileId,
        idempotency_key: createIdempotencyKey(`pov-${audienceSeat}`)
      }
    );
    this.store.patch({
      payerSelections: Object.freeze({
        ...this.state.payerSelections,
        [audienceSeat]: result.selection ?? result
      })
    });
    await this.refreshRoom();
    return result;
  }

  async lockAction({
    text,
    visibility = 'sealed',
    narrationPreference = 'full',
    narrationNote = ''
  }) {
    if (!ACTION_VISIBILITIES.includes(visibility)) throw new TypeError('invalid action visibility');
    if (!NARRATION_PREFERENCES.includes(narrationPreference)) {
      throw new TypeError('invalid narration preference');
    }
    if (!canSubmitProjectedAction(this.state)) {
      throw new MultiplayerApiError({
        code: 'ACTION_SUBMISSION_NOT_OPEN',
        message: actionSubmissionUnavailableMessage(this.state),
        details: { turn_status: this.state.turn?.status ?? null },
        status: 409
      });
    }
    const context = this._requireTurn();
    const request = {
      schema: 'naruto.multiplayer-action/v1',
      base_state_revision: this.state.room?.state_revision,
      text,
      pre_resolution_visibility: visibility,
      narration_preference: narrationPreference,
      idempotency_key: createIdempotencyKey('action')
    };
    if (narrationNote) request.narration_note = narrationNote;
    let result;
    try {
      result = await this.api.lockAction(
        context.roomId,
        context.epochNo,
        context.turnNo,
        request
      );
    } catch (error) {
      if (error?.code !== 'INVALID_TURN_STATE') throw error;
      try {
        await this.refreshRoom();
        await this.refreshTurn({ silent: true });
      } catch {
        // Preserve the original action failure while still showing a safe,
        // localized wait state when the refresh path is temporarily offline.
      }
      throw new MultiplayerApiError({
        code: 'ACTION_SUBMISSION_NOT_OPEN',
        message: actionSubmissionUnavailableMessage(this.state),
        details: {
          turn_status: this.state.turn?.status ?? error.details?.turn_status ?? null
        },
        status: error.status || 409
      });
    }
    await Promise.all([
      this.refreshRoom(),
      this.refreshTurn()
    ]);
    return result;
  }

  async sendChat(text) {
    const roomId = this._requireRoom();
    const result = await this.api.createChatMessage(roomId, {
      text,
      idempotency_key: createIdempotencyKey('chat')
    });
    if (result.message) this.store.appendChatMessage(result.message);
    return result;
  }

  async createExecutionGrant(request) {
    const roomId = this._requireRoom();
    return this.api.createExecutionGrant(roomId, request);
  }

  async revokeExecutionGrant(grantId, grantRevision) {
    const roomId = this._requireRoom();
    return this.api.revokeExecutionGrant(roomId, grantId, {
      grant_revision: grantRevision
    });
  }

  async grantDataProcessingConsent(request) {
    const roomId = this._requireRoom();
    return this.api.grantDataProcessingConsent(roomId, request);
  }

  async revokeDataProcessingConsent(consentId) {
    return this.api.revokeDataProcessingConsent(this._requireRoom(), consentId);
  }

  async authorizeBillingPlan({ planHash, grantId, grantRevision }) {
    const context = this._requireTurn();
    const result = await this.api.authorizeBillingPlan(
      context.roomId,
      context.epochNo,
      context.turnNo,
      {
        plan_hash: planHash,
        grant_id: grantId,
        grant_revision: grantRevision
      }
    );
    await this.refreshBillingPlan({ silent: true });
    return result;
  }

  async proposeBillingAmendment(futureStageChanges) {
    const context = this._requireTurn();
    const priorPlanHash = this.state.billingPlan?.plan_hash
      ?? this.state.billingPlan?.plan?.plan_hash;
    const result = await this.api.proposeBillingPlanAmendment(
      context.roomId,
      context.epochNo,
      context.turnNo,
      {
        prior_plan_hash: priorPlanHash,
        future_stage_changes: futureStageChanges
      }
    );
    this.store.setProposal('amendment', result.amendment ?? result);
    return result;
  }

  async acceptBillingAmendment(amendmentId) {
    const context = this._requireTurn();
    const result = await this.api.acceptBillingPlanAmendment(
      context.roomId,
      context.epochNo,
      context.turnNo,
      amendmentId
    );
    await this.refreshBillingPlan({ silent: true });
    return result;
  }

  async retryTurn() {
    const context = this._requireTurn();
    const result = await this.api.retryTurn(
      context.roomId,
      context.epochNo,
      context.turnNo,
      { expected_control_revision: this.state.room?.control_revision }
    );
    await Promise.all([this.refreshRoom(), this.refreshTurn({ silent: true })]);
    return result;
  }

  async createTurnVoidProposal() {
    const context = this._requireTurn();
    const result = await this.api.createTurnVoidProposal(
      context.roomId,
      context.epochNo,
      context.turnNo,
      {
        proposal_id: createIdempotencyKey('void'),
        proposal_revision: 1,
        expected_control_revision: this.state.room?.control_revision
      }
    );
    this.store.setProposal('void', result.proposal ?? result);
    return result;
  }

  async acceptTurnVoidProposal(proposal = this.state.proposals.void) {
    const context = this._requireTurn();
    const value = proposal?.proposal ?? proposal;
    const result = await this.api.acceptTurnVoidProposal(
      context.roomId,
      context.epochNo,
      context.turnNo,
      value.proposal_id,
      {
        proposal_revision: value.proposal_revision,
        expected_control_revision: this.state.room?.control_revision
      }
    );
    this.store.setProposal('void', result.proposal ?? result);
    await Promise.all([this.refreshRoom(), this.refreshLineage()]);
    return result;
  }

  async createArchiveProposal(checkpointId) {
    const roomId = this._requireRoom();
    const result = await this.api.createArchiveProposal(roomId, {
      proposal_id: createIdempotencyKey('archive'),
      proposal_revision: 1,
      checkpoint_id: checkpointId,
      expected_control_revision: this.state.room?.control_revision
    });
    this.store.setProposal('archive', result.proposal ?? result);
    return result;
  }

  async acceptArchiveProposal(proposal = this.state.proposals.archive) {
    const roomId = this._requireRoom();
    const value = proposal?.proposal ?? proposal;
    const result = await this.api.acceptArchiveProposal(roomId, value.proposal_id, {
      proposal_revision: value.proposal_revision,
      expected_control_revision: this.state.room?.control_revision
    });
    this.store.setProposal('archive', result.proposal ?? result);
    await Promise.all([this.refreshRoom(), this.refreshLineage()]);
    return result;
  }

  async createContinuationProposal({ mode, checkpointId, sourceImportId }) {
    const roomId = this._requireRoom();
    const request = {
      continuation_mode: mode,
      expected_control_revision: this.state.room?.control_revision
    };
    if (mode === 'resume_room_checkpoint') {
      request.proposal_id = createIdempotencyKey('continuation');
      request.proposal_revision = 1;
      request.checkpoint_id = checkpointId;
    }
    if (mode === 'fork_from_latest_source_save') {
      const binding = resolveLatestSourceContinuationBinding({
        sourceImportId,
        lineage: this.state.lineage,
        staged: this._latestSourceStagedContext()
      });
      request.proposal_id = binding.proposal_id;
      request.proposal_revision = binding.proposal_revision;
      request.source_import_id = binding.source_import_id;
    }
    const result = await this.api.createContinuationProposal(roomId, request);
    this.store.setProposal('continuation', result.proposal ?? result);
    return result;
  }

  async acceptContinuationProposal({
    proposal = this.state.proposals.continuation,
    audienceDiffCommitment = null
  } = {}) {
    const roomId = this._requireRoom();
    const value = proposal?.proposal ?? proposal;
    const request = {
      proposal_revision: value.proposal_revision,
      expected_control_revision: this.state.room?.control_revision
    };
    if (audienceDiffCommitment) request.audience_diff_commitment = audienceDiffCommitment;
    const result = await this.api.acceptContinuationProposal(
      roomId,
      value.proposal_id,
      request
    );
    this.store.setProposal('continuation', result.proposal ?? result);
    await Promise.all([this.refreshRoom(), this.refreshLineage()]);
    if (result.turn) {
      this.store.setTurnContext(result.turn);
      this._resolveEpochNumber();
      await this.refreshTurn({ silent: true });
    }
    return result;
  }

  async beginPersonalExport(checkpointId) {
    const result = await this.api.beginSinglePlayerExport(
      this._requireRoom(),
      checkpointId,
      {
        idempotency_key: createIdempotencyKey('personal-export'),
        projection_version: 'projection-v1',
        output_format: 'timeline-json-v1'
      }
    );
    this.store.patch({ latestExport: result.export ?? result });
    return result;
  }

  downloadPersonalExport(exportId) {
    return this.api.downloadSinglePlayerExport(this._requireRoom(), exportId);
  }
}

export { ROOM_ORIGIN_TYPES };
