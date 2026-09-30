import { DomainError } from '../domain/errors.js';

function fail(code, message) {
  throw new DomainError(code, message);
}

function waitFor(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Single-process logical worker scheduler. It never overlaps runNext calls,
 * stops claiming new runs during quiesce, and waits for the current worker to
 * reach its persisted safe boundary before SQLite is closed.
 */
export function createResolutionWorkerScheduler({
  worker,
  poll_interval_ms = 250,
  batch_size = 1,
  on_error = () => {}
} = {}) {
  if (typeof worker?.runNext !== 'function') {
    fail('RESOLUTION_SCHEDULER_CONFIGURATION_INVALID', 'worker.runNext is required');
  }
  if (!Number.isSafeInteger(poll_interval_ms) || poll_interval_ms < 10) {
    fail('RESOLUTION_SCHEDULER_CONFIGURATION_INVALID', 'poll_interval_ms must be at least 10');
  }
  if (!Number.isSafeInteger(batch_size) || batch_size < 1 || batch_size > 32) {
    fail('RESOLUTION_SCHEDULER_CONFIGURATION_INVALID', 'batch_size must be between 1 and 32');
  }
  if (typeof on_error !== 'function') {
    fail('RESOLUTION_SCHEDULER_CONFIGURATION_INVALID', 'on_error must be a function');
  }

  let running = null;
  let controller = null;

  async function drainOnce() {
    return worker.runNext({ limit: batch_size });
  }

  function start() {
    if (running) return running;
    controller = new AbortController();
    running = (async () => {
      while (!controller.signal.aborted) {
        try {
          const results = await drainOnce();
          if (results.length === 0) {
            await waitFor(poll_interval_ms, controller.signal);
          }
        } catch (error) {
          on_error(error, Object.freeze({ phase: 'resolution_worker' }));
          await waitFor(poll_interval_ms, controller.signal);
        }
      }
    })().finally(() => {
      running = null;
      controller = null;
    });
    return running;
  }

  async function quiesce() {
    if (!running) return;
    controller.abort();
    await running;
  }

  return Object.freeze({
    start,
    quiesce,
    close: quiesce,
    drainOnce,
    isRunning: () => running !== null
  });
}
