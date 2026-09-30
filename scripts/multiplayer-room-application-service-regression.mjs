import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMultiplayerRuntime } from '../server/multiplayer/application/runtime.js';
import {
  GUEST_CHARACTER_IMPORT_SCHEMA
} from '../server/multiplayer/application/genesis-state.js';
import { ACTION_REQUEST_SCHEMA } from '../server/multiplayer/domain/action-turn.js';
import {
  MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
  SHARED_STAGE_DATA_CATEGORIES
} from '../server/multiplayer/persistence/sqlite-billing-repository.js';
import { openMultiplayerRepositoryTestSqlite } from './helpers/multiplayer-test-sqlite.mjs';

let passed = 0;
async function test(name, operation) {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const key = label => createHash('sha256').update(label).digest('base64');
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'naruto-room-app-'));
const counters = new Map();
const idFactory = kind => {
  const next = (counters.get(kind) ?? 0) + 1;
  counters.set(kind, next);
  return `${kind}_${next}`;
};
const sourceState = () => ({
  _version: '5.0',
  _meta: { current_node_id: 'node_23', active_branch: 'branch_main' },
  '玩家·姓名': '来源忍者',
  '玩家·正式忍阶': '中忍',
  '玩家·当前目标': '调查边境异动',
  '玩家·出身': '木叶隐村',
  '玩家·个性': '谨慎',
  '属性·查克拉': 90,
  '属性·当前查克拉': 72,
  '属性·精神力': 65,
  '属性·当前精神力': 61,
  '属性·体力': 80,
  '属性·当前体力': 77,
  '属性·生命力': 100,
  '属性·当前生命力': 94,
  '进度·等级': 12,
  '进度·经验': 340,
  '进度·金钱': 2300,
  '世界·年代': '木叶48年',
  '世界·时间': '木叶48年春·清晨',
  '世界·地点': '木叶东门',
  '世界·天气': '薄雾',
  '技能·忍术·影分身·名称': '影分身之术',
  '技能·忍术·影分身·等级': 'B',
  '技能·忍术·影分身·熟练度': 68,
  '物品·武器·苦无·数量': 6,
  '物品·武器·苦无·描述': '常用忍具',
  ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
    `物品·消耗品·来源补给${String(index + 1).padStart(2, '0')}·数量`,
    index + 1
  ])),
  _missions: {
    active: {
      border_case: {
        title: '边境的暗号',
        progress_current: 2,
        progress_total: 5
      }
    }
  },
  _relationships: {
    奈良鹿久: {
      info: '仅来源知道的目标：查明雾隐内应',
      faction: '木叶',
      rank: '上忍',
      trust: 37
    }
  },
  _memory: {
    facts: '来源角色知道边境暗号与一条尚未公开的线索。',
    npc_notes: '鹿久怀疑雾隐内应，但尚未公开。'
  }
});

const guestCharacter = () => ({
  schema: GUEST_CHARACTER_IMPORT_SCHEMA,
  state_snapshot: {
    _version: '5.0',
    '玩家·姓名': '客方忍者',
    '玩家·正式忍阶': '下忍',
    '玩家·当前目标': '证明自己的实力',
    '玩家·出身': '砂隐村交换生',
    '玩家·个性': '果断',
    '属性·查克拉': 70,
    '属性·当前查克拉': 63,
    '属性·精神力': 55,
    '属性·当前精神力': 50,
    '属性·体力': 85,
    '属性·当前体力': 80,
    '属性·生命力': 100,
    '属性·当前生命力': 100,
    '进度·等级': 7,
    '进度·经验': 190,
    '进度·金钱': 800,
    '世界·年代': '不应导入的客方年代',
    '世界·地点': '不应导入的客方地点',
    '技能·体术·旋风腿·名称': '木叶旋风',
    '技能·体术·旋风腿·等级': 'C',
    '技能·体术·旋风腿·熟练度': 41,
    '物品·消耗品·兵粮丸·数量': 3,
    '物品·消耗品·兵粮丸·描述': '恢复用忍具',
    ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
      `物品·消耗品·客方补给${String(index + 1).padStart(2, '0')}·数量`,
      index + 1
    ])),
    _missions: { active: { forbidden: { title: '不应导入的客方任务' } } },
    _relationships: { 秘密联系人: { role: '同谋', trust: 99 } },
    _memory: { facts: '不应导入的客方旧世界记忆' },
    agent_internal: { story_plan: '不应继承' }
  }
});

const sourceTimeline = (snapshot = sourceState()) => ({
  export_version: '2.0',
  exported_at: '2026-08-22T10:00:00.000Z',
  include_archive: false,
  nodes: [{
    id: 'node_23',
    parent_id: null,
    children_ids: [],
    branch_id: 'branch_main',
    turn_number: 23,
    depth: 0,
    player_input: '来源行动',
    clean_response: '来源正文',
    state_snapshot: snapshot
  }],
  branches: [{
    id: 'branch_main',
    name: '主线',
    color: '#eb613f',
    head_node_id: 'node_23',
    node_count: 1,
    is_active: true,
    diverged_from: null
  }],
  meta: {
    key: 'root',
    value: {
      root_id: 'node_23',
      current_id: 'node_23',
      active_branch: 'branch_main',
      total_nodes: 1
    }
  }
});
const runtime = await createMultiplayerRuntime({
  databasePath: path.join(tempRoot, 'multiplayer.sqlite'),
  keyVersion: 'v1',
  contentMasterKey: key('content'),
  credentialMasterKey: key('credential'),
  credentialFingerprintKey: key('fingerprint'),
  actionCommitmentSecret: key('commitment'),
  lineageSigningSecret: key('lineage'),
  proposalCommitmentSecret: key('proposal')
}, {
  startDispatcher: false,
  openConnection: openMultiplayerRepositoryTestSqlite,
  roomApplicationOptions: { idFactory }
});

try {
  await test('default creation separates immutable room ID from readable room code and password', async () => {
    const generatedRuntime = await createMultiplayerRuntime({
      databasePath: path.join(tempRoot, 'generated-codes.sqlite'),
      keyVersion: 'v1',
      contentMasterKey: key('generated-content'),
      credentialMasterKey: key('generated-credential'),
      credentialFingerprintKey: key('generated-fingerprint'),
      actionCommitmentSecret: key('generated-commitment'),
      lineageSigningSecret: key('generated-lineage'),
      proposalCommitmentSecret: key('generated-proposal')
    }, {
      startDispatcher: false,
      openConnection: openMultiplayerRepositoryTestSqlite
    });
    try {
      const created = await generatedRuntime.services.rooms.create({
        authenticated_user_id: 'generated_host',
        request: {
          origin_type: 'new_multiplayer_save',
          new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha' }
        }
      });
      assert.match(created.room.room_id, /^room_[a-f0-9]{32}$/u);
      assert.match(created.room.room_code, /^R-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/u);
      assert.match(created.invite.token, /^N-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
    } finally {
      await generatedRuntime.close();
    }
  });

  let newRoom;
  await test('new-save room creation stores editable openings and defers immutable genesis', async () => {
    newRoom = await runtime.services.rooms.create({
      authenticated_user_id: 'host_user',
      request: {
        origin_type: 'new_multiplayer_save',
        new_world_profile: {
          era: '木叶48年',
          preset_id: 'preset:konoha',
          actor_a: { display_name: '甲' },
          actor_b: { display_name: '乙' }
        },
        default_narrative_mode: 'shared'
      }
    });
    assert.equal(newRoom.room.origin_type, 'new_multiplayer_save');
    assert.equal(newRoom.room.lifecycle, 'LOBBY');
    assert.equal(newRoom.room.active_epoch_id, null);
    assert.equal(newRoom.genesis.status, 'AWAITING_OPENING_CONFIRMATION');
    assert.equal(newRoom.room.opening.drafts.A.draft.display_name, '甲');
    assert.equal(newRoom.room.opening.drafts.B.draft.display_name, '乙');
    assert.match(newRoom.invite.token, /^N-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
    assert.throws(() => runtime.services.snapshots.readInternal({
      room_id: newRoom.room.room_id
    }), error => error?.code === 'SNAPSHOT_NOT_FOUND');
    const lobbyLineage = runtime.repositories.lineage.lineage.getForMember({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id
    });
    assert.equal(lobbyLineage.viewer_seat, 'A');
    assert.equal(lobbyLineage.lifecycle, 'LOBBY');
    assert.equal(lobbyLineage.epochs.length, 0);
    assert.equal(lobbyLineage.checkpoints.length, 0);
    assert.deepEqual(lobbyLineage.source_imports, []);
    assert.deepEqual(lobbyLineage.actor_bindings, []);
    const stored = runtime.connection.read(database => database.prepare(`
      SELECT token_hash FROM room_invites WHERE invite_id = ?
    `).get(newRoom.invite.invite_id));
    assert.notEqual(stored.token_hash, newRoom.invite.token);
  });

  await test('room codes only conflict while current and passwords may repeat across rooms', async () => {
    const custom = await runtime.services.rooms.create({
      authenticated_user_id: 'custom_host',
      request: {
        origin_type: 'new_multiplayer_save',
        new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha' },
        room_code: 'konoha-48',
        invite_code: 'team-7-2026'
      }
    });
    assert.notEqual(custom.room.room_id, 'KONOHA-48');
    assert.equal(custom.room.room_code, 'KONOHA-48');
    assert.equal(custom.invite.token, 'team-7-2026');
    const joined = await runtime.services.rooms.join({
      authenticated_user_id: 'custom_guest',
      room_id: 'konoha-48',
      request: { token: 'team-7-2026' }
    });
    assert.equal(joined.viewer_seat, 'B');
    assert.equal(joined.room.room_id, custom.room.room_id);
    assert.equal(joined.room.room_code, 'KONOHA-48');

    await assert.rejects(runtime.services.rooms.create({
      authenticated_user_id: 'room_conflict_host',
      request: {
        origin_type: 'new_multiplayer_save',
        new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha' },
        room_code: 'konoha-48',
        invite_code: 'another password'
      }
    }), error => error?.code === 'ROOM_CODE_TAKEN' && /正在使用/u.test(error.message));

    const samePassword = await runtime.services.rooms.create({
      authenticated_user_id: 'invite_conflict_host',
      request: {
        origin_type: 'new_multiplayer_save',
        new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha' },
        room_code: 'SAND-48',
        invite_code: 'team-7-2026'
      }
    });
    assert.equal(samePassword.invite.token, 'team-7-2026');

    const unrestricted = await runtime.services.rooms.create({
      authenticated_user_id: 'short_code_host',
      request: {
        origin_type: 'new_multiplayer_save',
        new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha' },
        room_code: '7',
        invite_code: 'x'
      }
    });
    assert.equal(unrestricted.room.room_code, '7');
    assert.equal(unrestricted.invite.token, 'x');
    await runtime.connection.write(database => {
      database.prepare(`
        UPDATE room_invites
           SET use_count = max_uses, expires_at = '2020-01-01T00:00:00.000Z'
         WHERE invite_id = ?
      `).run(unrestricted.invite.invite_id);
    });
    const joinedWithLegacyLimits = await runtime.services.rooms.join({
      authenticated_user_id: 'short_code_guest',
      room_id: '7',
      request: { token: 'x' }
    });
    assert.equal(joinedWithLegacyLimits.viewer_seat, 'B');

    await runtime.connection.write(database => {
      database.prepare(`
        UPDATE multiplayer_rooms
           SET lifecycle = 'ARCHIVED', archived_at = ?, updated_at = ?
         WHERE room_id = ?
      `).run('2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z', custom.room.room_id);
    });
    const reused = await runtime.services.rooms.create({
      authenticated_user_id: 'reused_code_host',
      request: {
        origin_type: 'new_multiplayer_save',
        new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha' },
        room_code: 'konoha-48',
        invite_code: 'new password'
      }
    });
    assert.equal(reused.room.room_code, 'KONOHA-48');
    assert.notEqual(reused.room.room_id, custom.room.room_id);
  });

  await test('legacy long invite tokens remain case-sensitive and joinable', async () => {
    const legacyRoom = await runtime.services.rooms.create({
      authenticated_user_id: 'legacy_host',
      request: {
        origin_type: 'new_multiplayer_save',
        new_world_profile: { era: '木叶48年', preset_id: 'preset:konoha' },
        room_code: 'LEGACY-ROOM',
        invite_code: 'legacy-2026'
      }
    });
    const legacyToken = 'LegacyInviteToken_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890';
    const legacyHash = `sha256:${createHash('sha256').update(legacyToken).digest('hex')}`;
    await runtime.connection.write(database => {
      database.prepare('UPDATE room_invites SET token_hash = ? WHERE invite_id = ?')
        .run(legacyHash, legacyRoom.invite.invite_id);
    });
    await assert.rejects(runtime.services.rooms.join({
      authenticated_user_id: 'legacy_guest',
      room_id: 'LEGACY-ROOM',
      request: { token: legacyToken.toLowerCase() }
    }), error => error?.code === 'INVITE_TOKEN_INVALID');
    const joined = await runtime.services.rooms.join({
      authenticated_user_id: 'legacy_guest',
      room_id: 'LEGACY-ROOM',
      request: { token: legacyToken }
    });
    assert.equal(joined.viewer_seat, 'B');
  });

  await runtime.repositories.core.invites.join({
    authenticated_user_id: 'guest_user',
    room_id: newRoom.room.room_id,
    token: newRoom.invite.token
  });

  await test('seat opening edits expose conflicts and invalidate both prior confirmations', async () => {
    const host = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id
    });
    const hostDraft = structuredClone(host.opening.drafts.A.draft);
    hostDraft.start_time.year = 49;
    const mismatched = await runtime.repositories.core.openings.saveOwn({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id,
      expected_revision: host.opening.drafts.A.revision,
      draft: hostDraft
    });
    assert.equal(mismatched.opening.blocking, true);
    assert.equal(mismatched.opening.conflicts[0].code, 'OPENING_TIME_MISMATCH');

    const guest = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'guest_user',
      room_id: newRoom.room.room_id
    });
    const guestDraft = structuredClone(guest.opening.drafts.B.draft);
    guestDraft.start_time = structuredClone(hostDraft.start_time);
    guestDraft.location = '波之国码头';
    const reconciled = await runtime.repositories.core.openings.saveOwn({
      authenticated_user_id: 'guest_user',
      room_id: newRoom.room.room_id,
      expected_revision: guest.opening.drafts.B.revision,
      draft: guestDraft
    });
    assert.equal(reconciled.opening.blocking, false);
    assert.ok(reconciled.opening.conflicts.some(item => item.code === 'OPENING_LOCATION_SPLIT'));
    assert.equal(reconciled.opening.drafts.A.confirmed, false);
    assert.equal(reconciled.opening.drafts.B.confirmed, false);
  });

  await test('both explicit ready acknowledgements create binding bijection and open first turn', async () => {
    const hostBefore = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id
    });
    const hostReady = await runtime.services.rooms.ready({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id,
      request: {
        expected_control_revision: hostBefore.control_revision,
        opening_revision: hostBefore.opening.drafts.A.revision,
        opening_commitment: hostBefore.opening.drafts.A.commitment
      }
    });
    assert.equal(hostReady.all_ready, false);
    assert.equal(hostReady.turn, null);

    const guestBefore = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'guest_user',
      room_id: newRoom.room.room_id
    });
    const guestReady = await runtime.services.rooms.ready({
      authenticated_user_id: 'guest_user',
      room_id: newRoom.room.room_id,
      request: {
        expected_control_revision: guestBefore.control_revision,
        opening_revision: guestBefore.opening.drafts.B.revision,
        opening_commitment: guestBefore.opening.drafts.B.commitment
      }
    });
    assert.equal(guestReady.all_ready, true);
    assert.equal(guestReady.turn.status, 'AWAITING_PAYER_SELECTION');
    assert.doesNotMatch(JSON.stringify(guestReady.turn), /state_hash/u);
    assert.equal(guestReady.room.lifecycle, 'ACTIVE');
    newRoom = Object.freeze({ ...newRoom, room: guestReady.room });
    const snapshot = runtime.services.snapshots.readInternal({
      room_id: newRoom.room.room_id
    });
    assert.equal(snapshot.state.actors.A.player.display_name, '甲');
    assert.equal(snapshot.state.actors.B.player.display_name, '乙');
    const revisionOnlyChange = structuredClone(snapshot.state);
    revisionOnlyChange.meta.state_revision = 999;
    assert.equal(
      runtime.services.snapshots.stateHash(revisionOnlyChange),
      snapshot.state_hash,
      'state_revision is a concurrency token and must not change checkpoint content hash'
    );
    const bindings = runtime.repositories.lineage.bindings.listMetadata({
      authenticated_user_id: 'guest_user',
      room_id: newRoom.room.room_id
    });
    assert.deepEqual(bindings.map(item => item.original_seat), ['A', 'B']);
    assert.notEqual(bindings[0].room_actor_id, bindings[1].room_actor_id);
  });

  await test('ready replay is idempotent and never opens a second active turn', async () => {
    const projection = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'guest_user',
      room_id: newRoom.room.room_id
    });
    const replay = await runtime.services.rooms.ready({
      authenticated_user_id: 'guest_user',
      room_id: newRoom.room.room_id,
      request: {
        expected_control_revision: projection.control_revision,
        opening_revision: projection.opening.drafts.B.revision,
        opening_commitment: projection.opening.drafts.B.commitment
      }
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.turn.turn_no, 1);
    assert.doesNotMatch(JSON.stringify(replay.turn), /state_hash/u);
    const count = runtime.connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM multiplayer_turns WHERE room_id = ?
    `).get(newRoom.room.room_id).count);
    assert.equal(count, 1);
  });

  await test('first opening anchor requires shared-data consents without a capability probe', async () => {
    const profile = (await runtime.repositories.billing.profiles.createVersion({
      authenticated_user_id: 'host_user',
      profile_id: 'profile_lock_gate',
      expected_config_revision: 0,
      adapter: 'openai_compatible',
      base_url: 'https://models.example.com/v1',
      model: 'structured-model',
      auth_scheme: 'none',
      credential_ref: null,
      capabilities: {},
      recommended_continuity_transport: null
    })).profile.profile;
    const beforeSelection = runtime.repositories.core.rooms.getForMember({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id
    });
    const selected = await runtime.repositories.billing.selections.selectShared({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id,
      epoch_id: newRoom.room.active_epoch_id,
      turn_no: 1,
      endpoint_profile_id: profile.profile_id,
      expected_selection_revision: 0,
      expected_control_revision: beforeSelection.control_revision,
      idempotency_key: 'shared-payer-once'
    });
    const actionRequest = {
      schema: ACTION_REQUEST_SCHEMA,
      base_state_revision: 0,
      text: '甲观察周围并等待同伴。',
      pre_resolution_visibility: 'sealed',
      narration_preference: 'full',
      idempotency_key: 'action-after-gates'
    };
    await assert.rejects(runtime.repositories.core.turns.lockAction({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id,
      epoch_id: newRoom.room.active_epoch_id,
      turn_no: 1,
      request: actionRequest
    }), error => error?.code === 'OPENING_TURN_SERVER_CONTROLLED');
    await assert.rejects(runtime.repositories.core.turns.lockAction({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id,
      epoch_id: newRoom.room.active_epoch_id,
      turn_no: 1,
      submission_kind: 'SERVER_OPENING_ANCHOR',
      request: actionRequest
    }), error => error?.code === 'DATA_PROCESSING_CONSENT_REQUIRED');

    for (const userId of ['host_user', 'guest_user']) {
      await runtime.repositories.billing.consents.grant({
        authenticated_user_id: userId,
        room_id: newRoom.room.room_id,
        epoch_id: newRoom.room.active_epoch_id,
        selection_hash: selected.selection.selection_hash,
        config_fingerprint: profile.config_fingerprint,
        terms_revision: MULTIPLAYER_DATA_PROCESSING_TERMS_REVISION,
        data_categories: SHARED_STAGE_DATA_CATEGORIES
      });
    }
    const locked = await runtime.repositories.core.turns.lockAction({
      authenticated_user_id: 'host_user',
      room_id: newRoom.room.room_id,
      epoch_id: newRoom.room.active_epoch_id,
      turn_no: 1,
      submission_kind: 'SERVER_OPENING_ANCHOR',
      request: actionRequest
    });
    assert.equal(locked.turn_status, 'ONE_ACTION_LOCKED');
  });

  await test('second opening anchor atomically seals, creates billing plan and queues one resolution run', async () => {
    const locked = await runtime.repositories.core.turns.lockAction({
      authenticated_user_id: 'guest_user',
      room_id: newRoom.room.room_id,
      epoch_id: newRoom.room.active_epoch_id,
      turn_no: 1,
      submission_kind: 'SERVER_OPENING_ANCHOR',
      request: {
        schema: ACTION_REQUEST_SCHEMA,
        base_state_revision: 0,
        text: '乙守住另一侧入口并留意异常声响。',
        pre_resolution_visibility: 'open',
        narration_preference: 'full',
        idempotency_key: 'guest-second-action'
      }
    });
    assert.equal(locked.turn_status, 'AWAITING_BILLING_AUTHORIZATION');
    assert.match(locked.sealed_finalization.plan_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.match(locked.sealed_finalization.run_id, /^run_/u);
    const persisted = runtime.connection.read(database => ({
      turns: database.prepare(`
        SELECT turn_id, turn_status, input_hash FROM multiplayer_turns WHERE room_id = ?
      `).all(newRoom.room.room_id),
      plans: database.prepare(`
        SELECT plan_hash FROM turn_billing_plans WHERE turn_id = (
          SELECT turn_id FROM multiplayer_turns WHERE room_id = ? AND turn_no = 1
        )
      `).all(newRoom.room.room_id),
      runs: database.prepare(`
        SELECT run_id, run_status, input_hash FROM resolution_runs WHERE room_id = ?
      `).all(newRoom.room.room_id)
    }));
    assert.equal(persisted.turns[0].turn_status, 'AWAITING_BILLING_AUTHORIZATION');
    assert.match(persisted.turns[0].input_hash, /^hmac-sha256:[a-f0-9]{64}$/u);
    assert.equal(persisted.plans.length, 1);
    assert.equal(persisted.runs.length, 1);
    assert.equal(persisted.runs[0].run_status, 'QUEUED');
    assert.equal(persisted.runs[0].input_hash, persisted.turns[0].input_hash);
  });

  await test('existing-save lobby waits for the guest character before creating genesis', async () => {
    const importedState = sourceState();
    const staged = await runtime.services.saveImports.create({
      authenticated_user_id: 'source_owner',
      request: {
        source_save_id: 'save_source',
        client_save_instance_id: 'client_instance',
        source_branch_id: 'branch_main',
        source_node_id: 'node_23',
        cloud_revision: null,
        state: importedState,
        source_timeline: sourceTimeline(),
        idempotency_key: 'stage-once'
      }
    });
    const derived = await runtime.services.rooms.create({
      authenticated_user_id: 'source_owner',
      request: {
        origin_type: 'existing_save_derived',
        source_import_id: staged.import.import_id,
        default_narrative_mode: 'dual_pov'
      }
    });
    assert.equal(derived.room.origin_type, 'existing_save_derived');
    assert.equal(derived.room.state_revision, 0);
    assert.equal(derived.room.active_epoch_id, null);
    assert.equal(derived.genesis.status, 'AWAITING_GUEST_CHARACTER');
    assert.throws(
      () => runtime.services.snapshots.readInternal({ room_id: derived.room.room_id }),
      error => error?.code === 'SNAPSHOT_NOT_FOUND'
    );
    const consumed = runtime.repositories.saveImports.get({
      authenticated_user_id: 'source_owner',
      import_id: staged.import.import_id
    });
    assert.equal(consumed.status, 'CONSUMED');
    const preservedTimeline = runtime.repositories.saveImports.getSourceTimelineForRoom({
      authenticated_user_id: 'source_owner',
      room_id: derived.room.room_id,
      import_id: staged.import.import_id
    });
    assert.equal(preservedTimeline.source_branch_id, 'branch_main');
    assert.equal(preservedTimeline.source_node_id, 'node_23');
    assert.deepEqual(preservedTimeline.timeline, sourceTimeline());
    assert.throws(
      () => runtime.repositories.saveImports.getSourceTimelineForRoom({
        authenticated_user_id: 'guest_user',
        room_id: derived.room.room_id,
        import_id: staged.import.import_id
      }),
      error => error?.code === 'SOURCE_OWNER_REQUIRED'
    );
    const hostProjection = await runtime.services.rooms.get({
      authenticated_user_id: 'source_owner',
      room_id: derived.room.room_id
    });
    assert.equal(hostProjection.genesis_review, null);

    const joined = await runtime.services.rooms.join({
      authenticated_user_id: 'derived_guest',
      room_id: derived.room.room_id,
      request: {
        token: derived.invite.token,
        guest_character: guestCharacter()
      }
    });
    assert.equal(joined.genesis.status, 'AWAITING_IMPORT_DIFF_CONFIRMATION');
    assert.equal(joined.genesis_review.audience_diff.audience, 'B');
    assert.equal(joined.genesis_review.audience_diff.audience_role, 'guest');

    const snapshot = runtime.services.snapshots.readInternal({ room_id: derived.room.room_id });
    assert.equal(snapshot.state.meta.state_revision, 0);
    assert.equal(snapshot.state.actors.A.player.display_name, '来源忍者');
    assert.equal(snapshot.state.actors.B.player.display_name, '客方忍者');
    assert.equal(snapshot.state.shared_world.calendar.display_date, '木叶48年春·清晨');
    assert.equal(snapshot.state.shared_world.map.markers[0].label, '木叶东门');
    assert.equal(snapshot.state.actors.A.missions.entries[0].title, '边境的暗号');
    assert.equal(snapshot.state.actors.B.missions.entries.length, 0);
    assert.deepEqual(snapshot.state.shared_world.world_state.npc_profiles, []);
    assert.deepEqual(snapshot.state.relationships, []);
    const sourcePrivateRelationships =
      snapshot.state.actors.A.private_knowledge.imported_relationships.entries;
    assert.equal(sourcePrivateRelationships.length, 1);
    assert.equal(sourcePrivateRelationships[0].display_name, '奈良鹿久');
    assert.equal(sourcePrivateRelationships[0].directed_relationship.score, 37);
    assert.equal(
      sourcePrivateRelationships[0].directed_relationship.label,
      '仅来源知道的目标：查明雾隐内应'
    );
    assert.equal(snapshot.state.memories['actor:A'].entries.length, 1);
    assert.equal(snapshot.state.memories['actor:B'].entries.length, 0);
    assert.ok(snapshot.state.actors.B.equipment.entries.some(item => item.display_name === '兵粮丸'));
    assert.equal(
      snapshot.state.agent_internal.story_plan.preset_id,
      'preset:singleplayer-import-v1'
    );
    assert.notEqual(snapshot.state.agent_internal.story_plan, '不应继承');

    const ownerReview = (await runtime.services.rooms.get({
      authenticated_user_id: 'source_owner',
      room_id: derived.room.room_id
    })).genesis_review;
    const guestReview = joined.genesis_review;
    assert.equal(ownerReview.audience_diff.audience, 'A');
    assert.equal(ownerReview.audience_diff.audience_role, 'source_owner');
    assert.notEqual(ownerReview.audience_diff_commitment, guestReview.audience_diff_commitment);
    const ownerText = JSON.stringify(ownerReview.audience_diff);
    const guestText = JSON.stringify(guestReview.audience_diff);
    assert.match(ownerText, /边境的暗号/u);
    assert.match(ownerText, /奈良鹿久/u);
    assert.match(ownerText, /仅来源知道的目标/u);
    assert.match(ownerText, /影分身之术/u);
    assert.match(ownerText, /苦无×6/u);
    assert.match(ownerText, /查克拉 72\/90/u);
    assert.doesNotMatch(ownerText, /木叶旋风|兵粮丸|查克拉 63\/70/u);
    assert.match(guestText, /木叶旋风/u);
    assert.match(guestText, /兵粮丸×3/u);
    assert.match(guestText, /查克拉 63\/70/u);
    assert.doesNotMatch(
      guestText,
      /边境的暗号|奈良鹿久|仅来源知道的目标|雾隐内应|影分身之术|苦无×6|查克拉 72\/90/u
    );
    assert.match(guestText, /不在客方确认视图中展开/u);
    assert.match(ownerText, /物品摘要仅展示前 24 项/u);
    assert.match(guestText, /物品摘要仅展示前 24 项/u);
    assert.match(ownerText, /时代与日期只采用来源 S0/u);
    assert.match(guestText, /双方忍阶无需相同/u);
    assert.match(ownerText, /互不相同的稳定房间角色 ID/u);
    assert.doesNotMatch(
      `${ownerText}${guestText}`,
      /genesis_state_hash|source_basis_hash|base_state_hash|canonical_ref|unique:/u
    );

    const originalGuestCommitment = guestReview.audience_diff_commitment;
    await runtime.connection.write(database => {
      database.prepare(`DELETE FROM room_genesis_import_reviews WHERE room_id = ?`)
        .run(derived.room.room_id);
    });
    const [recoveredByRoomRead, recoveredByGuestRead] = await Promise.all([
      runtime.services.rooms.get({
        authenticated_user_id: 'source_owner',
        room_id: derived.room.room_id
      }),
      runtime.services.rooms.get({
        authenticated_user_id: 'derived_guest',
        room_id: derived.room.room_id
      })
    ]);
    assert.equal(
      recoveredByRoomRead.genesis_review.audience_diff_commitment,
      ownerReview.audience_diff_commitment
    );
    assert.equal(
      recoveredByGuestRead.genesis_review.audience_diff_commitment,
      originalGuestCommitment
    );
    const recoveredRows = runtime.connection.read(database => database.prepare(`
      SELECT COUNT(*) AS count FROM room_genesis_import_reviews WHERE room_id = ?
    `).get(derived.room.room_id).count);
    assert.equal(recoveredRows, 1);
    await runtime.connection.write(database => {
      database.prepare(`DELETE FROM room_genesis_import_reviews WHERE room_id = ?`)
        .run(derived.room.room_id);
    });
    const replayedJoin = await runtime.services.rooms.join({
      authenticated_user_id: 'derived_guest',
      room_id: derived.room.room_id,
      request: { token: derived.invite.token }
    });
    assert.equal(replayedJoin.replayed, true);
    assert.equal(
      replayedJoin.genesis_review.audience_diff_commitment,
      originalGuestCommitment
    );

    const changedGuest = guestCharacter();
    changedGuest.state_snapshot['玩家·姓名'] = '另一名客方角色';
    await assert.rejects(
      runtime.services.rooms.join({
        authenticated_user_id: 'derived_guest',
        room_id: derived.room.room_id,
        request: {
          token: derived.invite.token,
          guest_character: changedGuest
        }
      }),
      error => error?.code === 'SOURCE_IMPORT_CHANGED'
    );

    const hostBeforeReady = await runtime.services.rooms.get({
      authenticated_user_id: 'source_owner',
      room_id: derived.room.room_id
    });
    await assert.rejects(
      runtime.services.rooms.ready({
        authenticated_user_id: 'source_owner',
        room_id: derived.room.room_id,
        request: {
          expected_control_revision: hostBeforeReady.control_revision,
          proposal_revision: ownerReview.proposal_revision,
          audience_diff_commitment: guestReview.audience_diff_commitment
        }
      }),
      error => error?.code === 'SOURCE_IMPORT_CHANGED'
    );
    assert.ok(hostBeforeReady.control_revision > 0);
    await assert.rejects(
      runtime.services.rooms.ready({
        authenticated_user_id: 'source_owner',
        room_id: derived.room.room_id,
        request: {
          expected_control_revision: hostBeforeReady.control_revision - 1,
          proposal_revision: ownerReview.proposal_revision,
          audience_diff_commitment: ownerReview.audience_diff_commitment
        }
      }),
      error => error?.code === 'STALE_CONTROL_REVISION'
    );
    const acceptedButNotReady = await runtime.services.rooms.get({
      authenticated_user_id: 'source_owner',
      room_id: derived.room.room_id
    });
    assert.equal(acceptedButNotReady.genesis_review.accepted_by_viewer, true);
    assert.equal(
      acceptedButNotReady.members.find(member => member.seat === 'A').ready_at,
      null
    );
    const hostReady = await runtime.services.rooms.ready({
      authenticated_user_id: 'source_owner',
      room_id: derived.room.room_id,
      request: {
        expected_control_revision: hostBeforeReady.control_revision,
        proposal_revision: ownerReview.proposal_revision,
        audience_diff_commitment: ownerReview.audience_diff_commitment
      }
    });
    assert.equal(hostReady.all_ready, false);
    assert.equal(hostReady.genesis_review.accepted_by_viewer, true);
    assert.equal(hostReady.turn, null);

    const guestBeforeReady = await runtime.services.rooms.get({
      authenticated_user_id: 'derived_guest',
      room_id: derived.room.room_id
    });
    const guestReady = await runtime.services.rooms.ready({
      authenticated_user_id: 'derived_guest',
      room_id: derived.room.room_id,
      request: {
        expected_control_revision: guestBeforeReady.control_revision,
        proposal_revision: guestBeforeReady.genesis_review.proposal_revision,
        audience_diff_commitment: guestBeforeReady.genesis_review.audience_diff_commitment
      }
    });
    assert.equal(guestReady.all_ready, true);
    assert.equal(guestReady.genesis_review.status, 'ACCEPTED');
    assert.equal(guestReady.turn.turn_no, 1);
    assert.equal(guestReady.turn.status, 'AWAITING_PAYER_SELECTION');
    assert.doesNotMatch(
      JSON.stringify(guestReady),
      /base_state_hash|genesis_state_hash|source_basis_hash/u
    );
    const bindingSeats = runtime.repositories.lineage.bindings.listMetadata({
      authenticated_user_id: 'derived_guest',
      room_id: derived.room.room_id
    }).map(binding => binding.original_seat);
    assert.deepEqual(bindingSeats, ['A', 'B']);

    await assert.rejects(
      runtime.services.rooms.create({
        authenticated_user_id: 'source_owner',
        request: {
          origin_type: 'existing_save_derived',
          source_import_id: staged.import.import_id,
          default_narrative_mode: 'shared'
        }
      }),
      error => error?.code === 'SAVE_IMPORT_NOT_READY'
    );
  });
} finally {
  await runtime.close();
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

console.log(`multiplayer room application service regression: ${passed} passed`);
