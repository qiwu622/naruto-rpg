import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MultiplayerRoomEventStream } from '../js/multiplayer/room-event-stream.js';
import { MultiplayerRoomStore } from '../js/multiplayer/room-store.js';
import {
  MultiplayerSessionController,
  deriveActiveTurnContext,
  normalizeGuestCharacterCandidate,
  normalizeSaveImportCandidate,
  unwrapProfile
} from '../js/multiplayer/session-controller.js';
import { multiplayerErrorMessage } from '../js/multiplayer/error-presentation.js';
import { GUEST_CHARACTER_IMPORT_SCHEMA } from '../js/multiplayer/contracts.js';
import {
  actionSubmissionUnavailableMessage,
  canSubmitProjectedAction,
  isProjectedOpeningTurn,
  projectedActionCards,
  projectedAuthoritativeState,
  projectedDaily,
  projectedMemories,
  projectedNarrativeDeliveries
} from '../js/multiplayer/ui-projection.js';
import {
  MULTIPLAYER_PANEL_TAG,
  NarutoMultiplayerPanel
} from '../js/multiplayer/multiplayer-panel.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

assert.deepEqual(unwrapProfile({ profile: { profile_id: 'profile_wrapped' } }), {
  profile_id: 'profile_wrapped'
});
assert.equal(
  multiplayerErrorMessage({
    code: 'MULTIPLAYER_UI_ERROR',
    message: 'profileValue is not defined'
  }),
  '界面操作失败，请刷新页面后重试'
);
assert.equal(
  multiplayerErrorMessage({
    code: 'MODEL_ENDPOINT_UPSTREAM_ERROR',
    message: 'model endpoint returned a non-success status',
    details: {
      upstream_status: 400,
      upstream_error_summary: 'unsupported parameter',
      provider_request_id: 'request_demo'
    }
  }),
  '模型服务拒绝了本次请求，请检查 API 方案与模型设置'
    + ' · 上游 HTTP 400 · 上游返回：unsupported parameter · 请求 ID request_demo'
);
assert.equal(
  multiplayerErrorMessage({
    code: 'MODEL_PROTOCOL_VIOLATION',
    message: 'Continuity response must be exactly one complete JSON value'
  }),
  '模型回复不是联机要求的完整 JSON，当前回合已暂停'
);

function envelope({ seq, type, roomId = 'room_1', payload = {}, epochId = 'epoch_1', turnId = 'turn_1' }) {
  return {
    event_id: `event_${seq}`,
    room_id: roomId,
    event_seq: seq,
    epoch_id: epochId,
    turn_id: turnId,
    event_type: type,
    projection_version: 'projection-v1',
    payload,
    payload_hash: `sha256:${String(seq).padStart(64, '0')}`,
    created_at: '2026-08-22T00:00:00.000Z'
  };
}

const actionProjectionBase = {
  room: { lifecycle: 'ACTIVE', viewer_seat: 'A' },
  turnContext: { epochId: 'epoch_1', epochNo: 1, turnId: 'turn_gate', turnNo: 1 },
  turn: {
    turn_id: 'turn_gate',
    turn_no: 1,
    viewer_seat: 'A',
    status: 'AWAITING_PAYER_SELECTION',
    actions: { A: { seat: 'A', locked: false }, B: { seat: 'B', locked: false } }
  }
};
assert.equal(canSubmitProjectedAction(actionProjectionBase), false);
assert.match(
  actionSubmissionUnavailableMessage(actionProjectionBase),
  /凭证与模型尚未就绪.*完整联机设置/u
);
assert.equal(canSubmitProjectedAction({
  ...actionProjectionBase,
  turn: { ...actionProjectionBase.turn, status: 'COLLECTING_ACTIONS' }
}), true);
assert.equal(canSubmitProjectedAction({
  ...actionProjectionBase,
  turn: {
    ...actionProjectionBase.turn,
    status: 'ONE_ACTION_LOCKED',
    actions: { A: { seat: 'A', locked: true }, B: { seat: 'B', locked: false } }
  }
}), false);
assert.equal(canSubmitProjectedAction({
  ...actionProjectionBase,
  turn: {
    ...actionProjectionBase.turn,
    status: 'ONE_ACTION_LOCKED',
    actions: { A: { seat: 'A', locked: false }, B: { seat: 'B', locked: true } }
  }
}), true);
assert.match(actionSubmissionUnavailableMessage({
  ...actionProjectionBase,
  turn: {
    ...actionProjectionBase.turn,
    status: 'SEALED',
    actions: { A: { seat: 'A', locked: true }, B: { seat: 'B', locked: true } }
  }
}), /正在生成本回合正文/u);

const openingTurnProjection = {
  ...actionProjectionBase,
  room: {
    ...actionProjectionBase.room,
    origin_type: 'new_multiplayer_save',
    state_revision: 0
  },
  turn: {
    ...actionProjectionBase.turn,
    turn_kind: 'OPENING',
    status: 'RESOLVING',
    actions: { A: { seat: 'A', locked: true }, B: { seat: 'B', locked: true } }
  }
};
assert.equal(isProjectedOpeningTurn(openingTurnProjection), true);
assert.equal(canSubmitProjectedAction(openingTurnProjection), false);
assert.match(
  actionSubmissionUnavailableMessage(openingTurnProjection),
  /正在根据双方开局生成第一回合.*初始化角色、世界、资源与记忆/u
);

class FakeEventSource {
  static instances = [];

  constructor(url, init) {
    this.url = url;
    this.init = init;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  emit(type, value = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }

  emitEnvelope(value) {
    this.emit(value.event_type, { data: JSON.stringify(value), lastEventId: String(value.event_seq) });
  }

  close() {
    this.closed = true;
  }
}

const timers = [];
const accepted = [];
const protocolErrors = [];
const cursorWrites = [];
const cursorErrors = [];
const sse = new MultiplayerRoomEventStream({
  apiClient: {
    eventsUrl: (roomId, after) => `/api/multiplayer/rooms/${roomId}/events?after=${after}`
  },
  eventSourceFactory: (url, init) => new FakeEventSource(url, init),
  cursorStore: {
    load: () => { throw new Error('simulated cursor read failure'); },
    save: (roomId, seq) => {
      cursorWrites.push([roomId, seq]);
      if (seq === 2) throw new Error('simulated cursor storage failure');
    }
  },
  reconnectInitialMs: 10,
  reconnectMaxMs: 100,
  setTimeoutImpl: (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  },
  clearTimeoutImpl: () => {},
  random: () => 0
});
sse.on('event', event => accepted.push(event));
sse.on('protocol-error', error => protocolErrors.push(error));
sse.on('cursor-error', error => cursorErrors.push(error));
sse.start('room_1');

assert.equal(FakeEventSource.instances[0].url, '/api/multiplayer/rooms/room_1/events?after=0');
assert.equal(FakeEventSource.instances[0].init.withCredentials, true);
FakeEventSource.instances[0].emit('open');
FakeEventSource.instances[0].emitEnvelope(envelope({
  seq: 2,
  type: 'action.locked',
  payload: { seat: 'A', locked: true }
}));
FakeEventSource.instances[0].emitEnvelope(envelope({
  seq: 2,
  type: 'action.locked',
  payload: { seat: 'A', locked: true }
}));
FakeEventSource.instances[0].emitEnvelope(envelope({
  seq: 1,
  type: 'chat.message_created',
  payload: { message_id: 'message_old', text: 'out of order' }
}));
FakeEventSource.instances[0].emit('turn.opened', { data: '{bad json' });
FakeEventSource.instances[0].emitEnvelope(envelope({
  seq: 5,
  type: 'turn.sealed',
  payload: { status: 'SEALED' }
}));

assert.deepEqual(accepted.map(event => event.event_seq), [2, 5]);
assert.deepEqual(cursorWrites, [['room_1', 2], ['room_1', 5]]);
assert.equal(protocolErrors.length, 1);
assert.equal(cursorErrors.length, 2);
assert.equal(sse.lastEventSeq, 5);
FakeEventSource.instances[0].emit('error');
assert.equal(FakeEventSource.instances[0].closed, true);
assert.equal(timers.length, 1);
assert.equal(timers[0].delay, 10);
timers[0].callback();
assert.equal(FakeEventSource.instances[1].url, '/api/multiplayer/rooms/room_1/events?after=5');
sse.stop({ preserveListeners: false });

const store = new MultiplayerRoomStore();
store.patch({
  roomId: 'room_1',
  room: {
    room_id: 'room_1',
    viewer_seat: 'B',
    state_revision: 7,
    control_revision: 3,
    active_narrative_mode: 'shared'
  }
});
store.applyEvent(envelope({
  seq: 1,
  type: 'action.locked',
  payload: { seat: 'A', locked: true }
}));
store.applyEvent(envelope({
  seq: 2,
  type: 'action.revealed_pre_resolution',
  payload: { submission_id: 'action_a' }
}));
let cards = projectedActionCards(store.state.turn);
assert.equal(cards[0].locked, true);
assert.equal(cards[0].text, null, 'reveal event must not fabricate action text');
assert.equal(JSON.stringify(store.state.turn).includes('commitment'), false);

store.setTurn({
  turn_id: 'turn_1',
  turn_no: 1,
  viewer_seat: 'B',
  status: 'ONE_ACTION_LOCKED',
  active_narrative_mode: 'shared',
  actions: {
    A: {
      seat: 'A',
      locked: true,
      submission_id: 'action_a',
      text: '服务端鉴权接口返回的公开原文',
      disclosure: 'open_pre_resolution'
    },
    B: { seat: 'B', locked: false }
  }
});
cards = projectedActionCards(store.state.turn);
assert.equal(cards[0].text, '服务端鉴权接口返回的公开原文');
store.applyEvent(envelope({
  seq: 3,
  type: 'narrative_mode.queued',
  payload: { mode: 'dual_pov', control_revision: 4 }
}));
assert.equal(store.state.room.active_narrative_mode, 'shared');
assert.equal(store.state.room.queued_narrative_mode, 'dual_pov');
store.applyEvent(envelope({
  seq: 4,
  type: 'lineage.proposal_created',
  payload: {
    proposal_id: 'proposal_void',
    proposal_revision: 1,
    proposal_type: 'void_turn'
  }
}));
assert.equal(store.state.proposals.void.proposal_id, 'proposal_void');
store.applyEvent(envelope({
  seq: 5,
  type: 'turn.void_requested',
  payload: { status: 'VOID_REQUESTED', control_revision: 5 }
}));
assert.equal(store.state.turn.status, 'VOID_REQUESTED');
store.applyEvent(envelope({
  seq: 6,
  type: 'resolution.progress',
  payload: {
    status: 'RETRYABLE_FAILED',
    error_code: 'MODEL_PROTOCOL_VIOLATION',
    detail: null
  }
}));
assert.equal(
  store.state.progress.detail,
  '模型回复不是联机要求的完整 JSON，当前回合已暂停'
);

assert.deepEqual(projectedNarrativeDeliveries({
  narratives: {
    A: { audience: 'A', segments: [{ text: 'A 的正文' }] },
    B: { audience: 'B', segments: [{ text: 'B 的正文' }] }
  }
}), [], 'legacy or internal narrative fields must never bypass the member commit projection');

const committedProjection = {
  status: 'COMMITTED',
  commit: {
    narratives: [{ audience: 'shared', segments: [{ text: '已提交正文' }] }],
    shinobi_daily: [{ daily_id: 'daily_1' }],
    state: {
      schema: 'naruto.multiplayer-member-state-projection/v1',
      memories: { shared: { entries: ['共同记忆'] }, personal: { entries: ['我的秘密'] } }
    }
  }
};
assert.deepEqual(
  projectedNarrativeDeliveries(committedProjection).map(item => item.text),
  ['已提交正文']
);
assert.equal(projectedDaily(committedProjection)[0].daily_id, 'daily_1');
assert.equal(
  projectedAuthoritativeState(committedProjection).schema,
  'naruto.multiplayer-member-state-projection/v1'
);
assert.deepEqual(projectedMemories(committedProjection), {
  shared: { entries: ['共同记忆'] },
  personal: { entries: ['我的秘密'] }
});

const normalizedImport = normalizeSaveImportCandidate({
  source_save_id: 'save_1',
  client_save_instance_id: 'instance_1',
  source_branch_id: 'branch_1',
  source_node_id: 'node_1',
  state: { schema: 'projected-state' },
  source_timeline: {
    export_version: '2.0',
    active_branch_id: 'branch_1',
    nodes: [{ node_id: 'node_1', player_input: '来源所有者历史' }]
  }
});
assert.deepEqual(normalizedImport.source_timeline.nodes, [
  { node_id: 'node_1', player_input: '来源所有者历史' }
]);

const guestCharacter = normalizeGuestCharacterCandidate({
  schema: GUEST_CHARACTER_IMPORT_SCHEMA,
  state_snapshot: {
    _version: '5.0',
    '玩家·姓名': '客方角色',
    '属性·查克拉': 48
  }
});
assert.equal(guestCharacter.schema, GUEST_CHARACTER_IMPORT_SCHEMA);
assert.equal(guestCharacter.state_snapshot['玩家·姓名'], '客方角色');
assert.throws(
  () => normalizeGuestCharacterCandidate({
    schema: 'naruto.multiplayer-guest-character-import/v0',
    state_snapshot: { _version: '5.0' }
  }),
  /guest character schema/u
);
assert.throws(
  () => normalizeGuestCharacterCandidate({
    schema: GUEST_CHARACTER_IMPORT_SCHEMA,
    state_snapshot: { _version: '5.0' },
    world_merge: true
  }),
  /unsupported fields/u
);

class FakeRoomStream {
  constructor() {
    this.listeners = new Map();
    this.started = null;
  }

  on(type, listener) {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
    return () => bucket.delete(listener);
  }

  start(roomId) {
    this.started = roomId;
    this.emit('status', { status: 'open', room_id: roomId, last_event_seq: 0 });
  }

  stop() {}

  emit(type, value) {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }
}

const genesisReview = {
  proposal_id: 'genesis_review_1',
  proposal_revision: 1,
  status: 'AWAITING_CONFIRMATION',
  audience_diff: {
    schema: 'naruto.multiplayer-audience-safe-import-diff/v1',
    audience: 'B',
    audience_role: 'guest',
    sections: [{ category: 'characters', entries: [{ summary: '你将控制客方角色' }] }]
  },
  audience_diff_commitment: 'hmac-sha256:guest-diff',
  server_hmac_commitment: 'hmac-sha256:server-basis',
  accepted_by: { A: false, B: false },
  accepted_by_viewer: false
};
const lobbyCalls = [];
const lobbyRooms = new Map([
  ['room_existing', 'EXISTING'],
  ['room_new', 'NEW']
]);
let createdRoomCount = 0;
function lobbyRoom(roomId, accepted = false) {
  const existing = roomId === 'room_existing';
  return {
    room_id: roomId,
    room_code: lobbyRooms.get(roomId) ?? roomId,
    viewer_seat: 'B',
    origin_type: existing ? 'existing_save_derived' : 'new_multiplayer_save',
    lifecycle: 'ACTIVE',
    active_epoch_id: null,
    current_turn_id: null,
    state_revision: 0,
    control_revision: existing ? 4 : 5,
    active_narrative_mode: 'shared',
    genesis_review: existing ? {
      ...genesisReview,
      accepted_by: { A: false, B: accepted },
      accepted_by_viewer: accepted
    } : null,
    members: [
      { seat: 'A', ready_at: null },
      { seat: 'B', ready_at: accepted ? '2026-08-23T00:00:00.000Z' : null }
    ]
  };
}
const lobbyApi = {
  createRoom: async request => {
    lobbyCalls.push(['create', request]);
    const roomId = `room_created_${++createdRoomCount}`;
    const roomCode = request.room_code ?? `R-AUTO-CODE-${createdRoomCount}`;
    lobbyRooms.set(roomId, roomCode);
    return {
      room: lobbyRoom(roomId),
      invite: {
        room_id: roomId,
        room_code: roomCode,
        token: request.invite_code ?? 'N-AUTO-CODE-2026'
      }
    };
  },
  joinRoom: async (roomLocator, request) => {
    lobbyCalls.push(['join', roomLocator, request]);
    const roomId = [...lobbyRooms].find(([id, code]) => (
      id === roomLocator || code === String(roomLocator).toUpperCase()
    ))?.[0] ?? roomLocator;
    return {
      room: lobbyRoom(roomId),
      genesis_review: roomId === 'room_existing' ? genesisReview : null
    };
  },
  getRoom: async roomLocator => {
    const roomId = [...lobbyRooms].find(([id, code]) => (
      id === roomLocator || code === String(roomLocator).toUpperCase()
    ))?.[0] ?? roomLocator;
    return lobbyRoom(roomId);
  },
  getLineage: async roomId => ({
    room_id: roomId,
    active_epoch_id: null,
    origin_type: roomId === 'room_existing'
      ? 'existing_save_derived'
      : 'new_multiplayer_save',
    epochs: [],
    checkpoints: []
  }),
  listModelEndpointProfiles: async () => [],
  listModelCredentials: async () => [],
  listChatMessages: async () => ({ messages: [], next_before: null }),
  markRoomReady: async (roomId, request) => {
    lobbyCalls.push(['ready', roomId, request]);
    const room = lobbyRoom(roomId, true);
    return {
      room,
      genesis_review: room.genesis_review,
      all_ready: false,
      turn: null
    };
  }
};

const automaticInviteController = new MultiplayerSessionController({
  apiClient: lobbyApi,
  eventStreamFactory: () => new FakeRoomStream()
});
await automaticInviteController.createNewMultiplayerRoom({}, { narrativeMode: 'dual_pov' });
assert.deepEqual(lobbyCalls.find(call => call[0] === 'create')[1], {
  origin_type: 'new_multiplayer_save',
  new_world_profile: {},
  default_narrative_mode: 'dual_pov'
});
assert.equal(automaticInviteController.state.roomId, 'room_created_1');
assert.equal(automaticInviteController.state.room.room_code, 'R-AUTO-CODE-1');
assert.equal(automaticInviteController.state.invite.token, 'N-AUTO-CODE-2026');
automaticInviteController.disconnect({ reset: true });

const existingLobbyController = new MultiplayerSessionController({
  apiClient: lobbyApi,
  eventStreamFactory: () => new FakeRoomStream()
});
await existingLobbyController.joinRoom('room_existing', 'invite-token-existing', guestCharacter);
assert.deepEqual(lobbyCalls.find(call => call[0] === 'join' && call[1] === 'room_existing')[2], {
  token: 'invite-token-existing',
  guest_character: guestCharacter
});
assert.equal(existingLobbyController.state.genesisReview.audience_diff.audience, 'B');
assert.equal(existingLobbyController.state.genesisReview.accepted_by_viewer, false);
await existingLobbyController.markReady();
assert.deepEqual(lobbyCalls.find(call => call[0] === 'ready' && call[1] === 'room_existing')[2], {
  expected_control_revision: 4,
  proposal_revision: 1,
  audience_diff_commitment: 'hmac-sha256:guest-diff'
});
assert.equal(existingLobbyController.state.genesisReview.accepted_by_viewer, true);
existingLobbyController.disconnect({ reset: true });

const newLobbyController = new MultiplayerSessionController({
  apiClient: lobbyApi,
  eventStreamFactory: () => new FakeRoomStream()
});
await newLobbyController.joinRoom('room_new', 'invite-token-new');
assert.deepEqual(
  lobbyCalls.find(call => call[0] === 'join' && call[1] === 'room_new')[2],
  { token: 'invite-token-new' },
  'new multiplayer joins remain compatible without a guest character payload'
);
await newLobbyController.markReady();
assert.deepEqual(
  lobbyCalls.find(call => call[0] === 'ready' && call[1] === 'room_new')[2],
  { expected_control_revision: 5 },
  'new multiplayer readiness keeps the original request shape'
);
newLobbyController.disconnect({ reset: true });

const controllerCalls = [];
const turnReads = [];
let currentTurnId = 'turn_1';
let committedTurnProjection = null;
let committedReadFailuresRemaining = 0;
let lineageCheckpoints = [
  { checkpoint_id: 'checkpoint_0', epoch_id: 'epoch_1', turn_no: 0, turn_id: null }
];
let projectedTurn = {
  turn_id: 'turn_1',
  turn_no: 1,
  viewer_seat: 'A',
  status: 'COLLECTING_ACTIONS',
  active_narrative_mode: 'shared',
  payer_selections: {
    shared: { selection_hash: 'sha256:selection-1', selection_revision: 1 },
    A: null,
    B: null
  },
  actions: { A: { seat: 'A', locked: false }, B: { seat: 'B', locked: false } }
};
const fakeApi = {
  getRoom: async roomId => ({
    room_id: roomId,
    viewer_seat: 'A',
    lifecycle: 'ACTIVE',
    active_epoch_id: 'epoch_1',
    current_turn_id: currentTurnId,
    state_revision: 7,
    control_revision: 3,
    active_narrative_mode: 'shared',
    members: [
      { seat: 'A', ready_at: '2026-08-22T00:00:00.000Z' },
      { seat: 'B', ready_at: '2026-08-22T00:00:00.000Z' }
    ]
  }),
  getLineage: async roomId => ({
    room_id: roomId,
    active_epoch_id: 'epoch_1',
    origin_type: 'existing_save_derived',
    epochs: [{ epoch_id: 'epoch_1', epoch_no: 1 }],
    checkpoints: lineageCheckpoints
  }),
  listModelEndpointProfiles: async () => [],
  listModelCredentials: async () => [],
  listChatMessages: async () => ({ messages: [], next_before: null }),
  getBillingPlan: async () => null,
  getTurn: async (roomId, epochNo, turnNo) => {
    turnReads.push([roomId, epochNo, turnNo]);
    if (turnNo === 1 && committedTurnProjection) {
      if (committedReadFailuresRemaining > 0) {
        committedReadFailuresRemaining -= 1;
        throw Object.assign(new Error('temporary committed projection read failure'), {
          code: 'MULTIPLAYER_NETWORK_ERROR',
          status: 0
        });
      }
      return committedTurnProjection;
    }
    return projectedTurn;
  },
  openNextTurn: async (roomId, previousTurnId) => {
    controllerCalls.push(['openNextTurn', roomId, previousTurnId]);
    currentTurnId = 'turn_2';
    lineageCheckpoints = [
      ...lineageCheckpoints.filter(item => item.turn_id !== 'turn_1'),
      { checkpoint_id: 'checkpoint_1', epoch_id: 'epoch_1', turn_no: 1, turn_id: 'turn_1' }
    ];
    projectedTurn = {
      turn_id: 'turn_2', turn_no: 2, viewer_seat: 'A', status: 'COLLECTING_ACTIONS',
      active_narrative_mode: 'shared', payer_selections: { shared: null, A: null, B: null },
      actions: { A: { seat: 'A', locked: false }, B: { seat: 'B', locked: false } }
    };
    return { turn: { turn_id: 'turn_2', turn_no: 2 } };
  },
  lockAction: async (roomId, epochNo, turnNo, request) => {
    controllerCalls.push(['lockAction', roomId, epochNo, turnNo, request]);
    projectedTurn = {
      ...projectedTurn,
      status: 'ONE_ACTION_LOCKED',
      actions: {
        ...projectedTurn.actions,
        A: { seat: 'A', locked: true, text: request.text, disclosure: 'owner' }
      }
    };
    return { receipt: { submission_id: 'action_a' } };
  },
  createChatMessage: async (roomId, request) => {
    controllerCalls.push(['chat', roomId, request]);
    return {
      message: {
        message_id: 'message_1',
        room_id: roomId,
        sender_seat: 'A',
        text: request.text,
        event_seq: 9,
        created_at: '2026-08-22T00:00:00.000Z'
      }
    };
  },
  changeNarrativeMode: async (roomId, request) => {
    controllerCalls.push(['mode', roomId, request]);
    return { disposition: 'queued_next_turn', mode: request.mode };
  },
  createContinuationProposal: async (roomId, request) => {
    controllerCalls.push(['continuation', roomId, request]);
    return { proposal: request };
  }
};
const fakeStream = new FakeRoomStream();
const controller = new MultiplayerSessionController({
  apiClient: fakeApi,
  eventStreamFactory: () => fakeStream,
  committedRetryDelayMs: 25
});
await controller.connectRoom('room_1');
assert.equal(fakeStream.started, 'room_1');
assert.deepEqual(controller.state.turnContext, {
  epochId: 'epoch_1', epochNo: 1, turnId: 'turn_1', turnNo: 1
});
assert.deepEqual(turnReads[0], ['room_1', 1, 1]);
assert.equal(controller.state.payerSelections.shared.selection_revision, 1);
assert.deepEqual(deriveActiveTurnContext({
  active_epoch_id: 'epoch_1', current_turn_id: 'turn_3'
}, {
  active_epoch_id: 'epoch_1',
  epochs: [{ epoch_id: 'epoch_1', epoch_no: 1 }],
  checkpoints: [{ epoch_id: 'epoch_1', turn_no: 2, turn_id: 'turn_2' }]
}), {
  epochId: 'epoch_1', epochNo: 1, turnId: 'turn_3', turnNo: 3
});

let failedStreamStopped = false;
const failedController = new MultiplayerSessionController({
  apiClient: {
    getRoom: async () => {
      throw Object.assign(new Error('not a member'), {
        code: 'ROOM_MEMBER_REQUIRED',
        status: 403
      });
    },
    getLineage: async () => ({})
  },
  eventStreamFactory: () => ({
    on: () => () => {},
    start() {},
    stop() { failedStreamStopped = true; }
  })
});
await assert.rejects(failedController.connectRoom('room_denied'), /not a member/u);
assert.equal(failedStreamStopped, false, 'membership resolves before an SSE stream is created');
assert.equal(failedController.state.roomId, null);
assert.equal(failedController.state.lastError.code, 'ROOM_MEMBER_REQUIRED');
projectedTurn = {
  ...projectedTurn,
  payer_selections: {
    ...projectedTurn.payer_selections,
    shared: { selection_hash: 'sha256:selection-2', selection_revision: 2 }
  }
};
fakeStream.emit('event', envelope({
  seq: 8,
  type: 'billing.payer_selection_changed',
  payload: { scope: 'shared', selection_revision: 2 }
}));
await new Promise(resolve => setImmediate(resolve));
assert.equal(controller.state.payerSelections.shared.selection_revision, 2);
assert.equal(turnReads.length >= 2, true, 'payer selection SSE must refresh the turn projection');
const lockCallsBeforeGateCheck = controllerCalls.filter(call => call[0] === 'lockAction').length;
controller.store.setTurn({
  ...controller.state.turn,
  status: 'AWAITING_PAYER_SELECTION'
});
await assert.rejects(
  controller.lockAction({
    text: '不应提前提交的行动',
    visibility: 'sealed'
  }),
  error => {
    assert.equal(error.code, 'ACTION_SUBMISSION_NOT_OPEN');
    assert.match(error.message, /凭证与模型尚未就绪.*完整联机设置/u);
    return true;
  }
);
assert.equal(
  controllerCalls.filter(call => call[0] === 'lockAction').length,
  lockCallsBeforeGateCheck,
  'AWAITING_PAYER_SELECTION must be blocked before an HTTP action write'
);
controller.store.setTurn({
  ...controller.state.turn,
  status: 'COLLECTING_ACTIONS'
});
await controller.lockAction({
  text: '我的原始行动',
  visibility: 'sealed'
});
const actionRequest = controllerCalls.find(call => call[0] === 'lockAction')[4];
assert.equal(actionRequest.base_state_revision, 7);
assert.equal(actionRequest.pre_resolution_visibility, 'sealed');
assert.equal(actionRequest.narration_preference, 'full');
assert.equal(Object.hasOwn(actionRequest, 'narration_note'), false);
assert.equal(Object.hasOwn(actionRequest, 'seat'), false);
assert.equal(Object.hasOwn(actionRequest, 'post_commit_disclosure'), false);
await controller.sendChat('只用于协调，不进入剧情');
assert.equal(controller.state.chat.messages[0].text, '只用于协调，不进入剧情');
await controller.changeNarrativeMode('dual_pov');
const modeRequest = controllerCalls.find(call => call[0] === 'mode')[2];
assert.equal(modeRequest.expected_control_revision, 3);
assert.equal(Object.hasOwn(modeRequest, 'payer'), false);

controller.store.setLineage({
  ...controller.state.lineage,
  source_imports: [{
    source_import_id: 'source_import_l2',
    proposal_id: 'proposal_l2_stable',
    proposal_revision: 3,
    source: { derived_from_export_id: 'export_l1' }
  }]
});
controller.store.patch({
  latestSourceImport: {
    import: {
      source_import_id: 'source_import_l2',
      proposal_id: 'proposal_l2_stable',
      proposal_revision: 3
    }
  }
});
await controller.createContinuationProposal({
  mode: 'fork_from_latest_source_save',
  sourceImportId: 'source_import_l2'
});
const continuationRequest = controllerCalls.find(call => call[0] === 'continuation')[2];
assert.equal(continuationRequest.proposal_id, 'proposal_l2_stable');
assert.equal(continuationRequest.proposal_revision, 3);
assert.equal(continuationRequest.source_import_id, 'source_import_l2');

fakeStream.emit('event', envelope({
  seq: 10,
  type: 'action.locked',
  payload: { seat: 'B', locked: true }
}));
assert.equal(projectedActionCards(controller.state.turn)[1].text, null);

let committedProjectionSeen = false;
const unsubscribeCommittedProjection = controller.subscribe(state => {
  if (projectedAuthoritativeState(state.turn)?.state_revision === 8) {
    committedProjectionSeen = true;
  }
});
lineageCheckpoints = [
  ...lineageCheckpoints,
  { checkpoint_id: 'checkpoint_1', epoch_id: 'epoch_1', turn_no: 1, turn_id: 'turn_1' }
];
projectedTurn = {
  ...projectedTurn,
  status: 'COMMITTED',
  commit: {
    checkpoint: { checkpoint_id: 'checkpoint_1', commit_id: 'commit_1' },
    state: { state_revision: 8, memories: { shared: [], personal: [] } },
    narratives: [{ audience: 'shared', text: '第一回合正式正文。' }],
    shinobi_daily: []
  }
};
committedTurnProjection = projectedTurn;
committedReadFailuresRemaining = 2;
fakeStream.emit('event', envelope({
  seq: 11,
  type: 'turn.committed',
  payload: { turn_id: 'turn_1', checkpoint_id: 'checkpoint_1', state_revision: 8 }
}));
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(
  controllerCalls.some(call => call[0] === 'openNextTurn'),
  false,
  'a failed committed projection read must not open the next turn'
);
await new Promise(resolve => setTimeout(resolve, 50));
unsubscribeCommittedProjection();
assert.equal(committedProjectionSeen, true, 'the committed member projection must render before advancing');
assert.deepEqual(
  controllerCalls.find(call => call[0] === 'openNextTurn'),
  ['openNextTurn', 'room_1', 'turn_1']
);
assert.equal(controller.state.turn.turn_id, 'turn_2');
assert.deepEqual(controller.state.turnContext, {
  epochId: 'epoch_1', epochNo: 1, turnId: 'turn_2', turnNo: 2
});

let reconnectSawCommittedNarrative = false;
const reconnectController = new MultiplayerSessionController({
  apiClient: fakeApi,
  eventStreamFactory: () => new FakeRoomStream()
});
const unsubscribeReconnect = reconnectController.subscribe(state => {
  if (projectedNarrativeDeliveries(state.turn).some(delivery => (
    delivery.text === '第一回合正式正文。'
  ))) reconnectSawCommittedNarrative = true;
});
await reconnectController.connectRoom('room_1');
unsubscribeReconnect();
assert.equal(
  reconnectSawCommittedNarrative,
  true,
  'reconnect must replay the latest committed body before showing the already-open next turn'
);
assert.equal(reconnectController.state.turn.turn_id, 'turn_2');
reconnectController.disconnect({ reset: true });

assert.equal(MULTIPLAYER_PANEL_TAG, 'naruto-multiplayer-panel');
assert.equal(typeof NarutoMultiplayerPanel, 'function');

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const multiplayerDirectory = path.resolve(scriptsDirectory, '../js/multiplayer');
const sourceFiles = (await readdir(multiplayerDirectory)).filter(name => name.endsWith('.js'));
const sources = await Promise.all(sourceFiles.map(async name => ({
  name,
  source: await readFile(path.join(multiplayerDirectory, name), 'utf8')
})));
for (const { name, source } of sources) {
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  assert.doesNotMatch(executableSource, /from\s+['"][^'"]*(?:instruction-parser|state-manager|agent-pipeline|pipeline\.js)/u, `${name} imports a forbidden single-player authority module`);
  assert.doesNotMatch(executableSource, /\bstateManager\s*\./u, `${name} calls browser stateManager`);
  assert.doesNotMatch(executableSource, /\b_applyInstructions\s*\(/u, `${name} calls front-end instruction parsing`);
  assert.doesNotMatch(executableSource, /new\s+MessagePipeline\s*\(/u, `${name} creates a single-player MessagePipeline`);
  // The panel has a display-only elapsed timer. Browser coverage verifies it
  // does not submit actions or retry; other transport/domain modules stay timer-free here.
  if (name !== 'multiplayer-panel.js') {
    assert.doesNotMatch(executableSource, /\bsetInterval\s*\(/u, `${name} adds a player action timeout/countdown`);
  }
  assert.doesNotMatch(executableSource, /\b(?:localStorage|sessionStorage|indexedDB)\b/u, `${name} persists member-projected text or sidecars in browser storage`);
}

const panelSource = sources.find(item => item.name === 'multiplayer-panel.js').source;
for (const requiredControl of [
  'existing_save_derived',
  'new_multiplayer_save',
  'join-room-form',
  'guest-character-details',
  'guest-character-file',
  'guest-character-label',
  'ready-room',
  'genesis-review',
  'genesis-review-status',
  'genesis-audience-diff',
  'active-action-visibility',
  'mode-shared',
  'mode-dual',
  'room-profile',
  'room-profile-field',
  'room-profile-requirement',
  'confirm-ai-settings',
  'edit-ai-settings',
  'ai-settings-summary',
  'ai-settings-summary-title',
  'ai-settings-summary-detail',
  'ai-settings-editor',
  'main-api-scheme',
  'import-main-api-scheme',
  'credential-current-turn',
  'credential-policy-status',
  'credential-binding-status',
  'ai-data-fee-details',
  'chat-form',
  'turn-recovery',
  'retry-turn',
  'propose-void',
  'accept-void',
  'room-tools',
  'propose-archive',
  'accept-archive',
  'stage-latest-source',
  'propose-continuation',
  'accept-continuation',
  'begin-export',
  'download-export',
  'member-list',
  'connection-status',
  'copy-room-code',
  'copy-invite-code',
  'copy-room-invite'
]) {
  assert.equal(panelSource.includes(requiredControl), true, `missing core multiplayer control ${requiredControl}`);
}
assert.match(panelSource, /id="turn-recovery"[^>]*hidden/u);
assert.match(panelSource, /<details id="room-tools"/u);
assert.match(panelSource, /<details id="guest-character-details"/u);
assert.match(
  panelSource,
  /id="active-action-visibility"[\s\S]*?<option value="sealed">[\s\S]*?<option value="open">/u
);
assert.equal(
  (panelSource.match(/data-credential-policy="(?:A_ONLY|B_ONLY|ALTERNATE)"/gu) ?? []).length,
  3,
  'credential choice must expose exactly three mutually exclusive policies'
);
for (const policy of ['A_ONLY', 'B_ONLY', 'ALTERNATE']) {
  assert.match(panelSource, new RegExp(`data-credential-policy="${policy}"`, 'u'));
}
for (const removedControl of [
  'new-era',
  'new-preset',
  'custom-room-code',
  'custom-invite-code',
  'restore-room',
  'refresh-room',
  'copy-current-room',
  'action-form',
  'action-text',
  'action-visibility',
  'narration-preference',
  'narration-note',
  'open-api-settings',
  'api-profile-management',
  'credential-form',
  'load-main-api-scheme',
  'refresh-main-api-schemes',
  'credential-rotate-form',
  'revoke-credential',
  'profile-form',
  'profile-model-options',
  'fetch-profile-models',
  'edit-profile',
  'probe-profile',
  'revoke-profile',
  'state-output',
  'memory-output',
  'daily-output',
  'timeline-output',
  'lineage-output',
  'probe-output',
  'void-proposal',
  'archive-proposal',
  'continuation-proposal',
  'export-output',
  'latest-source-import-id',
  'audience-diff-commitment',
  'export-id',
  'select-shared-payer',
  'select-pov-a',
  'select-pov-b',
  'payer-selections',
  'shared-profile',
  'pov-a-profile',
  'pov-b-profile',
  'bind-room-profile',
  'grant-form',
  'revoke-grant',
  'consent-form',
  'revoke-consent',
  'billing-authorization-form',
  'amendment-form',
  'accept-amendment',
  'billing-plan'
]) {
  assert.doesNotMatch(
    panelSource,
    new RegExp(`id="${removedControl}"`, 'u'),
    `non-core multiplayer control ${removedControl} must stay out of the normal UI`
  );
}
assert.doesNotMatch(panelSource, /data-(?:tab|view)="advanced"/u);
for (const internalFieldLabel of [
  'selection hash',
  'profile 配置指纹',
  'future_stage_changes',
  'grant ID',
  'grant revision'
]) {
  assert.doesNotMatch(
    panelSource,
    new RegExp(internalFieldLabel, 'u'),
    `internal authorization field ${internalFieldLabel} must stay out of the player UI`
  );
}
assert.equal(panelSource.includes('destroy()'), true, 'custom element must expose explicit teardown');
assert.doesNotMatch(panelSource, /insertAdjacentHTML|document\.write|\.outerHTML\s*=/u);
assert.equal((panelSource.match(/\.innerHTML\s*=/gu) ?? []).length, 1);
assert.match(panelSource, /shadowRoot\.innerHTML\s*=\s*shellTemplate\(\)/u);

const aiSettingsCalls = [];
const aiSettingsPanel = new NarutoMultiplayerPanel();
aiSettingsPanel._controller = {
  state: {
    room: {
      viewer_seat: 'B',
      credential_policy: {
        policy_revision: 0,
        policy: 'ALTERNATE',
        viewer_accepted: false
      }
    },
    modelProfiles: [{
      profile: {
        profile_id: 'profile_b',
        recommended_continuity_transport: 'strict_json'
      }
    }]
  },
  store: { setError(error) { assert.equal(error, null); } },
  async bindRoomModelProfile(profileId) { aiSettingsCalls.push(`bind:${profileId}`); },
  async chooseCredentialUsagePolicy(policy) {
    aiSettingsCalls.push(`policy:${policy}`);
    return { policy };
  }
};
aiSettingsPanel.$ = selector => (selector === '#room-profile' ? { value: 'profile_b' } : null);
aiSettingsPanel._renderCredentialPolicy = () => {};
aiSettingsPanel._selectedCredentialPolicy = 'A_ONLY';
await aiSettingsPanel._confirmAiSettings();
assert.deepEqual(
  aiSettingsCalls,
  ['policy:A_ONLY'],
  'seat B must not configure a profile when the room only uses seat A credentials'
);
aiSettingsCalls.length = 0;
aiSettingsPanel._selectedCredentialPolicy = 'ALTERNATE';
await aiSettingsPanel._confirmAiSettings();
assert.deepEqual(
  aiSettingsCalls,
  ['bind:profile_b', 'policy:ALTERNATE'],
  'alternate credentials must bind the viewer profile before confirming the policy'
);

const actionVisibility = { value: 'sealed' };
const actionOptionsPanel = new NarutoMultiplayerPanel();
actionOptionsPanel.$ = selector => (
  selector === '#active-action-visibility' ? actionVisibility : null
);
assert.deepEqual(actionOptionsPanel.actionOptions, {
  visibility: 'sealed',
  narrationPreference: 'full'
});
actionVisibility.value = 'open';
assert.deepEqual(actionOptionsPanel.actionOptions, {
  visibility: 'open',
  narrationPreference: 'full'
});

const genesisReviewElements = Object.fromEntries([
  '#genesis-review',
  '#genesis-review-status',
  '#genesis-review-detail',
  '#genesis-audience-diff'
].map(selector => [selector, { hidden: true, textContent: '' }]));
const genesisReviewPanel = new NarutoMultiplayerPanel();
genesisReviewPanel.$ = selector => genesisReviewElements[selector];
genesisReviewPanel._renderGenesisReview({
  room: { origin_type: 'existing_save_derived' },
  genesisReview
});
assert.equal(genesisReviewElements['#genesis-review'].hidden, false);
assert.match(genesisReviewElements['#genesis-review-status'].textContent, /起点导入确认/u);
assert.doesNotMatch(genesisReviewElements['#genesis-review-status'].textContent, /revision/iu);
assert.match(genesisReviewElements['#genesis-review-detail'].textContent, /我的确认：待确认/u);
assert.match(genesisReviewElements['#genesis-audience-diff'].textContent, /你将控制客方角色/u);
assert.doesNotMatch(
  genesisReviewElements['#genesis-audience-diff'].textContent,
  /"(?:schema|audience|audience_role|category)"/u
);

controller.disconnect({ reset: true });
assert.equal(controller.state.turn, null);
assert.deepEqual(controller.state.chat.messages, []);
assert.equal(controller.state.latestEvent, null);
console.log('multiplayer UI state/SSE/custom-element regression: core surface passed');
