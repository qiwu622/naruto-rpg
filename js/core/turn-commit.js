function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Guards the mutable part of a turn until its timeline node is durable.
 *
 * Model generation and review happen before this boundary. Once active, state
 * updates, memory writes and chat-history appends either all survive together,
 * or the live state/history are restored to their pre-commit snapshots.
 */
export class TurnCommitGuard {
  constructor({ stateManager, chatHistory } = {}) {
    if (!stateManager?.snapshot || !stateManager?.restore) {
      throw new TypeError('TurnCommitGuard requires a snapshot/restore state manager');
    }
    if (!Array.isArray(chatHistory)) {
      throw new TypeError('TurnCommitGuard requires the live chat history array');
    }
    this.stateManager = stateManager;
    this.chatHistory = chatHistory;
    this.stateSnapshot = stateManager.snapshot();
    this.historySnapshot = clone(chatHistory);
    this.status = 'active';
  }

  commit() {
    if (this.status === 'rolled_back' || this.status === 'abandoned') {
      throw new Error(`Cannot commit a ${this.status.replace('_', '-')} turn`);
    }
    if (this.status === 'committed') return false;
    this.status = 'committed';
    this._releaseSnapshots();
    return true;
  }

  rollback() {
    if (!this.isActive) return false;
    this.stateManager.restore(clone(this.stateSnapshot));
    this.chatHistory.splice(0, this.chatHistory.length, ...clone(this.historySnapshot));
    this.status = 'rolled_back';
    this._releaseSnapshots();
    return true;
  }

  // A different save now owns the live state and history. Restoring this turn's
  // snapshots would overwrite that save, so release them without any writes.
  abandon() {
    if (!this.isActive) return false;
    this.status = 'abandoned';
    this._releaseSnapshots();
    return true;
  }

  get isActive() {
    return this.status === 'active';
  }

  _releaseSnapshots() {
    this.stateSnapshot = null;
    this.historySnapshot = null;
  }
}

export function beginTurnCommit(options) {
  return new TurnCommitGuard(options);
}

export default TurnCommitGuard;
