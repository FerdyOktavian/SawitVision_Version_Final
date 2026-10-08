import { useEffect, useMemo, useRef, useState } from "react";
import { downloadMyPredictionReport } from "../services/reportApi";
import {
  deletePrediction,
  getPredictionDetail,
  getPredictionStats,
  getPredictions,
  updatePredictionLocationLabel,
} from "../services/api";
import Alert from "../components/ui/Alert";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import EmptyState from "../components/ui/EmptyState";
import FormField from "../components/ui/FormField";
import Icon from "../components/ui/Icon";
import IconButton from "../components/ui/IconButton";
import LoadingState from "../components/ui/LoadingState";
import Modal from "../components/ui/Modal";
import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/ui/StatCard";
import LocationSummary from "../components/LocationSummary";
import MaturityBadge from "../components/MaturityBadge";
import ProbabilityBar from "../components/ProbabilityBar";
import {
  MATURITY_META as CLASS_META,
  formatConfidence,
  formatDateTime as formatDate,
  formatMaturityLabel as formatClassLabel,
  normalizeMaturityClass as normalizeClassName,
} from "../utils/presentation";

const HISTORY_PAGE_SIZE = 30;

function formatInputSource(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (normalized === "camera") return "Kamera";
  if (normalized === "gallery") return "Galeri";
  if (normalized === "web_upload") return "Unggah web";

  return value || "Tidak diketahui";
}

function formatFileSize(value) {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function toSafeCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.trunc(number)
    : fallback;
}

function getHistoryItems(response) {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.data)) {
    return response.data;
  }

  if (Array.isArray(response?.items)) {
    return response.items;
  }

  if (Array.isArray(response?.predictions)) {
    return response.predictions;
  }

  return [];
}

function getHistoryTotal(statsResponse) {
  const candidates = [
    statsResponse?.image_stats?.total_images,
    statsResponse?.total_predictions,
    statsResponse?.total,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }

  return null;
}

function getPaginationItems(currentPage, totalPages) {
  if (!Number.isFinite(totalPages) || totalPages < 1) return [];

  const pageNumbers = new Set([1, totalPages]);

  for (
    let page = Math.max(1, currentPage - 1);
    page <= Math.min(totalPages, currentPage + 1);
    page += 1
  ) {
    pageNumbers.add(page);
  }

  if (currentPage <= 3) {
    for (let page = 1; page <= Math.min(4, totalPages); page += 1) {
      pageNumbers.add(page);
    }
  }

  if (currentPage >= totalPages - 2) {
    for (
      let page = Math.max(1, totalPages - 3);
      page <= totalPages;
      page += 1
    ) {
      pageNumbers.add(page);
    }
  }

  const sortedPages = [...pageNumbers].sort((a, b) => a - b);
  const items = [];

  sortedPages.forEach((page, index) => {
    const previousPage = sortedPages[index - 1];

    if (previousPage && page - previousPage > 1) {
      items.push(`ellipsis-${previousPage}-${page}`);
    }

    items.push(page);
  });

  return items;
}

function HistoryPage({ onStartPrediction, serverActionsUnavailable = false }) {
  const detailRequestRef = useRef(0);
  const historyListRef = useRef(null);
  const pageRequestInFlightRef = useRef(false);
  const initiallyServerUnavailableRef = useRef(serverActionsUnavailable);
  const [historyItems, setHistoryItems] = useState([]);
  const [stats, setStats] = useState(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [classFilter, setClassFilter] = useState("all");

  const [isLoading, setIsLoading] = useState(
    () => !serverActionsUnavailable,
  );
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [deletingId, setDeletingId] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [reportStartDate, setReportStartDate] = useState("");
  const [reportEndDate, setReportEndDate] = useState("");
  const [reportDateError, setReportDateError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedHistoryItem, setSelectedHistoryItem] = useState(null);
  const [predictionDetail, setPredictionDetail] = useState(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [failedDetailImages, setFailedDetailImages] = useState({});
  const [isEditingLocationLabel, setIsEditingLocationLabel] = useState(false);
  const [locationLabelDraft, setLocationLabelDraft] = useState("");
  const [isSavingLocationLabel, setIsSavingLocationLabel] = useState(false);
  const [locationLabelError, setLocationLabelError] = useState("");

  const loadHistory = async () => {
    if (pageRequestInFlightRef.current || serverActionsUnavailable) return;

    pageRequestInFlightRef.current = true;
    setIsPageLoading(true);
    setErrorMessage("");

    try {
      const statsResponse = await getPredictionStats();
      const updatedTotal = getHistoryTotal(statsResponse);
      const updatedTotalPages = updatedTotal === null
        ? null
        : Math.max(1, Math.ceil(updatedTotal / HISTORY_PAGE_SIZE));
      const safePage = updatedTotalPages === null
        ? currentPage
        : Math.min(currentPage, updatedTotalPages);
      const historyResponse = await getPredictions({
        limit: HISTORY_PAGE_SIZE,
        offset: (safePage - 1) * HISTORY_PAGE_SIZE,
      });

      const items = getHistoryItems(historyResponse);
      setHistoryItems(items);
      setCurrentPage(safePage);
      setStats(statsResponse);
    } catch (error) {
      setErrorMessage(error.message || "Riwayat prediksi gagal dimuat.");
    } finally {
      pageRequestInFlightRef.current = false;
      setIsPageLoading(false);
    }
  };

  useEffect(() => {
    let isCancelled = false;

    if (initiallyServerUnavailableRef.current) {
      return undefined;
    }

    Promise.all([
      getPredictions({
        limit: HISTORY_PAGE_SIZE,
        offset: 0,
      }),
      getPredictionStats(),
    ])
      .then(([historyResponse, statsResponse]) => {
        if (isCancelled) return;

        const items = getHistoryItems(historyResponse);
        setHistoryItems(items);
        setStats(statsResponse);
      })
      .catch((error) => {
        if (isCancelled) return;

        setErrorMessage(error.message || "Riwayat prediksi gagal dimuat.");
      })
      .finally(() => {
        if (isCancelled) return;

        setIsLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  const changeHistoryPage = async (nextPage) => {
    if (serverActionsUnavailable) return;

    const historyTotal = getHistoryTotal(stats);
    const totalPages = historyTotal === null
      ? null
      : Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
    const safePage = totalPages === null
      ? Math.max(1, nextPage)
      : Math.min(Math.max(1, nextPage), totalPages);

    if (
      safePage === currentPage ||
      pageRequestInFlightRef.current
    ) {
      return;
    }

    pageRequestInFlightRef.current = true;
    setIsPageLoading(true);
    setErrorMessage("");

    try {
      const historyResponse = await getPredictions({
        limit: HISTORY_PAGE_SIZE,
        offset: (safePage - 1) * HISTORY_PAGE_SIZE,
      });
      const nextItems = getHistoryItems(historyResponse);

      if (nextItems.length === 0 && safePage > 1) {
        const statsResponse = await getPredictionStats();
        const updatedTotal = getHistoryTotal(statsResponse);
        const fallbackPage = updatedTotal === null
          ? Math.max(1, safePage - 1)
          : Math.max(1, Math.ceil(updatedTotal / HISTORY_PAGE_SIZE));
        const fallbackResponse = await getPredictions({
          limit: HISTORY_PAGE_SIZE,
          offset: (fallbackPage - 1) * HISTORY_PAGE_SIZE,
        });

        setHistoryItems(getHistoryItems(fallbackResponse));
        setCurrentPage(fallbackPage);
        setStats(statsResponse);
      } else {
        setHistoryItems(nextItems);
        setCurrentPage(safePage);
      }

      window.requestAnimationFrame(() => {
        const reduceMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;

        historyListRef.current?.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "start",
        });
      });
    } catch (error) {
      setErrorMessage(
        error.message || "Halaman riwayat gagal dimuat.",
      );
    } finally {
      pageRequestInFlightRef.current = false;
      setIsPageLoading(false);
    }
  };

  const filteredItems = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return historyItems.filter((item) => {
      const className = normalizeClassName(item.predicted_class);

      const matchesClass = classFilter === "all" || className === classFilter;

      const searchableText = [
        CLASS_META[className]?.label || className,
        item.input_source,
        item.created_at,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesSearch =
        !normalizedSearch || searchableText.includes(normalizedSearch);

      return matchesClass && matchesSearch;
    });
  }, [historyItems, searchTerm, classFilter]);

  const closePredictionDetail = () => {
    detailRequestRef.current += 1;
    setSelectedHistoryItem(null);
    setPredictionDetail(null);
    setDetailError("");
    setIsDetailLoading(false);
    setFailedDetailImages({});
    setIsEditingLocationLabel(false);
    setLocationLabelDraft("");
    setIsSavingLocationLabel(false);
    setLocationLabelError("");
  };

  const openPredictionDetail = async (item) => {
    const recordId = item?.id || item?.record_id;

    if (
      !recordId
      || deletingId === recordId
      || serverActionsUnavailable
    ) {
      return;
    }

    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setSelectedHistoryItem(item);
    setPredictionDetail(null);
    setDetailError("");
    setFailedDetailImages({});
    setIsEditingLocationLabel(false);
    setLocationLabelDraft("");
    setIsSavingLocationLabel(false);
    setLocationLabelError("");
    setIsDetailLoading(true);

    try {
      const response = await getPredictionDetail(recordId);

      if (detailRequestRef.current !== requestId) {
        return;
      }

      const detail = response?.data || response?.prediction || response;
      setPredictionDetail(detail);
    } catch (error) {
      if (detailRequestRef.current !== requestId) {
        return;
      }

      setDetailError(
        error.message || "Detail riwayat prediksi gagal dimuat.",
      );
    } finally {
      if (detailRequestRef.current === requestId) {
        setIsDetailLoading(false);
      }
    }
  };

  const retryPredictionDetail = () => {
    if (selectedHistoryItem) {
      openPredictionDetail(selectedHistoryItem);
    }
  };

  const startEditingLocationLabel = () => {
    setLocationLabelDraft(
      String(predictionDetail?.location?.label || ""),
    );
    setLocationLabelError("");
    setIsEditingLocationLabel(true);
  };

  const cancelEditingLocationLabel = () => {
    setLocationLabelDraft("");
    setLocationLabelError("");
    setIsEditingLocationLabel(false);
  };

  const saveLocationLabel = async (event) => {
    event.preventDefault();

    if (serverActionsUnavailable) return;

    const recordId = predictionDetail?.id || predictionDetail?.record_id;
    if (!recordId || isSavingLocationLabel) {
      return;
    }

    setIsSavingLocationLabel(true);
    setLocationLabelError("");

    try {
      const response = await updatePredictionLocationLabel(
        recordId,
        locationLabelDraft,
      );
      const updatedLocation = response?.location || {};

      setPredictionDetail((current) => ({
        ...current,
        location: {
          ...(current?.location || {}),
          auto_name:
            updatedLocation.auto_name ??
            current?.location?.auto_name ??
            null,
          label: updatedLocation.label ?? null,
        },
      }));
      setLocationLabelDraft("");
      setIsEditingLocationLabel(false);
    } catch (error) {
      setLocationLabelError(
        error.message || "Nama lokasi gagal disimpan.",
      );
    } finally {
      setIsSavingLocationLabel(false);
    }
  };

  const handleDelete = async (recordId) => {
    if (pageRequestInFlightRef.current || serverActionsUnavailable) return;

    pageRequestInFlightRef.current = true;
    setDeletingId(recordId);
    setIsPageLoading(true);
    setDeleteCandidate(null);
    setErrorMessage("");

    try {
      await deletePrediction(recordId);
      const updatedStats = await getPredictionStats();
      const updatedTotal = getHistoryTotal(updatedStats);
      const updatedTotalPages = updatedTotal === null
        ? Math.max(1, currentPage)
        : Math.max(1, Math.ceil(updatedTotal / HISTORY_PAGE_SIZE));
      const safePage = Math.min(currentPage, updatedTotalPages);
      const historyResponse = await getPredictions({
        limit: HISTORY_PAGE_SIZE,
        offset: (safePage - 1) * HISTORY_PAGE_SIZE,
      });

      setHistoryItems(getHistoryItems(historyResponse));
      setCurrentPage(safePage);
      setStats(updatedStats);
    } catch (error) {
      setErrorMessage(error.message || "Riwayat gagal dihapus.");
    } finally {
      pageRequestInFlightRef.current = false;
      setIsPageLoading(false);
      setDeletingId("");
    }
  };

  const handleExport = async (event) => {
    event?.preventDefault();

    if (serverActionsUnavailable) return;

    const hasStartDate = Boolean(reportStartDate);
    const hasEndDate = Boolean(reportEndDate);

    if (hasStartDate !== hasEndDate) {
      setReportDateError("Pilih tanggal awal dan tanggal akhir.");
      return;
    }

    if (hasStartDate && reportStartDate > reportEndDate) {
      setReportDateError("Tanggal awal tidak boleh setelah tanggal akhir.");
      return;
    }

    setIsExporting(true);
    setReportDateError("");
    setErrorMessage("");

    try {
      await downloadMyPredictionReport({
        startDate: reportStartDate || undefined,
        endDate: reportEndDate || undefined,
      });
    } catch (error) {
      setErrorMessage(error.message || "Laporan Excel gagal diunduh.");
    } finally {
      setIsExporting(false);
    }
  };

  const totalImages = toSafeCount(
    stats?.image_stats?.total_images,
    toSafeCount(
      stats?.total_predictions ?? stats?.total,
      historyItems.length,
    ),
  );
  const historyTotal = getHistoryTotal(stats);
  const totalPages = historyTotal === null
    ? null
    : Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
  const pageStart = historyItems.length > 0
    ? (currentPage - 1) * HISTORY_PAGE_SIZE + 1
    : 0;
  const pageEnd = historyItems.length > 0
    ? pageStart + historyItems.length - 1
    : 0;
  const paginationItems = getPaginationItems(currentPage, totalPages);
  const canGoToPreviousPage = currentPage > 1;
  const canGoToNextPage = totalPages === null
    ? historyItems.length === HISTORY_PAGE_SIZE
    : currentPage < totalPages;
  const isPaginationBusy = isPageLoading || Boolean(deletingId);
  const hasActiveFilters = Boolean(
    searchTerm.trim() || classFilter !== "all",
  );
  const tbsStats = stats?.tbs_stats;
  const totalTbs = toSafeCount(tbsStats?.total_tbs);
  const tbsByClass = tbsStats?.by_class ?? {};
  const coverage = tbsStats?.coverage;
  const imagesWithDetectionDetails = toSafeCount(
    coverage?.images_with_detection_details,
  );
  const areTbsDetailsUnavailable =
    totalImages > 0 && imagesWithDetectionDetails === 0;
  const imagesWithoutDetectionDetails = toSafeCount(
    coverage?.images_without_detection_details,
    Math.max(totalImages - imagesWithDetectionDetails, 0),
  );
  const rawCoveragePercentage = Number(coverage?.coverage_percentage);
  const coveragePercentage = Number.isFinite(rawCoveragePercentage)
    ? Math.min(Math.max(rawCoveragePercentage, 0), 100)
    : totalImages > 0
      ? (imagesWithDetectionDetails / totalImages) * 100
      : 0;
  const formattedCoveragePercentage = new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(coveragePercentage);
  let coverageMessage = "";

  if (totalImages > 0 && (!tbsStats || areTbsDetailsUnavailable)) {
    coverageMessage = "Detail TBS belum tersedia untuk riwayat ini.";
  } else if (
    totalImages > 0 &&
    (imagesWithoutDetectionDetails > 0 || coveragePercentage < 100)
  ) {
    coverageMessage =
      `Detail TBS tersedia untuk ${imagesWithDetectionDetails} dari ` +
      `${totalImages} foto (${formattedCoveragePercentage}%). ` +
      "Statistik TBS dihitung dari hasil yang memiliki detail multi-deteksi.";
  }

  const detailRecord = predictionDetail;
  const detailClassName = normalizeClassName(detailRecord?.predicted_class);
  const detailClassMeta = CLASS_META[detailClassName] || {
    label: formatClassLabel(detailClassName),
  };
  const detailProbabilities = detailRecord?.probabilities || {};
  const detailDetections = Array.isArray(detailRecord?.detections)
    ? detailRecord.detections
    : [];
  const hasDetectionAvailabilityFlag =
    typeof detailRecord?.detection_details_available === "boolean";
  const hasPersistentDetectionData = hasDetectionAvailabilityFlag
    ? detailRecord.detection_details_available
    : Boolean(detailRecord?.summary || detailDetections.length > 0);
  const detectionCountFallback = detailDetections.reduce(
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
  const detailComposition = {
    total: detailDetections.length,
    byClass: detectionCountFallback,
  };
  const compositionHighestCount = detailComposition.total > 0
    ? Math.max(...Object.values(detailComposition.byClass))
    : 0;
  const compositionLeaders = compositionHighestCount > 0
    ? Object.keys(detailComposition.byClass).filter(
        (className) => detailComposition.byClass[className] === compositionHighestCount,
      )
    : [];
  const dominantMaturityClass = compositionLeaders.length === 1
    ? compositionLeaders[0]
    : "";
  const hasBalancedComposition = compositionLeaders.length > 1;
  const showDominantConfidence = Boolean(
    dominantMaturityClass && detailClassName === dominantMaturityClass,
  );
  const detailImageCandidates = [
    detailRecord?.image_processed_url,
    detailRecord?.image_thumbnail_url,
    detailRecord?.image_original_url,
    selectedHistoryItem?.image_processed_url,
    selectedHistoryItem?.image_thumbnail_url,
    selectedHistoryItem?.image_original_url,
  ].filter(
    (url, index, values) =>
      url && values.indexOf(url) === index && !failedDetailImages[url],
  );
  const detailImageUrl = detailImageCandidates[0] || "";
  const detailLocation = detailRecord?.location || {};
  const detailLocationAutoName = String(
    detailLocation.auto_name || "",
  ).trim();

  return (
    <main className="history-page">
      <PageHeader
        className="history-hero"
        eyebrow="Riwayat Lapangan"
        title="Hasil pemeriksaan sebelumnya"
        description="Tinjau kembali foto, ringkasan kematangan, lokasi, dan detail setiap TBS."
        actions={(
          <Button type="button" onClick={onStartPrediction}>
            <Icon name="camera" />
            Prediksi baru
          </Button>
        )}
      />

      {serverActionsUnavailable && (
        <Alert tone="warning" role="note">
          Riwayat dan laporan memerlukan koneksi server.
        </Alert>
      )}

      <section
        className="history-statistics"
        aria-label="Statistik foto dan TBS"
      >
        <div className="history-stats">
          <StatCard icon="gallery" label="Foto Tersimpan" value={totalImages} />
          <StatCard icon="scan" label="Total TBS" value={areTbsDetailsUnavailable ? "—" : totalTbs} />
          {Object.entries(CLASS_META).map(([className, meta]) => (
            <StatCard
              key={className}
              icon="scan"
              label={meta.label}
              value={areTbsDetailsUnavailable ? "—" : toSafeCount(tbsByClass?.[className]?.total)}
              suffix={areTbsDetailsUnavailable ? "" : " TBS"}
              tone={meta.tone}
            />
          ))}
        </div>

        {coverageMessage && (
          <Alert className="history-coverage-note" role="note">{coverageMessage}</Alert>
        )}
      </section>

      <section className="history-toolbar">
        <label className="history-search">
          <span className="history-control-label">Cari riwayat</span>
          <Icon name="scan" size={18} />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Cari lokasi atau hasil..."
          />
        </label>

        <label className="history-filter">
          <span className="history-control-label">Kematangan</span>
          <select
            value={classFilter}
            onChange={(event) => setClassFilter(event.target.value)}
          >
            <option value="all">Semua kelas</option>
            <option value="belum_masak">Belum Matang</option>
            <option value="masak">Matang</option>
            <option value="terlalu_masak">Terlalu Matang</option>
          </select>
        </label>

        <Button
          type="button"
          variant="secondary"
          onClick={loadHistory}
          disabled={
            isLoading
            || isPaginationBusy
            || serverActionsUnavailable
          }
        >
          <Icon name="refresh" />
          Muat ulang
        </Button>
      </section>

      <Card
        className="history-report-card"
        aria-labelledby="history-report-title"
      >
        <div className="history-report-heading">
          <div>
            <p>Laporan riwayat</p>
            <h2 id="history-report-title">Rentang laporan</h2>
          </div>
          <p>
            Pilih rentang tanggal, atau kosongkan keduanya untuk seluruh
            riwayat.
          </p>
        </div>

        <form className="history-report-form" onSubmit={handleExport}>
          <FormField
            id="history-report-start-date"
            label="Dari tanggal"
            type="date"
            value={reportStartDate}
            onChange={(event) => {
              setReportStartDate(event.target.value);
              setReportDateError("");
            }}
            disabled={isExporting}
            aria-invalid={reportDateError ? "true" : undefined}
            aria-describedby={reportDateError ? "history-report-error" : undefined}
          />
          <FormField
            id="history-report-end-date"
            label="Sampai tanggal"
            type="date"
            value={reportEndDate}
            onChange={(event) => {
              setReportEndDate(event.target.value);
              setReportDateError("");
            }}
            disabled={isExporting}
            aria-invalid={reportDateError ? "true" : undefined}
            aria-describedby={reportDateError ? "history-report-error" : undefined}
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={
              isLoading
              || isExporting
              || historyItems.length === 0
              || serverActionsUnavailable
            }
            aria-busy={isExporting}
          >
            <Icon name="download" />
            {isExporting ? "Mengekspor..." : "Export Excel"}
          </Button>
        </form>

        {reportDateError && (
          <Alert
            id="history-report-error"
            className="history-report-error"
            tone="error"
            role="alert"
          >
            {reportDateError}
          </Alert>
        )}
      </Card>

      {errorMessage && <Alert tone="error" role="alert">{errorMessage}</Alert>}

      <div ref={historyListRef} className="history-list-anchor" />

      {isLoading || isPageLoading ? (
        <LoadingState title="Memuat riwayat..." description="Data pemeriksaan sedang diambil." />
      ) : filteredItems.length === 0 ? (
        <EmptyState
          title={
            serverActionsUnavailable && historyItems.length === 0
              ? "Riwayat belum dapat dimuat"
              : historyItems.length
                ? "Tidak ada hasil yang cocok"
                : "Belum ada riwayat"
          }
          description={
            serverActionsUnavailable && historyItems.length === 0
              ? "Hubungkan perangkat ke server untuk memuat riwayat."
              : historyItems.length
                ? "Ubah kata pencarian atau filter kematangan."
                : "Mulai pemeriksaan TBS agar hasilnya tersimpan di halaman ini."
          }
          actionLabel={
            historyItems.length || serverActionsUnavailable
              ? undefined
              : "Mulai prediksi"
          }
          onAction={
            historyItems.length || serverActionsUnavailable
              ? undefined
              : onStartPrediction
          }
        />
      ) : (
        <section className="history-grid">
          {filteredItems.map((item) => {
            const className = normalizeClassName(item.predicted_class);
            const meta = CLASS_META[className] || {
              label: formatClassLabel(item.predicted_class),
            };
            const imageUrl =
              item.image_thumbnail_url || item.image_processed_url;
            const itemSummary = item.summary || {};
            const itemTotalTbs = itemSummary.total_detections ?? item.total_detections;
            const itemLocation = item.location?.label || item.location?.auto_name || item.location_label;

            return (
              <article key={item.id} className="history-card">
                <button
                  type="button"
                  className="history-card-open"
                  aria-haspopup="dialog"
                  aria-label={`Lihat detail prediksi ${meta.label}`}
                  onClick={() => openPredictionDetail(item)}
                  disabled={serverActionsUnavailable}
                >
                  <div className="history-card-image">
                    {imageUrl ? (
                      <img src={imageUrl} alt={`Hasil ${meta.label}`} />
                    ) : (
                      <div className="history-no-image">
                        <Icon name="gallery" size={28} />
                        <small>Gambar tidak tersedia</small>
                      </div>
                    )}
                  </div>

                  <div className="history-card-body">
                    <time dateTime={item.created_at}>{formatDate(item.created_at)}</time>
                    <div className="history-card-heading">
                      <MaturityBadge value={className} />
                      <strong>{formatConfidence(item.confidence)}%</strong>
                    </div>
                    <div className="history-card-summary">
                      <span><Icon name="scan" size={16} /> {itemTotalTbs ?? "—"} TBS</span>
                      <span><Icon name={item.input_source === "camera" ? "camera" : "gallery"} size={16} /> {formatInputSource(item.input_source)}</span>
                      {itemLocation && <span><Icon name="location" size={16} /> {itemLocation}</span>}
                    </div>
                    {itemSummary.by_class && (
                      <div className="history-card-breakdown" aria-label="Ringkasan kematangan TBS">
                        {Object.entries(CLASS_META).map(([key, classMeta]) => (
                          <span key={key} className={`is-${classMeta.tone}`}>
                            {classMeta.label}
                            <strong>{toSafeCount(itemSummary.by_class?.[key]?.total ?? itemSummary.by_class?.[key])}</strong>
                          </span>
                        ))}
                      </div>
                    )}
                    <span className="history-view-detail">
                      Lihat detail <Icon name="chevron" size={17} />
                    </span>
                  </div>
                </button>
                <div className="history-card-actions">
                  <IconButton
                    type="button"
                    className="history-delete-button"
                    onClick={() => setDeleteCandidate(item)}
                    disabled={
                      deletingId === item.id
                      || serverActionsUnavailable
                    }
                    aria-label={`Hapus riwayat ${formatDate(item.created_at)}`}
                  >
                    <Icon name="trash" size={18} />
                  </IconButton>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {!isLoading && historyItems.length > 0 && (
        <nav className="history-pagination" aria-label="Pagination riwayat">
          <p className="history-list-status" role="status">
            {historyTotal !== null
              ? `Menampilkan ${pageStart}–${pageEnd} dari ${historyTotal} riwayat.`
              : `Menampilkan ${historyItems.length} riwayat pada halaman ${currentPage}.`}
          </p>

          {hasActiveFilters && (
            <p className="history-filter-scope">
              {filteredItems.length} hasil cocok dari {historyItems.length} riwayat
              pada halaman ini. Pencarian dan filter belum mencakup halaman lain.
            </p>
          )}

          {(canGoToPreviousPage || canGoToNextPage) && (
            <div className="history-pagination-controls">
              <Button
                type="button"
                variant="secondary"
                className="history-pagination-direction history-pagination-previous"
                onClick={() => changeHistoryPage(currentPage - 1)}
                disabled={
                  !canGoToPreviousPage
                  || isPaginationBusy
                  || serverActionsUnavailable
                }
                aria-label="Buka halaman riwayat sebelumnya"
              >
                <Icon name="chevron" size={18} />
                <span>Sebelumnya</span>
              </Button>

              {totalPages !== null && (
                <div className="history-pagination-pages" aria-label="Pilih halaman">
                  {paginationItems.map((item) => (
                    typeof item === "number" ? (
                      <Button
                        key={item}
                        type="button"
                        variant={item === currentPage ? "secondary" : "ghost"}
                        className="history-pagination-page"
                        onClick={() => changeHistoryPage(item)}
                        disabled={isPaginationBusy || serverActionsUnavailable}
                        aria-label={`Buka halaman ${item}`}
                        aria-current={item === currentPage ? "page" : undefined}
                      >
                        {item}
                      </Button>
                    ) : (
                      <span
                        key={item}
                        className="history-pagination-ellipsis"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    )
                  ))}
                </div>
              )}

              {totalPages !== null && (
                <span className="history-pagination-mobile-status">
                  {currentPage} / {totalPages}
                </span>
              )}

              <Button
                type="button"
                variant="secondary"
                className="history-pagination-direction"
                onClick={() => changeHistoryPage(currentPage + 1)}
                disabled={
                  !canGoToNextPage
                  || isPaginationBusy
                  || serverActionsUnavailable
                }
                aria-label="Buka halaman riwayat berikutnya"
              >
                <span>Berikutnya</span>
                <Icon name="chevron" size={18} />
              </Button>
            </div>
          )}

          {totalPages === 1 && (
            <p className="history-list-end">Semua riwayat berada pada halaman ini.</p>
          )}
        </nav>
      )}

      <Modal
        open={Boolean(selectedHistoryItem)}
        onClose={closePredictionDetail}
        eyebrow="Detail Riwayat"
        title="Hasil Prediksi"
        className="history-detail-modal"
      >
              {isDetailLoading && (
                <LoadingState title="Memuat detail..." description="Data riwayat sedang diambil." />
              )}

              {!isDetailLoading && detailError && (
                <Alert tone="error" role="alert" className="history-detail-error">
                  <div>
                    <strong>Detail tidak dapat dibuka</strong>
                    <p>{detailError}</p>
                    <div className="history-detail-error-actions">
                      <Button type="button" onClick={retryPredictionDetail}>
                      Coba lagi
                      </Button>
                      <Button type="button" variant="secondary" onClick={closePredictionDetail}>
                      Tutup
                      </Button>
                    </div>
                  </div>
                </Alert>
              )}

              {!isDetailLoading && !detailError && detailRecord && (
                <>
                  <div className="history-detail-primary">
                    <figure className="history-detail-figure">
                      {detailImageUrl ? (
                        <img
                          src={detailImageUrl}
                          alt={`Gambar hasil ${detailClassMeta.label}`}
                          onError={() =>
                            setFailedDetailImages((current) => ({
                              ...current,
                              [detailImageUrl]: true,
                            }))
                          }
                        />
                      ) : (
                        <div className="history-detail-no-image">
                          <Icon name="gallery" size={30} />
                          <p>Gambar hasil tidak tersedia.</p>
                        </div>
                      )}
                    </figure>

                    <div className="history-detail-result-stack">
                      <section className="history-detail-overview">
                        <div className="history-detail-section-heading">
                          <small>Ringkasan Hasil</small>
                        </div>
                        <div className="history-detail-class">
                          <div>
                            <small>
                              {dominantMaturityClass
                                ? "Kematangan dominan"
                                : hasBalancedComposition
                                  ? "Distribusi kematangan"
                                  : "Klasifikasi tersimpan"}
                            </small>
                            <h3>
                              {dominantMaturityClass
                                ? formatClassLabel(dominantMaturityClass)
                                : hasBalancedComposition
                                  ? "Komposisi seimbang"
                                  : detailClassMeta.label}
                            </h3>
                          </div>
                          {dominantMaturityClass && (
                            <MaturityBadge value={dominantMaturityClass} />
                          )}
                        </div>

                        {detailComposition.total > 0 && (
                          <div className="history-detail-composition">
                            <div className="history-detail-composition-heading">
                              <strong>Komposisi TBS</strong>
                              <span>{detailComposition.total} TBS</span>
                            </div>
                            <dl>
                              {Object.entries(CLASS_META).map(([className, meta]) => (
                                <div key={className}>
                                  <dt>{meta.label}</dt>
                                  <dd>{detailComposition.byClass[className]} TBS</dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        )}

                        {showDominantConfidence && (
                          <div className="history-detail-confidence">
                            <small>Rata-rata keyakinan TBS dominan</small>
                            <strong>
                              {formatConfidence(detailRecord.confidence)}%
                            </strong>
                          </div>
                        )}

                        {detailComposition.total === 0 && (
                          <p className="history-detail-legacy-summary">
                            Detail per TBS tidak tersedia. Label klasifikasi
                            tersimpan ditampilkan tanpa klaim kelas dominan.
                          </p>
                        )}
                      </section>

                      <section className="history-detail-probabilities" aria-labelledby="history-probability-title">
                        <div className="history-detail-section-heading">
                          <small>Probabilitas Model</small>
                          <h3 id="history-probability-title">
                            {detailComposition.total > 0
                              ? "Rata-rata probabilitas per TBS"
                              : "Probabilitas klasifikasi tersimpan"}
                          </h3>
                        </div>
                        <div className="history-detail-probability-list">
                          {Object.entries(CLASS_META).map(([className, meta]) => (
                            <ProbabilityBar
                              key={className}
                              label={meta.label}
                              value={detailProbabilities[className]}
                              className={`is-${meta.tone}`}
                            />
                          ))}
                        </div>
                        <p className="history-detail-probability-note">
                          {detailComposition.total > 0
                            ? "Nilai ini adalah rata-rata keluaran model untuk seluruh TBS, bukan persentase jumlah TBS."
                            : "Detail per TBS tidak tersedia untuk menjelaskan agregasi nilai pada record ini."}
                        </p>
                      </section>
                    </div>
                  </div>

                  <section className="history-detail-metadata">
                    <div>
                      <small>Tanggal dan waktu</small>
                      <strong>{formatDate(detailRecord.created_at)}</strong>
                    </div>
                    <div>
                      <small>Sumber gambar</small>
                      <strong>
                        {formatInputSource(detailRecord.input_source)}
                      </strong>
                    </div>
                    {detailRecord.image_width && detailRecord.image_height && (
                      <div>
                        <small>Ukuran gambar</small>
                        <strong>
                          {detailRecord.image_width} × {detailRecord.image_height}
                          px
                        </strong>
                      </div>
                    )}
                    {formatFileSize(detailRecord.file_size_bytes) && (
                      <div>
                        <small>Ukuran file</small>
                        <strong>
                          {formatFileSize(detailRecord.file_size_bytes)}
                        </strong>
                      </div>
                    )}
                  </section>

                  <LocationSummary
                    location={detailLocation}
                    className="history-detail-location"
                    actions={!isEditingLocationLabel && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={startEditingLocationLabel}
                        disabled={serverActionsUnavailable}
                      >
                        <Icon name="edit" size={17} />
                        Edit lokasi
                      </Button>
                    )}
                  >
                    {isEditingLocationLabel && (
                      <form
                        className="history-detail-location-editor"
                        onSubmit={saveLocationLabel}
                      >
                        <label htmlFor="history-location-label">
                          Nama lokasi
                        </label>
                        <input
                          id="history-location-label"
                          type="text"
                          maxLength={500}
                          value={locationLabelDraft}
                          onChange={(event) =>
                            setLocationLabelDraft(event.target.value)
                          }
                          placeholder={
                            detailLocationAutoName ||
                            "Contoh: Blok 7 Afdeling Timur"
                          }
                          disabled={isSavingLocationLabel}
                          autoFocus
                        />
                        <p>
                          Mengubah nama lokasi tidak mengubah koordinat GPS.
                          Kosongkan field untuk menghapus label manual.
                        </p>
                        {locationLabelError && (
                          <Alert tone="error" role="alert">{locationLabelError}</Alert>
                        )}
                        <div>
                          <Button
                            type="submit"
                            disabled={
                              isSavingLocationLabel
                              || serverActionsUnavailable
                            }
                          >
                            {isSavingLocationLabel
                              ? "Menyimpan..."
                              : "Simpan"}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={cancelEditingLocationLabel}
                            disabled={isSavingLocationLabel}
                          >
                            Batal
                          </Button>
                        </div>
                      </form>
                    )}
                  </LocationSummary>

                  {!hasPersistentDetectionData && (
                    <section className="history-detail-unavailable">
                      <h3>Detail per TBS belum tersedia</h3>
                      <p>
                        Hasil ini hanya menyimpan ringkasan kematangan gambar.
                        Data jumlah dan deteksi setiap TBS belum tersimpan pada
                        riwayat ini.
                      </p>
                    </section>
                  )}

                  {detailDetections.length > 0 && (
                    <section className="history-detail-detections">
                      <div className="history-detail-section-heading">
                        <small>Detail Per Objek</small>
                        <h3>Hasil Setiap TBS</h3>
                      </div>

                      <div className="history-detail-detection-grid">
                        {detailDetections.map((detection, index) => {
                          const className = normalizeClassName(
                            detection?.predicted_class,
                          );
                          const bbox = Array.isArray(detection?.bbox)
                            ? detection.bbox
                            : null;
                          const probabilities = detection?.probabilities;

                          return (
                            <article
                              className={`history-detail-detection history-detail-detection-${className}`}
                              key={`${bbox?.join("-") || "tbs"}-${index}`}
                            >
                              <div className="history-detail-detection-head">
                                <h4>TBS {index + 1}</h4>
                                <MaturityBadge value={className} />
                              </div>

                              <dl>
                                <div>
                                  <dt>Keyakinan Kematangan</dt>
                                  <dd>
                                    {formatConfidence(
                                      detection?.maturity_confidence,
                                    )}
                                    %
                                  </dd>
                                </div>
                                <div>
                                  <dt>Keyakinan Deteksi</dt>
                                  <dd>
                                    {formatConfidence(
                                      detection?.detector_confidence,
                                    )}
                                    %
                                  </dd>
                                </div>
                              </dl>

                              {(probabilities || bbox) && (
                                <details className="history-detail-detection-disclosure">
                                  <summary>Lihat rincian TBS</summary>
                                  {probabilities && typeof probabilities === "object" && (
                                    <div className="history-detail-detection-probs">
                                      {Object.entries(CLASS_META).map(([key, meta]) => (
                                        <div key={key}>
                                          <span>{meta.label}</span>
                                          <strong>{formatConfidence(probabilities[key])}%</strong>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {bbox && (
                                    <div className="history-detail-bbox">
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

                  {detailRecord.notes && (
                    <section className="history-detail-notes">
                      <small>Catatan</small>
                      <p>{detailRecord.notes}</p>
                    </section>
                  )}

                  {Array.isArray(detailRecord.warnings) &&
                    detailRecord.warnings.length > 0 && (
                      <section className="history-detail-warnings">
                        <strong>Catatan pemrosesan</strong>
                        <ul>
                          {detailRecord.warnings.map((warning, index) => (
                            <li key={index}>
                              {typeof warning === "string"
                                ? warning
                                : String(
                                    warning?.reason ||
                                      "Sebagian objek tidak dapat diproses",
                                  ).replaceAll("_", " ")}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                  <p className="history-detail-record-id">
                    ID: {detailRecord.id || detailRecord.record_id || "-"}
                  </p>
                </>
              )}
      </Modal>

      <Modal
        open={Boolean(deleteCandidate)}
        onClose={() => {
          if (!deletingId) setDeleteCandidate(null);
        }}
        title="Hapus riwayat?"
        eyebrow="Konfirmasi"
        role="alertdialog"
        className="history-delete-modal"
        closeOnBackdrop={!deletingId}
      >
        <p className="history-delete-copy">
          Hasil prediksi {deleteCandidate ? formatDate(deleteCandidate.created_at) : "ini"} akan dihapus permanen dari riwayat.
        </p>
        <div className="history-delete-actions">
          <Button
            type="button"
            variant="secondary"
            data-autofocus
            onClick={() => setDeleteCandidate(null)}
            disabled={Boolean(deletingId)}
          >
            Batal
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => handleDelete(deleteCandidate?.id)}
            disabled={Boolean(deletingId) || serverActionsUnavailable}
          >
            {deletingId ? "Menghapus..." : "Hapus riwayat"}
          </Button>
        </div>
      </Modal>
    </main>
  );
}

export default HistoryPage;
