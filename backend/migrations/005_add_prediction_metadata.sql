-- SawitVision Phase 1: optional human-readable metadata for prediction records.
-- Run this migration manually in the Supabase SQL Editor before deploying code.

BEGIN;

ALTER TABLE public.prediction_records
    ADD COLUMN IF NOT EXISTS title TEXT NULL,
    ADD COLUMN IF NOT EXISTS description TEXT NULL;

COMMIT;
