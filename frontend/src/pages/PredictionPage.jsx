import { useEffect, useMemo, useRef, useState } from "react";
import {
  predictPalmImage,
  reverseGeocodeLocation,
  updatePredictionLocationLabel,
  updatePredictionMetadata,
} from "../services/api";
import {
  captureOptionalLocation,
  createCaptureMetadata,
  createEmptyCaptureMetadata,
} from "../utils/captureMetadata";
import {
  countSavedPhotosByOwner,
  saveSavedPhoto,
  SAVED_PHOTO_ERROR_CODES,
  SAVED_PHOTO_SCHEMA_VERSION,
  SAVED_PHOTO_STATUSES,
} from "../services/savedPhotosDb";
import Alert from "../components/ui/Alert";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Icon from "../components/ui/Icon";
import IconButton from "../components/ui/IconButton";
import LoadingState from "../components/ui/LoadingState";
import PageHeader from "../components/ui/PageHeader";
import SegmentedControl from "../components/ui/SegmentedControl";

const MAX_ZOOM = 5;
const MIN_ZOOM = 1;
const ZOOM_STEP = 0.2;
const LOCATION_STATUS_TEXT = {
  requesting: "Meminta izin lokasi...",
  resolving: "Lokasi GPS ditemukan. Mencari nama wilayah...",
  available: "Lokasi ditemukan dan akan disimpan otomatis.",
  denied: "Izin lokasi ditolak. Prediksi tetap dilanjutkan tanpa lokasi.",
  timeout: "Lokasi tidak merespons. Prediksi tetap dilanjutkan.",
  unavailable: "Lokasi tidak tersedia. Prediksi tetap dilanjutkan.",
  unsupported: "Browser ini tidak mendukung geolocation.",
};

const CLASS_INFO = {
  belum_masak: {
    label: "Belum Matang",
    status: "Belum siap dipanen",
    description:
      "Buah belum mencapai tingkat kematangan optimal untuk dipanen.",
    recommendation:
      "Lakukan pemeriksaan kembali setelah buah menunjukkan perubahan warna dan ciri kematangan yang lebih jelas.",
  },
  masak: {
    label: "Matang",
    status: "Siap dipanen",
    description:
      "Buah berada pada tingkat kematangan yang sesuai untuk dipanen.",
    recommendation:
      "Buah dapat diprioritaskan untuk proses panen sesuai kondisi lapangan.",
  },
  terlalu_masak: {
    label: "Terlalu Matang",
    status: "Melewati kematangan optimal",
    description: "Buah telah melewati tingkat kematangan optimal.",
    recommendation:
      "Buah sebaiknya segera ditangani agar keterlambatan panen tidak semakin bertambah.",
  },
};

function toPercent(value) {
  const number = Number(value || 0);
  return number <= 1 ? number * 100 : number;
}

function normalizeClassName(value = "") {
  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
}

function formatClassLabel(value) {
  const normalized = normalizeClassName(value);

  if (CLASS_INFO[normalized]) {
    return CLASS_INFO[normalized].label;
  }

  return normalized
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "Tidak diketahui";
}

function toSafeCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.trunc(number)
    : fallback;
}

function getValidCoordinate(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const coordinate = Number(value);
  return Number.isFinite(coordinate) &&
    coordinate >= minimum &&
    coordinate <= maximum
    ? coordinate
    : null;
}

function getLocationAccuracyQuality(value) {
  const accuracy = Number(value);
  const isAvailable =
    value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(accuracy) &&
    accuracy >= 0;

  if (!isAvailable) {
    return null;
  }

  if (accuracy <= 50) {
    return { accuracy, label: "Akurasi Tinggi", level: "high" };
  }

  if (accuracy <= 500) {
    return { accuracy, label: "Akurasi Sedang", level: "medium" };
  }

  return { accuracy, label: "Akurasi Rendah", level: "low" };
}

function formatWarning(warning) {
  if (typeof warning === "string") {
    return warning;
  }

  const detectionNumber = Number.isInteger(warning?.detection_index)
    ? `Kandidat TBS ${warning.detection_index + 1}: `
    : "";
  const reason = String(warning?.reason || "Sebagian hasil tidak dapat diproses")
    .replaceAll("_", " ");

  return `${detectionNumber}${reason}`;
}

function dataUrlToFile(dataUrl, filename) {
  const [header, content] = dataUrl.split(",");
  const mimeType = header.match(/data:(.*?);base64/)?.[1] || "image/jpeg";

  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], filename, {
    type: mimeType,
  });
}

function getLocalSaveErrorMessage(error) {
  switch (error?.code) {
    case SAVED_PHOTO_ERROR_CODES.QUOTA_EXCEEDED:
      return "Penyimpanan perangkat penuh. Kosongkan ruang browser lalu coba lagi.";
    case SAVED_PHOTO_ERROR_CODES.UNSUPPORTED:
      return "Penyimpanan foto lokal tidak tersedia pada browser ini.";
    case SAVED_PHOTO_ERROR_CODES.OWNERSHIP_MISMATCH:
      return "Foto tidak dapat disimpan karena terjadi konflik kepemilikan lokal.";
    case SAVED_PHOTO_ERROR_CODES.INVALID_RECORD:
      return "Foto tidak dapat disimpan. Periksa kembali foto lalu coba lagi.";
    case SAVED_PHOTO_ERROR_CODES.STORAGE_FAILURE:
    default:
      return "Penyimpanan foto lokal gagal diakses. Silakan coba lagi.";
  }
}

function createSavedPhotoRecord({ file, ownerUserId, captureMetadata, location }) {
  const timestamp = new Date().toISOString();

  return {
    id: globalThis.crypto.randomUUID(),
    schemaVersion: SAVED_PHOTO_SCHEMA_VERSION,
    ownerUserId,
    imageBlob: file,
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
    inputSource: captureMetadata.source,
    capturedAt: captureMetadata.capturedAt,
    location,
    status: SAVED_PHOTO_STATUSES.SAVED,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastAttemptAt: null,
    attemptCount: 0,
    lastError: null,
    serverRecordId: null,
  };
}

function PredictionPage({
  currentUser,
  onOpenHistory,
  onOpenSavedPhotos,
  definitelyOffline = false,
  serverActionsUnavailable = false,
}) {
  const galleryRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const cameraRequestIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const cameraSectionRef = useRef(null);
  const openCameraButtonRef = useRef(null);
  const restoreCameraTriggerFocusRef = useRef(false);
  const resultLocationSaveRef = useRef(false);
  const localSaveLockRef = useRef(false);
  const savedPhotoLocationPrefetchRef = useRef({
    file: null,
    promise: null,
    result: null,
  });

  const [mode, setMode] = useState("camera");
  const [cameraActive, setCameraActive] = useState(false);
  const [isOpeningCamera, setIsOpeningCamera] = useState(false);

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [captureMetadata, setCaptureMetadata] = useState(() =>
    createEmptyCaptureMetadata("camera"),
  );
  const source = captureMetadata.source;

  const [zoom, setZoom] = useState(1);

  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isPreparingLocation, setIsPreparingLocation] = useState(false);
  const [locationStatus, setLocationStatus] = useState("idle");
  const [isEditingResultLocation, setIsEditingResultLocation] = useState(false);
  const [resultLocationDraft, setResultLocationDraft] = useState("");
  const [isSavingResultLocation, setIsSavingResultLocation] = useState(false);
  const [resultLocationEditError, setResultLocationEditError] = useState("");
  const [resultMetadataTitle, setResultMetadataTitle] = useState("");
  const [resultMetadataDescription, setResultMetadataDescription] = useState("");
  const [resultMetadataStatus, setResultMetadataStatus] = useState("idle");
  const [isSavingResultMetadata, setIsSavingResultMetadata] = useState(false);
  const [resultMetadataError, setResultMetadataError] = useState("");
  const [resultImageErrors, setResultImageErrors] = useState({});
  const [loadedResultImages, setLoadedResultImages] = useState({});
  const [savedPhotoSummary, setSavedPhotoSummary] = useState({
    ownerUserId: "",
    status: "idle",
    count: null,
  });
  const [isSavingPhoto, setIsSavingPhoto] = useState(false);
  const [localSaveFeedback, setLocalSaveFeedback] = useState(null);
  const ownerUserId = String(currentUser?.id || "").trim();
  const hasCurrentOwnerSummary =
    savedPhotoSummary.ownerUserId === ownerUserId;
  const isSavedPhotoCountLoading = Boolean(ownerUserId) &&
    (!hasCurrentOwnerSummary || savedPhotoSummary.status === "loading");
  const savedPhotoCountUnavailable = hasCurrentOwnerSummary &&
    savedPhotoSummary.status === "unavailable";
  const savedPhotoCount = hasCurrentOwnerSummary
    ? savedPhotoSummary.count
    : null;
  const visibleLocalSaveFeedback =
    localSaveFeedback?.file === file &&
    localSaveFeedback?.ownerUserId === ownerUserId
      ? localSaveFeedback
      : null;
  const isBusy =
    loading
    || isPreparingLocation
    || isSavingResultLocation
    || isSavingResultMetadata
    || isSavingPhoto;
  const isLiveCameraVisible = cameraActive && mode === "camera" && !preview;

  const resultPayload = useMemo(() => {
    if (result?.result && typeof result.result === "object") {
      return result.result;
    }

    return result;
  }, [result]);

  const resultClass = useMemo(() => {
    const value =
      resultPayload?.predicted_class ||
      resultPayload?.prediction ||
      "";

    return normalizeClassName(value);
  }, [resultPayload]);

  const confidence = toPercent(
    resultPayload?.confidence ?? resultPayload?.confidence_score,
  );

  const probabilities = resultPayload?.probabilities || {};

  const detections = useMemo(
    () =>
      Array.isArray(resultPayload?.detections)
        ? resultPayload.detections
        : [],
    [resultPayload],
  );
  const warnings = Array.isArray(resultPayload?.warnings)
    ? resultPayload.warnings
    : [];
  const hasDetectionContract = Boolean(
    resultPayload?.summary || Array.isArray(resultPayload?.detections),
  );

  const detectionSummary = useMemo(() => {
    const fallbackByClass = detections.reduce(
      (counts, detection) => {
        const className = normalizeClassName(detection?.predicted_class);

        if (Object.hasOwn(counts, className)) {
          counts[className] += 1;
        }

        return counts;
      },
      {
        belum_masak: 0,
        masak: 0,
        terlalu_masak: 0,
      },
    );
    const backendSummary = resultPayload?.summary;

    return {
      total: toSafeCount(
        backendSummary?.total_detections,
        detections.length,
      ),
      byClass: {
        belum_masak: toSafeCount(
          backendSummary?.by_class?.belum_masak,
          fallbackByClass.belum_masak,
        ),
        masak: toSafeCount(
          backendSummary?.by_class?.masak,
          fallbackByClass.masak,
        ),
        terlalu_masak: toSafeCount(
          backendSummary?.by_class?.terlalu_masak,
          fallbackByClass.terlalu_masak,
        ),
      },
    };
  }, [detections, resultPayload]);

  const processedImageUrl =
    resultPayload?.image_processed_url || result?.image_processed_url || "";
  const resultImageCandidates = [processedImageUrl, preview].filter(
    (url, index, values) =>
      url && values.indexOf(url) === index && !resultImageErrors[url],
  );
  const resultImageSource = resultImageCandidates[0] || "";
  const resultImageIsProcessed =
    Boolean(processedImageUrl) && resultImageSource === processedImageUrl;
  const resultImageLoading = Boolean(
    resultImageSource && !loadedResultImages[resultImageSource],
  );
  const isZeroDetection =
    hasDetectionContract && detectionSummary.total === 0;
  const resultLocation = resultPayload?.location || null;
  const resultLatitude = getValidCoordinate(
    resultLocation?.latitude,
    -90,
    90,
  );
  const resultLongitude = getValidCoordinate(
    resultLocation?.longitude,
    -180,
    180,
  );
  const hasResultLocation =
    resultLocation?.available === true &&
    resultLatitude !== null &&
    resultLongitude !== null;
  const resultLocationLabel = String(resultLocation?.label || "").trim();
  const resultLocationAutoName = String(
    resultLocation?.auto_name || "",
  ).trim();
  const resultLocationName =
    resultLocationLabel ||
    resultLocationAutoName ||
    "Nama lokasi tidak tersedia";
  const resultRecordId = resultPayload?.record_id || null;
  const canUpdateResultLocation = Boolean(resultRecordId);
  const canNameResult = Boolean(
    resultRecordId && resultPayload?.history?.saved === true,
  );
  const showResultAutoName = Boolean(
    resultLocationLabel &&
      resultLocationAutoName &&
      resultLocationAutoName !== resultLocationLabel,
  );
  const resultAccuracyQuality = getLocationAccuracyQuality(
    resultLocation?.accuracy_meters,
  );
  const resultLocationMapUrl = hasResultLocation
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${resultLatitude},${resultLongitude}`,
      )}`
    : "";

  const info = CLASS_INFO[resultClass] || {
    label: resultClass || "Hasil Prediksi",
    status: "Hasil klasifikasi",
    description: "Hasil klasifikasi berhasil diperoleh dari sistem.",
    recommendation:
      "Gunakan hasil klasifikasi sebagai informasi pendukung pemeriksaan.",
  };

  const resetResultMetadata = () => {
    setResultMetadataTitle("");
    setResultMetadataDescription("");
    setResultMetadataStatus("idle");
    setIsSavingResultMetadata(false);
    setResultMetadataError("");
  };

  const stopCamera = () => {
    cameraRequestIdRef.current += 1;

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraActive(false);
    setIsOpeningCamera(false);
  };

  const clearPreviewUrl = () => {
    if (preview?.startsWith("blob:")) {
      URL.revokeObjectURL(preview);
    }
  };

  const invalidateSavedPhotoLocationPrefetch = () => {
    savedPhotoLocationPrefetchRef.current = {
      file: null,
      promise: null,
      result: null,
    };
  };

  const startSavedPhotoLocationPrefetch = (photoFile, { force = false } = {}) => {
    const currentRequest = savedPhotoLocationPrefetchRef.current;

    if (!force && currentRequest.file === photoFile && currentRequest.promise) {
      return currentRequest.promise;
    }

    const request = {
      file: photoFile,
      promise: null,
      result: null,
    };

    request.promise = captureOptionalLocation()
      .catch(() => ({
        ok: false,
        status: "unavailable",
        errorCode: null,
        location: null,
      }))
      .then((locationResult) => {
        if (savedPhotoLocationPrefetchRef.current === request) {
          request.result = locationResult;
        }

        return locationResult;
      });

    savedPhotoLocationPrefetchRef.current = request;
    return request.promise;
  };

  const getLocationForPhoto = (
    photoFile,
    { retryResolvedFailure = false } = {},
  ) => {
    const currentRequest = savedPhotoLocationPrefetchRef.current;

    if (currentRequest.file !== photoFile || !currentRequest.promise) {
      return startSavedPhotoLocationPrefetch(photoFile);
    }

    if (
      retryResolvedFailure
      && currentRequest.result
      && !currentRequest.result.ok
    ) {
      return startSavedPhotoLocationPrefetch(photoFile, { force: true });
    }

    return currentRequest.promise;
  };

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      cameraRequestIdRef.current += 1;

      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop());
        cameraStreamRef.current = null;
      }

      invalidateSavedPhotoLocationPrefetch();
    };
  }, []);

  useEffect(() => {
    if (localSaveFeedback?.tone !== "success") return undefined;

    const feedback = localSaveFeedback;
    const timeoutId = globalThis.setTimeout(() => {
      setLocalSaveFeedback((currentFeedback) =>
        currentFeedback === feedback ? null : currentFeedback
      );
    }, 4500);

    return () => globalThis.clearTimeout(timeoutId);
  }, [localSaveFeedback]);

  useEffect(
    () => () => {
      if (preview?.startsWith("blob:")) {
        URL.revokeObjectURL(preview);
      }
    },
    [preview],
  );

  useEffect(() => {
    let cancelled = false;

    if (!ownerUserId) {
      return undefined;
    }

    countSavedPhotosByOwner(ownerUserId)
      .then((count) => {
        if (!cancelled) {
          setSavedPhotoSummary({
            ownerUserId,
            status: "ready",
            count,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSavedPhotoSummary({
            ownerUserId,
            status: "unavailable",
            count: null,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ownerUserId]);

  useEffect(() => {
    if (!isLiveCameraVisible) return undefined;

    const body = document.body;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    body.classList.add("camera-scroll-locked");

    const focusFrame = window.requestAnimationFrame(() => {
      cameraSectionRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      cameraSectionRef.current?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      body.classList.remove("camera-scroll-locked");
    };
  }, [isLiveCameraVisible]);

  useEffect(() => {
    if (cameraActive || !restoreCameraTriggerFocusRef.current) return;

    restoreCameraTriggerFocusRef.current = false;
    const focusTrigger = window.requestAnimationFrame(() => {
      openCameraButtonRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(focusTrigger);
  }, [cameraActive]);

  const resetZoom = () => {
    setZoom(1);
  };

  const zoomIn = () => {
    setZoom((previous) =>
      Math.min(Number((previous + ZOOM_STEP).toFixed(1)), MAX_ZOOM),
    );
  };

  const zoomOut = () => {
    setZoom((previous) =>
      Math.max(Number((previous - ZOOM_STEP).toFixed(1)), MIN_ZOOM),
    );
  };

  const resetLocationStatus = () => {
    setLocationStatus("idle");
  };

  const resetResultLocationEditor = () => {
    setIsEditingResultLocation(false);
    setResultLocationDraft("");
    setIsSavingResultLocation(false);
    setResultLocationEditError("");
  };

  const switchMode = (selectedMode) => {
    restoreCameraTriggerFocusRef.current = false;
    stopCamera();
    clearPreviewUrl();
    invalidateSavedPhotoLocationPrefetch();

    setMode(selectedMode);
    setFile(null);
    setPreview("");
    setCaptureMetadata(createEmptyCaptureMetadata(selectedMode));
    setResult(null);
    setError("");
    setLoading(false);
    resetLocationStatus();
    setResultImageErrors({});
    setLoadedResultImages({});
    resetZoom();

    if (galleryRef.current) {
      galleryRef.current.value = "";
    }
  };

  const openCamera = async () => {
    restoreCameraTriggerFocusRef.current = false;
    stopCamera();
    const requestId = cameraRequestIdRef.current;

    setError("");
    setResult(null);
    setIsOpeningCamera(true);
    clearPreviewUrl();
    invalidateSavedPhotoLocationPrefetch();
    setFile(null);
    setPreview("");
    setCaptureMetadata(createEmptyCaptureMetadata("camera"));
    resetLocationStatus();
    resetZoom();

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "Browser ini belum mendukung kamera langsung. Gunakan mode Galeri.",
      );
      setIsOpeningCamera(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: {
            ideal: "environment",
          },
          width: {
            ideal: 1280,
          },
          height: {
            ideal: 720,
          },
        },
        audio: false,
      });

      if (
        !isMountedRef.current ||
        requestId !== cameraRequestIdRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      cameraStreamRef.current = stream;
      setCameraActive(true);
      setIsOpeningCamera(false);

      window.requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {
            if (cameraStreamRef.current !== stream) return;

            stopCamera();
            setError(
              "Preview kamera gagal dimulai. Tutup aplikasi kamera lain lalu coba kembali.",
            );
          });
        }
      });
    } catch (cameraError) {
      if (
        !isMountedRef.current ||
        requestId !== cameraRequestIdRef.current
      ) {
        return;
      }

      setCameraActive(false);
      setIsOpeningCamera(false);

      const message =
        cameraError?.name === "NotAllowedError"
          ? "Akses kamera ditolak. Izinkan kamera pada pengaturan browser."
          : "Kamera tidak dapat dibuka. Pastikan perangkat memiliki kamera dan halaman dibuka melalui HTTPS atau localhost.";

      setError(message);
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas) {
      setError("Kamera belum siap digunakan.");
      return;
    }

    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;

    if (!videoWidth || !videoHeight) {
      setError("Kamera masih memuat. Tunggu sebentar lalu coba lagi.");
      return;
    }

    canvas.width = videoWidth;
    canvas.height = videoHeight;

    const context = canvas.getContext("2d");

    if (!context) {
      setError("Gagal memproses hasil kamera.");
      return;
    }

    /*
      Zoom mengikuti perilaku V2:
      video diperbesar secara visual dan hasil capture juga dicrop
      ke bagian tengah sesuai nilai zoom.
    */
    const cropWidth = videoWidth / zoom;
    const cropHeight = videoHeight / zoom;
    const cropX = (videoWidth - cropWidth) / 2;
    const cropY = (videoHeight - cropHeight) / 2;

    context.drawImage(
      video,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      videoWidth,
      videoHeight,
    );

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const capturedFile = dataUrlToFile(dataUrl, `foto-sawit-${Date.now()}.jpg`);

    clearPreviewUrl();

    setFile(capturedFile);
    setPreview(URL.createObjectURL(capturedFile));
    setCaptureMetadata(createCaptureMetadata("camera"));
    startSavedPhotoLocationPrefetch(capturedFile);
    setResult(null);
    setError("");
    resetLocationStatus();

    restoreCameraTriggerFocusRef.current = false;
    stopCamera();
  };

  const closeCamera = () => {
    restoreCameraTriggerFocusRef.current = true;
    stopCamera();
  };

  const retakePhoto = async () => {
    clearPreviewUrl();
    invalidateSavedPhotoLocationPrefetch();

    setFile(null);
    setPreview("");
    setCaptureMetadata(createEmptyCaptureMetadata(mode));
    setResult(null);
    setError("");
    resetLocationStatus();
    resetZoom();

    if (mode === "camera") {
      await openCamera();
    }
  };

  const chooseFile = (event) => {
    const selected = event.target.files?.[0];

    if (!selected) {
      return;
    }

    if (!selected.type.startsWith("image/")) {
      setError("File yang dipilih harus berupa gambar.");
      event.target.value = "";
      return;
    }

    if (selected.size > 16 * 1024 * 1024) {
      setError("Ukuran gambar maksimal 16 MB.");
      event.target.value = "";
      return;
    }

    stopCamera();
    clearPreviewUrl();

    setFile(selected);
    setPreview(URL.createObjectURL(selected));
    setCaptureMetadata(createCaptureMetadata("gallery"));
    startSavedPhotoLocationPrefetch(selected);
    setResult(null);
    setError("");
    resetLocationStatus();
    resetZoom();
  };

  const openGallery = () => {
    galleryRef.current?.click();
  };

  const resetInput = () => {
    stopCamera();
    clearPreviewUrl();
    invalidateSavedPhotoLocationPrefetch();

    setFile(null);
    setPreview("");
    setCaptureMetadata(createEmptyCaptureMetadata(mode));
    setResult(null);
    setError("");
    setLoading(false);
    setIsPreparingLocation(false);
    resetLocationStatus();
    resetResultLocationEditor();
    resetResultMetadata();
    resetZoom();

    if (galleryRef.current) {
      galleryRef.current.value = "";
    }
  };

  const submitPrediction = async (location = null) => {
    resetResultLocationEditor();
    resetResultMetadata();
    setLoading(true);
    setError("");
    setResult(null);
    setResultImageErrors({});
    setLoadedResultImages({});

    try {
      const response = await predictPalmImage(file, source, location);
      setResult(response);
      setResultMetadataStatus(
        response?.record_id || response?.result?.record_id
          ? "pending"
          : "idle",
      );
    } catch (requestError) {
      if (requestError?.status === 413) {
        setError("Ukuran atau resolusi foto terlalu besar untuk diproses.");
      } else if (requestError?.status === 422) {
        setError("File yang dipilih bukan foto yang valid.");
      } else {
        setError(
          requestError.message || "Klasifikasi gagal. Silakan coba kembali.",
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const runPrediction = async () => {
    if (!file) {
      setError("Ambil atau pilih gambar buah sawit terlebih dahulu.");
      return;
    }

    if (serverActionsUnavailable) {
      setError(
        definitelyOffline
          ? "Prediksi memerlukan koneksi internet."
          : "Koneksi server belum tersedia.",
      );
      return;
    }

    const predictionFile = file;

    setIsPreparingLocation(true);
    setError("");
    setResult(null);
    setLocationStatus("requesting");

    let predictionLocation = null;

    try {
      const locationResult = await getLocationForPhoto(
        predictionFile,
        { retryResolvedFailure: true },
      );
      setLocationStatus(locationResult.status);

      if (locationResult.location) {
        let autoName = "";
        setLocationStatus("resolving");

        try {
          const geocodingResult = await reverseGeocodeLocation(
            locationResult.location.latitude,
            locationResult.location.longitude,
          );
          if (geocodingResult?.success) {
            autoName = String(
              geocodingResult?.location?.auto_name || "",
            ).trim();
          }
        } catch {
          autoName = "";
        }

        predictionLocation = {
          ...locationResult.location,
          autoName,
          label: autoName,
        };
        setLocationStatus("available");
      }
    } catch {
      setLocationStatus("unavailable");
    } finally {
      setIsPreparingLocation(false);
    }

    await submitPrediction(predictionLocation);
  };

  const savePhotoLocally = async () => {
    if (localSaveLockRef.current) {
      return;
    }

    if (!ownerUserId) {
      setLocalSaveFeedback({
        file,
        ownerUserId,
        tone: "error",
        message: "Sesi pengguna tidak tersedia. Silakan masuk kembali.",
      });
      return;
    }

    if (!file || !captureMetadata.capturedAt) {
      setLocalSaveFeedback({
        file,
        ownerUserId,
        tone: "error",
        message: "Ambil atau pilih gambar buah sawit terlebih dahulu.",
      });
      return;
    }

    localSaveLockRef.current = true;
    setIsSavingPhoto(true);
    setLocalSaveFeedback(null);

    const fileToSave = file;
    const captureMetadataToSave = captureMetadata;

    try {
      let savedLocation = null;

      try {
        const locationResult = await getLocationForPhoto(fileToSave);

        if (locationResult.ok && locationResult.location) {
          savedLocation = {
            ...locationResult.location,
            autoName: null,
            label: null,
          };
        }
      } catch {
        savedLocation = null;
      }

      await saveSavedPhoto(
        createSavedPhotoRecord({
          file: fileToSave,
          ownerUserId,
          captureMetadata: captureMetadataToSave,
          location: savedLocation,
        }),
      );

      if (isMountedRef.current) {
        setLocalSaveFeedback({
          file: fileToSave,
          ownerUserId,
          tone: "success",
          message: "Foto berhasil disimpan di perangkat.",
        });

        try {
          const count = await countSavedPhotosByOwner(ownerUserId);

          if (isMountedRef.current) {
            setSavedPhotoSummary({
              ownerUserId,
              status: "ready",
              count,
            });
          }
        } catch {
          if (isMountedRef.current) {
            setSavedPhotoSummary({
              ownerUserId,
              status: "unavailable",
              count: null,
            });
          }
        }
      }
    } catch (saveError) {
      if (isMountedRef.current) {
        setLocalSaveFeedback({
          file: fileToSave,
          ownerUserId,
          tone: "error",
          message: getLocalSaveErrorMessage(saveError),
        });
      }
    } finally {
      localSaveLockRef.current = false;

      if (isMountedRef.current) {
        setIsSavingPhoto(false);
      }
    }
  };

  const startEditingResultLocation = () => {
    setResultLocationDraft(
      resultLocationLabel || resultLocationAutoName || "",
    );
    setResultLocationEditError("");
    setIsEditingResultLocation(true);
  };

  const cancelEditingResultLocation = () => {
    if (resultLocationSaveRef.current) {
      return;
    }

    setResultLocationDraft("");
    setResultLocationEditError("");
    setIsEditingResultLocation(false);
  };

  const saveResultLocation = async (event) => {
    event.preventDefault();

    if (!resultRecordId || resultLocationSaveRef.current) {
      return;
    }

    resultLocationSaveRef.current = true;
    setIsSavingResultLocation(true);
    setResultLocationEditError("");

    try {
      const response = await updatePredictionLocationLabel(
        resultRecordId,
        resultLocationDraft,
      );
      const updatedLocation = response?.location || {};

      const updateLocation = (payload) => ({
        ...payload,
        location: {
          ...(payload?.location || {}),
          auto_name: Object.hasOwn(updatedLocation, "auto_name")
            ? updatedLocation.auto_name
            : payload?.location?.auto_name ?? null,
          label: Object.hasOwn(updatedLocation, "label")
            ? updatedLocation.label
            : payload?.location?.label ?? null,
        },
      });

      setResult((current) => {
        if (current?.result && typeof current.result === "object") {
          return {
            ...current,
            result: updateLocation(current.result),
          };
        }

        return updateLocation(current);
      });
      setResultLocationDraft("");
      setIsEditingResultLocation(false);
    } catch (requestError) {
      setResultLocationEditError(
        requestError.message || "Nama lokasi gagal disimpan.",
      );
    } finally {
      resultLocationSaveRef.current = false;
      setIsSavingResultLocation(false);
    }
  };

  const saveResultMetadata = async (event) => {
    event.preventDefault();

    if (
      !canNameResult
      || isSavingResultMetadata
      || serverActionsUnavailable
    ) {
      return;
    }

    const normalizedTitle = resultMetadataTitle.trim();
    if (!normalizedTitle) {
      setResultMetadataError(
        "Isi judul prediksi atau pilih Lewati.",
      );
      return;
    }

    setIsSavingResultMetadata(true);
    setResultMetadataError("");

    try {
      const response = await updatePredictionMetadata(resultRecordId, {
        title: normalizedTitle,
        description: resultMetadataDescription,
      });
      const metadata = response?.metadata || {};

      const updateMetadata = (payload) => ({
        ...payload,
        title: metadata.title ?? normalizedTitle,
        description: metadata.description ?? null,
      });

      setResult((current) => {
        if (current?.result && typeof current.result === "object") {
          return {
            ...current,
            result: updateMetadata(current.result),
          };
        }

        return updateMetadata(current);
      });
      setResultMetadataTitle(metadata.title ?? normalizedTitle);
      setResultMetadataDescription(metadata.description ?? "");
      setResultMetadataStatus("saved");
    } catch (requestError) {
      setResultMetadataError(
        requestError.message || "Judul prediksi gagal disimpan.",
      );
    } finally {
      setIsSavingResultMetadata(false);
    }
  };

  const skipResultMetadata = () => {
    if (isSavingResultMetadata) return;

    setResultMetadataError("");
    setResultMetadataStatus("skipped");
  };

  return (
    <main
      className={`prediction-v2-page${isLiveCameraVisible ? " is-camera-live" : ""}`}
    >
      <PageHeader
        className="prediction-v2-hero"
        eyebrow="Pemeriksaan Lapangan"
        title="Cek Kematangan Sawit"
        description="Ambil foto atau pilih gambar untuk memeriksa tingkat kematangan tandan buah segar."
      />

      <Card
        className={`prediction-v2-saved-count${
          savedPhotoCountUnavailable ? " is-unavailable" : ""
        }`}
      >
        <div className="prediction-v2-saved-count-icon" aria-hidden="true">
          <Icon name="folder" size={25} />
        </div>
        <div className="prediction-v2-saved-count-copy">
          <div className="prediction-v2-saved-count-heading">
            <b>Foto Tersimpan</b>
            <Badge
              tone={savedPhotoCountUnavailable ? "warning" : "success"}
              aria-hidden="true"
            >
              {isSavedPhotoCountLoading
                ? "..."
                : savedPhotoCountUnavailable
                  ? "Tidak tersedia"
                  : savedPhotoCount ?? 0}
            </Badge>
          </div>
          <p>Tempat menyimpan foto untuk diprediksi nanti.</p>
          <span
            className="prediction-v2-saved-count-status"
            role="status"
            aria-live="polite"
          >
            {isSavedPhotoCountLoading
              ? "Menghitung foto tersimpan..."
              : savedPhotoCountUnavailable
                ? "Penyimpanan lokal tidak tersedia di perangkat ini."
                : `${savedPhotoCount ?? 0} foto tersimpan di perangkat`}
          </span>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onOpenSavedPhotos}
          disabled={savedPhotoCountUnavailable}
        >
          Buka Foto Tersimpan
        </Button>
      </Card>

      <SegmentedControl
        className="prediction-v2-mode-switch"
        label="Pilih sumber gambar"
        value={mode}
        onChange={switchMode}
        disabled={isBusy}
        options={[
          { value: "camera", label: "Kamera", icon: <Icon name="camera" /> },
          { value: "gallery", label: "Galeri", icon: <Icon name="gallery" /> },
        ]}
      />

      <Card className="prediction-v2-tips-card" variant="subtle">
        <Icon name="info" size={20} />
        <div>
          <b>Tips foto terbaik</b>
          <p>
            Pastikan TBS terlihat utuh, cahaya cukup, dan objek berada di area
            panduan.
          </p>
        </div>
      </Card>

      <Card
        ref={cameraSectionRef}
        className="prediction-v2-camera-card"
        tabIndex={-1}
        role="region"
        aria-label={isLiveCameraVisible ? "Kamera aktif" : "Pengambilan gambar"}
      >
        <div className="prediction-v2-camera-frame">
          {!preview ? (
            mode === "camera" ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="prediction-v2-camera-media"
                  style={{
                    transform: `scale(${zoom})`,
                  }}
                />

                {!cameraActive && (
                  <div className="prediction-v2-camera-placeholder">
                    <Icon name="camera" size={36} />
                    <p>
                      {isOpeningCamera
                        ? "Membuka kamera..."
                        : "Kamera belum aktif"}
                    </p>
                  </div>
                )}

                <div className="prediction-v2-camera-guide" />

                <div className="prediction-v2-zoom-badge">
                  {zoom.toFixed(1)}x
                </div>
              </>
            ) : (
              <div className="prediction-v2-gallery-placeholder">
                <Icon name="gallery" size={36} />
                <p>Belum ada foto dipilih</p>
              </div>
            )
          ) : (
            <img
              src={preview}
              alt="Hasil input buah kelapa sawit"
              className="prediction-v2-camera-media"
            />
          )}
        </div>

        {mode === "camera" && !preview && (
          <div className="prediction-v2-zoom-panel">
            <IconButton
              type="button"
              onClick={zoomOut}
              disabled={!cameraActive || zoom <= MIN_ZOOM}
              aria-label="Perkecil zoom"
            >
              <Icon name="minus" />
            </IconButton>

            <div className="prediction-v2-zoom-info">
              <span>Zoom</span>
              <b>{zoom.toFixed(1)}x</b>
            </div>

            <IconButton
              type="button"
              onClick={zoomIn}
              disabled={!cameraActive || zoom >= MAX_ZOOM}
              aria-label="Perbesar zoom"
            >
              <Icon name="plus" />
            </IconButton>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="prediction-v2-reset-zoom"
              onClick={resetZoom}
              disabled={!cameraActive || zoom === 1}
            >
              Reset
            </Button>
          </div>
        )}

        {!preview && (mode === "camera" ? (
          <div className="prediction-v2-button-grid">
            {!cameraActive ? (
              <Button
                ref={openCameraButtonRef}
                type="button"
                variant="secondary"
                onClick={openCamera}
                disabled={isBusy || isOpeningCamera}
              >
                {isOpeningCamera ? "Membuka..." : "Buka Kamera"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="danger"
                onClick={closeCamera}
                disabled={isBusy}
              >
                Tutup Kamera
              </Button>
            )}

            <Button
              type="button"
              variant="primary"
              onClick={capturePhoto}
              disabled={!cameraActive || isBusy}
            >
              Ambil Gambar
            </Button>
          </div>
        ) : (
          <div className="prediction-v2-button-grid">
            <Button
              type="button"
              variant="secondary"
              onClick={resetInput}
              disabled={isBusy}
            >
              Reset
            </Button>

            <Button
              type="button"
              variant="secondary"
              onClick={openGallery}
              disabled={isBusy}
            >
              {preview ? "Ganti Foto" : "Pilih Foto"}
            </Button>
          </div>
        ))}

        {preview && (
          <>
            <div className="prediction-v2-preview-actions">
              <div className="prediction-v2-preview-action">
                <Button
                  type="button"
                  variant="primary"
                  onClick={runPrediction}
                  disabled={isBusy || serverActionsUnavailable}
                >
                  {loading
                    ? "Menganalisis..."
                    : isPreparingLocation
                      ? "Menyiapkan lokasi..."
                      : "Mulai Prediksi"}
                </Button>
                {serverActionsUnavailable && (
                  <small
                    className="prediction-v2-action-note is-warning"
                    role="status"
                  >
                    {definitelyOffline
                      ? "Prediksi memerlukan koneksi internet."
                      : "Koneksi server belum tersedia."}
                  </small>
                )}
              </div>

              <div className="prediction-v2-preview-action">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={savePhotoLocally}
                  disabled={isBusy}
                  aria-busy={isSavingPhoto}
                >
                  {isSavingPhoto ? "Menyimpan..." : "Simpan Foto"}
                </Button>
                <small className="prediction-v2-action-note">
                  Foto akan disimpan sementara di perangkat dan dapat diprediksi
                  nanti melalui Foto Tersimpan.
                </small>
              </div>

              <div className="prediction-v2-preview-action">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={mode === "camera" ? retakePhoto : openGallery}
                  disabled={isBusy}
                >
                  {mode === "camera" ? "Foto Ulang" : "Ganti Foto"}
                </Button>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              block
              onClick={resetInput}
              disabled={isBusy}
            >
              Reset
            </Button>
          </>
        )}

        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          onChange={chooseFile}
          hidden
        />

        <canvas ref={canvasRef} hidden />

        {file && (
          <div className="prediction-v2-file-info">
            <span>{file.name}</span>
            <b>{(file.size / 1024 / 1024).toFixed(2)} MB</b>
          </div>
        )}

        {visibleLocalSaveFeedback?.tone === "error" && (
          <Alert
            tone="error"
            role="alert"
          >
            {visibleLocalSaveFeedback.message}
          </Alert>
        )}

        {visibleLocalSaveFeedback?.tone === "success" && (
          <div
            className="prediction-v2-save-toast"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <Icon name="check" size={22} />
            <div>
              <strong>Foto berhasil disimpan.</strong>
              <span>Tersedia di Foto Tersimpan.</span>
            </div>
          </div>
        )}

        <div className="prediction-v2-location-note" role="note">
          <Icon name="location" size={21} />
          <div>
            <b className="prediction-v2-location-title">
              Lokasi Pengambilan
            </b>
            <p>
              Lokasi opsional mulai disiapkan saat foto tersedia dan akan
              disimpan bersama foto jika berhasil diperoleh.
            </p>
            {locationStatus !== "idle" && (
              <small
                className={`is-${locationStatus}`}
                role="status"
                aria-live="polite"
              >
                {LOCATION_STATUS_TEXT[locationStatus]}
              </small>
            )}
          </div>
        </div>

        {error && <Alert tone="error" role="alert">{error}</Alert>}
      </Card>

      {loading && (
        <LoadingState
          className="prediction-v2-loading-card"
          title="Memproses foto..."
          description="Mendeteksi TBS dan memeriksa tingkat kematangannya."
        />
      )}

      {result && (
        <section
          className={`prediction-v2-result-card prediction-v2-result-${resultClass}`}
        >
          <div className="prediction-v2-section-heading">
            <p className="prediction-v2-result-label">Hasil Analisis</p>
            <h2>Gambar Hasil Deteksi</h2>
          </div>

          <figure className="prediction-v2-result-figure">
            {resultImageSource ? (
              <div
                className={`prediction-v2-result-image-wrap${
                  resultImageLoading ? " is-loading" : ""
                }`}
              >
                {resultImageLoading && (
                  <div className="prediction-v2-image-loading" role="status">
                    <div className="prediction-v2-spinner" />
                    <span>Memuat gambar hasil...</span>
                  </div>
                )}

                <img
                  src={resultImageSource}
                  alt={
                    resultImageIsProcessed
                      ? "Hasil deteksi TBS dengan bounding box dan label kematangan"
                      : "Gambar TBS yang dianalisis"
                  }
                  className="prediction-v2-result-image"
                  onLoad={() =>
                    setLoadedResultImages((current) => ({
                      ...current,
                      [resultImageSource]: true,
                    }))
                  }
                  onError={() =>
                    setResultImageErrors((current) => ({
                      ...current,
                      [resultImageSource]: true,
                    }))
                  }
                />
              </div>
            ) : (
              <div className="prediction-v2-result-image-empty">
                Gambar hasil tidak dapat ditampilkan.
              </div>
            )}

            <figcaption>
              {resultImageIsProcessed
                ? "Bounding box dan label kematangan dibuat oleh sistem analisis."
                : "Gambar anotasi tidak tersedia; menampilkan gambar asli sebagai fallback."}
            </figcaption>
          </figure>

          {hasDetectionContract && (
            <section
              className="prediction-v2-detection-summary"
              aria-labelledby="detection-summary-title"
            >
              <div className="prediction-v2-section-heading">
                <p className="prediction-v2-result-label">Ringkasan Deteksi</p>
                <h2 id="detection-summary-title">TBS pada Gambar</h2>
              </div>

              <div className="prediction-v2-total-detections">
                <span>Total TBS terdeteksi</span>
                <b>{detectionSummary.total}</b>
              </div>

              <div className="prediction-v2-count-grid">
                {Object.entries(CLASS_INFO).map(([key, classInfo]) => (
                  <div
                    className={`prediction-v2-count-card prediction-v2-count-${key}`}
                    key={key}
                  >
                    <span>{classInfo.label}</span>
                    <b>{detectionSummary.byClass[key]}</b>
                  </div>
                ))}
              </div>
            </section>
          )}

          {isZeroDetection ? (
            <div className="prediction-v2-zero-state" role="status">
              <h2>Tidak ada TBS yang terdeteksi pada gambar.</h2>
              <p>
                Ambil gambar lebih dekat, pastikan TBS terlihat jelas, dan
                gunakan pencahayaan yang lebih baik sebelum mencoba kembali.
              </p>
            </div>
          ) : (
            <section
              className="prediction-v2-image-summary"
              aria-labelledby="image-summary-title"
            >
              <div className="prediction-v2-result-top">
                <div className="prediction-v2-result-icon" aria-hidden="true">
                  <Icon name="check" size={24} />
                </div>

                <div>
                  <p className="prediction-v2-result-label">
                    Ringkasan Kematangan Gambar
                  </p>
                  <h2 id="image-summary-title">{info.label}</h2>
                </div>
              </div>

              <Badge tone={resultClass === "terlalu_masak" ? "warning" : "success"}>
                {info.status}
              </Badge>

              <div className="prediction-v2-confidence-box">
                <span>Keyakinan ringkasan kematangan</span>
                <b>{confidence.toFixed(2)}%</b>
                <small>
                  Rata-rata keyakinan kematangan untuk kelas mayoritas pada
                  gambar.
                </small>
              </div>

              <div className="prediction-v2-recommendation-box">
                <b>Keterangan</b>
                <p>{info.description}</p>
              </div>

              <div className="prediction-v2-recommendation-box">
                <b>Saran</b>
                <p>{info.recommendation}</p>
              </div>

              <div className="prediction-v2-prob-list">
                {Object.entries(CLASS_INFO).map(([key, classInfo]) => {
                  const percent = toPercent(probabilities[key]);

                  return (
                    <div className="prediction-v2-prob-bar-item" key={key}>
                      <div className="prediction-v2-prob-bar-top">
                        <span>
                          {classInfo.label}
                        </span>
                        <b>{percent.toFixed(2)}%</b>
                      </div>

                      <div className="prediction-v2-prob-track">
                        <div
                          className="prediction-v2-prob-fill"
                          style={{
                            width: `${Math.min(Math.max(percent, 0), 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {canNameResult && resultMetadataStatus !== "skipped" && (
            <section
              className="prediction-v2-result-metadata"
              aria-labelledby="prediction-result-metadata-title"
            >
              <div className="prediction-v2-section-heading">
                <p className="prediction-v2-result-label">Identitas Riwayat</p>
                <h2 id="prediction-result-metadata-title">
                  Beri nama hasil ini
                </h2>
              </div>

              {resultMetadataStatus === "saved" ? (
                <Alert tone="success" role="status">
                  Judul “{resultMetadataTitle}” berhasil disimpan.
                </Alert>
              ) : (
                <form
                  className="prediction-v2-result-metadata-form"
                  onSubmit={saveResultMetadata}
                >
                  <p>
                    Berikan nama agar hasil mudah ditemukan di Riwayat.
                  </p>
                  <label htmlFor="prediction-result-metadata-title-input">
                    Judul prediksi
                  </label>
                  <input
                    id="prediction-result-metadata-title-input"
                    type="text"
                    maxLength={120}
                    value={resultMetadataTitle}
                    onChange={(event) => {
                      setResultMetadataTitle(event.target.value);
                      setResultMetadataError("");
                    }}
                    placeholder="Contoh: Lahan A - Pohon 12"
                    disabled={isSavingResultMetadata}
                  />
                  <label htmlFor="prediction-result-metadata-description">
                    Catatan <span>(opsional)</span>
                  </label>
                  <textarea
                    id="prediction-result-metadata-description"
                    maxLength={500}
                    rows={3}
                    value={resultMetadataDescription}
                    onChange={(event) => {
                      setResultMetadataDescription(event.target.value);
                      setResultMetadataError("");
                    }}
                    placeholder="Tambahkan informasi singkat tentang hasil ini."
                    disabled={isSavingResultMetadata}
                  />
                  {resultMetadataError && (
                    <Alert tone="error" role="alert">
                      {resultMetadataError}
                    </Alert>
                  )}
                  <div className="prediction-v2-result-metadata-actions">
                    <Button
                      type="submit"
                      disabled={
                        isSavingResultMetadata
                        || serverActionsUnavailable
                      }
                    >
                      {isSavingResultMetadata
                        ? "Menyimpan..."
                        : "Simpan judul"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={skipResultMetadata}
                      disabled={isSavingResultMetadata}
                    >
                      Lewati
                    </Button>
                  </div>
                </form>
              )}
            </section>
          )}

          <section
            className="prediction-v2-result-location"
            aria-labelledby="prediction-location-result-title"
          >
            <div className="prediction-v2-section-heading">
              <p className="prediction-v2-result-label">Metadata Lokasi</p>
              <h2 id="prediction-location-result-title">
                Lokasi Pengambilan
              </h2>
            </div>

            {isEditingResultLocation ? (
              <form
                className="prediction-v2-result-location-editor"
                onSubmit={saveResultLocation}
              >
                <label htmlFor="prediction-result-location-label">
                  Nama Lokasi
                </label>
                <input
                  id="prediction-result-location-label"
                  type="text"
                  maxLength={500}
                  value={resultLocationDraft}
                  onChange={(event) =>
                    setResultLocationDraft(event.target.value)
                  }
                  placeholder="Contoh: Blok 3 Afdeling Selatan"
                  disabled={isSavingResultLocation}
                  autoFocus
                />
                <p>
                  Nama lokasi dapat disesuaikan dengan nama kebun, blok,
                  afdeling, atau penyebutan lokasi di lapangan. Mengubah nama
                  tidak mengubah titik koordinat.
                </p>
                {!hasResultLocation && (
                  <p className="prediction-v2-result-location-manual-note">
                    Nama manual ini tidak memiliki koordinat GPS.
                  </p>
                )}
                {resultLocationEditError && (
                  <p
                    className="prediction-v2-result-location-edit-error"
                    role="alert"
                  >
                    {resultLocationEditError}
                  </p>
                )}
                <div>
                  <button
                    type="submit"
                    disabled={isSavingResultLocation}
                  >
                    {isSavingResultLocation ? "Menyimpan..." : "Simpan"}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditingResultLocation}
                    disabled={isSavingResultLocation}
                  >
                    Batal
                  </button>
                </div>
              </form>
            ) : (
              <div className="prediction-v2-result-location-name-row">
                <div className="prediction-v2-result-location-name">
                  <Icon name="location" size={22} />
                  <div>
                    <small>Lokasi</small>
                    <strong>{resultLocationName}</strong>
                  </div>
                </div>

                {canUpdateResultLocation && (
                  <button
                    type="button"
                    className="prediction-v2-result-location-edit-button"
                    onClick={startEditingResultLocation}
                  >
                    <Icon name="edit" size={17} />
                    {resultLocationLabel || resultLocationAutoName
                      ? "Edit Nama Lokasi"
                      : "Tambah Nama Lokasi"}
                  </button>
                )}
              </div>
            )}

            {hasResultLocation ? (
              <>
                <div className="prediction-v2-result-location-grid">
                  {showResultAutoName && (
                    <div className="is-auto-name">
                      <small>Perkiraan wilayah</small>
                      <strong>{resultLocationAutoName}</strong>
                    </div>
                  )}
                  <div>
                    <small>Koordinat</small>
                    <strong>
                      {resultLatitude.toFixed(6)}, {resultLongitude.toFixed(6)}
                    </strong>
                  </div>
                  <div>
                    <small>Akurasi</small>
                    <strong>
                      {resultAccuracyQuality
                        ? `±${resultAccuracyQuality.accuracy.toFixed(1)} m`
                        : "Tidak tersedia"}
                    </strong>
                    {resultAccuracyQuality && (
                      <span
                        className={`prediction-v2-location-quality is-${resultAccuracyQuality.level}`}
                      >
                        {resultAccuracyQuality.label}
                      </span>
                    )}
                  </div>
                </div>

                {resultAccuracyQuality?.level === "low" && (
                  <p className="prediction-v2-location-precision-note">
                    Posisi perangkat kurang presisi. Periksa titik pada peta.
                  </p>
                )}

                <a
                  className="prediction-v2-location-map-link"
                  href={resultLocationMapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="map" size={18} />
                  Lihat di Peta
                  <Icon name="external" size={16} />
                </a>
              </>
            ) : (
              <p className="prediction-v2-result-location-empty">
                Lokasi GPS tidak tersedia.
              </p>
            )}
          </section>

          <div className="prediction-v2-scan-meta">
            <span><Icon name="calendar" size={16} /> {new Date().toLocaleDateString("id-ID")}</span>
            <span><Icon name={source === "camera" ? "camera" : "gallery"} size={16} /> {source === "camera" ? "Kamera" : "Galeri"}</span>
          </div>

          {detections.length > 0 && (
            <section
              className="prediction-v2-detection-details"
              aria-labelledby="detection-details-title"
            >
              <div className="prediction-v2-section-heading">
                <p className="prediction-v2-result-label">Detail Per Objek</p>
                <h2 id="detection-details-title">Hasil Setiap TBS</h2>
              </div>

              <div className="prediction-v2-detection-grid">
                {detections.map((detection, index) => {
                  const detectionClass = normalizeClassName(
                    detection?.predicted_class,
                  );
                  const maturityConfidence = toPercent(
                    detection?.maturity_confidence,
                  );
                  const detectorConfidence = toPercent(
                    detection?.detector_confidence,
                  );
                  const detectionProbabilities = detection?.probabilities;
                  const bbox = Array.isArray(detection?.bbox)
                    ? detection.bbox
                    : null;

                  return (
                    <article
                      className={`prediction-v2-detection-card prediction-v2-detection-${detectionClass}`}
                      key={`${bbox?.join("-") || "tbs"}-${index}`}
                    >
                      <div className="prediction-v2-detection-card-head">
                        <h3>TBS {index + 1}</h3>
                        <span>{formatClassLabel(detectionClass)}</span>
                      </div>

                      <dl className="prediction-v2-detection-metrics">
                        <div>
                          <dt>Keyakinan Kematangan</dt>
                          <dd>{maturityConfidence.toFixed(2)}%</dd>
                        </div>
                        <div>
                          <dt>Keyakinan Deteksi</dt>
                          <dd>{detectorConfidence.toFixed(2)}%</dd>
                        </div>
                      </dl>

                      {(detectionProbabilities || bbox) && (
                        <details className="prediction-v2-detection-disclosure">
                          <summary>Lihat rincian TBS</summary>
                          {detectionProbabilities &&
                            typeof detectionProbabilities === "object" && (
                              <div className="prediction-v2-detection-probs">
                                {Object.entries(CLASS_INFO).map(
                                  ([key, classInfo]) => (
                                    <div key={key}>
                                      <span>{classInfo.label}</span>
                                      <b>
                                        {toPercent(
                                          detectionProbabilities[key],
                                        ).toFixed(2)}
                                        %
                                      </b>
                                    </div>
                                  ),
                                )}
                              </div>
                            )}
                          {bbox && (
                            <div className="prediction-v2-bbox-details">
                              <span>Koordinat bounding box</span>
                              <code>[{bbox.join(", ")}]</code>
                            </div>
                          )}
                        </details>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {warnings.length > 0 && (
            <aside className="prediction-v2-warning-box" role="status">
              <b>Catatan pemrosesan</b>
              <ul>
                {warnings.map((warning, index) => (
                  <li key={`${formatWarning(warning)}-${index}`}>
                    {formatWarning(warning)}
                  </li>
                ))}
              </ul>
              <small>
                Prediksi tetap berhasil; catatan ini hanya berlaku untuk
                kandidat yang tidak dapat diproses sepenuhnya.
              </small>
            </aside>
          )}

          <div className="prediction-v2-result-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={resetInput}
              disabled={
                isSavingResultLocation || isSavingResultMetadata
              }
            >
              Periksa gambar lain
            </Button>

            <Button
              type="button"
              variant="primary"
              onClick={onOpenHistory}
              disabled={
                isSavingResultLocation || isSavingResultMetadata
              }
            >
              Lihat riwayat
            </Button>
          </div>
        </section>
      )}
    </main>
  );
}

export default PredictionPage;
