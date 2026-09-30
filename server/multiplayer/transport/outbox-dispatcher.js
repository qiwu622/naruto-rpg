import { randomUUID } from 'node:crypto';

import { DomainError } from '../domain/errors.js';

const OWNER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;

function fail(code, message) {
  throw new DomainError(code, message);
}

function assertDependencies({ outbox, event_hub }) {
  for (const method of ['claim', 'markDispatched', 'release']) {
    if (typeof outbox?.[method] !== 'function') {
      fail('OUTBOX_DISPATCHER_CONFIGURATION_INVALID', `outbox.${method} is required`);
    }
  }
  if (typeof event_hub?.publish !== 'function') {
    fail('OUTBOX_DISPATCHER_CONFIGURATION_INVALID', 'event_hub.publish is required');
  }
}

function isoAfter(iso, milliseconds) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function waitFor(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Claims transactional outbox rows, publishes process-local notifications,
 * then fences the dispatched marker. A crash in either window is safe:
 * room_events remains replayable and a repeated live event is deduplicated by
 * event_seq at the client.
 */
export function createOutboxDispatcher({
  outbox,
  event_hub,
  dispatcher_owner_id = `dispatcher_${randomUUID().replaceAll('-', '')}`,
  clock = () => new Date().toISOString(),
  lease_ms = 15_000,
  batch_size = 100,
  poll_interval_ms = 250,
  on_error = () => {}
}) {
  assertDependencies({ outbox, event_hub });
  if (typeof dispatcher_owner_id !== 'string' || !OWNER_ID_PATTERN.test(dispatcher_owner_id)) {
    fail('OUTBOX_DISPATCHER_CONFIGURATION_INVALID', 'dispatcher_owner_id is invalid');
  }
  if (!Number.isSafeInteger(lease_ms) || lease_ms < 1_000) {
    fail('OUTBOX_DISPATCHER_CONFIGURATION_INVALID', 'lease_ms must be at least 1000');
  }
  if (!Number.isSafeInteger(batch_size) || batch_size < 1 || batch_size > 500) {
    fail('OUTBOX_DISPATCHER_CONFIGURATION_INVALID', 'batch_size must be between 1 and 500');
  }
  if (!Number.isSafeInteger(poll_interval_ms) || poll_interval_ms < 10) {
    fail('OUTBOX_DISPATCHER_CONFIGURATION_INVALID', 'poll_interval_ms must be at least 10');
  }
  if (typeof clock !== 'function' || typeof on_error !== 'function') {
    fail('OUTBOX_DISPATCHER_CONFIGURATION_INVALID', 'clock and on_error must be functions');
  }

  let running = null;
  let controller = null;

  async function dispatchOnce() {
    const claimedAt = clock();
    const claimed = await outbox.claim({
      dispatcher_owner_id,
      now: claimedAt,
      expires_at: isoAfter(claimedAt, lease_ms),
      limit: batch_size
    });
    let dispatched = 0;
    let released = 0;
    for (const item of claimed) {
      try {
        await event_hub.publish(item);
        await outbox.markDispatched({
          outbox_id: item.outbox_id,
          dispatcher_owner_id,
          lease_fence: item.lease_fence,
          dispatched_at: clock()
        });
        dispatched += 1;
      } catch (error) {
        try {
          await outbox.release({
            outbox_id: item.outbox_id,
            dispatcher_owner_id,
            lease_fence: item.lease_fence
          });
          released += 1;
        } catch (releaseError) {
          on_error(releaseError, Object.freeze({ phase: 'release', item }));
        }
        on_error(error, Object.freeze({ phase: 'publish_or_mark', item }));
      }
    }
    return Object.freeze({ claimed: claimed.length, dispatched, released });
  }

  function start() {
    if (running) return running;
    controller = new AbortController();
    running = (async () => {
      while (!controller.signal.aborted) {
        try {
          const result = await dispatchOnce();
          if (result.claimed === 0) {
            await waitFor(poll_interval_ms, controller.signal);
          }
        } catch (error) {
          on_error(error, Object.freeze({ phase: 'claim' }));
          await waitFor(poll_interval_ms, controller.signal);
        }
      }
    })().finally(() => {
      running = null;
      controller = null;
    });
    return running;
  }

  async function stop() {
    if (!running) return;
    controller.abort();
    await running;
  }

  return Object.freeze({
    dispatcher_owner_id,
    dispatchOnce,
    start,
    stop,
    isRunning: () => running !== null
  });
}
