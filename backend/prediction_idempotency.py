"""Durable PostgreSQL helpers for user-scoped prediction idempotency."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


def build_prediction_request_fingerprint(
    *,
    file_sha256: str,
    input_source: str,
    location: dict[str, Any],
) -> str:
    """Bind one client request ID to uploaded bytes and normalized metadata."""
    fingerprint_payload = {
        "file_sha256": str(file_sha256),
        "input_source": str(input_source),
        "latitude": location.get("latitude"),
        "longitude": location.get("longitude"),
        "location_accuracy": location.get("location_accuracy"),
        "location_captured_at": (
            location["location_captured_at"].isoformat()
            if location.get("location_captured_at")
            else None
        ),
        "location_auto_name": location.get("location_auto_name"),
        "location_label": location.get("location_label"),
    }
    canonical_payload = json.dumps(
        fingerprint_payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical_payload).hexdigest()


def claim_prediction_request(
    db: Session,
    *,
    user_id: str,
    client_request_id: str,
    request_fingerprint: str,
) -> dict[str, Any]:
    """Atomically create a processing claim or return the existing claim."""
    try:
        created_row = db.execute(
            text(
                """
                INSERT INTO public.prediction_request_idempotency (
                    user_id,
                    client_request_id,
                    request_fingerprint
                )
                VALUES (
                    :user_id,
                    :client_request_id,
                    :request_fingerprint
                )
                ON CONFLICT (user_id, client_request_id) DO NOTHING
                RETURNING
                    id,
                    request_fingerprint,
                    status,
                    prediction_record_id,
                    response_payload
                """
            ),
            {
                "user_id": user_id,
                "client_request_id": client_request_id,
                "request_fingerprint": request_fingerprint,
            },
        ).mappings().fetchone()

        if created_row:
            db.commit()
            return {"created": True, **dict(created_row)}

        existing_row = db.execute(
            text(
                """
                SELECT
                    id,
                    request_fingerprint,
                    status,
                    prediction_record_id,
                    response_payload
                FROM public.prediction_request_idempotency
                WHERE user_id = :user_id
                  AND client_request_id = :client_request_id
                """
            ),
            {
                "user_id": user_id,
                "client_request_id": client_request_id,
            },
        ).mappings().fetchone()
        db.commit()

        if existing_row is None:
            raise RuntimeError("Idempotency claim tidak dapat dibaca setelah konflik.")

        return {"created": False, **dict(existing_row)}
    except Exception:
        db.rollback()
        raise


def complete_prediction_request(
    db: Session,
    *,
    user_id: str,
    client_request_id: str,
    request_fingerprint: str,
    response_payload: dict[str, Any],
    prediction_record_id: str | None,
) -> None:
    """Persist the exact final response before it is returned to the client."""
    try:
        result = db.execute(
            text(
                """
                UPDATE public.prediction_request_idempotency
                SET
                    status = 'completed',
                    prediction_record_id = :prediction_record_id,
                    response_payload = CAST(:response_payload AS JSONB),
                    updated_at = NOW()
                WHERE user_id = :user_id
                  AND client_request_id = :client_request_id
                  AND request_fingerprint = :request_fingerprint
                  AND status = 'processing'
                """
            ),
            {
                "user_id": user_id,
                "client_request_id": client_request_id,
                "request_fingerprint": request_fingerprint,
                "prediction_record_id": prediction_record_id,
                "response_payload": json.dumps(
                    response_payload,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            },
        )
        if result.rowcount != 1:
            raise RuntimeError("Claim idempotency tidak berada pada status processing.")
        db.commit()
    except Exception:
        db.rollback()
        raise


def fail_prediction_request(
    db: Session,
    *,
    user_id: str,
    client_request_id: str,
    request_fingerprint: str,
    prediction_record_id: str | None = None,
) -> None:
    """Mark a claimed request failed without persisting exception details."""
    try:
        db.execute(
            text(
                """
                UPDATE public.prediction_request_idempotency
                SET
                    status = 'failed',
                    prediction_record_id = COALESCE(
                        :prediction_record_id,
                        prediction_record_id
                    ),
                    updated_at = NOW()
                WHERE user_id = :user_id
                  AND client_request_id = :client_request_id
                  AND request_fingerprint = :request_fingerprint
                  AND status = 'processing'
                """
            ),
            {
                "user_id": user_id,
                "client_request_id": client_request_id,
                "request_fingerprint": request_fingerprint,
                "prediction_record_id": prediction_record_id,
            },
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
