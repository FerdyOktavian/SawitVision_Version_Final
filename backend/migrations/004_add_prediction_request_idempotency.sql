-- SawitVision Phase E1: durable, user-scoped idempotency for POST /predict.
-- Run this migration manually in the Supabase SQL Editor before deploying
-- backend code that accepts client_request_id.

BEGIN;

CREATE TABLE IF NOT EXISTS public.prediction_request_idempotency (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    client_request_id UUID NOT NULL,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    prediction_record_id UUID NULL,
    response_payload JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT prediction_request_idempotency_user_fk
        FOREIGN KEY (user_id)
        REFERENCES public.users(id)
        ON DELETE CASCADE,
    CONSTRAINT prediction_request_idempotency_record_fk
        FOREIGN KEY (prediction_record_id)
        REFERENCES public.prediction_records(id)
        ON DELETE SET NULL,
    CONSTRAINT prediction_request_idempotency_status_valid
        CHECK (status IN ('processing', 'completed', 'failed')),
    CONSTRAINT prediction_request_idempotency_user_request_key
        UNIQUE (user_id, client_request_id),
    CONSTRAINT prediction_request_idempotency_completed_payload_required
        CHECK (status <> 'completed' OR response_payload IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS prediction_request_idempotency_record_idx
    ON public.prediction_request_idempotency (prediction_record_id)
    WHERE prediction_record_id IS NOT NULL;

COMMENT ON TABLE public.prediction_request_idempotency IS
    'Durable per-user idempotency ledger for optional POST /predict client request IDs.';

COMMENT ON COLUMN public.prediction_request_idempotency.request_fingerprint IS
    'SHA-256 binding of uploaded bytes and normalized request metadata.';

COMMIT;

-- RLS is intentionally not enabled here. The application accesses PostgreSQL
-- through the backend DATABASE_URL and every lookup is scoped by user_id plus
-- client_request_id. Review RLS separately if this table is exposed by an API.
