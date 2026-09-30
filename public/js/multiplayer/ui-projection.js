import { ROOM_SEATS, turnProgressLabel } from './contracts.js';

export const ACTION_SUBMISSION_OPEN_STATUSES = Object.freeze([
  'COLLECTING_ACTIONS',
  'ONE_ACTION_LOCKED'
]);

const GENERATING_TURN_STATUSES = Object.freeze([
  'SEALED',
  'RESOLVING',
  'RENDERING',
  'STAGING_UPDATES',
  'AUDITING',
  'REPAIRING_DRAFT',
  'RENDERING_REPAIR',
  'RESOLUTION_HANDOFF',
  'COMMITTING',
  'RECOVERING_COMMIT'
]);

export function isGeneratingTurnStatus(status) {
  return GENERATING_TURN_STATUSES.includes(status);
}

const MODEL_STAGES = Object.freeze({
  referee: [0, '裁定剧情'], resolution_repair: [0, '修正剧情裁决'],
  resolution_completeness_reviewer: [0, '核对剧情裁决'],
  writer: [1, '生成正文'], narrative_grounding_reviewer: [1, '审核正文'],
  continuity_steward: [2, '整理记忆与日报'], continuity_repair: [2, '修正记忆与日报']
});

/** One presentation for the main panel, compact overlay and minimized launcher. */
export function projectedGenerationProgress(state, now = Date.now()) {
  const status = state?.turn?.status ?? state?.progress?.status;
  const progress = state?.progress ?? {};
  const opening = isProjectedOpeningTurn(state);
  const retryable = ['REPAIR_PAUSED', 'RETRYABLE_FAILED'].includes(status);
  const failed = retryable || status === 'CONSISTENCY_FAULT';
  const generating = isGeneratingTurnStatus(status);
  const heartbeat = Date.parse(progress.heartbeatAt);
  const stale = generating && Number.isFinite(heartbeat) && now - heartbeat > 90_000;
  const disconnected = generating && state?.connection?.status !== 'open';
  const uncertain = disconnected || stale;
  const complete = status === 'COMMITTED';
  let step = MODEL_STAGES[progress.modelStage]?.[0]
    ?? (['STAGING_UPDATES', 'REPAIRING_DRAFT', 'REPAIR_PAUSED'].includes(status) ? 2
      : ['RENDERING', 'RENDERING_REPAIR', 'AUDITING'].includes(status) ? 1 : 0);
  if (['COMMITTING', 'RECOVERING_COMMIT', 'COMMITTED'].includes(status)) step = 3;
  const stage = MODEL_STAGES[progress.modelStage]?.[1]
    ?? (step === 3 ? '发布回合' : turnProgressLabel(status));
  const name = opening ? '开场' : '本回合';
  let title = generating ? `${name}生成中 · ${stage}` : turnProgressLabel(status);
  let detail = generating
    ? (step === 2 ? '正文已生成，正在完成记忆与日报；全部核对通过后一起发布。'
      : '服务器正在处理这一阶段，完成后会自动进入下一步。')
    : (complete ? '正文与状态已发布。' : '双方行动锁定后会自动开始生成。');
  if (failed) {
    title = `${name}生成已暂停`;
    const kind = progress.failureKind === 'memory' ? '记忆'
      : progress.failureKind === 'shinobi_daily' ? '日报' : '状态更新';
    detail = step === 2
      ? `正文已生成，但${kind}未通过校验。后台已停止生成；重试将保留已完成内容，只继续未完成步骤。`
      : '后台已停止生成。已完成的步骤会保留，请重试未完成步骤。';
    if (status === 'CONSISTENCY_FAULT') detail = '回合状态核对失败，服务器已停止处理，请保留诊断信息。';
    if (progress.detail) detail += ` ${progress.detail}`;
  } else if (uncertain) {
    title = '生成状态待确认';
    detail = stale
      ? '暂未收到新的服务器心跳，正在同步状态。请勿重复发起生成。'
      : '实时连接已断开，正在重新确认服务器状态；此时无法确认是否仍在生成。';
  }
  const started = Date.parse(progress.startedAt);
  const stopped = Date.parse(progress.updatedAt);
  const elapsedSeconds = Number.isFinite(started)
    ? Math.max(0, Math.floor((((failed || complete || uncertain) && Number.isFinite(stopped) ? stopped : now) - started) / 1000))
    : null;
  const diagnostics = [
    `房间：${state?.room?.room_code ?? state?.roomId ?? '未知'}`,
    `回合：${state?.turn?.turn_no ?? '未知'} · ${status ?? '同步中'}`,
    `阶段：${stage}${progress.attempt ? ` · 第 ${progress.attempt} 次调用` : ''}`,
    progress.errorCode ? `错误：${progress.errorCode}` : null,
    progress.repairAttempts ? `本次自动尝试：${progress.repairAttempts} 次` : null,
    progress.remainingItems ? `待修复：${progress.remainingItems} 项` : null,
    progress.updatedAt ? `最后更新：${progress.updatedAt}` : null,
    progress.detail
  ].filter(Boolean).join('\n');
  return Object.freeze({ status, title, detail, diagnostics, stage, elapsedSeconds,
    running: generating && !uncertain, retryable, attempt: progress.attempt ?? null,
    tone: failed ? 'error' : uncertain ? 'warning' : generating ? 'running' : complete ? 'success' : 'idle',
    steps: ['裁定剧情', '生成正文', '记忆与日报', '发布回合'].map((label, index) => ({
      label, state: complete || (generating || failed) && index < step ? 'done'
        : (generating || failed) && index === step ? (failed ? 'paused' : uncertain ? 'unknown' : 'active') : 'waiting'
    }))
  });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function isActionSubmissionOpen(status) {
  return ACTION_SUBMISSION_OPEN_STATUSES.includes(status);
}

export function isProjectedOpeningTurn(state) {
  const turn = state?.turn;
  if (turn?.turn_kind === 'OPENING') return true;
  if (turn?.turn_kind === 'ACTION') return false;
  return state?.room?.origin_type === 'new_multiplayer_save'
    && turn?.turn_no === 1
    && state?.room?.state_revision === 0;
}

/**
 * Client-side affordance only. The server remains authoritative and repeats
 * the same status/revision checks when the action is locked.
 */
export function canSubmitProjectedAction(state) {
  const room = state?.room;
  const turn = state?.turn;
  const context = state?.turnContext;
  const viewerSeat = turn?.viewer_seat ?? room?.viewer_seat;
  const ownAction = ROOM_SEATS.includes(viewerSeat)
    ? turn?.actions?.[viewerSeat]
    : null;
  return Boolean(
    room?.lifecycle === 'ACTIVE'
    && !isProjectedOpeningTurn(state)
    && isActionSubmissionOpen(turn?.status)
    && Number.isSafeInteger(context?.epochNo)
    && context.epochNo > 0
    && Number.isSafeInteger(context?.turnNo)
    && context.turnNo > 0
    && context.turnId === turn?.turn_id
    && context.turnNo === turn?.turn_no
    && ownAction?.locked !== true
  );
}

export function actionSubmissionUnavailableMessage(state) {
  const room = state?.room;
  const turn = state?.turn;
  const status = turn?.status ?? state?.progress?.status ?? null;
  const viewerSeat = turn?.viewer_seat ?? room?.viewer_seat;
  const ownAction = ROOM_SEATS.includes(viewerSeat)
    ? turn?.actions?.[viewerSeat]
    : null;
  const openingTurn = isProjectedOpeningTurn(state);

  if (room?.lifecycle !== 'ACTIVE') return '联机房间尚未进入行动阶段。';
  if (status === 'AWAITING_PAYER_SELECTION') {
    return openingTurn
      ? '联机 AI 设置尚未完成，请打开完整联机设置并让双方确认凭证与模型。'
      : '本回合联机凭证与模型尚未就绪，请打开完整联机设置。';
  }
  if (status === 'AWAITING_BILLING_AUTHORIZATION') {
    return openingTurn
      ? '正在授权模型并准备根据双方开局生成第一回合。'
      : '本回合正在等待凭证授权，请打开联机悬浮窗查看。';
  }
  if (GENERATING_TURN_STATUSES.includes(status)) {
    return openingTurn
      ? '正在根据双方开局生成第一回合，并初始化角色、世界、资源与记忆。'
      : '双方行动已发送，正在生成本回合正文。';
  }
  if (status === 'COMMITTED') {
    return openingTurn
      ? '第一回合开场已生成，正在开启玩家行动回合。'
      : '本回合已完成，正在开启下一回合。';
  }
  if (status === 'RETRYABLE_FAILED' || status === 'REPAIR_PAUSED') {
    return '本回合生成已暂停，请在联机悬浮窗中重试。';
  }
  if (status === 'VOID_REQUESTED') return '本回合正在等待共同作废处理。';
  if (status === 'TURN_VOIDED') return '本回合已作废，正在开启下一回合。';
  if (status === 'CONSISTENCY_FAULT') return '联机回合发生一致性故障，已停止提交行动。';
  if (openingTurn && isActionSubmissionOpen(status)) {
    return '开场资料已确认，服务器正在启动第一回合生成。';
  }
  if (isActionSubmissionOpen(status) && ownAction?.locked === true) {
    return '本回合行动已经发送，正在等待对方。';
  }
  if (isActionSubmissionOpen(status)) return '联机回合状态正在同步，请稍候。';
  return status
    ? `当前暂不能提交行动：${turnProgressLabel(status)}。`
    : '联机回合状态正在同步，请稍候。';
}

/**
 * Action cards are built only from the authenticated turn projection. A
 * locked boolean or reveal SSE event is never treated as proof that text may
 * be reconstructed locally.
 */
export function projectedActionCards(turn) {
  return ROOM_SEATS.map(seat => {
    const action = turn?.actions?.[seat] ?? { seat, locked: false };
    const text = nonEmptyString(action.text);
    return Object.freeze({
      seat,
      locked: action.locked === true,
      text,
      disclosure: nonEmptyString(action.disclosure),
      submissionId: nonEmptyString(action.submission_id),
      receipt: action.receipt && typeof action.receipt === 'object'
        ? action.receipt
        : null
    });
  });
}

function deliveryText(value) {
  const direct = nonEmptyString(value?.text);
  if (direct) return direct;
  if (!Array.isArray(value?.segments)) return null;
  const parts = value.segments
    .map(segment => nonEmptyString(segment?.text))
    .filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}

export function projectedNarrativeDeliveries(turn) {
  const source = turn?.status === 'COMMITTED'
    ? (turn?.commit?.narratives ?? null)
    : null;
  let values = [];
  if (Array.isArray(source)) values = source;
  else if (source && typeof source === 'object') {
    if (source.segments || source.text) values = [source];
    else values = Object.entries(source).map(([audience, value]) => ({
      ...(value && typeof value === 'object' ? value : { text: value }),
      audience: value?.audience ?? audience
    }));
  }
  return Object.freeze(values.map((delivery, index) => Object.freeze({
    audience: nonEmptyString(delivery?.audience) ?? (values.length === 1 ? 'shared' : `#${index + 1}`),
    text: deliveryText(delivery),
    hash: nonEmptyString(delivery?.narrative_hash)
      ?? nonEmptyString(delivery?.hash)
      ?? null
  })).filter(delivery => delivery.text));
}

export function projectedDaily(turn) {
  return turn?.status === 'COMMITTED'
    ? (turn?.commit?.shinobi_daily ?? null)
    : null;
}

export function projectedAuthoritativeState(turn) {
  return turn?.status === 'COMMITTED'
    ? (turn?.commit?.state ?? null)
    : null;
}

export function projectedMemories(turn) {
  return projectedAuthoritativeState(turn)?.memories ?? null;
}

export function projectedTimeline(turn, lineage) {
  return lineage?.checkpoints ?? [];
}

export function profileList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.profiles)) return value.profiles;
  return [];
}

export function credentialList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.credentials)) return value.credentials;
  return [];
}

export function safeDisplayJson(value) {
  if (value === undefined || value === null) return '暂无';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '（无法显示服务端投影）';
  }
}
