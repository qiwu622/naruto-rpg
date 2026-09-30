import {
  AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
  assertAudienceSafeImportDiff
} from '../contracts/lineage-contracts.js';
import {
  canonicalStringify,
  canonicalizeJson,
  hmacSha256,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { roomCheckpointStateHash } from '../domain/lineage.js';
import { assertReducerDomainState } from '../domain/reducers/index.js';
import {
  IMPORTED_PRIVATE_RELATIONSHIPS_SCHEMA,
  INITIAL_GENESIS_COMPATIBILITY_POLICY,
  SINGLEPLAYER_GENESIS_CODEC,
  assertInitialGenesisCompatibilityState
} from '../application/genesis-state.js';

const ROOM_SEATS = Object.freeze(['A', 'B']);
const ID = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9:_-]{1,255}$/u;

function fail(code, message, details = {}, status = 400, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('GENESIS_IMPORT_REVIEW_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function principal(value) {
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) {
    fail('GENESIS_IMPORT_REVIEW_REQUEST_INVALID', 'authenticated_user_id is invalid', {}, 401);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('GENESIS_IMPORT_REVIEW_REQUEST_INVALID', `${label} is invalid`, { field: label });
  }
  return value;
}

function hmac(secret, value) {
  return `hmac-sha256:${hmacSha256(secret, value)}`;
}

function immutable(value) {
  const clone = canonicalizeJson(value);
  const freeze = candidate => {
    if (candidate && typeof candidate === 'object' && !Object.isFrozen(candidate)) {
      Object.values(candidate).forEach(freeze);
      Object.freeze(candidate);
    }
    return candidate;
  };
  return freeze(clone);
}

function memberRows(database, roomId) {
  return database.prepare(`
    SELECT m.user_id, m.seat_id, r.origin_type, r.origin_owner_user_id,
           r.origin_snapshot_id, r.active_epoch_id, r.lineage_id
      FROM multiplayer_members AS m
      JOIN multiplayer_rooms AS r ON r.room_id = m.room_id
     WHERE m.room_id = ? AND m.member_status = 'ACTIVE'
     ORDER BY m.seat_id
  `).all(roomId);
}

function requireMember(database, roomId, userId) {
  const members = memberRows(database, roomId);
  const member = members.find(item => item.user_id === userId);
  if (!member) fail('ROOM_MEMBER_REQUIRED', 'authenticated user is not a Room member', {}, 403);
  return { member, members };
}

function actorLocation(state, seat) {
  const actorId = state.actors[seat].room_actor_id;
  const location = state.shared_world.world_state.locations.find(item => item.entity_id === actorId);
  const marker = location && state.shared_world.map.markers.find(
    item => item.location_id === location.location_id
  );
  return marker?.label ?? location?.location_id ?? '未知地点';
}

function boundedListSummary(prefix, values, emptyText, { maxItems = 24, maxLength = 1_800 } = {}) {
  const included = [];
  for (const value of values) {
    if (included.length >= maxItems) break;
    const candidate = [...included, value].join('、');
    if (`${prefix}${candidate}`.length > maxLength) break;
    included.push(value);
  }
  const omitted = values.length - included.length;
  return Object.freeze({
    summary: `${prefix}${included.length > 0 ? included.join('、') : emptyText}`,
    included: included.length,
    omitted
  });
}

function previewEntries(values, {
  entryPrefix,
  summary,
  maxEntries = 63,
  warningText
}) {
  const visible = values.slice(0, maxEntries).map((value, index) => ({
    entry_id: `${entryPrefix}_${index + 1}`,
    kind: 'result',
    summary: summary(value)
  }));
  if (values.length > visible.length) {
    visible.push({
      entry_id: `${entryPrefix}_truncated`,
      kind: 'warning',
      summary: warningText(values.length - visible.length, visible.length)
    });
  }
  return visible;
}

function mechanicsEntries(actor) {
  const resourceLabels = Object.freeze({
    chakra: '查克拉',
    mental: '精神力',
    money: '金钱',
    stamina: '体力',
    vitality: '生命力'
  });
  const resources = actor.attributes.resources
    .map(resource => `${resourceLabels[resource.resource_id] ?? resource.resource_id} ${resource.current}/${resource.maximum}`);
  const skills = boundedListSummary(
    '你的角色技能：',
    actor.skills.entries.map(skill => (
      `${skill.display_name}（${skill.rank}，熟练度${skill.mastery}）`
    )),
    '未导入技能。'
  );
  const entries = [
    {
      entry_id: 'entry_own_rank',
      kind: 'result',
      summary: `你的忍阶“${actor.player.rank}”已按原值保留；双方忍阶无需相同。`
    },
    {
      entry_id: 'entry_own_resources',
      kind: 'result',
      summary: `你的角色资源：${resources.join('、')}。`
    },
    {
      entry_id: 'entry_own_skills',
      kind: 'result',
      summary: skills.summary
    }
  ];
  if (skills.omitted > 0) {
    entries.push({
      entry_id: 'entry_own_skills_truncated',
      kind: 'warning',
      summary: `技能摘要仅展示前 ${skills.included} 项，另有 ${skills.omitted} 项已保留；完整内容只属于你的确认视图。`
    });
  }
  return entries;
}

function ownItemEntries(actor) {
  const items = boundedListSummary(
    '你的角色物品：',
    actor.equipment.entries.map(item => {
      const equipped = item.equipped_slot === null ? '' : `，装备槽${item.equipped_slot}`;
      return `${item.display_name}×${item.quantity}${equipped}`;
    }),
    '未导入物品。'
  );
  const entries = [{
    entry_id: 'entry_own_items',
    kind: 'result',
    summary: items.summary
  }];
  if (items.omitted > 0) {
    entries.push({
      entry_id: 'entry_own_items_truncated',
      kind: 'warning',
      summary: `物品摘要仅展示前 ${items.included} 项，另有 ${items.omitted} 项已保留；完整内容只属于你的确认视图。`
    });
  }
  entries.push({
    entry_id: 'entry_unique_mechanics_checked',
    kind: 'result',
    summary: '显式唯一能力与唯一物品引用已通过冲突检查；确认页不会公开任一角色的规范引用。'
  });
  return entries;
}

function importedPrivateRelationships(state, sourceOwnerSeat) {
  const value = state.actors[sourceOwnerSeat]?.private_knowledge?.imported_relationships;
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== IMPORTED_PRIVATE_RELATIONSHIPS_SCHEMA
    || !Array.isArray(value.entries)) {
    fail(
      'PERSISTED_LINEAGE_CORRUPT',
      'imported private relationship continuity is malformed',
      {},
      500
    );
  }
  return value.entries;
}

function sectionsFor(state, seat, sourceOwnerSeat) {
  const ownActor = state.actors[seat];
  const otherSeat = seat === 'A' ? 'B' : 'A';
  const sourceOwner = seat === sourceOwnerSeat;
  const characterSummary = [seat, otherSeat].map(actorSeat => {
    const actor = state.actors[actorSeat];
    const control = actorSeat === seat ? '你将控制' : '另一位玩家将控制';
    return `${control}“${actor.player.display_name}”（${actor.player.rank}，${actor.player.status}）`;
  }).join('；');
  const taskEntries = sourceOwner
    ? previewEntries(state.actors[sourceOwnerSeat].missions.entries, {
        entryPrefix: 'entry_task',
        summary: mission => (
          `${mission.title}：${mission.status}（${mission.progress_current}/${mission.progress_total}）`
        ),
        warningText: (omitted, included) => (
          `任务摘要仅展示前 ${included} 项，另有 ${omitted} 项已保留在你的来源连续性中。`
        )
      })
    : [{
      entry_id: 'entry_tasks_private',
      kind: 'warning',
      summary: '来源角色的未公开任务作为其私有连续性保留，不在客方确认视图中展开。'
    }];
  const relationshipEntries = sourceOwner
    ? previewEntries(importedPrivateRelationships(state, sourceOwnerSeat), {
        entryPrefix: 'entry_relationship',
        summary: entry => (
          `${entry.display_name}：${entry.directed_relationship.label}`
          + `（${entry.directed_relationship.kind}）`
        ),
        warningText: (omitted, included) => (
          `关系摘要仅展示前 ${included} 项，另有 ${omitted} 项已保留在你的来源连续性中。`
        )
      })
    : [{
      entry_id: 'entry_relationships_private',
      kind: 'warning',
      summary: '来源存档中未向你公开的 NPC 关系、目标和伏笔不会出现在你的确认视图中。'
    }];
  return [
    {
      category: 'world_time',
      entries: [
        {
          entry_id: 'entry_world_time',
          kind: 'result',
          summary: `联机起点：${state.shared_world.calendar.display_date}，${actorLocation(state, sourceOwnerSeat)}。`
        },
        {
          entry_id: 'entry_guest_world_time_normalized',
          kind: 'result',
          summary: '时代与日期只采用来源 S0；客方旧世界字段已确定性剥离，机械字段中的显式时代/日期引用已检查。'
        }
      ]
    },
    {
      category: 'tasks',
      entries: taskEntries
    },
    {
      category: 'characters',
      entries: [
        { entry_id: 'entry_characters', kind: 'result', summary: characterSummary },
        ...mechanicsEntries(ownActor),
        {
          entry_id: 'entry_actor_ids',
          kind: 'result',
          summary: '两名角色已由服务端分配互不相同的稳定房间角色 ID；客户端旧 ID 不参与绑定。'
        }
      ]
    },
    {
      category: 'relationships',
      entries: relationshipEntries
    },
    {
      category: 'items',
      entries: ownItemEntries(ownActor)
    },
    {
      category: 'memories',
      entries: [{
        entry_id: 'entry_memories',
        kind: 'result',
        summary: sourceOwner
          ? '来源单机记忆已保留在来源角色与 NPC 私有分区，不会自动公开给客方。'
          : '不会导入你的原世界记忆；你的角色只保留本次角色卡允许的私有背景。'
      }]
    },
    {
      category: 'privacy_normalization',
      entries: [{
        entry_id: 'entry_privacy',
        kind: 'result',
        summary: `服务端按 ${INITIAL_GENESIS_COMPATIBILITY_POLICY} 只从来源 S0 重建世界；客方角色卡中的世界、任务、关系、记忆和 Agent 内部字段均已排除。`
      }]
    }
  ];
}

function diffContext(roomId, sourceImportId, proposalId, seat) {
  return Object.freeze({
    purpose: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
    phase: 'initial_genesis',
    room_id: roomId,
    source_import_id: sourceImportId,
    proposal_id: proposalId,
    proposal_revision: 1,
    audience: seat
  });
}

function buildDiff({
  state,
  seat,
  membersBySeat,
  sourceOwnerUserId,
  roomId,
  lineageId,
  sourceImportId,
  proposalId,
  commitmentSecret,
  serverCommitment
}) {
  const sourceOwnerSeat = membersBySeat.A === sourceOwnerUserId ? 'A' : 'B';
  const unsigned = {
    schema: AUDIENCE_SAFE_IMPORT_DIFF_SCHEMA,
    proposal_id: proposalId,
    proposal_revision: 1,
    room_id: roomId,
    lineage_id: lineageId,
    source_import_id: sourceImportId,
    audience: seat,
    audience_user_id: membersBySeat[seat],
    audience_role: seat === sourceOwnerSeat ? 'source_owner' : 'guest',
    sections: sectionsFor(state, seat, sourceOwnerSeat)
  };
  const projectionCommitment = hmac(commitmentSecret, {
    schema: 'naruto.multiplayer-initial-import-diff-commitment/v1',
    compatibility_policy: INITIAL_GENESIS_COMPATIBILITY_POLICY,
    diff: unsigned
  });
  return assertAudienceSafeImportDiff({
    ...unsigned,
    projection_commitment: projectionCommitment,
    server_hmac_commitment: serverCommitment
  }, {
    expected_members_by_seat: membersBySeat,
    origin_owner_user_id: sourceOwnerUserId
  });
}

export function createSqliteGenesisImportReviewRepository(connection, {
  audienceDiffCodec,
  commitmentSecret,
  clock = () => new Date().toISOString()
} = {}) {
  if (!connection || typeof connection.read !== 'function' || typeof connection.write !== 'function'
    || typeof audienceDiffCodec?.sealJson !== 'function'
    || typeof audienceDiffCodec?.openJson !== 'function'
    || typeof audienceDiffCodec?.codecVersion !== 'string'
    || typeof commitmentSecret !== 'string' || !commitmentSecret) {
    fail(
      'GENESIS_IMPORT_REVIEW_CONFIGURATION_INVALID',
      'genesis import review dependencies are incomplete',
      {},
      500
    );
  }

  async function ensure({
    authenticated_user_id,
    room_id,
    source_import_id,
    source_basis_hash,
    genesis_state_hash,
    state,
    created_at = clock()
  }) {
    const userId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    const sourceImportId = identifier(source_import_id, 'source_import_id');
    timestamp(created_at, 'created_at');
    for (const [label, value] of [
      ['source_basis_hash', source_basis_hash],
      ['genesis_state_hash', genesis_state_hash]
    ]) {
      if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
        fail('GENESIS_IMPORT_REVIEW_REQUEST_INVALID', `${label} is invalid`);
      }
    }
    const reducerState = canonicalizeJson(assertReducerDomainState(state));
    assertInitialGenesisCompatibilityState(reducerState);
    const reducerStateHash = roomCheckpointStateHash(reducerState, {
      A: reducerState.actors.A.room_actor_id,
      B: reducerState.actors.B.room_actor_id
    });
    if (reducerStateHash !== genesis_state_hash) {
      fail('SOURCE_IMPORT_CHANGED', 'review state does not match the genesis state hash', {}, 409);
    }
    const authority = connection.read(database => {
      const { member, members } = requireMember(database, roomId, userId);
      if (members.length !== 2
        || member.origin_type !== 'existing_save_derived'
        || member.origin_snapshot_id !== sourceImportId
        || member.active_epoch_id === null) {
        fail('GENESIS_IMPORT_REVIEW_NOT_READY', 'Room genesis is not ready for review', {}, 409);
      }
      const checkpoint = database.prepare(`
        SELECT c.state_hash, r.lineage_id
          FROM multiplayer_rooms AS r
          JOIN room_epochs AS e ON e.epoch_id = r.active_epoch_id
          JOIN room_checkpoints AS c ON c.checkpoint_id = e.genesis_checkpoint_id
         WHERE r.room_id = ?
      `).get(roomId);
      if (!checkpoint || checkpoint.state_hash !== genesis_state_hash) {
        fail('SOURCE_IMPORT_CHANGED', 'genesis checkpoint changed before review', {}, 409);
      }
      const source = database.prepare(`
        SELECT state_hash, import_status, consumed_room_id
          FROM save_import_staging WHERE import_id = ?
      `).get(sourceImportId);
      if (!source
        || source.state_hash !== source_basis_hash
        || source.import_status !== 'CONSUMED'
        || source.consumed_room_id !== roomId) {
        fail('SOURCE_IMPORT_CHANGED', 'consumed source basis changed before review', {}, 409);
      }
      return {
        lineage_id: checkpoint.lineage_id,
        origin_owner_user_id: member.origin_owner_user_id,
        members_by_seat: Object.fromEntries(members.map(item => [item.seat_id, item.user_id]))
      };
    });
    const proposalId = `genesis_review_${sha256Hex(canonicalStringify({
      room_id: roomId,
      source_import_id: sourceImportId
    })).slice(0, 40)}`;
    const serverCommitment = hmac(commitmentSecret, {
      schema: 'naruto.multiplayer-initial-genesis-review/v1',
      room_id: roomId,
      lineage_id: authority.lineage_id,
      source_import_id: sourceImportId,
      source_basis_hash,
      genesis_state_hash,
      codec: SINGLEPLAYER_GENESIS_CODEC,
      compatibility_policy: INITIAL_GENESIS_COMPATIBILITY_POLICY,
      proposal_id: proposalId,
      proposal_revision: 1
    });
    const diffs = Object.fromEntries(ROOM_SEATS.map(seat => [seat, buildDiff({
      state: reducerState,
      seat,
      membersBySeat: authority.members_by_seat,
      sourceOwnerUserId: authority.origin_owner_user_id,
      roomId,
      lineageId: authority.lineage_id,
      sourceImportId,
      proposalId,
      commitmentSecret,
      serverCommitment
    })]));
    const ciphertext = Object.fromEntries(ROOM_SEATS.map(seat => [seat,
      audienceDiffCodec.sealJson(diffs[seat], diffContext(roomId, sourceImportId, proposalId, seat))
    ]));
    return connection.write(database => {
      requireMember(database, roomId, userId);
      const existing = database.prepare(`
        SELECT * FROM room_genesis_import_reviews WHERE room_id = ?
      `).get(roomId);
      if (existing) {
        if (existing.source_import_id !== sourceImportId
          || existing.source_basis_hash !== source_basis_hash
          || existing.genesis_state_hash !== genesis_state_hash
          || existing.proposal_id !== proposalId
          || existing.server_hmac_commitment !== serverCommitment) {
          fail('SOURCE_IMPORT_CHANGED', 'genesis review was already created from another basis', {}, 409);
        }
        return immutable({ proposal_id: proposalId, proposal_revision: 1, replayed: true });
      }
      database.prepare(`
        INSERT INTO room_genesis_import_reviews (
          room_id, source_import_id, proposal_id, proposal_revision,
          genesis_codec, source_basis_hash, genesis_state_hash,
          audience_diff_codec, audience_diff_a_ciphertext,
          audience_diff_b_ciphertext, audience_diff_a_commitment,
          audience_diff_b_commitment, server_hmac_commitment,
          accepted_by_a_at, accepted_by_b_at, review_status, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
          'AWAITING_CONFIRMATION', ?)
      `).run(
        roomId,
        sourceImportId,
        proposalId,
        SINGLEPLAYER_GENESIS_CODEC,
        source_basis_hash,
        genesis_state_hash,
        audienceDiffCodec.codecVersion,
        ciphertext.A,
        ciphertext.B,
        diffs.A.projection_commitment,
        diffs.B.projection_commitment,
        serverCommitment,
        created_at
      );
      return immutable({ proposal_id: proposalId, proposal_revision: 1, replayed: false });
    });
  }

  function getForMember({ authenticated_user_id, room_id }) {
    const userId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    const stored = connection.read(database => {
      const { member, members } = requireMember(database, roomId, userId);
      const row = database.prepare(`
        SELECT * FROM room_genesis_import_reviews WHERE room_id = ?
      `).get(roomId);
      return row ? {
        row: { ...row },
        seat: member.seat_id,
        lineage_id: member.lineage_id,
        origin_owner_user_id: member.origin_owner_user_id,
        members_by_seat: Object.fromEntries(members.map(item => [item.seat_id, item.user_id]))
      } : null;
    });
    if (!stored) return null;
    const {
      row,
      seat,
      lineage_id: lineageId,
      origin_owner_user_id: originOwnerUserId,
      members_by_seat: membersBySeat
    } = stored;
    if (row.audience_diff_codec !== audienceDiffCodec.codecVersion) {
      fail('PERSISTED_LINEAGE_CORRUPT', 'genesis audience diff codec is unavailable', {}, 500);
    }
    let diff;
    try {
      diff = audienceDiffCodec.openJson(
        row[`audience_diff_${seat.toLowerCase()}_ciphertext`],
        diffContext(roomId, row.source_import_id, row.proposal_id, seat)
      );
      assertAudienceSafeImportDiff(diff, {
        expected_members_by_seat: membersBySeat,
        origin_owner_user_id: originOwnerUserId
      });
      const {
        projection_commitment: projectionCommitment,
        server_hmac_commitment: diffServerCommitment,
        ...unsignedDiff
      } = diff;
      const expectedProjectionCommitment = hmac(commitmentSecret, {
        schema: 'naruto.multiplayer-initial-import-diff-commitment/v1',
        compatibility_policy: INITIAL_GENESIS_COMPATIBILITY_POLICY,
        diff: unsignedDiff
      });
      const expectedServerCommitment = hmac(commitmentSecret, {
        schema: 'naruto.multiplayer-initial-genesis-review/v1',
        room_id: roomId,
        lineage_id: lineageId,
        source_import_id: row.source_import_id,
        source_basis_hash: row.source_basis_hash,
        genesis_state_hash: row.genesis_state_hash,
        codec: row.genesis_codec,
        compatibility_policy: INITIAL_GENESIS_COMPATIBILITY_POLICY,
        proposal_id: row.proposal_id,
        proposal_revision: row.proposal_revision
      });
      if (diff.audience !== seat
        || diff.room_id !== roomId
        || diff.lineage_id !== lineageId
        || diff.source_import_id !== row.source_import_id
        || diff.proposal_id !== row.proposal_id
        || diff.proposal_revision !== row.proposal_revision
        || projectionCommitment !== row[`audience_diff_${seat.toLowerCase()}_commitment`]
        || projectionCommitment !== expectedProjectionCommitment
        || diffServerCommitment !== row.server_hmac_commitment
        || diffServerCommitment !== expectedServerCommitment
        || row.genesis_codec !== SINGLEPLAYER_GENESIS_CODEC) {
        fail('PERSISTED_LINEAGE_CORRUPT', 'genesis audience diff authority does not match', {}, 500);
      }
    } catch (error) {
      if (error?.code === 'PERSISTED_LINEAGE_CORRUPT') throw error;
      fail('PERSISTED_LINEAGE_CORRUPT', 'genesis audience diff could not be authenticated', {}, 500, error);
    }
    return immutable({
      proposal_id: row.proposal_id,
      proposal_revision: row.proposal_revision,
      status: row.review_status,
      audience_diff: diff,
      audience_diff_commitment: row[`audience_diff_${seat.toLowerCase()}_commitment`],
      server_hmac_commitment: row.server_hmac_commitment,
      accepted_by: {
        A: row.accepted_by_a_at !== null,
        B: row.accepted_by_b_at !== null
      },
      accepted_by_viewer: row[`accepted_by_${seat.toLowerCase()}_at`] !== null,
      created_at: row.created_at
    });
  }

  async function accept({
    authenticated_user_id,
    room_id,
    proposal_revision,
    audience_diff_commitment
  }) {
    const userId = principal(authenticated_user_id);
    const roomId = identifier(room_id, 'room_id');
    if (proposal_revision !== 1 || typeof audience_diff_commitment !== 'string') {
      fail('GENESIS_IMPORT_REVIEW_REQUEST_INVALID', 'review revision or commitment is invalid');
    }
    const projected = getForMember({
      authenticated_user_id: userId,
      room_id: roomId
    });
    if (!projected
      || projected.proposal_revision !== proposal_revision
      || projected.audience_diff_commitment !== audience_diff_commitment) {
      fail('SOURCE_IMPORT_CHANGED', 'member accepted another genesis import diff', {}, 409);
    }
    const acceptedAt = timestamp(clock(), 'clock');
    return connection.write(database => {
      const { member } = requireMember(database, roomId, userId);
      const row = database.prepare(`
        SELECT * FROM room_genesis_import_reviews WHERE room_id = ?
      `).get(roomId);
      if (!row) fail('GENESIS_IMPORT_REVIEW_NOT_READY', 'genesis import review is unavailable', {}, 409);
      const seat = member.seat_id;
      const expected = row[`audience_diff_${seat.toLowerCase()}_commitment`];
      if (audience_diff_commitment !== expected || row.proposal_revision !== proposal_revision) {
        fail('SOURCE_IMPORT_CHANGED', 'member accepted another genesis import diff', {}, 409);
      }
      const acceptedColumn = `accepted_by_${seat.toLowerCase()}_at`;
      if (row[acceptedColumn] !== null) {
        return immutable({
          proposal_id: row.proposal_id,
          proposal_revision: 1,
          all_accepted: row.review_status === 'ACCEPTED',
          replayed: true
        });
      }
      const otherSeat = seat === 'A' ? 'b' : 'a';
      database.prepare(`
        UPDATE room_genesis_import_reviews
           SET ${acceptedColumn} = ?,
               review_status = CASE
                 WHEN accepted_by_${otherSeat}_at IS NOT NULL THEN 'ACCEPTED'
                 ELSE 'AWAITING_CONFIRMATION'
               END
         WHERE room_id = ?
      `).run(acceptedAt, roomId);
      const accepted = database.prepare(`
        SELECT accepted_by_a_at, accepted_by_b_at, review_status
          FROM room_genesis_import_reviews WHERE room_id = ?
      `).get(roomId);
      const allAccepted = accepted.accepted_by_a_at !== null && accepted.accepted_by_b_at !== null;
      if (allAccepted !== (accepted.review_status === 'ACCEPTED')) {
        fail('PERSISTED_LINEAGE_CORRUPT', 'genesis review acceptance state is inconsistent', {}, 500);
      }
      return immutable({
        proposal_id: row.proposal_id,
        proposal_revision: 1,
        all_accepted: allAccepted,
        replayed: false
      });
    });
  }

  return Object.freeze({ ensure, getForMember, accept });
}
