import { createRoomEventStreamHandler } from '../transport/room-events-sse.js';
import {
  createMultiplayerHttpErrorHandler,
  multiplayerHttpErrorPayload,
  multiplayerRouteNotFound
} from './error-mapper.js';
import {
  MULTIPLAYER_APPLICATION_SERVICE_PORTS,
  MULTIPLAYER_HTTP_OPERATION_NAMES,
  assertMultiplayerApplicationServices,
  assertMultiplayerHttpOperations
} from './ports.js';
import { createRepositoryBackedMultiplayerHttpOperations } from './repository-operations.js';
import {
  MULTIPLAYER_HTTP_MOUNT_PATH,
  MULTIPLAYER_HTTP_ROUTE_SPECS,
  createMultiplayerHttpRouter
} from './router.js';

/** Complete repository-backed phase-2 HTTP composition, without server mount. */
export function createRepositoryBackedMultiplayerHttpRouter({
  core_repositories,
  billing_repository,
  lineage_repository,
  application_services,
  event_hub,
  room_event_stream_handler = null,
  session_authorizer = async () => true,
  heartbeat_ms = 15_000,
  replay_page_size = 200,
  on_stream_error = () => {},
  chat_rate_limiter,
  json_limit = '256kb',
  error_logger = () => {}
}) {
  const operations = createRepositoryBackedMultiplayerHttpOperations({
    core_repositories,
    billing_repository,
    lineage_repository,
    application_services
  });
  const streamHandler = room_event_stream_handler ?? createRoomEventStreamHandler({
    repositories: core_repositories,
    event_hub,
    session_authorizer,
    heartbeat_ms,
    replay_page_size,
    on_error: on_stream_error
  });
  return createMultiplayerHttpRouter({
    operations,
    room_event_stream_handler: streamHandler,
    chat_rate_limiter,
    json_limit,
    error_logger
  });
}

export {
  MULTIPLAYER_APPLICATION_SERVICE_PORTS,
  MULTIPLAYER_HTTP_MOUNT_PATH,
  MULTIPLAYER_HTTP_OPERATION_NAMES,
  MULTIPLAYER_HTTP_ROUTE_SPECS,
  assertMultiplayerApplicationServices,
  assertMultiplayerHttpOperations,
  createMultiplayerHttpErrorHandler,
  createMultiplayerHttpRouter,
  createRepositoryBackedMultiplayerHttpOperations,
  multiplayerHttpErrorPayload,
  multiplayerRouteNotFound
};
