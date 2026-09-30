import assert from 'node:assert/strict';

import {
  AUDIENCE_PROJECTION_SCHEMA,
  AudienceProjectionError,
  PROJECTION_AUDIENCE,
  SHARED_PROJECTION_SCHEMA,
  WORLD_PUBLIC_PROJECTION_SCHEMA,
  projectAudience,
  projectAudienceViews
} from '../server/multiplayer/domain/audience-projector.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function ids(projection, collection, key) {
  return projection[collection].map(record => record[key]);
}

function byId(projection, collection, key, id) {
  return projection[collection].find(record => record[key] === id);
}

function fixture() {
  return {
    schema: 'naruto.multiplayer-resolution/v1',
    turn_id: 'turn_projection_1',
    receipt_seq: 99,
    conflicts: [{ id: 'conflict_secret', reason: 'must never be projected' }],
    outcomes: [{ submission_id: 'action_A', reason: 'private outcome reason' }],
    effects: [{ effect_id: 'effect_secret', payload: { amount: 12 } }],
    events: [
      {
        event_id: 'event_shared',
        summary: '两名角色共同看见密室石门开启。',
        audiences: ['seat:B', 'seat:A'],
        world_public: false,
        effect_ids: ['effect_secret'],
        conflict_refs: ['conflict_secret'],
        reason: 'server-only adjudication explanation',
        event_count: 6,
        event_refs: [
          'event_public',
          'event_everywhere',
          'event_b',
          'event_a',
          'event_missing'
        ],
        source_refs: ['event_b', 'world:archive', 'event_a'],
        related_event_id: 'event_public',
        details: [
          {
            id: 'detail_server',
            visibility: 'server_only',
            summary: 'sealed server detail'
          },
          {
            id: 'detail_b',
            audiences: ['seat:B'],
            world_public: false,
            summary: 'B notices a private marking.'
          },
          {
            id: 'detail_shared',
            audiences: ['seat:A', 'seat:B'],
            world_public: false,
            summary: 'Both hear the lock click.'
          },
          {
            id: 'detail_a',
            audiences: ['seat:A'],
            world_public: false,
            summary: 'A notices a private marking.'
          }
        ],
        hidden_slots: [
          {
            visibility: 'server_only',
            value: 'no placeholder may remain'
          }
        ]
      },
      {
        event_id: 'event_a',
        summary: 'A 独自察觉暗号。',
        audiences: ['actor:A'],
        world_public: false
      },
      {
        event_id: 'event_public',
        summary: '远处村民公开目击了烽火。',
        audiences: ['npc:villager'],
        world_public: true
      },
      {
        event_id: 'event_server',
        summary: 'internal-only event',
        audiences: ['seat:A', 'seat:B'],
        world_public: true,
        visibility: 'server_only'
      },
      {
        event_id: 'event_everywhere',
        summary: '两人和公众都知道会场钟声响起。',
        audiences: ['seat:A', 'seat:B'],
        world_public: true
      },
      {
        event_id: 'event_b',
        summary: 'B 独自察觉暗号。',
        audiences: ['actor:B'],
        world_public: false
      }
    ],
    facts: [
      {
        fact_id: 'fact_public',
        summary: '烽火已经成为公开消息。',
        audiences: ['npc:villager'],
        world_public: true,
        event_refs: ['event_public', 'event_shared']
      },
      {
        fact_id: 'fact_shared',
        summary: '石门已开启。',
        audiences: ['seat:A', 'seat:B'],
        world_public: false,
        event_refs: ['event_shared', 'event_server']
      },
      {
        fact_id: 'fact_a',
        summary: '暗号内容只有 A 知道。',
        audiences: ['seat:A'],
        world_public: false,
        event_ref: 'event_a'
      },
      {
        fact_id: 'fact_everywhere',
        summary: '会场钟声已经响过。',
        audiences: ['seat:A', 'seat:B'],
        world_public: true,
        event_refs: ['event_everywhere']
      },
      {
        fact_id: 'fact_b',
        summary: '暗号内容只有 B 知道。',
        audiences: ['seat:B'],
        world_public: false,
        event_ref: 'event_b'
      },
      {
        fact_id: 'fact_server',
        summary: 'internal fact',
        audiences: ['seat:A', 'seat:B'],
        world_public: true,
        visibility: 'server_only'
      }
    ]
  };
}

test('seat, shared, and world-public projections enforce independent privacy grants', () => {
  const views = projectAudienceViews(fixture());

  assert.deepEqual(ids(views.seat_A, 'events', 'event_id'), [
    'event_a',
    'event_everywhere',
    'event_shared'
  ]);
  assert.deepEqual(ids(views.seat_B, 'events', 'event_id'), [
    'event_b',
    'event_everywhere',
    'event_shared'
  ]);
  assert.deepEqual(ids(views.shared, 'events', 'event_id'), [
    'event_everywhere',
    'event_shared'
  ]);
  assert.deepEqual(ids(views.world_public, 'events', 'event_id'), [
    'event_everywhere',
    'event_public'
  ]);

  assert.deepEqual(ids(views.seat_A, 'facts', 'fact_id'), [
    'fact_a',
    'fact_everywhere',
    'fact_shared'
  ]);
  assert.deepEqual(ids(views.seat_B, 'facts', 'fact_id'), [
    'fact_b',
    'fact_everywhere',
    'fact_shared'
  ]);
  assert.deepEqual(ids(views.shared, 'facts', 'fact_id'), [
    'fact_everywhere',
    'fact_shared'
  ]);
  assert.deepEqual(ids(views.world_public, 'facts', 'fact_id'), [
    'fact_everywhere',
    'fact_public'
  ]);

  assert.equal(views.seat_A.schema, AUDIENCE_PROJECTION_SCHEMA);
  assert.equal(views.seat_B.audience, PROJECTION_AUDIENCE.SEAT_B);
  assert.equal(views.shared.schema, SHARED_PROJECTION_SCHEMA);
  assert.equal(views.world_public.schema, WORLD_PUBLIC_PROJECTION_SCHEMA);
  assert.equal(views.world_public.turn_id, 'turn_projection_1');
});

test('projection removes dangling/internal references, reasons, holes, and hidden counts', () => {
  const { seat_A: seatA, shared } = projectAudienceViews(fixture());
  const seatEvent = byId(seatA, 'events', 'event_id', 'event_shared');
  const sharedEvent = byId(shared, 'events', 'event_id', 'event_shared');

  assert.deepEqual(seatEvent.event_refs, ['event_a', 'event_everywhere']);
  assert.deepEqual(seatEvent.source_refs, ['event_a', 'world:archive']);
  assert.equal('related_event_id' in seatEvent, false);
  assert.equal('effect_ids' in seatEvent, false);
  assert.equal('conflict_refs' in seatEvent, false);
  assert.equal('reason' in seatEvent, false);
  assert.equal('event_count' in seatEvent, false);
  assert.equal('hidden_slots' in seatEvent, false);
  assert.deepEqual(seatEvent.details.map(detail => detail.id), ['detail_a', 'detail_shared']);
  assert.deepEqual(sharedEvent.details.map(detail => detail.id), ['detail_shared']);

  const sharedFact = byId(shared, 'facts', 'fact_id', 'fact_shared');
  assert.deepEqual(sharedFact.event_refs, ['event_shared']);

  const serialized = JSON.stringify(projectAudienceViews(fixture()));
  for (const forbidden of [
    'effect_secret',
    'conflict_secret',
    'private outcome reason',
    'sealed server detail',
    'no placeholder may remain',
    'internal-only event',
    'internal fact'
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked forbidden fragment: ${forbidden}`);
  }
});

test('all projections are independent deep copies and input remains immutable', () => {
  const source = fixture();
  const before = JSON.stringify(source);
  const views = projectAudienceViews(source);

  assert.equal(JSON.stringify(source), before);
  assert.notStrictEqual(views.seat_A.events, source.events);
  assert.notStrictEqual(views.seat_A.events, views.shared.events);

  const seatSharedEvent = byId(views.seat_A, 'events', 'event_id', 'event_shared');
  const sharedSharedEvent = byId(views.shared, 'events', 'event_id', 'event_shared');
  seatSharedEvent.summary = 'mutated projection';
  seatSharedEvent.details[0].summary = 'mutated nested projection';

  assert.equal(byId(source, 'events', 'event_id', 'event_shared').summary, '两名角色共同看见密室石门开启。');
  assert.equal(sharedSharedEvent.summary, '两名角色共同看见密室石门开启。');
  assert.equal(JSON.stringify(source), before);
});

test('shared knowledge is neither widened from nor narrowed to world-public knowledge', () => {
  const views = projectAudienceViews(fixture());

  assert.ok(byId(views.shared, 'events', 'event_id', 'event_shared'));
  assert.equal(byId(views.world_public, 'events', 'event_id', 'event_shared'), undefined);

  assert.ok(byId(views.world_public, 'events', 'event_id', 'event_public'));
  assert.equal(byId(views.shared, 'events', 'event_id', 'event_public'), undefined);
  assert.equal(byId(views.seat_A, 'events', 'event_id', 'event_public'), undefined);
  assert.equal(byId(views.seat_B, 'events', 'event_id', 'event_public'), undefined);
});

test('canonical collection, nested record, audience, and reference reordering is deterministic', () => {
  const first = fixture();
  const reordered = structuredClone(first);
  reordered.events.reverse();
  reordered.facts.reverse();

  for (const record of [...reordered.events, ...reordered.facts]) {
    if (Array.isArray(record.audiences)) record.audiences.reverse();
    if (Array.isArray(record.event_refs)) record.event_refs.reverse();
    if (Array.isArray(record.source_refs)) record.source_refs.reverse();
    if (Array.isArray(record.details)) record.details.reverse();
  }

  assert.deepEqual(projectAudienceViews(reordered), projectAudienceViews(first));
  assert.equal(
    JSON.stringify(projectAudienceViews(reordered)),
    JSON.stringify(projectAudienceViews(first))
  );
});

test('single-target API is fail-closed for absent or invalid policy data', () => {
  const noPolicy = {
    events: [{ event_id: 'event_unscoped', summary: 'must default to hidden' }],
    facts: []
  };
  assert.deepEqual(projectAudience(noPolicy, PROJECTION_AUDIENCE.SEAT_A).events, []);
  assert.deepEqual(projectAudience(noPolicy, PROJECTION_AUDIENCE.WORLD_PUBLIC).events, []);

  assert.throws(
    () => projectAudience(fixture(), 'everyone'),
    error => error instanceof AudienceProjectionError && error.code === 'INVALID_PROJECTION_TARGET'
  );
  assert.throws(
    () => projectAudience({
      events: [{ event_id: 'event_bad', visibility: 'maybe_public' }]
    }, PROJECTION_AUDIENCE.SEAT_A),
    error => error instanceof AudienceProjectionError && error.code === 'INVALID_VISIBILITY'
  );
  assert.throws(
    () => projectAudience({
      events: [
        { event_id: 'event_duplicate', audiences: ['seat:A'] },
        { event_id: 'event_duplicate', audiences: ['seat:A'] }
      ]
    }, PROJECTION_AUDIENCE.SEAT_A),
    error => error instanceof AudienceProjectionError && error.code === 'DUPLICATE_RECORD_ID'
  );
});

console.log(`\n${passed} multiplayer audience projection regression tests passed.`);
