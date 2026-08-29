-- banksync Phase 1.5 — CF Email Routing rule auto-sync
--
-- Adds cf_rule_id to bank_accounts so the worker can directly
-- DELETE the matching CF Email Routing rule when an account is removed
-- (without scanning all rules to find the matcher value).
--
-- nullable: existing rows + dev/test setups without CF_API_TOKEN
-- have NULL cf_rule_id (CF auto-sync is opt-in via worker secret).

ALTER TABLE bank_accounts ADD COLUMN cf_rule_id TEXT;

UPDATE schema_meta SET value = '3' WHERE key = 'version';
