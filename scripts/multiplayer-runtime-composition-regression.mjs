import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMultiplayerRuntime } from '../server/multiplayer/application/runtime.js';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const key = label => createHash('sha256').update(label).digest('base64');
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-multiplayer-runtime-'));
const databasePath = path.join(tempRoot, 'multiplayer.sqlite');
const config = {
  databasePath,
  keyVersion: 'v1',
  contentMasterKey: key('content'),
  credentialMasterKey: key('credential'),
  credentialFingerprintKey: key('fingerprint'),
  actionCommitmentSecret: key('commitment'),
  lineageSigningSecret: key('lineage'),
  proposalCommitmentSecret: key('proposal')
};
const backupLifecycle = {
  start_calls: 0,
  quiesce_calls: 0,
  running: false
};
let finishBackupLoop;
const backupLoop = new Promise(resolve => { finishBackupLoop = resolve; });
const backupScheduler = Object.freeze({
  start() {
    backupLifecycle.start_calls += 1;
    backupLifecycle.running = true;
    return backupLoop;
  },
  async quiesce() {
    backupLifecycle.quiesce_calls += 1;
    backupLifecycle.running = false;
    finishBackupLoop();
  },
  stats() {
    return Object.freeze({
      backup_scheduler_running: backupLifecycle.running,
      backup_in_flight: false,
      backup_completed_count: 3,
      backup_failed_count: 0,
      backup_last_failure_at: null
    });
  }
});

try {
  const runtime = await createMultiplayerRuntime(config, {
    startDispatcher: false,
    backupScheduler
  });
  await test('runtime composes every phase-2 authoritative port', () => {
    assert.equal(runtime.assertReady(), true);
    assert.equal(typeof runtime.repositories.core.turns.lockAction, 'function');
    assert.equal(typeof runtime.repositories.billing.usage.start, 'function');
    assert.equal(typeof runtime.repositories.billing.modelBindings.resolveProfile, 'function');
    assert.equal(typeof runtime.repositories.lineage.personalExports.begin, 'function');
    assert.equal(typeof runtime.repositories.leases.claim, 'function');
    assert.equal(typeof runtime.repositories.commits.commitTurn, 'function');
    assert.equal(typeof runtime.repositories.continuityDrafts.executeTransport, 'function');
    assert.equal(typeof runtime.repositories.turnWorkflows.prepareContinuity, 'function');
    assert.equal(typeof runtime.repositories.turnWorkflows.prepareCommit, 'function');
    assert.equal(typeof runtime.repositories.turnWorkflows.recoverCommit, 'function');
    assert.equal(typeof runtime.resolutionWorker.process, 'function');
    assert.equal(runtime.resolutionScheduler.isRunning(), true);
    assert.equal(typeof runtime.services.capabilityProbes.run, 'function');
    assert.equal(typeof runtime.sseHandler, 'function');
    assert.equal(runtime.backupScheduler, backupScheduler);
    assert.equal(backupLifecycle.start_calls, 1);
    assert.equal(backupLifecycle.running, true);
  });

  await test('runtime metrics combine SQLite and live transport state', async () => {
    const metrics = await runtime.operationalMetrics();
    assert.equal(metrics.sse_active_connections, 0);
    assert.equal(metrics.sse_active_rooms, 0);
    assert.equal(metrics.outbox_dispatcher_running, false);
    assert.equal(metrics.resolution_scheduler_running, true);
    assert.equal(metrics.backup_scheduler_running, true);
    assert.equal(metrics.backup_completed_count, 3);
    assert.ok(metrics.wal_bytes >= 0);
  });

  await test('runtime quiesce stops event delivery before closing SQLite', async () => {
    await runtime.quiesce();
    assert.equal(runtime.eventHub.stats().closed, true);
    assert.equal(runtime.dispatcher.isRunning(), false);
    assert.equal(runtime.resolutionScheduler.isRunning(), false);
    assert.equal(backupLifecycle.running, false);
    assert.equal(backupLifecycle.quiesce_calls, 1);
    assert.equal(runtime.assertReady(), true);
  });

  await runtime.close();
  await test('runtime shutdown closes the authoritative writer', () => {
    assert.throws(() => runtime.assertReady(), error => error?.code === 'MULTIPLAYER_RUNTIME_CLOSED');
    assert.equal(backupLifecycle.quiesce_calls, 1);
  });

  const retryLifecycle = {
    quiesce_calls: 0,
    quiesce_started: false,
    running: false
  };
  let rejectFirstBackupDrain;
  const retryBackupScheduler = Object.freeze({
    start() {
      retryLifecycle.running = true;
      return Promise.resolve();
    },
    quiesce() {
      retryLifecycle.quiesce_calls += 1;
      retryLifecycle.quiesce_started = true;
      retryLifecycle.running = false;
      if (retryLifecycle.quiesce_calls === 1) {
        return new Promise((resolve, reject) => {
          rejectFirstBackupDrain = () => reject(new Error('injected backup drain failure'));
        });
      }
      return Promise.resolve();
    },
    stats() {
      return Object.freeze({
        backup_scheduler_running: retryLifecycle.running,
        backup_in_flight: retryLifecycle.quiesce_started,
        backup_completed_count: 0,
        backup_failed_count: retryLifecycle.quiesce_calls > 0 ? 1 : 0,
        backup_last_failure_at: null
      });
    }
  });
  const retryRuntime = await createMultiplayerRuntime({
    ...config,
    databasePath: path.join(tempRoot, 'retry-close.sqlite')
  }, {
    startDispatcher: false,
    backupScheduler: retryBackupScheduler
  });
  let firstQuiesce;
  await test('quiesce stops new resolution claims before a delayed backup drain settles', async () => {
    firstQuiesce = retryRuntime.quiesce();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(retryLifecycle.quiesce_started, true);
    assert.equal(retryRuntime.resolutionScheduler.isRunning(), false);
    assert.equal(retryRuntime.isAcceptingWork(), false);
    assert.equal(retryRuntime.eventHub.stats().closed, true);
    assert.equal(retryRuntime.assertReady(), true);
    rejectFirstBackupDrain();
    await assert.rejects(
      firstQuiesce,
      error => error instanceof AggregateError
        && error.errors.some(item => item?.message === 'injected backup drain failure')
    );
  });

  await test('close retries unfinished lifecycle cleanup after a partial quiesce failure', async () => {
    await retryRuntime.close();
    assert.equal(retryLifecycle.quiesce_calls, 2);
    assert.equal(retryRuntime.resolutionScheduler.isRunning(), false);
    assert.throws(
      () => retryRuntime.assertReady(),
      error => error?.code === 'MULTIPLAYER_RUNTIME_CLOSED'
    );
    await retryRuntime.close();
    assert.equal(retryLifecycle.quiesce_calls, 2);
  });
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer runtime composition regression: ${passed} passed`);
