export const ROOM_SEATS = Object.freeze(['A', 'B']);
export const ROOM_ORIGIN_TYPES = Object.freeze([
  'existing_save_derived',
  'new_multiplayer_save'
]);
export const NARRATIVE_MODES = Object.freeze(['shared', 'dual_pov']);
export const PRE_RESOLUTION_VISIBILITIES = Object.freeze(['open', 'sealed']);
export const NARRATION_PREFERENCES = Object.freeze(['full', 'summarize_intent']);
export const CONTINUITY_TRANSPORTS = Object.freeze(['native_tools', 'json_protocol']);
export const CONTINUITY_OPERATIONS = Object.freeze([
  'stage_turn_bundle',
  'repair_turn_bundle'
]);
export const CONFLICT_TYPES = Object.freeze([
  'independent',
  'resource_race',
  'causal_conflict',
  'direct_opposition',
  'mutually_impossible'
]);
export const ACTION_OUTCOME_STATUSES = Object.freeze([
  'success',
  'partial_success',
  'transformed',
  'blocked',
  'failed'
]);
export const DOMAIN_CHECK_REASON_CODES = Object.freeze([
  'NO_CANONICAL_CHANGE',
  'NOT_APPLICABLE_TO_SCOPE',
  'ALREADY_REFLECTED_IN_BASE'
]);
export const CONTINUITY_RESULT_STATUSES = Object.freeze([
  'READY',
  'REPAIR_REQUIRED',
  'PROTOCOL_RETRY',
  'HANDOFF_REQUIRED',
  'PAUSED'
]);
export const CONTINUITY_RETRY_OWNERS = Object.freeze([
  'none',
  'continuity',
  'referee',
  'orchestrator'
]);
export const CONTINUITY_PAUSE_REASONS = Object.freeze([
  'BILLING_AUTHORIZATION_REQUIRED',
  'LOOP_BREAKER',
  'MANUAL_PAUSE',
  'RECOVERABLE_RUNTIME_FAULT'
]);
export const TURN_DRAFT_STATUSES = Object.freeze([
  'OPEN',
  'REVIEW_REQUIRED',
  'READY',
  'DISCARDED'
]);
export const TURN_STATUSES = Object.freeze([
  'AWAITING_PAYER_SELECTION',
  'COLLECTING_ACTIONS',
  'ONE_ACTION_LOCKED',
  'SEALED',
  'AWAITING_BILLING_AUTHORIZATION',
  'RESOLVING',
  'RENDERING',
  'STAGING_UPDATES',
  'AUDITING',
  'REPAIRING_DRAFT',
  'RENDERING_REPAIR',
  'RESOLUTION_HANDOFF',
  'REPAIR_PAUSED',
  'RETRYABLE_FAILED',
  'VOID_REQUESTED',
  'TURN_VOIDED',
  'COMMITTING',
  'RECOVERING_COMMIT',
  'COMMITTED',
  'CONSISTENCY_FAULT'
]);
export const ROOM_LIFECYCLES = Object.freeze([
  'LOBBY',
  'READY',
  'ACTIVE',
  'ARCHIVED'
]);
export const MODEL_ADAPTERS = Object.freeze([
  'openai_compatible',
  'anthropic'
]);
export const CREDENTIAL_STATES = Object.freeze([
  'ACTIVE',
  'REVOKED'
]);
export const EXECUTION_GRANT_STATES = Object.freeze([
  'ACTIVE',
  'REVOKED',
  'EXHAUSTED',
  'EXPIRED'
]);
export const CHAT_MESSAGE_MAX_LENGTH = 1_000;

/** Values frozen by design section 28.1; UI defaults intentionally live apart. */
export const CONFIRMED_MULTIPLAYER_INVARIANTS = Object.freeze({
  max_players: 2,
  origin_type_allowed: ROOM_ORIGIN_TYPES,
  origin_type_selection_required: true,
  existing_save_import: 'source_owner_world_guest_character_only',
  narrative_mode_change: 'either_member_before_first_lock_else_queue_next_turn',
  narrative_mode_allowed: NARRATIVE_MODES,
  pre_resolution_visibility_allowed: PRE_RESOLUTION_VISIBILITIES,
  post_commit_disclosure: 'full_after_commit',
  receipt_order_story_effect: 'none',
  wait_policy: 'unlimited_player_coordinated',
  action_timeout: null,
  chat_enabled: true,
  chat_agent_ingestion: 'explicit_action_copy_only',
  ai_billing: 'player_byok_no_platform_fallback',
  credential_usage_policy: 'mutually_confirmed_a_only_b_only_or_alternate',
  alternate_credential_first_payer: 'A_on_odd_turns_B_on_even_turns',
  shared_stage_payer_selection: 'server_materialized_each_turn_from_credential_policy',
  shared_stage_payer_inheritance: 'policy_derived_never_previous_turn_fallback',
  shared_stage_payer_acceptance: 'both_members_pre_authorize_policy_before_first_action_lock',
  dual_pov_writer_selection: 'server_materialized_for_both_audiences_from_credential_policy',
  dual_pov_writer_payer: 'same_as_policy_resolved_turn_payer',
  turn_model_selection_browser_default: 'never',
  billing_preflight: 'all_required_grants_before_first_model_call',
  credential_mode: 'encrypted_server_vault',
  credential_plaintext_readback: 'never',
  credential_endpoint_binding: 'normalized_origin_and_revision',
  custom_shared_endpoint_policy: 'player_supplied_public_https_supported_adapter',
  continuity_transport_allowed: CONTINUITY_TRANSPORTS,
  continuity_transport_minimum_capability: 'validated_by_formal_stage_schema_and_repair',
  continuity_transport_selection: 'json_protocol_frozen_per_invocation',
  agent_execution: 'server_authoritative_structured_bundle',
  frontend_instruction_parsing: 'forbidden',
  turn_failure_policy: 'no_partial_commit_or_action_disclosure',
  deployment_topology: 'single_instance',
  database_backend: 'sqlite_wal',
  existing_save_resume: Object.freeze([
    'resume_room_checkpoint',
    'fork_from_latest_source_save'
  ]),
  existing_save_playable_export: 'both_original_members_personal_projection',
  singleplayer_export_player_actor: 'exporting_member',
  singleplayer_export_counterpart_actor: 'audience_safe_npc_with_signed_room_actor_binding',
  singleplayer_export_actor_bindings: 'both_actors_distinct_opaque_non_agent_tokens',
  latest_source_uploader: 'origin_owner',
  guest_export_reimport_original_room: false,
  latest_source_returning_actor: 'exact_signed_l2_binding_required',
  latest_source_actor_binding_validation: 'both_original_actors_unique_bijection',
  latest_source_returning_actor_mechanical_state: 'privacy_normalized_l2_only',
  latest_source_private_continuity: 'l2_authorized_projection_only_no_checkpoint_capsule',
  latest_source_privacy_normalization: 'strip_known_isolated_private_namespaces_else_reject',
  latest_source_genesis_formula: 'privacy_normalized_l2_plus_control_rebind',
  latest_source_rebind_failure: 'block_without_guess_or_fresh_character',
  new_multiplayer_save_export: 'multiplayer_only',
  archived_room_resume_membership: 'original_two_members_only'
});

export const MULTIPLAYER_UI_DEFAULTS = Object.freeze({
  narrative_mode_default: 'shared',
  pre_resolution_visibility_default: 'sealed',
  narration_preference_default: 'full'
});
