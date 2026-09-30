const EXACT_MESSAGES = Object.freeze({
  MULTIPLAYER_UI_ERROR: '界面操作失败，请刷新页面后重试',
  MULTIPLAYER_REQUEST_FAILED: '联机请求失败，请稍后重试',
  MULTIPLAYER_NETWORK_ERROR: '无法连接联机服务，请检查网络后重试',
  MULTIPLAYER_RESPONSE_INVALID: '联机服务返回了无法识别的数据',
  SSE_PROTOCOL_ERROR: '联机实时连接出现异常，正在尝试恢复',
  CAPABILITY_PROBE_REQUIRED: '当前回合仍引用旧版模型能力检测，请重新确认 API 方案',
  CAPABILITY_PROBE_INSUFFICIENT: '当前回合的旧版能力记录已失效，请重新确认 API 方案',
  CAPABILITY_PROBE_BUDGET_INSUFFICIENT: '旧版模型能力检测预算不足，请重新确认 API 方案',
  CAPABILITY_PROBE_RESULT_INVALID: '旧版模型能力检测记录无效，请重新确认 API 方案',
  MODEL_ENDPOINT_UPSTREAM_ERROR: '模型服务拒绝了本次请求，请检查 API 方案与模型设置',
  MODEL_ENDPOINT_REQUEST_FAILED: '无法连接模型服务，请检查 API 地址与网络代理',
  MODEL_ENDPOINT_REQUEST_TIMEOUT: '模型服务响应超时，请稍后重试',
  MODEL_ENDPOINT_REQUEST_ABORTED: '模型请求已取消',
  MODEL_ENDPOINT_RESPONSE_INVALID: '模型服务返回了无法识别的数据',
  MODEL_ENDPOINT_RESPONSE_TOO_LARGE: '模型服务返回的内容超过联机限制',
  MODEL_ENDPOINT_REDIRECT_FORBIDDEN: '模型 API 地址发生了不安全的重定向',
  MODEL_ENDPOINT_PROFILE_MISMATCH: '当前 API 方案已变化，请重新保存并确认',
  MODEL_CREDENTIAL_REQUIRED: '当前 API 方案缺少可用密钥',
  MODEL_CREDENTIAL_REVOKED: '当前 API 密钥已失效，请重新保存',
  MODEL_PROTOCOL_VIOLATION: '模型回复不是联机要求的完整 JSON，当前回合已暂停',
  MODEL_OUTPUT_SCHEMA_INVALID: '模型回复缺少联机所需字段，当前回合已暂停',
  MODEL_OUTPUT_TRUNCATED: '模型回复达到输出上限而被截断，当前回合已暂停',
  MODEL_INVOCATION_FAILED: '模型未能完成当前联机阶段，请稍后重试',
  REFEREE_CHECK_LIMIT_EXCEEDED: '裁决模型请求了过多次规则核对，当前回合已暂停',
  LOOP_BREAKER: '自动修正后仍有未通过的项目，当前回合已暂停',
  AUDIENCE_VIOLATION: '记忆或来源引用不在服务器允许的范围内',
  RECOVERABLE_RUNTIME_FAULT: '联机模型阶段暂时失败，可以稍后重试',
  NARRATIVE_REPAIR_REQUIRED: '剧情正文未通过一致性检查，当前生成已暂停',
  BILLING_AUTHORIZATION_REQUIRED: '当前回合仍需凭证付款方确认',
  BILLING_BUDGET_EXHAUSTED: '旧版调用预算暂停已取消，请重试当前回合继续生成',
  DATA_PROCESSING_CONSENT_REQUIRED: '当前回合仍需完成数据处理确认',
  EXECUTION_GRANT_REQUIRED: '当前回合仍需付款方授权模型调用',
  ROOM_MEMBER_REQUIRED: '你不是该房间的有效成员',
  ROOM_NOT_FOUND: '房间不存在或已经失效',
  ROOM_ARCHIVED_READ_ONLY: '该房间已经归档，不能继续修改',
  ROOM_FULL: '房间席位已满',
  INVALID_TURN_STATE: '当前回合状态已变化，请刷新后重试',
  TURN_STAGE_CONFLICT: '当前回合已经推进，请刷新后重试',
  ACTION_SUBMISSION_NOT_OPEN: '当前暂不能提交行动',
  ACTION_ALREADY_LOCKED: '你的本回合行动已经锁定',
  COMMITTED_TURN_PROJECTION_INVALID: '正式正文尚未准备完成，请稍后重试',
  IDEMPOTENCY_CONFLICT: '本次操作与已提交内容冲突，请刷新后重试',
  CHAT_RATE_LIMITED: '消息发送过于频繁，请稍后再试'
});

const PREFIX_MESSAGES = Object.freeze([
  Object.freeze(['CAPABILITY_PROBE_', '模型能力检测失败，请检查 API 方案后重试']),
  Object.freeze(['MODEL_ENDPOINT_', '模型服务连接失败，请检查 API 地址、网络和模型设置']),
  Object.freeze(['MODEL_CREDENTIAL_', 'API 密钥不可用，请重新保存当前方案']),
  Object.freeze(['MODEL_', '模型未能完成当前联机阶段，请稍后重试']),
  Object.freeze(['PROVIDER_', '模型服务会话异常，请稍后重试']),
  Object.freeze(['REFEREE_', '联机裁决阶段未能完成，请稍后重试']),
  Object.freeze(['NARRATIVE_', '联机剧情阶段未能完成，请稍后重试']),
  Object.freeze(['CONTINUITY_', '联机状态结算阶段未能完成，请稍后重试']),
  Object.freeze(['BILLING_', '当前回合的模型调用授权尚未完成']),
  Object.freeze(['ROOM_', '房间操作失败，请刷新后重试']),
  Object.freeze(['TURN_', '回合操作失败，请刷新后重试']),
  Object.freeze(['ACTION_', '行动提交失败，请刷新后重试']),
  Object.freeze(['LINEAGE_', '存档续接操作失败，请刷新后重试'])
]);

const HAS_CHINESE = /[\u3400-\u9fff]/u;

function statusMessage(status) {
  if (status === 400) return '提交内容不符合联机要求，请检查后重试';
  if (status === 401) return '登录状态已失效，请重新登录';
  if (status === 403) return '你没有执行此操作的权限';
  if (status === 404) return '请求的联机内容不存在或已经失效';
  if (status === 409) return '联机状态已经变化，请刷新后重试';
  if (status === 413) return '提交内容超过了联机服务允许的大小';
  if (status === 429) return '操作过于频繁，请稍后重试';
  if (Number.isSafeInteger(status) && status >= 500) {
    return '联机服务暂时异常，请稍后重试';
  }
  return '联机操作失败，请稍后重试';
}

function messageForCode(code) {
  if (!code) return null;
  if (EXACT_MESSAGES[code]) return EXACT_MESSAGES[code];
  if (/^HTTP_\d{3}$/u.test(code)) return statusMessage(Number(code.slice(5)));
  return PREFIX_MESSAGES.find(([prefix]) => code.startsWith(prefix))?.[1] ?? null;
}

/**
 * Keeps stable server error codes available in state/logs while presenting a
 * localized, actionable message to players. Provider summaries are already
 * bounded and redacted by the server and remain visible as diagnostics.
 */
export function multiplayerErrorMessage(errorValue) {
  const error = errorValue && typeof errorValue === 'object' ? errorValue : {};
  const code = typeof error.code === 'string' ? error.code : '';
  const rawMessage = typeof error.message === 'string' ? error.message.trim() : '';
  const base = HAS_CHINESE.test(rawMessage)
    ? rawMessage
    : (messageForCode(code) ?? statusMessage(error.status));
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details
    : {};
  const diagnostics = [
    Number.isSafeInteger(details.upstream_status)
      ? `上游 HTTP ${details.upstream_status}`
      : null,
    typeof details.upstream_error_summary === 'string' && details.upstream_error_summary
      ? `上游返回：${details.upstream_error_summary}`
      : null,
    typeof details.provider_request_id === 'string' && details.provider_request_id
      ? `请求 ID ${details.provider_request_id}`
      : null
  ].filter(Boolean);
  return [base, ...diagnostics].join(' · ');
}
