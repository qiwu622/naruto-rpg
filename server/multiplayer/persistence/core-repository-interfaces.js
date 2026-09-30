import { DomainError } from '../domain/errors.js';

/**
 * Runtime manifest for the phase-2 multiplayer persistence ports.
 *
 * JavaScript has no compile-time interfaces, so application composition uses
 * this manifest to fail at startup when a SQLite adapter is incomplete. The
 * methods deliberately accept an authenticated principal and derive
 * member/seat authority from the database; no port accepts a client-reported
 * member ID or seat.
 */
export const MULTIPLAYER_CORE_REPOSITORY_PORTS = Object.freeze({
  rooms: Object.freeze(['createWithGenesis', 'getForMember']),
  invites: Object.freeze(['create', 'join', 'revoke']),
  members: Object.freeze(['resolve', 'markReady']),
  epochs: Object.freeze(['getActive', 'getGenesis']),
  turns: Object.freeze([
    'open',
    'changeNarrativeMode',
    'lockAction',
    'getForMember'
  ]),
  chat: Object.freeze(['append', 'listHistory']),
  events: Object.freeze(['listAfter']),
  outbox: Object.freeze(['claim', 'markDispatched', 'release'])
});

export function assertMultiplayerCoreRepositoryBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError(
      'MULTIPLAYER_REPOSITORY_CONFIGURATION_INVALID',
      'multiplayer core repositories must be an object'
    );
  }
  for (const [portName, methods] of Object.entries(MULTIPLAYER_CORE_REPOSITORY_PORTS)) {
    const port = value[portName];
    if (!port || typeof port !== 'object' || Array.isArray(port)) {
      throw new DomainError(
        'MULTIPLAYER_REPOSITORY_CONFIGURATION_INVALID',
        `multiplayer repository port ${portName} is missing`
      );
    }
    for (const method of methods) {
      if (typeof port[method] !== 'function') {
        throw new DomainError(
          'MULTIPLAYER_REPOSITORY_CONFIGURATION_INVALID',
          `multiplayer repository method ${portName}.${method} is missing`
        );
      }
    }
  }
  return value;
}

/**
 * Required synchronous envelope-codec interface for encrypted action content.
 * Implementations normally keep wrapping keys outside the business database.
 */
export const ACTION_CONTENT_CODEC_METHODS = Object.freeze(['sealJson', 'openJson']);

export function assertActionContentCodec(codec) {
  if (!codec || typeof codec !== 'object' || Array.isArray(codec)) {
    throw new DomainError(
      'ACTION_CONTENT_CODEC_INVALID',
      'an injected action content codec is required'
    );
  }
  for (const method of ACTION_CONTENT_CODEC_METHODS) {
    if (typeof codec[method] !== 'function') {
      throw new DomainError(
        'ACTION_CONTENT_CODEC_INVALID',
        `action content codec must implement ${method}`
      );
    }
  }
  return codec;
}
