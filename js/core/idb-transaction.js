// Retry only transaction creation. Once a transaction exists, its own
// completion/abort handlers decide the result and its writes are never replayed.
export async function withTimelineTransaction(open, forget, stores, mode, run) {
  const db = await open();
  let tx;
  try {
    tx = db.transaction(stores, mode);
  } catch (error) {
    if (error?.name !== 'InvalidStateError') throw error;
    forget(db);
    const reopened = await open();
    try {
      tx = reopened.transaction(stores, mode);
    } catch (reopenError) {
      if (reopenError?.name !== 'InvalidStateError') throw reopenError;
      forget(reopened);
      throw new Error('本地存档数据库连接已关闭，请关闭其他游戏标签页后重新打开。', { cause: reopenError });
    }
  }
  return new Promise((resolve, reject) => run(tx, resolve, reject));
}
