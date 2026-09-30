import { CHAT_MESSAGE_MAX_LENGTH, ROOM_SEATS } from './enums.js';
import {
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertPlainRecord,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';

export const ROOM_CHAT_MESSAGE_SCHEMA = 'naruto.multiplayer-room-chat-message/v1';
export const ROOM_CHAT_MESSAGE_REQUEST_SCHEMA =
  'naruto.multiplayer-room-chat-message-request/v1';
export const CHAT_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

const IDENTIFIER_PATTERN = '^[A-Za-z][A-Za-z0-9:_-]*$';
const SAFE_TEXT_PATTERN =
  '^(?![\\s\\S]*[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069])[\\s\\S]*$';
const NORMALIZED_SAFE_TEXT_PATTERN =
  '^(?![\\s\\S]*[\\u0000-\\u0008\\u000B\\u000C\\u000D\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069])[\\s\\S]*$';
const ISO_TIMESTAMP_REGEXP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

export const ROOM_CHAT_MESSAGE_REQUEST_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['text', 'idempotency_key'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: CHAT_MESSAGE_MAX_LENGTH,
      pattern: SAFE_TEXT_PATTERN
    },
    idempotency_key: {
      type: 'string',
      minLength: 1,
      maxLength: CHAT_IDEMPOTENCY_KEY_MAX_LENGTH,
      pattern: SAFE_TEXT_PATTERN
    }
  }
});

export const CHAT_MESSAGE_REQUEST_JSON_SCHEMA = ROOM_CHAT_MESSAGE_REQUEST_JSON_SCHEMA;

export const ROOM_CHAT_MESSAGE_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'message_id',
    'room_id',
    'epoch_id',
    'sender_seat',
    'text',
    'created_at',
    'event_seq'
  ],
  properties: {
    schema: { const: ROOM_CHAT_MESSAGE_SCHEMA },
    message_id: {
      type: 'string',
      minLength: 2,
      maxLength: 160,
      pattern: IDENTIFIER_PATTERN
    },
    room_id: {
      type: 'string',
      minLength: 2,
      maxLength: 160,
      pattern: IDENTIFIER_PATTERN
    },
    epoch_id: {
      oneOf: [
        {
          type: 'string',
          minLength: 2,
          maxLength: 160,
          pattern: IDENTIFIER_PATTERN
        },
        { type: 'null' }
      ]
    },
    sender_seat: { type: 'string', enum: ROOM_SEATS },
    text: {
      type: 'string',
      minLength: 1,
      maxLength: CHAT_MESSAGE_MAX_LENGTH,
      pattern: NORMALIZED_SAFE_TEXT_PATTERN
    },
    created_at: { type: 'string', format: 'date-time', maxLength: 64 },
    event_seq: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
  }
});

function assertObject(value, { allowed, required = allowed, path = '', label }) {
  assertPlainRecord(value, path || '/', label);
  return assertExactKeys(value, { allowed, required, path, label });
}

function assertChatText(value, path) {
  if (typeof value !== 'string') {
    throw contractError(path, 'text must be a string');
  }
  const normalized = value.replace(/\r\n?/gu, '\n');

  // The product rule is Unicode characters, while String#length counts UTF-16
  // code units. Two code units per code point is the largest valid expansion.
  assertString(normalized, {
    path,
    label: 'text',
    min: 1,
    max: CHAT_MESSAGE_MAX_LENGTH * 2
  });
  const characterCount = Array.from(normalized).length;
  if (characterCount < 1 || characterCount > CHAT_MESSAGE_MAX_LENGTH) {
    throw contractError(
      path,
      `text must contain between 1 and ${CHAT_MESSAGE_MAX_LENGTH} Unicode characters`,
      { min: 1, max: CHAT_MESSAGE_MAX_LENGTH, actual: characterCount }
    );
  }
  return normalized;
}

function assertIsoTimestamp(value, path) {
  assertString(value, { path, label: 'created_at', max: 64 });
  if (!ISO_TIMESTAMP_REGEXP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw contractError(path, 'created_at must be an ISO 8601 UTC timestamp');
  }
  return value;
}

export function assertRoomChatMessageRequest(value) {
  assertObject(value, {
    allowed: ['text', 'idempotency_key'],
    path: '',
    label: 'room chat message request'
  });
  const text = assertChatText(value.text, '/text');
  assertString(value.idempotency_key, {
    path: '/idempotency_key',
    label: 'idempotency_key',
    max: CHAT_IDEMPOTENCY_KEY_MAX_LENGTH
  });
  return immutableContractValue({ ...value, text });
}

export const assertChatMessageRequest = assertRoomChatMessageRequest;

export function inspectRoomChatMessageRequest(value) {
  return inspectContract(value, assertRoomChatMessageRequest);
}

export const inspectChatMessageRequest = inspectRoomChatMessageRequest;

export function assertRoomChatMessage(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'message_id',
      'room_id',
      'epoch_id',
      'sender_seat',
      'text',
      'created_at',
      'event_seq'
    ],
    path: '',
    label: 'room chat message'
  });
  if (value.schema !== ROOM_CHAT_MESSAGE_SCHEMA) {
    throw contractError('/schema', `schema must be ${ROOM_CHAT_MESSAGE_SCHEMA}`);
  }
  assertIdentifier(value.message_id, { path: '/message_id', label: 'message_id' });
  assertIdentifier(value.room_id, { path: '/room_id', label: 'room_id' });
  if (value.epoch_id !== null) {
    assertIdentifier(value.epoch_id, { path: '/epoch_id', label: 'epoch_id' });
  }
  assertString(value.sender_seat, {
    path: '/sender_seat',
    label: 'sender_seat',
    enumValues: ROOM_SEATS
  });
  const text = assertChatText(value.text, '/text');
  assertIsoTimestamp(value.created_at, '/created_at');
  assertInteger(value.event_seq, { path: '/event_seq', label: 'event_seq', min: 1 });
  return immutableContractValue({ ...value, text });
}

export function inspectRoomChatMessage(value) {
  return inspectContract(value, assertRoomChatMessage);
}
