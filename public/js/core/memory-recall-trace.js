import { eventBus } from './event-bus.js';

// UI-only evidence for the latest prompt. Never persist it into snapshots or
// add it back to a model prompt (which would recursively grow the save).
let latest = null;
export function recordMemoryRecallTrace(state, sections) {
  latest = { turn: Number(state?.['系统·回合数']) || 0, branchId: state?._meta?.active_branch || '',
    nodeId: state?._meta?.current_node_id || '', sections, createdAt: Date.now() };
  eventBus.emit('memory:recall-trace');
}
export function getMemoryRecallTrace() { return latest; }
export function clearMemoryRecallTrace() { latest = null; eventBus.emit('memory:recall-trace'); }
for (const event of ['state:restored', 'state:reset', 'memory:corrected']) eventBus.on(event, clearMemoryRecallTrace);
