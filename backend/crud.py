"""
Operasi database untuk prediksi SawitVision V3.

Semua query memakai tabel pada schema public Supabase PostgreSQL.
"""

import math
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session


DETECTION_CLASS_TO_INDEX = {
    "belum_masak": 0,
    "masak": 1,
    "terlalu_masak": 2,
}


def get_active_model_version(db: Session) -> Optional[str]:
    """Mengambil ID model yang sedang aktif."""
    row = db.execute(
        text(
            """
            SELECT id
            FROM public.model_versions
            WHERE is_active = TRUE
            ORDER BY created_at DESC
            LIMIT 1
            """
        )
    ).fetchone()

    return str(row[0]) if row else None


def save_prediction_record(
    db: Session,
    predicted_class: str,
    confidence: float,
    probabilities: dict[str, float],
    user_id: Optional[str] = None,
    image_original_url: Optional[str] = None,
    image_processed_url: Optional[str] = None,
    image_thumbnail_url: Optional[str] = None,
    input_source: str = "unknown",
    image_width: Optional[int] = None,
    image_height: Optional[int] = None,
    file_size_bytes: Optional[int] = None,
    device_info: Optional[dict[str, Any]] = None,
    notes: Optional[str] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    location_accuracy: Optional[float] = None,
    location_captured_at: Optional[datetime] = None,
    location_auto_name: Optional[str] = None,
    location_label: Optional[str] = None,
) -> dict[str, Any]:
    """Menyimpan satu hasil prediksi ke riwayat."""
    model_version_id = get_active_model_version(db)

    try:
        row = db.execute(
            text(
                """
                INSERT INTO public.prediction_records (
                    model_version_id,
                    user_id,
                    image_original_url,
                    image_processed_url,
                    image_thumbnail_url,
                    predicted_class,
                    confidence,
                    prob_belum_masak,
                    prob_masak,
                    prob_terlalu_masak,
                    input_source,
                    image_width,
                    image_height,
                    file_size_bytes,
                    device_info,
                    notes,
                    latitude,
                    longitude,
                    location_accuracy,
                    location_captured_at,
                    location_auto_name,
                    location_label
                )
                VALUES (
                    :model_version_id,
                    :user_id,
                    :image_original_url,
                    :image_processed_url,
                    :image_thumbnail_url,
                    :predicted_class,
                    :confidence,
                    :prob_belum_masak,
                    :prob_masak,
                    :prob_terlalu_masak,
                    :input_source,
                    :image_width,
                    :image_height,
                    :file_size_bytes,
                    CAST(:device_info AS JSONB),
                    :notes,
                    :latitude,
                    :longitude,
                    :location_accuracy,
                    :location_captured_at,
                    :location_auto_name,
                    :location_label
                )
                RETURNING id, created_at
                """
            ),
            {
                "model_version_id": model_version_id,
                "user_id": user_id,
                "image_original_url": image_original_url,
                "image_processed_url": image_processed_url,
                "image_thumbnail_url": image_thumbnail_url,
                "predicted_class": predicted_class,
                "confidence": float(confidence),
                "prob_belum_masak": float(
                    probabilities.get("belum_masak", 0)
                ),
                "prob_masak": float(probabilities.get("masak", 0)),
                "prob_terlalu_masak": float(
                    probabilities.get("terlalu_masak", 0)
                ),
                "input_source": input_source,
                "image_width": image_width,
                "image_height": image_height,
                "file_size_bytes": file_size_bytes,
                "device_info": __import__("json").dumps(
                    device_info or {},
                    ensure_ascii=False,
                    default=str,
                ),
                "notes": notes,
                "latitude": latitude,
                "longitude": longitude,
                "location_accuracy": location_accuracy,
                "location_captured_at": location_captured_at,
                "location_auto_name": location_auto_name,
                "location_label": location_label,
            },
        ).fetchone()

        db.commit()

    except Exception:
        db.rollback()
        raise

    return {
        "id": str(row[0]),
        "created_at": (
            row[1].isoformat()
            if row[1]
            else None
        ),
    }


def _validated_percentage(value: Any, field_name: str) -> float:
    """Validate the public API's 0-100 confidence/probability scale."""
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= 100:
        raise ValueError(
            f"{field_name} harus berupa angka finite pada rentang 0-100."
        )
    return number


def save_prediction_detections(
    db: Session,
    prediction_record_id: str,
    detections: list[dict[str, Any]],
) -> int:
    """Persist every valid per-TBS result in one child transaction.

    ``detection_index`` is the stable zero-based list position. The parent
    prediction record is already committed by ``save_prediction_record``;
    therefore a child failure rolls back every child row without deleting the
    otherwise valid parent history record.
    """
    if not detections:
        return 0
    if not prediction_record_id:
        raise ValueError("prediction_record_id wajib diisi.")

    parameters: list[dict[str, Any]] = []
    for detection_index, detection in enumerate(detections):
        bbox = detection.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            raise ValueError(
                f"bbox detection_index={detection_index} harus berisi 4 nilai."
            )

        coordinates: list[int] = []
        for coordinate_name, raw_value in zip(
            ("x1", "y1", "x2", "y2"),
            bbox,
            strict=True,
        ):
            numeric_value = float(raw_value)
            if not math.isfinite(numeric_value) or not numeric_value.is_integer():
                raise ValueError(
                    f"{coordinate_name} detection_index={detection_index} "
                    "harus berupa integer finite."
                )
            coordinates.append(int(numeric_value))

        x1, y1, x2, y2 = coordinates
        if x1 < 0 or y1 < 0 or x2 <= x1 or y2 <= y1:
            raise ValueError(
                f"bbox detection_index={detection_index} tidak valid: {bbox!r}."
            )

        maturity_class = str(detection.get("predicted_class", ""))
        expected_class_index = DETECTION_CLASS_TO_INDEX.get(maturity_class)
        maturity_class_index = int(detection.get("class_index", -1))
        if expected_class_index is None:
            raise ValueError(
                f"Kelas detection_index={detection_index} tidak valid: "
                f"{maturity_class!r}."
            )
        if maturity_class_index != expected_class_index:
            raise ValueError(
                f"class_index detection_index={detection_index} tidak cocok "
                f"dengan kelas {maturity_class!r}."
            )

        probabilities = detection.get("probabilities")
        if not isinstance(probabilities, dict):
            raise ValueError(
                f"probabilities detection_index={detection_index} wajib berupa "
                "dictionary."
            )

        parameters.append(
            {
                "prediction_record_id": prediction_record_id,
                "detection_index": detection_index,
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "detector_confidence": _validated_percentage(
                    detection.get("detector_confidence"),
                    f"detector_confidence detection_index={detection_index}",
                ),
                "maturity_class": maturity_class,
                "maturity_class_index": maturity_class_index,
                "maturity_confidence": _validated_percentage(
                    detection.get("maturity_confidence"),
                    f"maturity_confidence detection_index={detection_index}",
                ),
                "prob_belum_masak": _validated_percentage(
                    probabilities.get("belum_masak"),
                    f"prob_belum_masak detection_index={detection_index}",
                ),
                "prob_masak": _validated_percentage(
                    probabilities.get("masak"),
                    f"prob_masak detection_index={detection_index}",
                ),
                "prob_terlalu_masak": _validated_percentage(
                    probabilities.get("terlalu_masak"),
                    f"prob_terlalu_masak detection_index={detection_index}",
                ),
            }
        )

    try:
        db.execute(
            text(
                """
                INSERT INTO public.prediction_detections (
                    prediction_record_id,
                    detection_index,
                    x1,
                    y1,
                    x2,
                    y2,
                    detector_confidence,
                    maturity_class,
                    maturity_class_index,
                    maturity_confidence,
                    prob_belum_masak,
                    prob_masak,
                    prob_terlalu_masak
                )
                VALUES (
                    :prediction_record_id,
                    :detection_index,
                    :x1,
                    :y1,
                    :x2,
                    :y2,
                    :detector_confidence,
                    :maturity_class,
                    :maturity_class_index,
                    :maturity_confidence,
                    :prob_belum_masak,
                    :prob_masak,
                    :prob_terlalu_masak
                )
                """
            ),
            parameters,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return len(parameters)


def _prediction_row_to_dict(row) -> dict[str, Any]:
    """Mengubah hasil query menjadi bentuk JSON yang dipakai frontend."""
    return {
        "id": str(row[0]),
        "image_processed_url": row[1],
        "image_thumbnail_url": row[2],
        "predicted_class": row[3],
        "confidence": float(row[4] or 0),
        "probabilities": {
            "belum_masak": float(row[5] or 0),
            "masak": float(row[6] or 0),
            "terlalu_masak": float(row[7] or 0),
        },
        "input_source": row[8],
        "image_width": row[9],
        "image_height": row[10],
        "file_size_bytes": int(row[11] or 0),
        "created_at": row[12].isoformat() if row[12] else None,
    }


def get_prediction_records(
    db: Session,
    user_id: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    start_at: Optional[datetime] = None,
    end_at: Optional[datetime] = None,
) -> list[dict[str, Any]]:
    """Mengambil daftar riwayat prediksi."""
    conditions = []

    if user_id:
        conditions.append("user_id = :user_id")
    if start_at is not None:
        conditions.append("created_at >= :start_at")
    if end_at is not None:
        conditions.append("created_at < :end_at")

    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    query_parameters = {
        "limit": max(1, min(int(limit), 100)),
        "offset": max(0, int(offset)),
    }

    if user_id:
        query_parameters["user_id"] = user_id
    if start_at is not None:
        query_parameters["start_at"] = start_at
    if end_at is not None:
        query_parameters["end_at"] = end_at

    rows = db.execute(
        text(
            f"""
            SELECT
                id,
                image_processed_url,
                image_thumbnail_url,
                predicted_class,
                confidence,
                prob_belum_masak,
                prob_masak,
                prob_terlalu_masak,
                input_source,
                image_width,
                image_height,
                file_size_bytes,
                created_at
            FROM public.prediction_records
            {where_sql}
            ORDER BY created_at DESC
            LIMIT :limit OFFSET :offset
            """
        ),
        query_parameters,
    ).fetchall()

    return [_prediction_row_to_dict(row) for row in rows]


def count_prediction_records(
    db: Session,
    user_id: Optional[str] = None,
    start_at: Optional[datetime] = None,
    end_at: Optional[datetime] = None,
) -> int:
    """Menghitung jumlah prediksi, global atau per pengguna."""
    conditions = []

    if user_id:
        conditions.append("user_id = :user_id")
    if start_at is not None:
        conditions.append("created_at >= :start_at")
    if end_at is not None:
        conditions.append("created_at < :end_at")

    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    query_parameters = {}

    if user_id:
        query_parameters["user_id"] = user_id
    if start_at is not None:
        query_parameters["start_at"] = start_at
    if end_at is not None:
        query_parameters["end_at"] = end_at

    total = db.execute(
        text(
            f"""
            SELECT COUNT(*)
            FROM public.prediction_records
            {where_sql}
            """
        ),
        query_parameters,
    ).scalar()

    return int(total or 0)


def get_prediction_detections(
    db: Session,
    prediction_record_id: str,
) -> list[dict[str, Any]]:
    """Return persisted per-TBS results in their stable inference order."""
    rows = db.execute(
        text(
            """
            SELECT
                detection_index,
                x1,
                y1,
                x2,
                y2,
                detector_confidence,
                maturity_class,
                maturity_class_index,
                maturity_confidence,
                prob_belum_masak,
                prob_masak,
                prob_terlalu_masak
            FROM public.prediction_detections
            WHERE prediction_record_id = :prediction_record_id
            ORDER BY detection_index ASC
            """
        ),
        {"prediction_record_id": prediction_record_id},
    ).fetchall()

    return [
        {
            "bbox": [int(row[1]), int(row[2]), int(row[3]), int(row[4])],
            "detector_confidence": float(row[5]),
            "predicted_class": row[6],
            "class_index": int(row[7]),
            "maturity_confidence": float(row[8]),
            "probabilities": {
                "belum_masak": float(row[9]),
                "masak": float(row[10]),
                "terlalu_masak": float(row[11]),
            },
        }
        for row in rows
    ]


def get_prediction_record_by_id(
    db: Session,
    record_id: str,
    user_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """
    Mengambil detail prediksi.

    user_id digunakan agar pengguna hanya dapat membuka datanya sendiri.
    """
    user_filter = "AND user_id = :user_id" if user_id else ""

    row = db.execute(
        text(
            f"""
            SELECT
                id,
                image_processed_url,
                image_thumbnail_url,
                predicted_class,
                confidence,
                prob_belum_masak,
                prob_masak,
                prob_terlalu_masak,
                input_source,
                image_width,
                image_height,
                file_size_bytes,
                created_at,
                latitude,
                longitude,
                location_accuracy,
                location_captured_at,
                location_auto_name,
                location_label
            FROM public.prediction_records
            WHERE id = :record_id
            {user_filter}
            LIMIT 1
            """
        ),
        {
            "record_id": record_id,
            "user_id": user_id,
        },
    ).fetchone()

    if row is None:
        return None

    record = _prediction_row_to_dict(row)
    location_available = row[13] is not None and row[14] is not None
    record["location"] = {
        "available": location_available,
        "latitude": float(row[13]) if location_available else None,
        "longitude": float(row[14]) if location_available else None,
        "accuracy_meters": (
            float(row[15])
            if location_available and row[15] is not None
            else None
        ),
        "captured_at": (
            row[16].isoformat()
            if location_available and row[16] is not None
            else None
        ),
        "auto_name": row[17],
        "label": row[18],
    }
    detections = get_prediction_detections(db, record_id)
    counts = {class_name: 0 for class_name in DETECTION_CLASS_TO_INDEX}
    for detection in detections:
        class_name = detection["predicted_class"]
        if class_name in counts:
            counts[class_name] += 1

    record.update(
        {
            "detection_details_available": bool(detections),
            "summary": {
                "total_detections": len(detections),
                "by_class": counts,
            },
            "detections": detections,
        }
    )
    return record


def get_prediction_stats(
    db: Session,
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """Mengambil statistik image-level lama dan statistik multi-TBS."""
    user_filter = "WHERE user_id = :user_id" if user_id else ""
    params = {"user_id": user_id}

    total = db.execute(
        text(
            f"""
            SELECT COUNT(*)
            FROM public.prediction_records
            {user_filter}
            """
        ),
        params,
    ).scalar()

    rows = db.execute(
        text(
            f"""
            SELECT
                predicted_class,
                COUNT(*) AS total,
                AVG(confidence) AS avg_confidence
            FROM public.prediction_records
            {user_filter}
            GROUP BY predicted_class
            ORDER BY total DESC
            """
        ),
        params,
    ).fetchall()

    by_class = {
        row[0]: {
            "total": int(row[1]),
            "avg_confidence": round(float(row[2] or 0), 2),
        }
        for row in rows
    }

    total_images = int(total or 0)
    summary_by_class = {
        class_name: int(by_class.get(class_name, {}).get("total", 0))
        for class_name in DETECTION_CLASS_TO_INDEX
    }

    return {
        "total_predictions": total_images,
        "by_class": by_class,
        "image_stats": {
            "total_images": total_images,
            "by_summary_class": summary_by_class,
        },
        "tbs_stats": get_tbs_statistics(
            db=db,
            total_images=total_images,
            user_id=user_id,
        ),
    }


def build_empty_tbs_statistics(total_images: int = 0) -> dict[str, Any]:
    """Membentuk statistik TBS kosong tanpa menganggap record lama sebagai TBS nol."""
    total_images = int(total_images or 0)
    return {
        "total_tbs": 0,
        "by_class": {
            class_name: {
                "total": 0,
                "avg_maturity_confidence": None,
            }
            for class_name in DETECTION_CLASS_TO_INDEX
        },
        "avg_detector_confidence": None,
        "coverage": {
            "images_with_detection_details": 0,
            "images_without_detection_details": total_images,
            "coverage_percentage": 0.0,
        },
    }


def get_tbs_statistics(
    db: Session,
    total_images: int,
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """Mengagregasi child detection, dengan scope user melalui parent record."""
    user_filter = "WHERE pr.user_id = :user_id" if user_id is not None else ""
    params = {"user_id": user_id} if user_id is not None else {}

    overview_row = db.execute(
        text(
            f"""
            SELECT
                COUNT(pd.id) AS total_tbs,
                AVG(pd.detector_confidence) AS avg_detector_confidence,
                COUNT(DISTINCT pd.prediction_record_id)
                    AS images_with_detection_details
            FROM public.prediction_detections pd
            INNER JOIN public.prediction_records pr
                ON pr.id = pd.prediction_record_id
            {user_filter}
            """
        ),
        params,
    ).fetchone()

    class_rows = db.execute(
        text(
            f"""
            SELECT
                pd.maturity_class,
                COUNT(pd.id) AS total,
                AVG(pd.maturity_confidence) AS avg_maturity_confidence
            FROM public.prediction_detections pd
            INNER JOIN public.prediction_records pr
                ON pr.id = pd.prediction_record_id
            {user_filter}
            GROUP BY pd.maturity_class
            ORDER BY pd.maturity_class
            """
        ),
        params,
    ).fetchall()

    stats = build_empty_tbs_statistics(total_images)
    total_tbs = int(overview_row[0] or 0) if overview_row else 0
    avg_detector_confidence = (
        round(float(overview_row[1]), 2)
        if overview_row and overview_row[1] is not None
        else None
    )
    images_with_details = int(overview_row[2] or 0) if overview_row else 0
    images_without_details = max(int(total_images or 0) - images_with_details, 0)
    coverage_percentage = (
        round((images_with_details / int(total_images)) * 100, 2)
        if total_images
        else 0.0
    )

    for row in class_rows:
        class_name = row[0]
        if class_name not in stats["by_class"]:
            continue
        stats["by_class"][class_name] = {
            "total": int(row[1]),
            "avg_maturity_confidence": (
                round(float(row[2]), 2)
                if row[2] is not None
                else None
            ),
        }

    stats.update(
        {
            "total_tbs": total_tbs,
            "avg_detector_confidence": avg_detector_confidence,
            "coverage": {
                "images_with_detection_details": images_with_details,
                "images_without_detection_details": images_without_details,
                "coverage_percentage": coverage_percentage,
            },
        }
    )
    return stats


def update_prediction_images(
    db: Session,
    record_id: str,
    image_processed_url: Optional[str] = None,
    image_thumbnail_url: Optional[str] = None,
) -> bool:
    """Menyimpan URL gambar setelah upload ke Supabase Storage."""
    try:
        row = db.execute(
            text(
                """
                UPDATE public.prediction_records
                SET
                    image_processed_url = :image_processed_url,
                    image_thumbnail_url = :image_thumbnail_url,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :record_id
                RETURNING id
                """
            ),
            {
                "record_id": record_id,
                "image_processed_url": image_processed_url,
                "image_thumbnail_url": image_thumbnail_url,
            },
        ).fetchone()

        db.commit()
        return row is not None

    except Exception:
        db.rollback()
        raise


def update_prediction_location_label(
    db: Session,
    record_id: str,
    user_id: str,
    location_label: Optional[str],
) -> Optional[dict[str, Any]]:
    """Update only the editable label on a prediction owned by the user."""
    try:
        row = db.execute(
            text(
                """
                UPDATE public.prediction_records
                SET
                    location_label = :location_label,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :record_id
                  AND user_id = :user_id
                RETURNING id, location_auto_name, location_label
                """
            ),
            {
                "record_id": record_id,
                "user_id": user_id,
                "location_label": location_label,
            },
        ).fetchone()

        db.commit()
    except Exception:
        db.rollback()
        raise

    if row is None:
        return None

    return {
        "id": str(row[0]),
        "location_auto_name": row[1],
        "location_label": row[2],
    }


def delete_prediction_record(
    db: Session,
    record_id: str,
    user_id: str,
) -> Optional[str]:
    """Delete one prediction only when it belongs to the requesting user."""
    try:
        row = db.execute(
            text(
                """
                DELETE FROM public.prediction_records
                WHERE id = :record_id
                  AND user_id = :user_id
                RETURNING id
                """
            ),
            {"record_id": record_id, "user_id": user_id},
        ).fetchone()

        db.commit()

    except Exception:
        db.rollback()
        raise

    return str(row[0]) if row else None


def get_estimated_storage_usage(db: Session) -> int:
    """
    Mengestimasi pemakaian storage dari ukuran file asli.

    Main.py memakai perkiraan 60% untuk gambar processed dan 10%
    untuk thumbnail, sehingga total estimasinya 70% dari file asli.
    """
    original_bytes = int(
        db.execute(
            text(
                """
                SELECT COALESCE(SUM(file_size_bytes), 0)
                FROM public.prediction_records
                WHERE image_processed_url IS NOT NULL
                   OR image_thumbnail_url IS NOT NULL
                """
            )
        ).scalar()
        or 0
    )

    return int(original_bytes * 0.70)


def get_oldest_prediction_images(
    db: Session,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Mengambil gambar prediksi tertua untuk fitur cleanup admin."""
    rows = db.execute(
        text(
            """
            SELECT
                id,
                image_processed_url,
                image_thumbnail_url,
                predicted_class,
                created_at
            FROM public.prediction_records
            WHERE image_processed_url IS NOT NULL
               OR image_thumbnail_url IS NOT NULL
            ORDER BY created_at ASC
            LIMIT :limit
            """
        ),
        {"limit": max(1, min(int(limit), 100))},
    ).fetchall()

    return [
        {
            "id": str(row[0]),
            "image_processed_url": row[1],
            "image_thumbnail_url": row[2],
            "predicted_class": row[3],
            "created_at": row[4].isoformat() if row[4] else None,
        }
        for row in rows
    ]


def clear_prediction_image_urls(
    db: Session,
    record_id: str,
) -> Optional[str]:
    """
    Mengosongkan URL gambar setelah file dibersihkan dari Storage.

    Record klasifikasi tetap dipertahankan untuk kebutuhan riwayat/laporan.
    """
    try:
        row = db.execute(
            text(
                """
                UPDATE public.prediction_records
                SET
                    image_original_url = NULL,
                    image_processed_url = NULL,
                    image_thumbnail_url = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :record_id
                RETURNING id
                """
            ),
            {"record_id": record_id},
        ).fetchone()

        db.commit()

    except Exception:
        db.rollback()
        raise

    return str(row[0]) if row else None
