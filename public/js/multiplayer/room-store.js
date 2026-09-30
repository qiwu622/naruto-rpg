import { turnProgressLabel } from './contracts.js';
import { multiplayerErrorMessage } from './error-presentation.js';

class StoreListeners {
  constructor() {
    this.values = new Set();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('store listener must be a function');
    this.values.add(listener);
    return () => this.values.delete(listener);
  }

  emit(value) {
    for (const listener of this.values) {
      try {
        listener(value);
      } catch {
        // Rendering failures are isolated from the authoritative session state.
      }
    }
  }
}

function initialState() {
  return Object.freeze({
    roomId: null,
    room: null,
    invite: null,
    genesis: null,
    genesisReview: null,
    lineage: null,
    turnContext: null,
    turn: null,
    latestCommittedTurn: null,
    billingPlan: null,
    modelProfiles: Object.freeze([]),
    credentials: Object.freeze([]),
    latestSourceImport: null,
    payerSelections: Object.freeze({ shared: null, A: null, B: null }),
    chat: Object.freeze({ messages: Object.freeze([]), nextBefore: null }),
    presence: Object.freeze({}),
    connection: Object.freeze({ status: 'idle', lastEventSeq: 0 }),
    progress: Object.freeze({
      status: null,
      label: turnProgressLabel(null),
      resumeStage: null,
      detail: null
    }),
    proposals: Object.freeze({
      void: null,
      archive: null,
      continuation: null,
      amendment: null
    }),
    latestExport: null,
    latestEvent: null,
    notices: Object.freeze([]),
    lastError: null
  });
}

function asArray(value, field) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[field])) return value[field];
  return [];
}

function mergeMessages(current, incoming) {
  const byId = new Map();
  for (const message of [...current, ...incoming]) {
    if (!message || typeof message.message_id !== 'string') continue;
    byId.set(message.message_id, message);
  }
  return Object.freeze([...byId.values()].sort((left, right) => (
    (Number(left.event_seq) || 0) - (Number(right.event_seq) || 0)
  )));
}

function resolutionProgressDetail(payload) {
  const errorCode = payload.error_code ?? payload.reason ?? null;
  if (typeof payload.detail === 'string') {
    return multiplayerErrorMessage({
      code: errorCode,
      message: payload.detail,
      status: 0,
      details: {}
    });
  }
  const detail = payload.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    return multiplayerErrorMessage({
      code: errorCode,
      message: payload.message,
      status: 0,
      details: detail
    });
  }
  if (errorCode) {
    return multiplayerErrorMessage({
      code: errorCode,
      message: payload.message,
      status: 0,
      details: {}
    });
  }
  return payload.resumed_from ?? null;
}

function generationProgress(payload, status, turnId, updatedAt = null) {
  return Object.freeze({
    status, turnId, label: turnProgressLabel(status),
    modelStage: payload.model_stage ?? null,
    attempt: payload.attempt ?? null,
    runStatus: payload.run_status ?? null,
    startedAt: payload.started_at ?? null,
    updatedAt: payload.updated_at ?? updatedAt,
    heartbeatAt: payload.heartbeat_at ?? null,
    resumeStage: payload.resume_stage ?? null,
    errorCode: payload.error_code ?? payload.reason ?? null,
    failureKind: payload.failure_kind ?? payload.detail?.failure_kind ?? null,
    repairAttempts: payload.repair_attempts ?? payload.detail?.repair_attempts ?? null,
    remainingItems: payload.remaining_items ?? payload.detail?.remaining_items ?? null,
    detail: resolutionProgressDetail(payload)
  });
}

function eventNotice(envelope) {
  return Object.freeze({
    event_seq: envelope.event_seq,
    event_type: envelope.event_type,
    created_at: envelope.created_at,
    payload: envelope.payload
  });
}

function projectedPayerSelections(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return Object.freeze({
    shared: value.shared ?? null,
    A: value.A ?? null,
    B: value.B ?? null
  });
}

/**
 * Projection store. It never runs reducers and never accepts canonical state
 * patches from UI code: all values originate in authenticated REST/SSE member
 * projections.
 */
export class MultiplayerRoomStore {
  constructor() {
    this.state = initialState();
    this.listeners = new StoreListeners();
  }

  subscribe(listener, { emitCurrent = true } = {}) {
    const unsubscribe = this.listeners.subscribe(listener);
    if (emitCurrent) listener(this.state);
    return unsubscribe;
  }

  reset() {
    this.state = initialState();
    this.listeners.emit(this.state);
  }

  patch(values) {
    this.state = Object.freeze({ ...this.state, ...values });
    this.listeners.emit(this.state);
    return this.state;
  }

  setRoom(room) {
    const value = room?.room ?? room;
    return this.patch({
      roomId: value?.room_id ?? this.state.roomId,
      room: value ?? null,
      latestCommittedTurn: this.state.room?.room_id === value?.room_id
        && this.state.room?.active_epoch_id === value?.active_epoch_id ? this.state.latestCommittedTurn : null,
      genesisReview: room?.genesis_review ?? value?.genesis_review ?? null,
      progress: this.state.progress.status || !value?.lifecycle
        ? this.state.progress
        : Object.freeze({
            ...this.state.progress,
            detail: `房间状态：${value.lifecycle}`
          })
    });
  }

  setLineage(lineage) {
    return this.patch({ lineage: lineage ?? null });
  }

  setGenesisReview(review) {
    return this.patch({ genesisReview: review ?? null });
  }

  setTurnContext(context) {
    if (!context) return this.patch({ turnContext: null });
    const prior = this.state.turnContext;
    const field = (camelName, snakeName) => {
      if (Object.prototype.hasOwnProperty.call(context, camelName)
        && context[camelName] !== undefined) return context[camelName];
      if (Object.prototype.hasOwnProperty.call(context, snakeName)
        && context[snakeName] !== undefined) return context[snakeName];
      return prior?.[camelName] ?? null;
    };
    return this.patch({
      turnContext: Object.freeze({
        epochId: field('epochId', 'epoch_id'),
        epochNo: field('epochNo', 'epoch_no'),
        turnId: field('turnId', 'turn_id'),
        turnNo: field('turnNo', 'turn_no')
      })
    });
  }

  setTurn(turn) {
    const status = turn?.status ?? this.state.progress.status;
    const progress = turn?.generation
      ? generationProgress(turn.generation, status, turn.turn_id)
      : (turn?.turn_id === this.state.turn?.turn_id && status === this.state.progress.status
          ? this.state.progress : generationProgress({}, status, turn?.turn_id));
    const context = turn
      ? {
          epochId: turn.epoch_id,
          turnId: turn.turn_id,
          turnNo: turn.turn_no
        }
      : null;
    if (context) this.setTurnContext(context);
    return this.patch({
      turn: turn ?? null,
      latestCommittedTurn: turn?.status === 'COMMITTED' && turn.commit
        ? turn : (turn?.epoch_id && this.state.latestCommittedTurn?.epoch_id !== turn.epoch_id
          ? null : this.state.latestCommittedTurn),
      payerSelections: projectedPayerSelections(
        turn?.payer_selections,
        this.state.payerSelections
      ),
      progress: Object.freeze({
        ...progress,
        status,
        label: turnProgressLabel(status)
      })
    });
  }

  setBillingPlan(plan) {
    return this.patch({ billingPlan: plan ?? null });
  }

  setProfiles(value) {
    return this.patch({ modelProfiles: Object.freeze([...asArray(value, 'profiles')]) });
  }

  setCredentials(value) {
    return this.patch({ credentials: Object.freeze([...asArray(value, 'credentials')]) });
  }

  setChatPage(value, { replace = false } = {}) {
    const messages = asArray(value, 'messages');
    return this.patch({
      chat: Object.freeze({
        messages: replace
          ? mergeMessages([], messages)
          : mergeMessages(this.state.chat.messages, messages),
        nextBefore: value?.next_before ?? null
      })
    });
  }

  appendChatMessage(message) {
    return this.patch({
      chat: Object.freeze({
        ...this.state.chat,
        messages: mergeMessages(this.state.chat.messages, [message])
      })
    });
  }

  setProposal(kind, value) {
    if (!Object.prototype.hasOwnProperty.call(this.state.proposals, kind)) {
      throw new TypeError(`unknown proposal kind ${kind}`);
    }
    return this.patch({
      proposals: Object.freeze({ ...this.state.proposals, [kind]: value ?? null })
    });
  }

  setConnection(value) {
    return this.patch({
      connection: Object.freeze({
        ...this.state.connection,
        ...value,
        lastEventSeq: value?.last_event_seq
          ?? value?.lastEventSeq
          ?? this.state.connection.lastEventSeq
      })
    });
  }

  setError(error) {
    if (!error) return this.patch({ lastError: null });
    return this.patch({
      lastError: Object.freeze({
        code: error.code ?? 'MULTIPLAYER_UI_ERROR',
        message: error.message ?? String(error),
        status: error.status ?? 0,
        details: error.details ?? {}
      })
    });
  }

  applyEvent(envelope) {
    if (!envelope || envelope.room_id !== this.state.roomId) return false;
    if (envelope.event_seq <= this.state.connection.lastEventSeq) return false;
    const payload = envelope.payload && typeof envelope.payload === 'object'
      ? envelope.payload
      : {};
    const next = {
      latestEvent: envelope,
      connection: Object.freeze({
        ...this.state.connection,
        lastEventSeq: envelope.event_seq
      }),
      notices: Object.freeze([
        ...this.state.notices,
        eventNotice(envelope)
      ].slice(-40))
    };

    switch (envelope.event_type) {
      case 'room.snapshot':
        next.room = Object.freeze({ ...(this.state.room ?? {}), ...payload });
        if (Object.prototype.hasOwnProperty.call(payload, 'genesis_review')) {
          next.genesisReview = payload.genesis_review ?? null;
        }
        break;
      case 'room.opening_changed':
      case 'room.opening_committed':
        next.room = Object.freeze({
          ...(this.state.room ?? {}),
          lifecycle: payload.lifecycle ?? this.state.room?.lifecycle,
          active_epoch_id: payload.active_epoch_id ?? this.state.room?.active_epoch_id,
          control_revision: payload.control_revision ?? this.state.room?.control_revision,
          opening: payload.opening ?? this.state.room?.opening
        });
        break;
      case 'member.presence_changed': {
        const seat = payload.seat ?? payload.member_seat;
        if (['A', 'B'].includes(seat)) {
          next.presence = Object.freeze({ ...this.state.presence, [seat]: payload });
        }
        break;
      }
      case 'chat.message_created':
        next.chat = Object.freeze({
          ...this.state.chat,
          messages: mergeMessages(this.state.chat.messages, [payload])
        });
        break;
      case 'narrative_mode.changed':
        next.room = Object.freeze({
          ...(this.state.room ?? {}),
          active_narrative_mode: payload.mode,
          queued_narrative_mode: null,
          control_revision: payload.control_revision ?? this.state.room?.control_revision
        });
        if (this.state.turn) {
          next.turn = Object.freeze({
            ...this.state.turn,
            active_narrative_mode: payload.mode,
            narrative_mode: payload.mode
          });
        }
        break;
      case 'narrative_mode.queued':
        next.room = Object.freeze({
          ...(this.state.room ?? {}),
          queued_narrative_mode: payload.mode,
          control_revision: payload.control_revision ?? this.state.room?.control_revision
        });
        break;
      case 'turn.opened':
        next.turnContext = Object.freeze({
          epochId: envelope.epoch_id,
          epochNo: this.state.turnContext?.epochId === envelope.epoch_id
            ? (this.state.turnContext?.epochNo ?? null)
            : null,
          turnId: payload.turn_id ?? envelope.turn_id,
          turnNo: payload.turn_no
        });
        next.turn = Object.freeze({
          turn_id: payload.turn_id ?? envelope.turn_id,
          turn_no: payload.turn_no,
          turn_kind: payload.turn_kind,
          viewer_seat: payload.viewer_seat ?? this.state.room?.viewer_seat,
          status: payload.status,
          active_narrative_mode: payload.narrative_mode,
          actions: Object.freeze({
            A: Object.freeze({ seat: 'A', locked: false }),
            B: Object.freeze({ seat: 'B', locked: false })
          })
        });
        next.payerSelections = Object.freeze({ shared: null, A: null, B: null });
        next.progress = Object.freeze({
          status: payload.status,
          label: turnProgressLabel(payload.status),
          resumeStage: null,
          detail: null
        });
        break;
      case 'action.locked': {
        const seat = payload.seat;
        if (['A', 'B'].includes(seat)) {
          next.turn = Object.freeze({
            ...(this.state.turn ?? {}),
            actions: Object.freeze({
              ...(this.state.turn?.actions ?? {}),
              [seat]: Object.freeze({
                ...(this.state.turn?.actions?.[seat] ?? { seat }),
                ...payload,
                seat,
                locked: true
              })
            })
          });
        }
        break;
      }
      case 'action.revealed_pre_resolution':
        next.turn = Object.freeze({
          ...(this.state.turn ?? {}),
          reveal_refresh_submission_id: payload.submission_id ?? null
        });
        break;
      case 'turn.sealed':
        next.turn = Object.freeze({ ...(this.state.turn ?? {}), status: payload.status ?? 'SEALED' });
        next.progress = Object.freeze({
          ...this.state.progress,
          status: payload.status ?? 'SEALED',
          label: turnProgressLabel(payload.status ?? 'SEALED')
        });
        break;
      case 'billing.credential_policy_changed':
        next.room = Object.freeze({
          ...(this.state.room ?? {}),
          credential_policy: payload.credential_policy ?? this.state.room?.credential_policy
        });
        next.progress = Object.freeze({
          ...this.state.progress,
          detail: '联机凭证策略已更新'
        });
        break;
      case 'billing.plan_ready':
      case 'billing.plan_amended':
      case 'billing.authorization_required':
      case 'billing.consent_required':
      case 'billing.grant_changed':
      case 'billing.payer_selection_required':
      case 'billing.payer_selection_changed':
        next.progress = Object.freeze({
          ...this.state.progress,
          detail: payload.message ?? payload.status ?? envelope.event_type
        });
        break;
      case 'resolution.progress': {
        const status = payload.status ?? payload.stage ?? this.state.progress.status;
        next.turn = Object.freeze({ ...(this.state.turn ?? {}), status });
        next.progress = generationProgress(payload, status, payload.turn_id ?? envelope.turn_id, envelope.created_at);
        break;
      }
      case 'turn.repairing_draft':
      case 'turn.repair_paused':
      case 'turn.repair_resumed':
      case 'turn.retryable_failed': {
        const statusByEvent = {
          'turn.repairing_draft': 'REPAIRING_DRAFT',
          'turn.repair_paused': 'REPAIR_PAUSED',
          'turn.repair_resumed': payload.status ?? payload.resume_stage ?? 'REPAIRING_DRAFT',
          'turn.retryable_failed': 'RETRYABLE_FAILED'
        };
        const status = statusByEvent[envelope.event_type];
        next.turn = Object.freeze({ ...(this.state.turn ?? {}), status });
        next.progress = generationProgress(payload, status, payload.turn_id ?? envelope.turn_id, envelope.created_at);
        break;
      }
      case 'action.revealed_after_commit':
        next.turn = Object.freeze({
          ...(this.state.turn ?? {}),
          full_disclosure_available: true
        });
        break;
      case 'turn.committed':
        next.turn = Object.freeze({
          ...(this.state.turn ?? {}),
          status: 'COMMITTED',
          checkpoint_id: payload.checkpoint_id ?? this.state.turn?.checkpoint_id,
          state_revision: payload.state_revision ?? this.state.turn?.state_revision
        });
        next.room = Object.freeze({
          ...(this.state.room ?? {}),
          state_revision: payload.state_revision ?? this.state.room?.state_revision
        });
        next.progress = Object.freeze({
          status: 'COMMITTED',
          label: turnProgressLabel('COMMITTED'),
          resumeStage: null,
          detail: null
        });
        break;
      case 'room.archived':
      case 'lineage.room_archived':
        next.room = Object.freeze({ ...(this.state.room ?? {}), lifecycle: 'ARCHIVED' });
        break;
      case 'lineage.proposal_created': {
        const kind = payload.proposal_type === 'void_turn'
          ? 'void'
          : (payload.proposal_type === 'archive_room' ? 'archive' : 'continuation');
        next.proposals = Object.freeze({
          ...this.state.proposals,
          [kind]: Object.freeze({ ...payload, status: 'OPEN' })
        });
        break;
      }
      case 'lineage.proposal_acceptance_changed': {
        const entries = Object.entries(this.state.proposals);
        const match = entries.find(([, proposal]) => (
          proposalValueId(proposal) === payload.proposal_id
        ));
        if (match) {
          next.proposals = Object.freeze({
            ...this.state.proposals,
            [match[0]]: Object.freeze({
              ...(match[1]?.proposal ?? match[1] ?? {}),
              ...payload,
              status: payload.proposal_status
            })
          });
        }
        break;
      }
      case 'turn.void_requested':
      case 'turn.voided': {
        const status = payload.status
          ?? (envelope.event_type === 'turn.voided' ? 'TURN_VOIDED' : 'VOID_REQUESTED');
        next.turn = Object.freeze({ ...(this.state.turn ?? {}), status });
        next.room = Object.freeze({
          ...(this.state.room ?? {}),
          control_revision: payload.control_revision ?? this.state.room?.control_revision
        });
        next.progress = Object.freeze({
          status,
          label: turnProgressLabel(status),
          resumeStage: null,
          detail: null
        });
        break;
      }
      case 'room.continuation_prepared':
        next.proposals = Object.freeze({
          ...this.state.proposals,
          continuation: payload
        });
        break;
      case 'room.epoch_activated':
      case 'lineage.epoch_activated':
        next.room = Object.freeze({
          ...(this.state.room ?? {}),
          lifecycle: 'ACTIVE',
          active_epoch_id: payload.epoch_id ?? envelope.epoch_id,
          state_revision: payload.state_revision ?? this.state.room?.state_revision
        });
        break;
      case 'room.singleplayer_export_ready':
        next.latestExport = payload;
        break;
      default:
        break;
    }
    this.patch(next);
    return true;
  }
}

function proposalValueId(value) {
  return value?.proposal?.proposal_id ?? value?.proposal_id ?? null;
}

export { mergeMessages };
