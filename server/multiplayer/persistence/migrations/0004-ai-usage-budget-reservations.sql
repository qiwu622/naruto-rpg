ALTER TABLE ai_usage_ledger
  ADD COLUMN reserved_input_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (reserved_input_tokens >= 0);

ALTER TABLE ai_usage_ledger
  ADD COLUMN reserved_output_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (reserved_output_tokens >= 0);

ALTER TABLE ai_usage_ledger
  ADD COLUMN reserved_retry_count INTEGER NOT NULL DEFAULT 0
  CHECK (reserved_retry_count BETWEEN 0 AND 1);

ALTER TABLE ai_usage_ledger
  ADD COLUMN budget_charge_state TEXT NOT NULL DEFAULT 'RESERVED'
  CHECK (budget_charge_state IN ('RESERVED', 'SETTLED', 'RELEASED'));

ALTER TABLE ai_usage_ledger
  ADD COLUMN authorization_snapshot_json TEXT
  CHECK (authorization_snapshot_json IS NULL OR length(authorization_snapshot_json) >= 2);

UPDATE ai_usage_ledger
   SET reserved_input_tokens = COALESCE(input_tokens, 0),
       reserved_output_tokens = COALESCE(output_tokens, 0),
       reserved_retry_count = CASE WHEN attempt > 1 THEN 1 ELSE 0 END,
       budget_charge_state = CASE
         WHEN usage_status IN ('IN_FLIGHT', 'UNKNOWN', 'CANCELLED') THEN 'RESERVED'
         ELSE 'SETTLED'
       END;
