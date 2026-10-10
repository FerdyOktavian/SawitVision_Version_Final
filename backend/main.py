"""
Main application SawitVision V3.

Perubahan utama V3:
- akun memakai nama dan nomor telepon;
- tidak menggunakan email;
- tidak menggunakan password;
- tidak menggunakan verifikasi email;
- autentikasi endpoint tetap memakai JWT setelah login berhasil.

Catatan:
File ini hanya mengatur aplikasi utama, middleware, router, prediksi,
riwayat, statistik, dan penghapusan hasil prediksi. Logika daftar/login
berada di auth_routes.py, sedangkan pemeriksaan token berada di auth.py.
"""

import asyncio
import logging
import math
import time
import warnings
from datetime import date as calendar_date
from datetime import datetime, time as datetime_time, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict
from starlette.concurrency import run_in_threadpool

from activity_log import log_activity
from admin_routes import router as admin_router
from auth import get_current_user
from auth_routes import router as auth_router
from config_utils import (
    cors_origins as configured_cors_origins,
    env_bool,
    env_float,
    env_int,
    env_text,
)
from crud import (
    save_prediction_detections,
    save_prediction_record,
    update_prediction_metadata,
    update_prediction_location_label,
    update_prediction_images,
    get_prediction_records,
    get_prediction_record_by_id,
    get_prediction_stats,
    delete_prediction_record,
    count_prediction_records,
    get_estimated_storage_usage,
)
from database import SessionLocal
from geocoding import (
    MAX_LOCATION_NAME_LENGTH,
    reverse_geocode,
    validate_coordinates,
)
from image_safety import (
    ImageResolutionTooLargeError,
    UploadTooLargeError,
    log_rss_checkpoint,
    measure_upload_size,
    process_rss_bytes,
    sha256_upload,
    validate_image_dimensions,
)
from prediction_idempotency import (
    build_prediction_request_fingerprint,
    claim_prediction_request,
    complete_prediction_request,
    fail_prediction_request,
)
from predict import load_ai_pipeline, predict_image_with_pipeline
from observability import configure_logging, request_observability_middleware
from readiness import build_readiness
from report_routes import router as report_router
from security import IS_PRODUCTION, enforce_rate_limit
from storage_supabase import (
    PROCESSED_IMAGE_MAX_SIZE,
    SUPABASE_BUCKET,
    SUPABASE_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL,
    delete_prediction_images_from_supabase,
    upload_prediction_images,
)

APP_STORAGE_LIMIT_GB = env_float(
    "APP_STORAGE_LIMIT_GB", 1, minimum=0.01
)

APP_STORAGE_LIMIT_BYTES = int(
    APP_STORAGE_LIMIT_GB * 1024 * 1024 * 1024
)

MIN_SAVE_CONFIDENCE = env_float(
    "MIN_SAVE_CONFIDENCE", 70, minimum=0, maximum=100
)
MAX_UPLOAD_SIZE_MB = env_int("MAX_UPLOAD_MB", 16, minimum=1, maximum=100)
MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024
MAX_IMAGE_PIXELS = env_int(
    "MAX_IMAGE_PIXELS", 25_000_000, minimum=1_000_000, maximum=200_000_000
)
MAX_IMAGE_WIDTH = env_int(
    "MAX_IMAGE_WIDTH", 8_000, minimum=1_000, maximum=50_000
)
MAX_IMAGE_HEIGHT = env_int(
    "MAX_IMAGE_HEIGHT", 8_000, minimum=1_000, maximum=50_000
)
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}
PREDICTION_SEMAPHORE = asyncio.Semaphore(1)
MAX_PREDICTION_TITLE_LENGTH = 120
MAX_PREDICTION_DESCRIPTION_LENGTH = 500

# Pillow checks this while reading image headers. Converting its warning to an
# exception is scoped to the open operation below so unrelated image work is
# unaffected.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class UpdateLocationLabelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    location_label: str | None


class UpdatePredictionMetadataRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    description: str | None = None


def normalize_optional_location(
    latitude_raw: str | None,
    longitude_raw: str | None,
    accuracy_raw: str | None,
    captured_at_raw: str | None,
) -> tuple[dict, list[dict[str, str]]]:
    """Validate optional client location without blocking prediction."""
    location = {
        "latitude": None,
        "longitude": None,
        "location_accuracy": None,
        "location_captured_at": None,
    }
    warnings = []

    latitude_value = str(latitude_raw).strip() if latitude_raw is not None else ""
    longitude_value = (
        str(longitude_raw).strip()
        if longitude_raw is not None
        else ""
    )
    accuracy_value = str(accuracy_raw).strip() if accuracy_raw is not None else ""
    captured_at_value = (
        str(captured_at_raw).strip()
        if captured_at_raw is not None
        else ""
    )

    if not any(
        (latitude_value, longitude_value, accuracy_value, captured_at_value)
    ):
        return location, warnings

    if not latitude_value or not longitude_value:
        warnings.append(
            {
                "stage": "location_metadata",
                "reason": "koordinat_lokasi_tidak_lengkap_diabaikan",
            }
        )
        return location, warnings

    try:
        latitude = float(latitude_value)
        longitude = float(longitude_value)
    except (TypeError, ValueError):
        warnings.append(
            {
                "stage": "location_metadata",
                "reason": "koordinat_lokasi_tidak_valid_diabaikan",
            }
        )
        return location, warnings

    if (
        not math.isfinite(latitude)
        or not math.isfinite(longitude)
        or not -90 <= latitude <= 90
        or not -180 <= longitude <= 180
    ):
        warnings.append(
            {
                "stage": "location_metadata",
                "reason": "koordinat_lokasi_di_luar_batas_diabaikan",
            }
        )
        return location, warnings

    location["latitude"] = latitude
    location["longitude"] = longitude

    if accuracy_value:
        try:
            accuracy = float(accuracy_value)
            if not math.isfinite(accuracy) or accuracy < 0:
                raise ValueError
            location["location_accuracy"] = accuracy
        except (TypeError, ValueError):
            warnings.append(
                {
                    "stage": "location_metadata",
                    "reason": "akurasi_lokasi_tidak_valid_diabaikan",
                }
            )

    if captured_at_value:
        try:
            captured_at = datetime.fromisoformat(
                captured_at_value.replace("Z", "+00:00")
            )
            if captured_at.tzinfo is None:
                raise ValueError
            location["location_captured_at"] = captured_at
        except ValueError:
            warnings.append(
                {
                    "stage": "location_metadata",
                    "reason": "waktu_capture_lokasi_tidak_valid_diabaikan",
                }
            )

    return location, warnings


def normalize_optional_location_name(
    raw_value: str | None,
    field_name: str,
    warnings: list[dict[str, str]],
) -> str | None:
    """Normalize optional location text without blocking prediction."""
    if raw_value is None:
        return None

    value = " ".join(str(raw_value).split())
    if not value:
        return None

    if len(value) > MAX_LOCATION_NAME_LENGTH:
        value = value[:MAX_LOCATION_NAME_LENGTH].rstrip()
        warnings.append(
            {
                "stage": "location_metadata",
                "reason": f"{field_name}_terlalu_panjang_dipotong",
            }
        )

    return value or None


def build_location_response(location: dict) -> dict:
    available = (
        location.get("latitude") is not None
        and location.get("longitude") is not None
    )
    return {
        "available": available,
        "latitude": location.get("latitude") if available else None,
        "longitude": location.get("longitude") if available else None,
        "accuracy_meters": (
            location.get("location_accuracy")
            if available
            else None
        ),
        "captured_at": (
            location["location_captured_at"].isoformat()
            if available and location.get("location_captured_at")
            else None
        ),
        "auto_name": location.get("location_auto_name"),
        "label": location.get("location_label"),
    }


SAFE_PIPELINE_WARNING_REASONS = {
    "bbox_non_finite",
    "bbox_invalid_after_clamp",
    "crop_too_small",
}


def sanitize_pipeline_warnings(warnings: list[dict]) -> list[dict]:
    """Keep warning metadata while removing internal exception details."""
    sanitized = []
    for warning in warnings:
        stage = str(warning.get("stage") or "ai_pipeline")
        raw_reason = str(warning.get("reason") or "")
        if raw_reason in SAFE_PIPELINE_WARNING_REASONS:
            safe_reason = raw_reason
        else:
            logger.warning("Internal AI pipeline warning: %r", warning)
            safe_reason = f"{stage}_failed"

        safe_warning = {
            "stage": stage,
            "reason": safe_reason,
        }
        if "detection_index" in warning:
            safe_warning["detection_index"] = warning["detection_index"]
        if "bbox" in warning:
            safe_warning["bbox"] = warning["bbox"]
        sanitized.append(safe_warning)
    return sanitized

logger = logging.getLogger(__name__)
LOG_LEVEL = configure_logging()
ENABLE_API_DOCS = env_bool("ENABLE_API_DOCS", not IS_PRODUCTION)
APP_ENV = str(env_text("APP_ENV", "development"))
GEOCODING_ENABLED = env_bool("GEOCODING_ENABLED", True)


def mark_prediction_request_failed_safely(
    *,
    user_id: str,
    client_request_id: str,
    request_fingerprint: str,
    prediction_record_id: str | None,
) -> None:
    """Best-effort terminal transition without exposing failure details."""
    db = SessionLocal()
    try:
        fail_prediction_request(
            db,
            user_id=user_id,
            client_request_id=client_request_id,
            request_fingerprint=request_fingerprint,
            prediction_record_id=prediction_record_id,
        )
    except Exception:
        logger.exception("prediction_idempotency_failure_update_failed")
    finally:
        db.close()

app = FastAPI(
    title="SawitVision V3 API",
    description=(
        "Backend klasifikasi kematangan buah kelapa sawit "
        "dengan autentikasi nama dan nomor telepon."
    ),
    version="3.0.0",
    docs_url="/docs" if ENABLE_API_DOCS else None,
    redoc_url="/redoc" if ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)

# Untuk production, isi CORS_ORIGINS dengan URL frontend, dipisahkan koma.
# Contoh: CORS_ORIGINS=https://sawitvision.vercel.app,http://localhost:5173
cors_origins = configured_cors_origins()

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault(
        "Referrer-Policy",
        "strict-origin-when-cross-origin",
    )
    return response


app.middleware("http")(request_observability_middleware)

app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(report_router)

pipeline_load_started_at = time.perf_counter()
ai_pipeline = load_ai_pipeline()
pipeline_load_duration_ms = (
    time.perf_counter() - pipeline_load_started_at
) * 1000
STORAGE_CONFIGURED = bool(
    SUPABASE_URL
    and (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY)
    and SUPABASE_BUCKET
)
logger.info(
    "ai_pipeline_loaded device=%s yolo_loaded=true dino_loaded=true "
    "duration_ms=%.2f",
    ai_pipeline.device,
    pipeline_load_duration_ms,
)
logger.info(
    "startup_configuration app_env=%s storage_configured=%s "
    "geocoding=%s api_docs=%s log_level=%s",
    APP_ENV,
    STORAGE_CONFIGURED,
    "enabled" if GEOCODING_ENABLED else "disabled",
    "enabled" if ENABLE_API_DOCS else "disabled",
    LOG_LEVEL,
)


@app.on_event("startup")
async def log_application_ready() -> None:
    logger.info("application_ready service=sawitvision-backend")


@app.get("/")
def root():
    return {
        "message": "SawitVision V3 Backend berjalan.",
        "status": "ok",
        "version": "3.0.0",
        "authentication": "name_and_phone_number",
    }


@app.get("/health")
def health():
    """Liveness only: no database, model, Storage, or geocoder work."""
    return {
        "status": "ok",
        "service": "sawitvision-backend",
        "version": "3.0.0",
    }


@app.get("/ready")
def ready():
    """Check required local AI state and lightweight DB connectivity."""
    payload, status_code = build_readiness(
        pipeline=ai_pipeline,
        session_factory=SessionLocal,
        storage_configured=STORAGE_CONFIGURED,
        geocoding_enabled=GEOCODING_ENABLED,
    )
    return JSONResponse(content=payload, status_code=status_code)


@app.get("/location/reverse-geocode")
async def get_reverse_geocoded_location(
    request: Request,
    latitude: str = Query(...),
    longitude: str = Query(...),
    current_user: dict = Depends(get_current_user),
):
    enforce_rate_limit(
        request,
        "reverse_geocode_user",
        limit=30,
        window_seconds=60,
        identity=current_user["id"],
    )
    try:
        latitude_value, longitude_value = validate_coordinates(
            latitude, longitude
        )
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail="Koordinat lokasi tidak valid atau berada di luar batas.",
        ) from error

    try:
        result = await run_in_threadpool(
            reverse_geocode,
            latitude_value,
            longitude_value,
        )
    except Exception:
        logger.error("reverse_geocoding_request_failed")
        result = {
            "success": False,
            "display_name": None,
            "warning": "Nama lokasi otomatis tidak tersedia.",
        }
    response = {
        "success": result["success"],
        "location": {
            "latitude": latitude_value,
            "longitude": longitude_value,
            "auto_name": result.get("display_name"),
        },
    }
    if not result["success"]:
        response["warning"] = result.get(
            "warning", "Nama lokasi otomatis tidak tersedia."
        )

    return response


@app.post("/predict")
async def predict(
    request: Request,
    file: UploadFile = File(...),
    input_source: str = Form("web_upload"),
    latitude: str | None = Form(None),
    longitude: str | None = Form(None),
    location_accuracy: str | None = Form(None),
    location_captured_at: str | None = Form(None),
    location_auto_name: str | None = Form(None),
    location_label: str | None = Form(None),
    client_request_id: UUID | None = Form(None),
    current_user: dict = Depends(get_current_user),
):
    image = None
    annotated_image = None
    prediction_slot_acquired = False
    prediction_started_at = time.perf_counter()
    ai_duration_ms = 0.0
    rss_before_bytes = None
    idempotency_request_id = (
        str(client_request_id) if client_request_id is not None else None
    )
    idempotency_fingerprint = None
    idempotency_claim_created = False
    idempotency_completed = False
    idempotency_prediction_record_id = None

    try:
        log_rss_checkpoint(logger, "predict_start")
        enforce_rate_limit(
            request,
            "predict_user",
            limit=10,
            window_seconds=60,
            identity=current_user["id"],
        )
        enforce_rate_limit(
            request,
            "predict_ip",
            limit=30,
            window_seconds=60,
        )
        location, location_warnings = normalize_optional_location(
            latitude,
            longitude,
            location_accuracy,
            location_captured_at,
        )
        normalized_auto_name = normalize_optional_location_name(
            location_auto_name,
            "location_auto_name",
            location_warnings,
        )
        normalized_location_label = normalize_optional_location_name(
            location_label,
            "location_label",
            location_warnings,
        )
        if location["latitude"] is None or location["longitude"] is None:
            if normalized_auto_name or normalized_location_label:
                location_warnings.append(
                    {
                        "stage": "location_metadata",
                        "reason": "nama_lokasi_tanpa_koordinat_diabaikan",
                    }
                )
            normalized_auto_name = None
            normalized_location_label = None

        location["location_auto_name"] = normalized_auto_name
        location["location_label"] = normalized_location_label

        normalized_input_source = input_source.strip().lower()
        if normalized_input_source not in {"camera", "gallery", "web_upload"}:
            normalized_input_source = "web_upload"

        if file.content_type not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(
                status_code=400,
                detail="Format file tidak didukung. Gunakan JPG, PNG, JPEG, atau WEBP.",
            )

        try:
            file_size_bytes = await measure_upload_size(
                file,
                MAX_UPLOAD_SIZE_BYTES,
            )
        except UploadTooLargeError:
            raise HTTPException(
                status_code=413,
                detail="Ukuran foto terlalu besar untuk diproses.",
            ) from None

        file_sha256 = None
        if idempotency_request_id is not None:
            file_sha256 = await sha256_upload(file)

        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                image = Image.open(file.file)
            if image.format not in ALLOWED_IMAGE_FORMATS:
                raise UnidentifiedImageError
        except (
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ):
            raise HTTPException(
                status_code=413,
                detail="Resolusi foto terlalu besar untuk diproses.",
            ) from None
        except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
            raise HTTPException(
                status_code=422,
                detail="File yang dipilih bukan foto yang valid.",
            ) from None

        original_width, original_height = image.size
        try:
            pixel_count = validate_image_dimensions(
                original_width,
                original_height,
                max_pixels=MAX_IMAGE_PIXELS,
                max_width=MAX_IMAGE_WIDTH,
                max_height=MAX_IMAGE_HEIGHT,
            )
        except ImageResolutionTooLargeError:
            raise HTTPException(
                status_code=413,
                detail="Resolusi foto terlalu besar untuk diproses.",
            ) from None
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail="File yang dipilih bukan foto yang valid.",
            ) from None
        log_rss_checkpoint(logger, "after_header_validation")

        if idempotency_request_id is not None:
            idempotency_fingerprint = build_prediction_request_fingerprint(
                file_sha256=file_sha256,
                input_source=normalized_input_source,
                location=location,
            )
            db = SessionLocal()
            try:
                idempotency_claim = claim_prediction_request(
                    db,
                    user_id=str(current_user["id"]),
                    client_request_id=idempotency_request_id,
                    request_fingerprint=idempotency_fingerprint,
                )
            finally:
                db.close()

            if not idempotency_claim["created"]:
                if (
                    idempotency_claim["request_fingerprint"]
                    != idempotency_fingerprint
                ):
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "idempotency_fingerprint_mismatch",
                            "message": (
                                "client_request_id sudah digunakan untuk "
                                "request yang berbeda."
                            ),
                        },
                    )

                idempotency_status = idempotency_claim["status"]
                if idempotency_status == "completed":
                    return idempotency_claim["response_payload"]
                if idempotency_status == "processing":
                    conflict_code = "idempotency_processing"
                    conflict_message = "Request prediksi masih diproses."
                elif idempotency_status == "failed":
                    conflict_code = "idempotency_failed"
                    conflict_message = (
                        "Request prediksi sebelumnya gagal dan tidak dijalankan ulang."
                    )
                else:
                    conflict_code = "idempotency_invalid_status"
                    conflict_message = "Status request prediksi tidak valid."
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": conflict_code,
                        "message": conflict_message,
                    },
                )

            idempotency_claim_created = True

        await PREDICTION_SEMAPHORE.acquire()
        prediction_slot_acquired = True
        rss_before_bytes = log_rss_checkpoint(
            logger,
            "prediction_slot_acquired",
        )

        try:
            await run_in_threadpool(image.load)
        except (OSError, SyntaxError, ValueError):
            raise HTTPException(
                status_code=422,
                detail="File yang dipilih bukan foto yang valid.",
            ) from None
        log_rss_checkpoint(logger, "after_decode")

        ai_started_at = time.perf_counter()
        pipeline_result = await run_in_threadpool(
            predict_image_with_pipeline,
            ai_pipeline,
            image,
            MIN_SAVE_CONFIDENCE,
            PROCESSED_IMAGE_MAX_SIZE,
            True,
        )
        ai_duration_ms = (time.perf_counter() - ai_started_at) * 1000
        predicted_class = pipeline_result["predicted_class"]
        confidence = pipeline_result["confidence"]
        probabilities = pipeline_result["probabilities"]
        annotated_image = pipeline_result["annotated_image"]
        detections = pipeline_result["detections"]
        summary = pipeline_result["summary"]
        image_width, image_height = pipeline_result["image_size"]
        response_warnings = location_warnings + sanitize_pipeline_warnings(
            list(pipeline_result["warnings"])
        )
        del pipeline_result
        image.close()
        image = None
        log_rss_checkpoint(logger, "after_source_release")

        confidence_value = float(confidence)
        should_save_history = (
            predicted_class is not None
            and confidence_value >= MIN_SAVE_CONFIDENCE
        )

        record = None
        image_urls = {
            "image_processed_url": None,
            "image_thumbnail_url": None,
        }
        storage_saved = False
        detection_details_saved = False

        if not should_save_history:
            if predicted_class is None:
                history_message = (
                    "Hasil prediksi tidak disimpan ke riwayat karena tidak "
                    "ada TBS valid yang terdeteksi."
                )
            else:
                history_message = (
                    f"Hasil prediksi tidak disimpan ke riwayat karena confidence "
                    f"{confidence_value:.2f}% berada di bawah batas "
                    f"{MIN_SAVE_CONFIDENCE:.2f}%."
                )
            storage_message = (
                "Gambar tidak disimpan karena hasil prediksi memiliki "
                "confidence rendah."
            )
        else:
            db = SessionLocal()
            try:
                record = save_prediction_record(
                    db=db,
                    predicted_class=predicted_class,
                    confidence=confidence_value,
                    probabilities=probabilities,
                    user_id=current_user["id"],
                    input_source=normalized_input_source,
                    image_width=image_width,
                    image_height=image_height,
                    file_size_bytes=file_size_bytes,
                    latitude=location["latitude"],
                    longitude=location["longitude"],
                    location_accuracy=location["location_accuracy"],
                    location_captured_at=location["location_captured_at"],
                    location_auto_name=location["location_auto_name"],
                    location_label=location["location_label"],
                )
                idempotency_prediction_record_id = (
                    str(record["id"]) if record else None
                )
            finally:
                db.close()

            if record and detections:
                db = SessionLocal()
                try:
                    saved_detection_count = save_prediction_detections(
                        db=db,
                        prediction_record_id=record["id"],
                        detections=detections,
                    )
                    detection_details_saved = (
                        saved_detection_count == len(detections)
                    )
                except Exception:
                    logger.exception(
                        "prediction_detection_persistence_failed"
                    )
                    response_warnings.append(
                        {
                            "stage": "database_persistence",
                            "reason": "detail_per_TBS_gagal_disimpan",
                        }
                    )
                finally:
                    db.close()

            history_message = "Hasil prediksi berhasil disimpan ke riwayat."
            storage_message = "Gambar tidak disimpan."

            # Perkiraan tambahan storage:
            # processed 60% + thumbnail 10% = 70%.
            estimated_new_storage_bytes = int(file_size_bytes * 0.70)

            db = SessionLocal()
            try:
                current_storage_bytes = get_estimated_storage_usage(db)
                projected_storage_bytes = (
                    current_storage_bytes + estimated_new_storage_bytes
                )
                storage_available = (
                    projected_storage_bytes <= APP_STORAGE_LIMIT_BYTES
                )
            finally:
                db.close()

            if storage_available:
                try:
                    if annotated_image is None:
                        raise RuntimeError(
                            "Annotated image tidak tersedia untuk hasil tersimpan."
                        )
                    log_rss_checkpoint(logger, "before_storage")
                    image_urls = await run_in_threadpool(
                        upload_prediction_images,
                        image=annotated_image,
                        record_id=record["id"],
                    )

                    db = SessionLocal()
                    try:
                        update_prediction_images(
                            db=db,
                            record_id=record["id"],
                            image_processed_url=image_urls[
                                "image_processed_url"
                            ],
                            image_thumbnail_url=image_urls[
                                "image_thumbnail_url"
                            ],
                        )
                    finally:
                        db.close()

                    storage_saved = True
                    storage_message = "Gambar berhasil disimpan."
                    log_rss_checkpoint(logger, "after_storage")

                except Exception:
                    logger.exception("prediction_storage_upload_failed")
                    storage_message = (
                        "Hasil prediksi tersimpan, tetapi gambar gagal "
                        "disimpan ke storage."
                    )
            else:
                storage_message = (
                    "Hasil prediksi tersimpan, tetapi gambar tidak disimpan "
                    "karena kapasitas storage telah mencapai batas."
                )

        response_payload = {
            "record_id": record["id"] if record else None,
            "predicted_class": predicted_class,
            "confidence": round(confidence_value, 2),
            "history": {
                "saved": should_save_history,
                "detection_details_saved": detection_details_saved,
                "message": history_message,
                "minimum_confidence": MIN_SAVE_CONFIDENCE,
            },
            "probabilities": {
                key: round(float(value), 2)
                for key, value in probabilities.items()
            },
            "summary": summary,
            "detections": [
                {
                    **detection,
                    "detector_confidence": round(
                        float(detection["detector_confidence"]), 2
                    ),
                    "maturity_confidence": round(
                        float(detection["maturity_confidence"]), 2
                    ),
                    "probabilities": {
                        key: round(float(value), 2)
                        for key, value in detection["probabilities"].items()
                    },
                }
                for detection in detections
            ],
            "warnings": response_warnings,
            "image_processed_url": image_urls[
                "image_processed_url"
            ],
            "image_thumbnail_url": image_urls[
                "image_thumbnail_url"
            ],
            "storage": {
                "saved": storage_saved,
                "message": storage_message,
                "limit_gb": APP_STORAGE_LIMIT_GB,
            },
            "location": build_location_response(location),
        }
        if annotated_image is not None:
            annotated_image.close()
            annotated_image = None
        log_rss_checkpoint(logger, "predict_end")
        rss_after_bytes = process_rss_bytes()
        logger.info(
            "prediction_completed total_duration_ms=%.2f "
            "ai_duration_ms=%.2f upload_size_bytes=%d original_width=%d "
            "original_height=%d pixel_count=%d detection_count=%d "
            "dino_batch_size=%d history_saved=%s storage_saved=%s "
            "rss_before_bytes=%s rss_after_bytes=%s",
            (time.perf_counter() - prediction_started_at) * 1000,
            ai_duration_ms,
            file_size_bytes,
            original_width,
            original_height,
            pixel_count,
            len(detections),
            ai_pipeline.dino_batch_size,
            should_save_history,
            storage_saved,
            rss_before_bytes,
            rss_after_bytes,
        )

        if idempotency_claim_created:
            db = SessionLocal()
            try:
                complete_prediction_request(
                    db,
                    user_id=str(current_user["id"]),
                    client_request_id=idempotency_request_id,
                    request_fingerprint=idempotency_fingerprint,
                    response_payload=response_payload,
                    prediction_record_id=idempotency_prediction_record_id,
                )
                idempotency_completed = True
            finally:
                db.close()

        return response_payload
    except HTTPException:
        if idempotency_claim_created and not idempotency_completed:
            mark_prediction_request_failed_safely(
                user_id=str(current_user["id"]),
                client_request_id=idempotency_request_id,
                request_fingerprint=idempotency_fingerprint,
                prediction_record_id=idempotency_prediction_record_id,
            )
        raise
    except Exception:
        if idempotency_claim_created and not idempotency_completed:
            mark_prediction_request_failed_safely(
                user_id=str(current_user["id"]),
                client_request_id=idempotency_request_id,
                request_fingerprint=idempotency_fingerprint,
                prediction_record_id=idempotency_prediction_record_id,
            )
        logger.exception("prediction_request_failed")
        raise HTTPException(
            status_code=500,
            detail="Prediction gagal diproses.",
        ) from None
    finally:
        if image is not None:
            image.close()
        if annotated_image is not None:
            annotated_image.close()
        if prediction_slot_acquired:
            PREDICTION_SEMAPHORE.release()
        await file.close()


@app.get("/predictions")
def list_predictions(
    limit: int = 20,
    offset: int = 0,
    start_date: str | None = Query(
        None,
        description="Tanggal awal riwayat dalam format YYYY-MM-DD",
    ),
    end_date: str | None = Query(
        None,
        description="Tanggal akhir riwayat dalam format YYYY-MM-DD",
    ),
    q: str | None = Query(
        None,
        description="Pencarian sebagian judul prediksi",
    ),
    current_user: dict = Depends(get_current_user),
):
    def parse_date(value: str | None, parameter_name: str):
        if value is None:
            return None

        try:
            parsed_value = calendar_date.fromisoformat(value)
        except (TypeError, ValueError):
            parsed_value = None

        if parsed_value is None or parsed_value.isoformat() != value:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "invalid_history_date",
                    "message": (
                        f"{parameter_name} harus menggunakan format YYYY-MM-DD."
                    ),
                },
            )

        return parsed_value

    parsed_start_date = parse_date(start_date, "start_date")
    parsed_end_date = parse_date(end_date, "end_date")
    normalized_title_query = " ".join(str(q or "").split())

    if len(normalized_title_query) > MAX_PREDICTION_TITLE_LENGTH:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_history_query",
                "message": (
                    "Pencarian judul maksimal "
                    f"{MAX_PREDICTION_TITLE_LENGTH} karakter."
                ),
            },
        )

    if (
        parsed_start_date is not None
        and parsed_end_date is not None
        and parsed_start_date > parsed_end_date
    ):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_history_date_range",
                "message": "Tanggal awal tidak boleh setelah tanggal akhir.",
            },
        )

    history_timezone = ZoneInfo("Asia/Jakarta")
    start_at = (
        datetime.combine(
            parsed_start_date,
            datetime_time.min,
            tzinfo=history_timezone,
        ).astimezone(timezone.utc)
        if parsed_start_date is not None
        else None
    )
    end_at = (
        datetime.combine(
            parsed_end_date + timedelta(days=1),
            datetime_time.min,
            tzinfo=history_timezone,
        ).astimezone(timezone.utc)
        if parsed_end_date is not None
        else None
    )

    limit = min(max(limit, 1), 50)
    offset = max(offset, 0)
    db = SessionLocal()
    try:
        records = get_prediction_records(
            db=db,
            user_id=current_user["id"],
            limit=limit,
            offset=offset,
            start_at=start_at,
            end_at=end_at,
            title_query=normalized_title_query or None,
        )
        filtered_total = count_prediction_records(
            db=db,
            user_id=current_user["id"],
            start_at=start_at,
            end_at=end_at,
            title_query=normalized_title_query or None,
        )
        return {
            "total": len(records),
            "filtered_total": filtered_total,
            "data": records,
        }
    finally:
        db.close()


@app.get("/predictions/{record_id}")
def prediction_detail(
    record_id: str,
    current_user: dict = Depends(get_current_user),
):
    db = SessionLocal()
    try:
        record = get_prediction_record_by_id(
            db=db, record_id=record_id, user_id=current_user["id"]
        )
        if record is None:
            raise HTTPException(status_code=404, detail="Data prediksi tidak ditemukan")
        return record
    finally:
        db.close()


@app.patch("/predictions/{record_id}")
def update_prediction_record_metadata(
    record_id: str,
    payload: UpdatePredictionMetadataRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    enforce_rate_limit(
        request,
        "prediction_metadata_user",
        limit=30,
        window_seconds=60,
        identity=current_user["id"],
    )

    updates = {}

    if "title" in payload.model_fields_set:
        normalized_title = " ".join(str(payload.title or "").split())
        if len(normalized_title) > MAX_PREDICTION_TITLE_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Judul prediksi maksimal "
                    f"{MAX_PREDICTION_TITLE_LENGTH} karakter."
                ),
            )
        updates["title"] = normalized_title or None

    if "description" in payload.model_fields_set:
        normalized_description = str(payload.description or "").strip()
        if len(normalized_description) > MAX_PREDICTION_DESCRIPTION_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Catatan maksimal "
                    f"{MAX_PREDICTION_DESCRIPTION_LENGTH} karakter."
                ),
            )
        updates["description"] = normalized_description or None

    if not updates:
        raise HTTPException(
            status_code=400,
            detail="Isi judul atau catatan yang ingin diperbarui.",
        )

    db = SessionLocal()
    try:
        updated = update_prediction_metadata(
            db=db,
            record_id=record_id,
            user_id=current_user["id"],
            updates=updates,
        )
        if updated is None:
            raise HTTPException(
                status_code=404,
                detail="Data prediksi tidak ditemukan",
            )

        return {
            "message": "Metadata prediksi berhasil diperbarui.",
            "record_id": updated["id"],
            "metadata": {
                "title": updated["title"],
                "description": updated["description"],
            },
        }
    finally:
        db.close()


@app.patch("/predictions/{record_id}/location-label")
def update_location_label(
    record_id: str,
    payload: UpdateLocationLabelRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    enforce_rate_limit(
        request,
        "location_label_user",
        limit=30,
        window_seconds=60,
        identity=current_user["id"],
    )
    normalized_label = " ".join(
        str(payload.location_label or "").split()
    )
    if len(normalized_label) > MAX_LOCATION_NAME_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=(
                "Nama lokasi maksimal "
                f"{MAX_LOCATION_NAME_LENGTH} karakter."
            ),
        )

    db = SessionLocal()
    try:
        updated = update_prediction_location_label(
            db=db,
            record_id=record_id,
            user_id=current_user["id"],
            location_label=normalized_label or None,
        )
        if updated is None:
            raise HTTPException(
                status_code=404,
                detail="Data prediksi tidak ditemukan",
            )

        return {
            "message": "Nama lokasi berhasil diperbarui.",
            "record_id": updated["id"],
            "location": {
                "auto_name": updated["location_auto_name"],
                "label": updated["location_label"],
            },
        }
    finally:
        db.close()


@app.delete("/predictions/{record_id}")
def delete_prediction(
    record_id: str,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    db = SessionLocal()
    try:
        record = get_prediction_record_by_id(
            db=db, record_id=record_id, user_id=current_user["id"]
        )
        if record is None:
            raise HTTPException(status_code=404, detail="Data prediksi tidak ditemukan")

        storage_result = {"deleted_paths": [], "message": "Penghapusan gambar tidak dijalankan."}
        try:
            storage_result = delete_prediction_images_from_supabase(
                image_processed_url=record.get("image_processed_url"),
                image_thumbnail_url=record.get("image_thumbnail_url"),
            )
        except Exception:
            logger.exception("prediction_storage_delete_failed")

        deleted_id = delete_prediction_record(
            db,
            record_id,
            user_id=current_user["id"],
        )
        if deleted_id is None:
            raise HTTPException(status_code=404, detail="Data prediksi gagal dihapus")

        log_activity(
            db,
            "DELETE_HISTORY",
            "Pengguna menghapus satu riwayat prediksi.",
            request=request,
            user_id=current_user["id"],
            actor_user_id=current_user["id"],
            metadata={
                "record_id": deleted_id,
                "predicted_class": record.get("predicted_class"),
            },
        )

        return {
            "message": "Data prediksi berhasil dihapus",
            "deleted_record_id": deleted_id,
            "storage": storage_result,
        }
    finally:
        db.close()


@app.get("/stats")
def prediction_stats(current_user: dict = Depends(get_current_user)):
    db = SessionLocal()
    try:
        return get_prediction_stats(db=db, user_id=current_user["id"])
    finally:
        db.close()
