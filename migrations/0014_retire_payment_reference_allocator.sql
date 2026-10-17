-- Deploy the schema-13/14 compatible runtime first. No reservation is erased.
-- Issuance belongs to consuming applications; bank facts remain unchanged.
UPDATE physical_accounts SET allocation_enabled=0;
DROP TRIGGER IF EXISTS reference_identity_immutable;
-- Keep reference_no_update/reference_no_delete: retained obligations are audit facts.
UPDATE schema_meta SET value='14' WHERE key='version';
