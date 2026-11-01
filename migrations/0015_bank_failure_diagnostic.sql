-- Deploy the schema-14/15 compatible runtime before this additive migration.
-- The latest safe failure survives recovery; api_last_error still owns current health.
ALTER TABLE bank_accounts ADD COLUMN api_last_failure TEXT CHECK(api_last_failure IS NULL OR json_valid(api_last_failure));
UPDATE schema_meta SET value='15' WHERE key='version';
