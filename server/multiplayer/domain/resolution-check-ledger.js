import {
  assertRefereeCheckJsonCommand,
  assertResolutionCheckRejectedResult,
  assertResolutionCheckRequest,
  assertResolutionCheckResolvedResult,
  computeResolutionCheckResultHash
} from '../contracts/resolution-check-contracts.js';
import { canonicalizeJson, sha256Hex } from './canonical-json.js';
import { DomainError } from './errors.js';

export const RESOLUTION_CHECK_REQUEST_HASH_SCHEMA =
  'naruto.referee-check-request-hash/v1';
export const RESOLUTION_CHECK_LEDGER_RECORD_SCHEMA =
  'naruto.referee-check-ledger-record/v1';

const CHECK_ID = /^check_[A-Za-z0-9_-]{1,154}$/u;
const OUTCOME = /^[A-Z][A-Z0-9_:-]*$/u;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_ROLL_BOUND = Number.MAX_SAFE_INTEGER;

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPlainObject(value, code, label) {
  const prototype = value && typeof value === 'object'
    ? Object.getPrototypeOf(value)
    : undefined;
  if (!value || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new DomainError(code, `${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, allowed, code, label) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new DomainError(code, `${label} contains an unknown property`, { property: key });
    }
  }
  for (const key of allowedSet) {
    if (!own(value, key)) {
      throw new DomainError(code, `${label} is missing a required property`, { property: key });
    }
  }
  return value;
}

function assertSynchronous(value, callbackName) {
  if (value && typeof value.then === 'function') {
    throw new DomainError(
      'ASYNC_RESOLUTION_CHECK_CALLBACK',
      `${callbackName} must be synchronous so check consumption remains atomic`,
      { callback: callbackName }
    );
  }
  return value;
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_LEDGER_CONFIG',
      `${name} must be an injected synchronous function`,
      { field: name }
    );
  }
  return value;
}

function normalizeSessionId(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_SESSION_ID_LENGTH
    || !value.trim()
    || /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(value)) {
    throw new DomainError(
      'INVALID_REFEREE_SESSION',
      `session_id must be nonblank safe text of at most ${MAX_SESSION_ID_LENGTH} characters`
    );
  }
  return value;
}

function normalizeCheckId(value) {
  if (typeof value !== 'string' || !CHECK_ID.test(value)) {
    throw new DomainError('INVALID_RESOLUTION_CHECK_ID', 'check_id has an invalid format', {
      check_id: typeof value === 'string' ? value : null
    });
  }
  return value;
}

function immutable(value) {
  const normalized = canonicalizeJson(value);
  (function freezeDeep(current) {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freezeDeep(child);
      Object.freeze(current);
    }
  }(normalized));
  return normalized;
}

function normalizeInvocation(value, payloadKey) {
  assertPlainObject(value, 'INVALID_RESOLUTION_CHECK_INVOCATION', 'check invocation');
  assertExactKeys(
    value,
    ['session_id', payloadKey],
    'INVALID_RESOLUTION_CHECK_INVOCATION',
    'check invocation'
  );
  return {
    session_id: normalizeSessionId(value.session_id),
    payload: value[payloadKey]
  };
}

/**
 * Hashes a normalized request together with its Referee session. The explicit
 * check_id binding is retained even though check_id is also inside request so
 * a future request schema cannot accidentally weaken the ledger key.
 */
export function computeResolutionCheckRequestHash({ session_id, request }) {
  const normalizedSessionId = normalizeSessionId(session_id);
  const normalizedRequest = assertResolutionCheckRequest(request);
  return `sha256:${sha256Hex({
    schema: RESOLUTION_CHECK_REQUEST_HASH_SCHEMA,
    session_id: normalizedSessionId,
    check_id: normalizedRequest.check_id,
    request: normalizedRequest
  })}`;
}

function normalizeRollSpec(value, path, participantRefs) {
  assertPlainObject(value, 'INVALID_RESOLUTION_CHECK_PLAN', 'roll spec');
  assertExactKeys(
    value,
    ['participant_ref', 'minimum', 'maximum', 'modifier', 'difficulty'],
    'INVALID_RESOLUTION_CHECK_PLAN',
    'roll spec'
  );

  if (typeof value.participant_ref !== 'string'
    || !participantRefs.has(value.participant_ref)) {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_PLAN',
      'roll spec participant_ref must belong to the request',
      { path: `${path}/participant_ref`, participant_ref: value.participant_ref ?? null }
    );
  }
  if (!Number.isSafeInteger(value.minimum)
    || !Number.isSafeInteger(value.maximum)
    || value.minimum < -MAX_ROLL_BOUND
    || value.maximum > MAX_ROLL_BOUND
    || value.minimum > value.maximum) {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_PLAN',
      'roll bounds must be ordered safe integers',
      { path, minimum: value.minimum, maximum: value.maximum }
    );
  }
  if (!Number.isSafeInteger(value.modifier)) {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_PLAN',
      'roll modifier must be a safe integer',
      { path: `${path}/modifier` }
    );
  }
  if (value.difficulty !== null && !Number.isSafeInteger(value.difficulty)) {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_PLAN',
      'roll difficulty must be null or a safe integer',
      { path: `${path}/difficulty` }
    );
  }

  return immutable({
    participant_ref: value.participant_ref,
    minimum: value.minimum,
    maximum: value.maximum,
    modifier: value.modifier,
    difficulty: value.difficulty
  });
}

function normalizeAcceptedDecision(value, request) {
  assertExactKeys(
    value,
    ['status', 'roll_specs'],
    'INVALID_RESOLUTION_CHECK_PLAN',
    'accepted check decision'
  );
  if (value.status !== 'ACCEPTED') {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_PLAN',
      'accepted check decision status must be ACCEPTED'
    );
  }
  if (!Array.isArray(value.roll_specs)
    || value.roll_specs.length !== request.participant_refs.length) {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_PLAN',
      'roll_specs must contain exactly one roll for every requested participant',
      {
        expected: request.participant_refs.length,
        actual: Array.isArray(value.roll_specs) ? value.roll_specs.length : null
      }
    );
  }

  const participantRefs = new Set(request.participant_refs);
  const seen = new Set();
  const rollSpecs = value.roll_specs.map((spec, index) => {
    const normalized = normalizeRollSpec(spec, `/roll_specs/${index}`, participantRefs);
    if (seen.has(normalized.participant_ref)) {
      throw new DomainError(
        'INVALID_RESOLUTION_CHECK_PLAN',
        'roll_specs contains a duplicate participant_ref',
        { path: `/roll_specs/${index}/participant_ref`, participant_ref: normalized.participant_ref }
      );
    }
    seen.add(normalized.participant_ref);
    return normalized;
  });
  for (const participantRef of request.participant_refs) {
    if (!seen.has(participantRef)) {
      throw new DomainError(
        'INVALID_RESOLUTION_CHECK_PLAN',
        'roll_specs omitted a requested participant',
        { participant_ref: participantRef }
      );
    }
  }
  return immutable({ status: 'ACCEPTED', roll_specs: rollSpecs });
}

function buildRejectedResult(decision, checkId) {
  assertExactKeys(
    decision,
    ['status', 'error_code', 'allowed_correction_fields'],
    'INVALID_RESOLUTION_CHECK_REJECTION',
    'rejected check decision'
  );
  if (decision.status !== 'REJECTED') {
    throw new DomainError(
      'INVALID_RESOLUTION_CHECK_REJECTION',
      'rejected check decision status must be REJECTED'
    );
  }
  const material = {
    schema: 'naruto.referee-check-result/v1',
    status: 'REJECTED',
    check_id: checkId,
    error_code: decision.error_code,
    allowed_correction_fields: decision.allowed_correction_fields
  };
  return assertResolutionCheckRejectedResult({
    ...material,
    result_hash: computeResolutionCheckResultHash(material)
  });
}

function normalizeDecision(value, request) {
  assertPlainObject(value, 'INVALID_RESOLUTION_CHECK_DECISION', 'check decision');
  if (value.status === 'ACCEPTED') return normalizeAcceptedDecision(value, request);
  if (value.status === 'REJECTED') return value;
  throw new DomainError(
    'INVALID_RESOLUTION_CHECK_DECISION',
    'check decision status must be ACCEPTED or REJECTED'
  );
}

function conflictError(sessionId, checkId, resolvedHash, attemptedHash) {
  return new DomainError(
    'CHECK_ID_CONFLICT',
    'check_id is already sealed by a different request hash',
    {
      session_id: sessionId,
      check_id: checkId,
      resolved_request_hash: resolvedHash,
      attempted_request_hash: attemptedHash
    },
    { status: 409 }
  );
}

/**
 * Synchronous in-memory authority for Referee checks.
 *
 * All rule validation, random integers and outcome resolution are mandatory
 * injected functions. This module deliberately has no Math.random fallback.
 */
export class ResolutionCheckLedger {
  #sessions = new Map();

  #validateRequest;

  #randomInteger;

  #resolveOutcome;

  constructor(config) {
    assertPlainObject(
      config,
      'INVALID_RESOLUTION_CHECK_LEDGER_CONFIG',
      'resolution check ledger config'
    );
    assertExactKeys(
      config,
      ['validateRequest', 'randomInteger', 'resolveOutcome'],
      'INVALID_RESOLUTION_CHECK_LEDGER_CONFIG',
      'resolution check ledger config'
    );
    this.#validateRequest = assertFunction(config.validateRequest, 'validateRequest');
    this.#randomInteger = assertFunction(config.randomInteger, 'randomInteger');
    this.#resolveOutcome = assertFunction(config.resolveOutcome, 'resolveOutcome');
  }

  /** Native tool arguments are exactly the request object from section 9.2. */
  executeNative(invocation) {
    const { session_id: sessionId, payload } = normalizeInvocation(invocation, 'request');
    return this.#execute(sessionId, assertResolutionCheckRequest(payload));
  }

  /** Strict JSON transport enters the same private ledger path as native. */
  executeJson(invocation) {
    const { session_id: sessionId, payload } = normalizeInvocation(invocation, 'command');
    const command = assertRefereeCheckJsonCommand(payload);
    return this.#execute(sessionId, command.request);
  }

  requestResolutionCheck(invocation) {
    return this.executeNative(invocation);
  }

  #entryFor(sessionId, checkId) {
    let session = this.#sessions.get(sessionId);
    if (!session) {
      session = new Map();
      this.#sessions.set(sessionId, session);
    }
    let entry = session.get(checkId);
    if (!entry) {
      entry = { rejected: new Map(), resolved: null, processing: false };
      session.set(checkId, entry);
    }
    return entry;
  }

  #execute(sessionId, request) {
    const requestHash = computeResolutionCheckRequestHash({
      session_id: sessionId,
      request
    });
    const entry = this.#entryFor(sessionId, request.check_id);

    if (entry.resolved) {
      if (entry.resolved.check_request_hash === requestHash) {
        return entry.resolved.result;
      }
      throw conflictError(
        sessionId,
        request.check_id,
        entry.resolved.check_request_hash,
        requestHash
      );
    }

    const priorRejection = entry.rejected.get(requestHash);
    if (priorRejection) return priorRejection.result;

    if (entry.processing) {
      throw new DomainError(
        'RESOLUTION_CHECK_IN_PROGRESS',
        'this session and check_id are already being processed',
        { session_id: sessionId, check_id: request.check_id },
        { status: 409 }
      );
    }

    entry.processing = true;
    try {
      const decisionContext = immutable({
        session_id: sessionId,
        check_id: request.check_id,
        check_request_hash: requestHash
      });
      const decision = normalizeDecision(
        assertSynchronous(
          this.#validateRequest(request, decisionContext),
          'validateRequest'
        ),
        request
      );

      if (decision.status === 'REJECTED') {
        const result = buildRejectedResult(decision, request.check_id);
        const record = immutable({
          check_request_hash: requestHash,
          request,
          result
        });
        entry.rejected.set(requestHash, record);
        return record.result;
      }

      const rolls = decision.roll_specs.map((spec, index) => {
        const randomContext = immutable({
          session_id: sessionId,
          check_id: request.check_id,
          check_request_hash: requestHash,
          roll_index: index,
          participant_ref: spec.participant_ref,
          difficulty: spec.difficulty
        });
        const raw = assertSynchronous(
          this.#randomInteger(spec.minimum, spec.maximum, randomContext),
          'randomInteger'
        );
        if (!Number.isSafeInteger(raw) || raw < spec.minimum || raw > spec.maximum) {
          throw new DomainError(
            'INVALID_RESOLUTION_CHECK_RANDOM_VALUE',
            'randomInteger must return a safe integer inside the requested inclusive bounds',
            {
              participant_ref: spec.participant_ref,
              minimum: spec.minimum,
              maximum: spec.maximum,
              actual: Number.isSafeInteger(raw) ? raw : null
            }
          );
        }
        const total = raw + spec.modifier;
        if (!Number.isSafeInteger(total)) {
          throw new DomainError(
            'INVALID_RESOLUTION_CHECK_TOTAL',
            'raw + modifier exceeds the safe integer range',
            { participant_ref: spec.participant_ref }
          );
        }
        return immutable({
          participant_ref: spec.participant_ref,
          raw,
          modifier: spec.modifier,
          total
        });
      });

      const outcomeEvidence = immutable({
        session_id: sessionId,
        check_id: request.check_id,
        check_request_hash: requestHash,
        request,
        roll_specs: decision.roll_specs,
        rolls
      });
      const outcome = assertSynchronous(
        this.#resolveOutcome(outcomeEvidence),
        'resolveOutcome'
      );
      if (typeof outcome !== 'string'
        || outcome.length < 2
        || outcome.length > 128
        || !OUTCOME.test(outcome)) {
        throw new DomainError(
          'INVALID_RESOLUTION_CHECK_OUTCOME',
          'resolveOutcome must return a stable uppercase outcome code'
        );
      }

      const material = {
        schema: 'naruto.referee-check-result/v1',
        status: 'RESOLVED',
        check_id: request.check_id,
        rule_ref: request.rule_ref,
        rolls,
        outcome
      };
      const result = assertResolutionCheckResolvedResult({
        ...material,
        result_hash: computeResolutionCheckResultHash(material)
      });

      // The one assignment below is the consume/seal point. No ledger state is
      // marked resolved until validation, every roll and the result contract
      // have all succeeded.
      entry.resolved = immutable({
        schema: RESOLUTION_CHECK_LEDGER_RECORD_SCHEMA,
        session_id: sessionId,
        check_id: request.check_id,
        check_request_hash: requestHash,
        request,
        roll_specs: decision.roll_specs,
        result
      });
      return entry.resolved.result;
    } finally {
      entry.processing = false;
    }
  }

  /** Returns a detached server-only snapshot; null means this ID was unseen. */
  getRecord({ session_id, check_id }) {
    const sessionId = normalizeSessionId(session_id);
    const checkId = normalizeCheckId(check_id);
    const entry = this.#sessions.get(sessionId)?.get(checkId);
    if (!entry) return null;
    const rejectedAttempts = [...entry.rejected.values()]
      .sort((left, right) => left.check_request_hash.localeCompare(right.check_request_hash));
    return immutable({
      schema: RESOLUTION_CHECK_LEDGER_RECORD_SCHEMA,
      session_id: sessionId,
      check_id: checkId,
      consumed: entry.resolved !== null,
      resolved: entry.resolved,
      rejected_attempts: rejectedAttempts
    });
  }
}

export function createResolutionCheckLedger(config) {
  return new ResolutionCheckLedger(config);
}
