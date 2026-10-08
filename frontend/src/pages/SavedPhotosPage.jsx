import { useEffect, useRef, useState } from "react";

import Alert from "../components/ui/Alert";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import EmptyState from "../components/ui/EmptyState";
import Icon from "../components/ui/Icon";
import LoadingState from "../components/ui/LoadingState";
import Modal from "../components/ui/Modal";
import MaturityBadge from "../components/MaturityBadge";
import PageHeader from "../components/ui/PageHeader";
import { predictPalmImage } from "../services/api";
import {
  deleteSavedPhoto,
  getSavedPhoto,
  getSavedPhotosTotalBytes,
  listSavedPhotosByOwner,
  SAVED_PHOTO_ERROR_CODES,
  updateSavedPhotoStatus,
} from "../services/savedPhotosDb";
import {
  formatConfidence,
  formatMaturityLabel,
} from "../utils/presentation";

const STATUS_INFO = {
  saved: { label: "Tersimpan", tone: "success" },
  failed: { label: "Gagal diproses", tone: "danger" },
  processing: { label: "Sedang diproses", tone: "neutral" },
  server_saved_incomplete: { label: "Perlu perhatian", tone: "warning" },
};

const PREDICTABLE_STATUSES = new Set([
  "saved",
  "failed",
  "server_saved_incomplete",
]);

const IDEMPOTENCY_ERROR_MESSAGES = {
  idempotency_processing:
    "Permintaan sebelumnya masih berstatus tidak pasti. Foto tetap disimpan.",
  idempotency_failed:
    "Permintaan sebelumnya gagal dan memerlukan perhatian. Foto tetap disimpan.",
  idempotency_fingerprint_mismatch:
    "Data foto tidak cocok dengan permintaan sebelumnya. Foto tetap disimpan dan tidak dikirim ulang.",
};

function canPredictPhoto(photo) {
  return PREDICTABLE_STATUSES.has(photo?.status);
}

function hasStrictPredictionSuccess(response) {
  const hasDetections = Array.isArray(response?.detections)
    && response.detections.length > 0;

  return Boolean(
    response?.record_id
    && response?.history?.saved === true
    && response?.storage?.saved === true
    && (
      !hasDetections
      || response?.history?.detection_details_saved === true
    ),
  );
}

function getPredictionResultSummary(response) {
  const payload = response?.result && typeof response.result === "object"
    ? response.result
    : response;
  const predictedClass = payload?.predicted_class || payload?.prediction || "";
  const rawConfidence = payload?.confidence ?? payload?.confidence_score;
  const hasConfidence = rawConfidence !== null
    && rawConfidence !== undefined
    && rawConfidence !== ""
    && Number.isFinite(Number(rawConfidence));

  return {
    predictedClass,
    classLabel: formatMaturityLabel(predictedClass),
    confidence: hasConfidence ? formatConfidence(rawConfidence) : null,
  };
}

function classifyPredictionError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;

  if (error?.kind === "network" || status === null) {
    return {
      kind: "network",
      status: null,
      message: "Koneksi ke server terputus. Foto tetap tersimpan di perangkat.",
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      status,
      message: "Sesi tidak valid. Silakan masuk kembali sebelum mencoba lagi.",
    };
  }

  if (status === 409) {
    return {
      kind: error?.code || "idempotency_conflict",
      status,
      message: IDEMPOTENCY_ERROR_MESSAGES[error?.code]
        || "Permintaan prediksi mengalami konflik. Foto tetap disimpan.",
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limit",
      status,
      message: "Batas prediksi sementara tercapai. Coba lagi beberapa saat lagi.",
    };
  }

  if (status >= 500) {
    return {
      kind: "server",
      status,
      message: "Server gagal memproses prediksi. Foto tetap tersimpan di perangkat.",
    };
  }

  return {
    kind: "request",
    status,
    message: error?.message
      || "Foto tidak dapat diproses. Periksa format dan ukuran foto.",
  };
}

function formatDateTime(value) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "Waktu tidak tersedia";
  }

  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value) {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const amount = bytes / (1024 ** unitIndex);

  return `${amount.toLocaleString("id-ID", {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  })} ${units[unitIndex]}`;
}

function getStorageErrorMessage(error, action = "read") {
  if (error?.code === SAVED_PHOTO_ERROR_CODES.UNSUPPORTED) {
    return "Penyimpanan foto lokal tidak tersedia pada browser ini.";
  }

  if (error?.code === SAVED_PHOTO_ERROR_CODES.OWNERSHIP_MISMATCH) {
    return "Foto tidak dapat diakses karena terjadi konflik kepemilikan lokal.";
  }

  if (action === "delete") {
    return "Sebagian foto gagal dihapus dari perangkat. Silakan coba lagi.";
  }

  return "Foto tersimpan gagal dimuat dari perangkat. Silakan coba lagi.";
}

async function loadOwnerPhotos(ownerUserId) {
  const [photos, totalBytes] = await Promise.all([
    listSavedPhotosByOwner(ownerUserId),
    getSavedPhotosTotalBytes(ownerUserId),
  ]);

  return { photos, totalBytes };
}

function SavedPhotoThumbnail({ imageBlob, alt }) {
  const [hasError, setHasError] = useState(false);
  const imageRef = useRef(null);

  useEffect(() => {
    if (!(imageBlob instanceof Blob) || hasError) return undefined;

    const objectUrl = URL.createObjectURL(imageBlob);

    if (imageRef.current) {
      imageRef.current.src = objectUrl;
    }

    return () => URL.revokeObjectURL(objectUrl);
  }, [hasError, imageBlob]);

  if (!(imageBlob instanceof Blob) || hasError) {
    return (
      <div className="saved-photos-thumbnail-fallback" role="img" aria-label={alt}>
        <Icon name="gallery" size={30} />
        <span>Pratinjau tidak tersedia</span>
      </div>
    );
  }

  return (
    <img
      ref={imageRef}
      className="saved-photos-thumbnail"
      alt={alt}
      onError={() => setHasError(true)}
    />
  );
}

function SavedPhotosPage({ currentUser, onBack, onOpenHistory }) {
  const selectAllRef = useRef(null);
  const predictionRunRef = useRef(false);
  const ownerUserId = String(currentUser?.id || "").trim();

  const [dataState, setDataState] = useState({
    ownerUserId: "",
    status: "idle",
    photos: [],
    totalBytes: 0,
    errorMessage: "",
  });
  const [selectionState, setSelectionState] = useState({
    ownerUserId: "",
    ids: new Set(),
  });
  const [deleteRequest, setDeleteRequest] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [predictionNotice, setPredictionNotice] = useState(null);
  const [singlePredictionResult, setSinglePredictionResult] = useState(null);
  const [predictionProgress, setPredictionProgress] = useState({
    active: false,
    current: 0,
    total: 0,
    success: 0,
    failed: 0,
    remaining: 0,
  });

  const hasCurrentOwnerData = dataState.ownerUserId === ownerUserId;
  const isLoading = Boolean(ownerUserId) && !hasCurrentOwnerData;
  const photos = hasCurrentOwnerData ? dataState.photos : [];
  const totalBytes = hasCurrentOwnerData ? dataState.totalBytes : 0;
  const loadError = hasCurrentOwnerData && dataState.status === "error"
    ? dataState.errorMessage
    : "";
  const selectedIds = selectionState.ownerUserId === ownerUserId
    ? selectionState.ids
    : new Set();
  const predictablePhotos = photos.filter(canPredictPhoto);
  const predictableIds = predictablePhotos.map((photo) => photo.id);
  const visibleSelectedCount = predictableIds
    .filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = predictableIds.length > 0 &&
    visibleSelectedCount === predictableIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const selectedPhotos = predictablePhotos
    .filter((photo) => selectedIds.has(photo.id));
  const isPredicting = predictionProgress.active;
  const visiblePredictionNotice = predictionNotice?.ownerUserId === ownerUserId
    ? predictionNotice
    : null;
  const visibleSinglePredictionResult =
    singlePredictionResult?.ownerUserId === ownerUserId
      ? singlePredictionResult
      : null;

  useEffect(() => {
    let cancelled = false;

    if (!ownerUserId) return undefined;

    loadOwnerPhotos(ownerUserId)
      .then(({ photos: loadedPhotos, totalBytes: loadedBytes }) => {
        if (!cancelled) {
          setDataState({
            ownerUserId,
            status: "ready",
            photos: loadedPhotos,
            totalBytes: loadedBytes,
            errorMessage: "",
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDataState({
            ownerUserId,
            status: "error",
            photos: [],
            totalBytes: 0,
            errorMessage: getStorageErrorMessage(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ownerUserId]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  const updateSelection = (updater) => {
    setSelectionState((previous) => {
      const currentIds = previous.ownerUserId === ownerUserId
        ? previous.ids
        : new Set();

      return {
        ownerUserId,
        ids: updater(new Set(currentIds)),
      };
    });
  };

  const togglePhoto = (photoId) => {
    updateSelection((nextIds) => {
      if (nextIds.has(photoId)) nextIds.delete(photoId);
      else nextIds.add(photoId);
      return nextIds;
    });
  };

  const toggleAllVisible = () => {
    updateSelection((nextIds) => {
      if (allVisibleSelected) {
        predictableIds.forEach((id) => nextIds.delete(id));
      } else {
        predictableIds.forEach((id) => nextIds.add(id));
      }
      return nextIds;
    });
  };

  const clearSelection = () => {
    setSelectionState({ ownerUserId, ids: new Set() });
  };

  const updatePhotoInView = (updatedPhoto) => {
    setDataState((previous) => {
      if (previous.ownerUserId !== ownerUserId) return previous;

      return {
        ...previous,
        photos: previous.photos.map((photo) =>
          photo.id === updatedPhoto.id ? updatedPhoto : photo
        ),
      };
    });
  };

  const refreshOwnerData = async () => {
    const refreshed = await loadOwnerPhotos(ownerUserId);
    setDataState({
      ownerUserId,
      status: "ready",
      photos: refreshed.photos,
      totalBytes: refreshed.totalBytes,
      errorMessage: "",
    });
  };

  const persistPredictionFailure = async (
    photo,
    failure,
    status = "failed",
    serverRecordId = photo.serverRecordId,
  ) => {
    const updatedPhoto = await updateSavedPhotoStatus(
      ownerUserId,
      photo.id,
      {
        status,
        lastError: failure,
        serverRecordId,
      },
    );
    updatePhotoInView(updatedPhoto);
  };

  const processSavedPhoto = async (photo) => {
    let ownedPhoto;

    try {
      ownedPhoto = await getSavedPhoto(ownerUserId, photo.id);
    } catch (error) {
      return {
        success: false,
        stop: true,
        tone: "error",
        message: getStorageErrorMessage(error),
      };
    }

    if (!canPredictPhoto(ownedPhoto)) {
      return {
        success: false,
        stop: true,
        tone: "warning",
        message: ownedPhoto.status === "processing"
          ? "Foto masih berstatus sedang diproses dan tidak dikirim ulang."
          : "Foto ini belum aman untuk diproses.",
      };
    }

    const attemptStartedAt = new Date().toISOString();

    try {
      ownedPhoto = await updateSavedPhotoStatus(
        ownerUserId,
        ownedPhoto.id,
        {
          status: "processing",
          attemptCount: ownedPhoto.attemptCount + 1,
          lastAttemptAt: attemptStartedAt,
          lastError: null,
        },
      );
      updatePhotoInView(ownedPhoto);
    } catch (error) {
      return {
        success: false,
        stop: true,
        tone: "error",
        message: getStorageErrorMessage(error),
      };
    }

    let imageFile;

    try {
      imageFile = new File(
        [ownedPhoto.imageBlob],
        ownedPhoto.fileName,
        {
          type: ownedPhoto.mimeType,
          lastModified: ownedPhoto.lastModified || Date.now(),
        },
      );
    } catch {
      const failure = {
        kind: "request",
        status: null,
        message: "File lokal tidak dapat disiapkan. Foto tetap tersimpan.",
      };

      try {
        await persistPredictionFailure(ownedPhoto, failure);
      } catch {
        // Status processing tetap aman dan tidak dikirim ulang otomatis.
      }

      return {
        success: false,
        stop: true,
        tone: "error",
        message: failure.message,
      };
    }

    let response;

    try {
      response = await predictPalmImage(
        imageFile,
        ownedPhoto.inputSource,
        ownedPhoto.location,
        ownedPhoto.id,
      );
    } catch (error) {
      const failure = classifyPredictionError(error);

      try {
        await persistPredictionFailure(ownedPhoto, failure);
      } catch (storageError) {
        return {
          success: false,
          stop: true,
          tone: "error",
          message: getStorageErrorMessage(storageError),
        };
      }

      return {
        success: false,
        stop: true,
        tone: failure.status === 409 ? "warning" : "error",
        message: failure.message,
      };
    }

    if (hasStrictPredictionSuccess(response)) {
      try {
        await deleteSavedPhoto(ownerUserId, ownedPhoto.id);
      } catch {
        const failure = {
          kind: "storage",
          status: null,
          message: (
            "Prediksi tersimpan di server, tetapi foto lokal gagal dihapus. "
            + "Foto tetap memerlukan perhatian."
          ),
        };

        try {
          await persistPredictionFailure(
            ownedPhoto,
            failure,
            "server_saved_incomplete",
            response.record_id,
          );
        } catch {
          // Record tetap dipertahankan; kegagalan storage menghentikan antrean.
        }

        return {
          success: false,
          stop: true,
          tone: "error",
          message: failure.message,
        };
      }

      updateSelection((nextIds) => {
        nextIds.delete(ownedPhoto.id);
        return nextIds;
      });
      setDataState((previous) => {
        if (previous.ownerUserId !== ownerUserId) return previous;

        return {
          ...previous,
          photos: previous.photos.filter(
            (currentPhoto) => currentPhoto.id !== ownedPhoto.id,
          ),
          totalBytes: Math.max(
            previous.totalBytes - ownedPhoto.sizeBytes,
            0,
          ),
        };
      });

      try {
        await refreshOwnerData();
      } catch {
        return {
          success: true,
          stop: true,
          tone: "warning",
          message: (
            "Prediksi berhasil dan foto telah dipindahkan ke Riwayat, "
            + "tetapi ringkasan penyimpanan lokal gagal dimuat ulang."
          ),
          result: getPredictionResultSummary(response),
        };
      }

      return {
        success: true,
        stop: false,
        tone: "success",
        message: "Prediksi berhasil. Foto telah dipindahkan ke Riwayat.",
        result: getPredictionResultSummary(response),
      };
    }

    const serverRecordId = response?.record_id || ownedPhoto.serverRecordId;
    const historyWasNotSaved = response?.history?.saved === false;
    const failure = historyWasNotSaved
      ? {
        kind: "server",
        status: null,
        message: (
          "Hasil prediksi tidak disimpan ke riwayat. "
          + "Foto tetap tersimpan di perangkat."
        ),
      }
      : {
        kind: "server",
        status: null,
        message: (
          "Hasil prediksi belum tersimpan lengkap di server. "
          + "Foto tetap tersimpan di perangkat."
        ),
      };
    const nextStatus = historyWasNotSaved
      ? "failed"
      : "server_saved_incomplete";

    try {
      await persistPredictionFailure(
        ownedPhoto,
        failure,
        nextStatus,
        serverRecordId,
      );
    } catch (error) {
      return {
        success: false,
        stop: true,
        tone: "error",
        message: getStorageErrorMessage(error),
      };
    }

    return {
      success: false,
      stop: true,
      tone: "warning",
      message: failure.message,
    };
  };

  const runPredictionQueue = async (requestedPhotos) => {
    if (
      predictionRunRef.current
      || isDeleting
      || !ownerUserId
      || requestedPhotos.length === 0
    ) {
      return;
    }

    const queuedPhotos = requestedPhotos.filter(canPredictPhoto);

    if (queuedPhotos.length === 0) return;

    predictionRunRef.current = true;
    setOperationError("");
    setPredictionNotice(null);
    setSinglePredictionResult(null);
    setPredictionProgress({
      active: true,
      current: 0,
      total: queuedPhotos.length,
      success: 0,
      failed: 0,
      remaining: queuedPhotos.length,
    });

    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    let lastResult = null;

    try {
      for (let index = 0; index < queuedPhotos.length; index += 1) {
        setPredictionProgress({
          active: true,
          current: index + 1,
          total: queuedPhotos.length,
          success: successCount,
          failed: failedCount,
          remaining: queuedPhotos.length - index,
        });

        try {
          lastResult = await processSavedPhoto(queuedPhotos[index]);
        } catch {
          lastResult = {
            success: false,
            stop: true,
            tone: "error",
            message: (
              "Proses foto berhenti karena kesalahan yang tidak terduga. "
              + "Foto tetap tersimpan di perangkat."
            ),
          };
        }
        processedCount = index + 1;

        if (lastResult.success) successCount += 1;
        else failedCount += 1;

        setPredictionProgress({
          active: true,
          current: index + 1,
          total: queuedPhotos.length,
          success: successCount,
          failed: failedCount,
          remaining: queuedPhotos.length - processedCount,
        });

        if (lastResult.stop) break;
      }
    } finally {
      const remainingCount = queuedPhotos.length - processedCount;
      const summary = (
        `${successCount} berhasil • ${failedCount} gagal • `
        + `${remainingCount} belum diproses`
      );

      setPredictionProgress({
        active: false,
        current: processedCount,
        total: queuedPhotos.length,
        success: successCount,
        failed: failedCount,
        remaining: remainingCount,
      });
      predictionRunRef.current = false;

      if (queuedPhotos.length === 1 && lastResult?.success) {
        setSinglePredictionResult({
          ...lastResult.result,
          ownerUserId,
        });

        if (lastResult.stop) {
          setPredictionNotice({
            ownerUserId,
            tone: lastResult.tone,
            title: "Prediksi selesai",
            message: lastResult.message,
            summary,
            successCount,
          });
        }
      } else if (lastResult?.stop) {
        setPredictionNotice({
          ownerUserId,
          tone: lastResult.tone,
          title: "Proses prediksi berhenti",
          message: lastResult.message,
          summary,
          successCount,
        });
      } else if (lastResult && !lastResult.success) {
        setPredictionNotice({
          ownerUserId,
          tone: lastResult.tone,
          title: "Prediksi belum selesai",
          message: lastResult.message,
          summary,
          successCount,
        });
      } else {
        setPredictionNotice({
          ownerUserId,
          tone: "success",
          title: "Proses prediksi selesai",
          message: "Foto yang berhasil diproses telah disimpan ke Riwayat.",
          summary,
          successCount,
        });
      }
    }
  };

  const closeSinglePredictionResult = () => {
    setSinglePredictionResult(null);
  };

  const openHistory = () => {
    setSinglePredictionResult(null);
    setPredictionNotice(null);
    onOpenHistory?.();
  };

  const confirmDeletion = async () => {
    const requestedPhotos = deleteRequest?.photos || [];

    if (
      !ownerUserId
      || requestedPhotos.length === 0
      || isDeleting
      || isPredicting
    ) return;

    setIsDeleting(true);
    setOperationError("");
    const deletedIds = new Set();
    const failedIds = [];

    for (const photo of requestedPhotos) {
      try {
        await deleteSavedPhoto(ownerUserId, photo.id);
        deletedIds.add(photo.id);
      } catch {
        failedIds.push(photo.id);
      }
    }

    updateSelection((nextIds) => {
      deletedIds.forEach((id) => nextIds.delete(id));
      return nextIds;
    });

    try {
      const refreshed = await loadOwnerPhotos(ownerUserId);
      setDataState({
        ownerUserId,
        status: "ready",
        photos: refreshed.photos,
        totalBytes: refreshed.totalBytes,
        errorMessage: "",
      });
    } catch (error) {
      setDataState({
        ownerUserId,
        status: "error",
        photos: [],
        totalBytes: 0,
        errorMessage: getStorageErrorMessage(error),
      });
    }

    if (failedIds.length > 0) {
      setOperationError(getStorageErrorMessage(null, "delete"));
    }

    setDeleteRequest(null);
    setIsDeleting(false);
  };

  const closeDeleteDialog = () => {
    if (!isDeleting) setDeleteRequest(null);
  };

  const headerActions = (
    <Button type="button" variant="ghost" onClick={onBack}>
      <Icon className="saved-photos-back-icon" name="chevron" size={18} />
      Kembali ke Prediksi
    </Button>
  );

  if (!ownerUserId) {
    return (
      <main className="saved-photos-page">
        <PageHeader
          eyebrow="Penyimpanan Perangkat"
          title="Foto Tersimpan"
          description="Foto tersimpan di perangkat ini dan belum diproses."
          actions={headerActions}
        />
        <Alert tone="warning" role="alert">
          Sesi pengguna tidak tersedia. Silakan masuk kembali untuk membuka foto tersimpan.
        </Alert>
      </main>
    );
  }

  return (
    <main className="saved-photos-page">
      <PageHeader
        className="saved-photos-header"
        eyebrow="Penyimpanan Perangkat"
        title="Foto Tersimpan"
        description="Foto tersimpan di perangkat ini dan belum diproses."
        actions={headerActions}
      />

      {isLoading ? (
        <LoadingState
          title="Memuat foto tersimpan..."
          description="Membaca penyimpanan lokal perangkat."
        />
      ) : loadError ? (
        <Alert tone="error" role="alert">{loadError}</Alert>
      ) : (
        <>
          <Card className="saved-photos-summary" variant="subtle">
            <div>
              <span>Foto tersimpan</span>
              <strong>{photos.length}</strong>
            </div>
            <div>
              <span>Penggunaan lokal</span>
              <strong>{formatBytes(totalBytes)}</strong>
            </div>
          </Card>

          {operationError && (
            <Alert tone="error" role="alert">{operationError}</Alert>
          )}

          {predictionProgress.active && (
            <Alert tone="neutral" role="status">
              <strong>
                Memproses {predictionProgress.current} dari {predictionProgress.total} foto
              </strong>
              <span className="saved-photos-progress-detail">
                {predictionProgress.success} berhasil • {predictionProgress.failed} gagal
              </span>
            </Alert>
          )}

          {!predictionProgress.active && visiblePredictionNotice && (
            <Alert
              tone={visiblePredictionNotice.tone}
              role={visiblePredictionNotice.tone === "error" ? "alert" : "status"}
            >
              <strong>{visiblePredictionNotice.title}</strong>
              <span className="saved-photos-progress-message">
                {visiblePredictionNotice.message}
              </span>
              <span className="saved-photos-progress-detail">
                {visiblePredictionNotice.summary}
              </span>
              {visiblePredictionNotice.successCount > 0 && (
                <div className="saved-photos-notice-actions">
                  <Button type="button" variant="ghost" size="sm" onClick={openHistory}>
                    <Icon name="history" size={17} />
                    Lihat Riwayat
                  </Button>
                </div>
              )}
            </Alert>
          )}

          {photos.length === 0 ? (
            <EmptyState
              icon="gallery"
              title="Belum ada foto tersimpan"
              description="Simpan foto dari halaman Prediksi untuk melihatnya di sini."
              actionLabel="Kembali ke Prediksi"
              onAction={onBack}
            />
          ) : (
            <>
              <Card className="saved-photos-selection" variant="subtle">
                <label className="saved-photos-select-all">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    disabled={
                      predictableIds.length === 0
                      || isDeleting
                      || isPredicting
                    }
                  />
                  <span>Pilih semua foto yang dapat diproses</span>
                </label>

                <span className="saved-photos-selection-count">
                  {selectedPhotos.length} dipilih
                </span>

                <div className="saved-photos-selection-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearSelection}
                    disabled={
                      selectedPhotos.length === 0
                      || isDeleting
                      || isPredicting
                    }
                  >
                    Bersihkan pilihan
                  </Button>
                  {selectedPhotos.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => runPredictionQueue(selectedPhotos)}
                      disabled={isDeleting || isPredicting}
                    >
                      <Icon name="scan" size={17} />
                      Prediksi {selectedPhotos.length} Foto
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setDeleteRequest({ photos: selectedPhotos })}
                    disabled={
                      selectedPhotos.length === 0
                      || isDeleting
                      || isPredicting
                    }
                  >
                    Hapus yang dipilih
                  </Button>
                </div>
              </Card>

              <div className="saved-photos-grid">
                {photos.map((photo) => {
                  const isSelected = selectedIds.has(photo.id);
                  const status = STATUS_INFO[photo.status] || STATUS_INFO.saved;
                  const sourceLabel = photo.inputSource === "gallery"
                    ? "Galeri"
                    : "Kamera";
                  const isPhotoProcessing = photo.status === "processing";
                  const isPhotoPredictable = canPredictPhoto(photo);

                  return (
                    <Card
                      as="article"
                      className={`saved-photo-card${isSelected ? " is-selected" : ""}`}
                      key={photo.id}
                    >
                      <div className="saved-photo-image-wrap">
                        <SavedPhotoThumbnail
                          imageBlob={photo.imageBlob}
                          alt={`Foto TBS dari ${sourceLabel.toLowerCase()}`}
                        />
                        <label className="saved-photo-checkbox">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => togglePhoto(photo.id)}
                            disabled={
                              isPhotoProcessing
                              || isDeleting
                              || isPredicting
                            }
                          />
                          <span className="sr-only">Pilih foto ini</span>
                        </label>
                      </div>

                      <div className="saved-photo-card-body">
                        <div className="saved-photo-card-heading">
                          <strong>{formatDateTime(photo.capturedAt)}</strong>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </div>
                        <dl className="saved-photo-meta">
                          <div>
                            <dt>Sumber</dt>
                            <dd>{sourceLabel}</dd>
                          </div>
                          <div>
                            <dt>Lokasi</dt>
                            <dd>{photo.location ? "GPS tersedia" : "Lokasi tidak tersedia"}</dd>
                          </div>
                          <div>
                            <dt>Ukuran</dt>
                            <dd>{formatBytes(photo.sizeBytes)}</dd>
                          </div>
                        </dl>
                        {photo.lastError?.message && (
                          <p className="saved-photo-error" role="status">
                            {photo.lastError.message}
                          </p>
                        )}
                        <div className="saved-photo-actions">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => runPredictionQueue([photo])}
                            disabled={
                              !isPhotoPredictable
                              || isDeleting
                              || isPredicting
                            }
                          >
                            <Icon name="scan" size={17} />
                            {isPhotoProcessing ? "Memproses..." : "Prediksi"}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteRequest({ photos: [photo] })}
                            disabled={
                              isPhotoProcessing
                              || isDeleting
                              || isPredicting
                            }
                          >
                            <Icon name="trash" size={17} />
                            Hapus foto
                          </Button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      <Modal
        open={Boolean(visibleSinglePredictionResult)}
        onClose={closeSinglePredictionResult}
        title="Prediksi selesai"
        eyebrow="Hasil Prediksi"
        className="saved-photos-result-modal"
      >
        <div className="saved-photos-result-dialog">
          <div className="saved-photos-result-summary">
            <span>Hasil kematangan</span>
            {visibleSinglePredictionResult?.predictedClass ? (
              <MaturityBadge value={visibleSinglePredictionResult.predictedClass} />
            ) : (
              <strong>{visibleSinglePredictionResult?.classLabel}</strong>
            )}
            {visibleSinglePredictionResult?.confidence !== null && (
              <p>
                Keyakinan hasil <strong>{visibleSinglePredictionResult?.confidence}%</strong>
              </p>
            )}
          </div>
          <p>
            Foto telah berhasil diproses dan disimpan ke Riwayat. Salinan lokal
            telah dihapus dengan aman.
          </p>
          <div className="saved-photos-result-actions">
            <Button type="button" variant="ghost" onClick={closeSinglePredictionResult}>
              Tutup
            </Button>
            <Button type="button" onClick={openHistory} data-autofocus>
              <Icon name="history" size={18} />
              Lihat Riwayat
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(deleteRequest)}
        onClose={closeDeleteDialog}
        title="Hapus foto tersimpan?"
        eyebrow="Konfirmasi"
        role="alertdialog"
        closeOnBackdrop={!isDeleting}
      >
        <div className="saved-photos-delete-dialog">
          <p>
            {deleteRequest?.photos?.length === 1
              ? "Hapus foto tersimpan ini?"
              : `Hapus ${deleteRequest?.photos?.length || 0} foto tersimpan?`}
          </p>
          <p>Foto yang dihapus dari perangkat tidak dapat dipulihkan.</p>
          <div className="saved-photos-delete-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={closeDeleteDialog}
              disabled={isDeleting || isPredicting}
              data-autofocus
            >
              Batalkan
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={confirmDeletion}
              disabled={isDeleting || isPredicting}
            >
              {isDeleting ? "Menghapus..." : "Hapus foto"}
            </Button>
          </div>
        </div>
      </Modal>
    </main>
  );
}

export default SavedPhotosPage;
