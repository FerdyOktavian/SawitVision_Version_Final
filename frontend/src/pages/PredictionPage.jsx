import { useEffect, useMemo, useRef, useState } from "react";
import {
  predictPalmImage,
  reverseGeocodeLocation,
  updatePredictionLocationLabel,
} from "../services/api";
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
const GEOLOCATION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 60000,
};

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

async function captureOptionalLocation() {
  if (
    typeof navigator === "undefined" ||
    !navigator.geolocation?.getCurrentPosition
  ) {
    return { location: null, status: "unsupported" };
  }

  const requestPosition = () =>
    new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ position, error: null }),
        (error) => resolve({ position: null, error }),
        GEOLOCATION_OPTIONS,
      );
    });

  try {
    let result = await requestPosition();

    // A newly granted permission can finish before a cold GPS fix is ready.
    // Retry transient failures once within the same prediction attempt.
    if (!result.position && [2, 3].includes(result.error?.code)) {
      result = await requestPosition();
    }

    if (result.position) {
      return {
        location: {
          latitude: result.position.coords.latitude,
          longitude: result.position.coords.longitude,
          accuracy: result.position.coords.accuracy,
          capturedAt: new Date().toISOString(),
        },
        status: "available",
      };
    }

    return {
      location: null,
      status: result.error?.code === 1
        ? "denied"
        : result.error?.code === 3
          ? "timeout"
          : "unavailable",
    };
  } catch {
    return { location: null, status: "unavailable" };
  }
}

function PredictionPage({ onOpenHistory }) {
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

  const [mode, setMode] = useState("camera");
  const [cameraActive, setCameraActive] = useState(false);
  const [isOpeningCamera, setIsOpeningCamera] = useState(false);

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [source, setSource] = useState("camera");

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
  const [resultImageErrors, setResultImageErrors] = useState({});
  const [loadedResultImages, setLoadedResultImages] = useState({});
  const isBusy =
    loading || isPreparingLocation || isSavingResultLocation;
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

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      cameraRequestIdRef.current += 1;

      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop());
        cameraStreamRef.current = null;
      }
    };
  }, []);

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

    setMode(selectedMode);
    setFile(null);
    setPreview("");
    setSource(selectedMode);
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
    setFile(null);
    setPreview("");
    setSource("camera");
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
    setSource("camera");
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

    setFile(null);
    setPreview("");
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
    setSource("gallery");
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

    setFile(null);
    setPreview("");
    setResult(null);
    setError("");
    setLoading(false);
    setIsPreparingLocation(false);
    resetLocationStatus();
    resetResultLocationEditor();
    resetZoom();

    if (galleryRef.current) {
      galleryRef.current.value = "";
    }
  };

  const submitPrediction = async (location = null) => {
    resetResultLocationEditor();
    setLoading(true);
    setError("");
    setResult(null);
    setResultImageErrors({});
    setLoadedResultImages({});

    try {
      const response = await predictPalmImage(file, source, location);
      setResult(response);
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

    setIsPreparingLocation(true);
    setError("");
    setResult(null);
    setLocationStatus("requesting");

    let predictionLocation = null;

    try {
      const locationResult = await captureOptionalLocation();
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

        {mode === "camera" ? (
          <div className="prediction-v2-button-grid">
            {preview ? (
              <Button
                type="button"
                variant="secondary"
                onClick={retakePhoto}
                disabled={isBusy}
              >
                Foto Ulang
              </Button>
            ) : !cameraActive ? (
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

            {!preview ? (
              <Button
                type="button"
                variant="primary"
                onClick={capturePhoto}
                disabled={!cameraActive || isBusy}
              >
                Ambil Gambar
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                onClick={runPrediction}
                disabled={isBusy}
              >
                {loading
                  ? "Menganalisis..."
                  : isPreparingLocation
                    ? "Menyiapkan lokasi..."
                    : "Mulai Prediksi"}
              </Button>
            )}
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
        )}

        {mode === "camera" && preview && (
          <Button
            type="button"
            variant="secondary"
            block
            onClick={resetInput}
            disabled={isBusy}
          >
            Reset
          </Button>
        )}

        {mode === "gallery" && preview && (
          <Button
            type="button"
            variant="primary"
            block
            onClick={runPrediction}
            disabled={isBusy}
          >
            {loading
              ? "Menganalisis..."
              : isPreparingLocation
                ? "Menyiapkan lokasi..."
                : "Mulai Prediksi"}
          </Button>
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

        <div className="prediction-v2-location-note" role="note">
          <Icon name="location" size={21} />
          <div>
            <b className="prediction-v2-location-title">
              Lokasi Pengambilan
            </b>
            <p>
              Lokasi akan disimpan otomatis jika tersedia. Browser akan
              meminta izin saat prediksi dimulai.
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
              disabled={isSavingResultLocation}
            >
              Periksa gambar lain
            </Button>

            <Button
              type="button"
              variant="primary"
              onClick={onOpenHistory}
              disabled={isSavingResultLocation}
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
