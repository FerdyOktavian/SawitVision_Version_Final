from datetime import date, datetime
import logging
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_admin, get_current_user
from database import get_db
from report_service import (
    CLASS_LABELS,
    build_admin_report_workbook,
    build_user_report_workbook,
    get_admin_prediction_report_data,
    get_user_prediction_report_data,
    sanitize_filename,
)


router = APIRouter(tags=["Reports"])
logger = logging.getLogger(__name__)


def validate_date_range(
    start_date: Optional[date],
    end_date: Optional[date],
) -> None:
    if start_date and end_date and start_date > end_date:
        raise HTTPException(
            status_code=400,
            detail="Tanggal mulai tidak boleh melebihi tanggal akhir.",
        )


def build_excel_response(buffer, filename: str) -> StreamingResponse:
    encoded_filename = quote(filename)

    return StreamingResponse(
        buffer,
        media_type=(
            "application/vnd.openxmlformats-officedocument."
            "spreadsheetml.sheet"
        ),
        headers={
            "Content-Disposition": (
                f"attachment; filename*=UTF-8''{encoded_filename}"
            ),
            "Cache-Control": "no-store",
        },
    )


@router.get("/reports/my-predictions.xlsx")
def export_my_predictions_excel(
    start_date: Optional[date] = Query(
        None,
        description="Tanggal awal laporan dalam format YYYY-MM-DD",
    ),
    end_date: Optional[date] = Query(
        None,
        description="Tanggal akhir laporan dalam format YYYY-MM-DD",
    ),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    validate_date_range(start_date, end_date)

    try:
        data = get_user_prediction_report_data(
            db=db,
            user_id=current_user["id"],
            start_date=start_date,
            end_date=end_date,
        )
        buffer = build_user_report_workbook(data)
    except ValueError as error:
        raise HTTPException(
            status_code=404,
            detail="Pengguna tidak ditemukan.",
        ) from error
    except Exception:
        logger.exception("User Excel report generation failed")
        raise HTTPException(
            status_code=500,
            detail="Gagal membuat laporan Excel pengguna.",
        ) from None

    safe_name = sanitize_filename(current_user.get("name") or "user")
    date_suffix = (
        f"{start_date}_{end_date}"
        if start_date and end_date
        else datetime.now().strftime("%Y-%m-%d")
    )
    filename = f"Laporan_Prediksi_{safe_name}_{date_suffix}.xlsx"

    return build_excel_response(buffer, filename)


@router.get("/admin/reports/predictions.xlsx")
def export_admin_predictions_excel(
    start_date: Optional[date] = Query(
        None,
        description="Tanggal awal laporan dalam format YYYY-MM-DD",
    ),
    end_date: Optional[date] = Query(
        None,
        description="Tanggal akhir laporan dalam format YYYY-MM-DD",
    ),
    user_id: Optional[str] = Query(
        None,
        description="Filter berdasarkan UUID user",
    ),
    user_ids: Optional[List[str]] = Query(
        None,
        description="Filter berdasarkan satu atau lebih UUID user",
    ),
    predicted_class: Optional[str] = Query(
        None,
        description=(
            "Filter kelas: belum_masak, masak, atau terlalu_masak"
        ),
    ),
    current_admin: dict = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    validate_date_range(start_date, end_date)

    if predicted_class and predicted_class not in CLASS_LABELS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Kelas prediksi tidak valid. Gunakan belum_masak, "
                "masak, atau terlalu_masak."
            ),
        )

    try:
        selected_user_ids = list(dict.fromkeys([
            *[value.strip() for value in (user_ids or []) if value.strip()],
            *([user_id.strip()] if user_id and user_id.strip() else []),
        ]))
        data = get_admin_prediction_report_data(
            db=db,
            start_date=start_date,
            end_date=end_date,
            user_ids=selected_user_ids or None,
            predicted_class=predicted_class,
        )
        buffer = build_admin_report_workbook(data)
    except Exception:
        logger.exception("Admin Excel report generation failed")
        raise HTTPException(
            status_code=500,
            detail="Gagal membuat laporan Excel admin.",
        ) from None

    date_suffix = datetime.now().strftime("%Y-%m-%d")
    filename = f"Laporan_Global_SawitVision_{date_suffix}.xlsx"

    return build_excel_response(buffer, filename)
