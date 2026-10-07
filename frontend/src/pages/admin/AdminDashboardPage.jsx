import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cleanupActivityLogs,
  cleanupStorage,
  downloadAdminPredictionReport,
  getAdminActivityLogs,
  getAdminStats,
  getAdminStorageStats,
  getAdminUsers,
  updateAdminUserStatus,
} from "../../services/api";
import AdminActivity from "../../components/admin/AdminActivity";
import AdminOverview from "../../components/admin/AdminOverview";
import AdminPredictions from "../../components/admin/AdminPredictions";
import AdminReports from "../../components/admin/AdminReports";
import AdminSectionNav from "../../components/admin/AdminSectionNav";
import AdminStorage from "../../components/admin/AdminStorage";
import AdminUsers from "../../components/admin/AdminUsers";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import EmptyState from "../../components/ui/EmptyState";
import Icon from "../../components/ui/Icon";
import Modal from "../../components/ui/Modal";
import PageHeader from "../../components/ui/PageHeader";

const USERS_PAGE_SIZE = 20;
const ACTIVITY_PAGE_SIZE = 50;

function toSafeCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function AdminDashboardPage({ currentUser }) {
  const [activeTab, setActiveTab] = useState("overview");
  const [stats, setStats] = useState(null);
  const [storageStats, setStorageStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [activityLogs, setActivityLogs] = useState([]);
  const [usersSearch, setUsersSearch] = useState("");
  const [activitySearch, setActivitySearch] = useState("");
  const usersSearchRef = useRef("");
  const activitySearchRef = useRef("");
  const usersPageRef = useRef(1);
  const usersLoadingRef = useRef(false);
  const activityPageRef = useRef(1);
  const activityLoadingRef = useRef(false);
  const [isLoadingStats, setIsLoadingStats] = useState(true);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [usersPagination, setUsersPagination] = useState({
    page: 1,
    total: 0,
    totalPages: 0,
    hasMore: false,
  });
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);
  const [activityPagination, setActivityPagination] = useState({
    page: 1,
    total: 0,
    totalPages: 0,
    hasMore: false,
  });
  const [isLoadingStorage, setIsLoadingStorage] = useState(false);
  const [actionUserId, setActionUserId] = useState("");
  const [isCleaningStorage, setIsCleaningStorage] = useState(false);
  const [isCleaningLogs, setIsCleaningLogs] = useState(false);
  const [isDownloadingReport, setIsDownloadingReport] = useState(false);
  const [reportUsers, setReportUsers] = useState([]);
  const [reportUsersSearch, setReportUsersSearch] = useState("");
  const [selectedReportUsers, setSelectedReportUsers] = useState([]);
  const [isLoadingReportUsers, setIsLoadingReportUsers] = useState(false);
  const reportUsersSearchRef = useRef("");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [reportFilter, setReportFilter] = useState({
    start_date: "",
    end_date: "",
    predicted_class: "",
  });

  const isAdmin = currentUser?.role === "admin";

  const loadStats = useCallback(async () => {
    setIsLoadingStats(true);
    setErrorMessage("");
    try {
      setStats(await getAdminStats());
    } catch (error) {
      setErrorMessage(error.message || "Statistik admin gagal dimuat.");
    } finally {
      setIsLoadingStats(false);
    }
  }, []);

  const loadUsers = useCallback(async (requestedPage = usersPageRef.current) => {
    if (usersLoadingRef.current) return;

    usersLoadingRef.current = true;
    setIsLoadingUsers(true);
    setErrorMessage("");
    try {
      const page = Math.max(1, Number(requestedPage) || 1);
      let response = await getAdminUsers({
        limit: USERS_PAGE_SIZE,
        offset: (page - 1) * USERS_PAGE_SIZE,
        search: usersSearchRef.current.trim(),
      });

      let total = toSafeCount(response?.total);
      let totalPages = total > 0
        ? Math.ceil(total / USERS_PAGE_SIZE)
        : 0;
      let effectivePage = page;

      if (
        page > 1 &&
        (response?.data || []).length === 0 &&
        total > 0 &&
        totalPages > 0 &&
        page > totalPages
      ) {
        effectivePage = totalPages;
        response = await getAdminUsers({
          limit: USERS_PAGE_SIZE,
          offset: (effectivePage - 1) * USERS_PAGE_SIZE,
          search: usersSearchRef.current.trim(),
        });
        total = toSafeCount(response?.total);
        totalPages = total > 0
          ? Math.ceil(total / USERS_PAGE_SIZE)
          : 0;
      }

      setUsers(response?.data || []);
      usersPageRef.current = effectivePage;
      setUsersPagination({
        page: effectivePage,
        total,
        totalPages,
        hasMore: Boolean(response?.has_more),
      });
    } catch (error) {
      setErrorMessage(error.message || "Daftar pengguna gagal dimuat.");
    } finally {
      usersLoadingRef.current = false;
      setIsLoadingUsers(false);
    }
  }, []);

  const loadActivity = useCallback(async (requestedPage = activityPageRef.current) => {
    if (activityLoadingRef.current) return;

    activityLoadingRef.current = true;
    setIsLoadingActivity(true);
    setErrorMessage("");
    try {
      const page = Math.max(1, Number(requestedPage) || 1);
      let response = await getAdminActivityLogs({
        page,
        pageSize: ACTIVITY_PAGE_SIZE,
        search: activitySearchRef.current.trim(),
      });

      const responseTotal = toSafeCount(response?.total);
      const responseTotalPages = toSafeCount(response?.total_pages);
      let effectivePage = toSafeCount(response?.page, page) || page;

      if (
        page > 1 &&
        (response?.data || []).length === 0 &&
        responseTotal > 0 &&
        responseTotalPages > 0 &&
        page > responseTotalPages
      ) {
        effectivePage = responseTotalPages;
        response = await getAdminActivityLogs({
          page: effectivePage,
          pageSize: ACTIVITY_PAGE_SIZE,
          search: activitySearchRef.current.trim(),
        });
      }

      setActivityLogs(response?.data || []);
      activityPageRef.current = effectivePage;
      setActivityPagination({
        page: effectivePage,
        total: toSafeCount(response?.total),
        totalPages: toSafeCount(response?.total_pages),
        hasMore: Boolean(response?.has_more),
      });
    } catch (error) {
      setErrorMessage(error.message || "Aktivitas sistem gagal dimuat.");
    } finally {
      activityLoadingRef.current = false;
      setIsLoadingActivity(false);
    }
  }, []);

  const loadStorage = useCallback(async () => {
    setIsLoadingStorage(true);
    setErrorMessage("");
    try {
      setStorageStats(await getAdminStorageStats());
    } catch (error) {
      setErrorMessage(error.message || "Informasi storage gagal dimuat.");
    } finally {
      setIsLoadingStorage(false);
    }
  }, []);

  const loadReportUsers = useCallback(async () => {
    setIsLoadingReportUsers(true);
    setErrorMessage("");
    try {
      const response = await getAdminUsers({
        limit: 100,
        offset: 0,
        search: reportUsersSearchRef.current.trim(),
      });
      setReportUsers(response?.data || []);
    } catch (error) {
      setErrorMessage(error.message || "Daftar pengguna laporan gagal dimuat.");
    } finally {
      setIsLoadingReportUsers(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;

    async function loadInitialData() {
      await Promise.all([loadStats(), loadStorage()]);
    }

    loadInitialData();
  }, [isAdmin, loadStats, loadStorage]);

  useEffect(() => {
    if (!isAdmin) return;

    async function loadActiveSection() {
      if (activeTab === "users") await loadUsers();
      if (activeTab === "activity") await loadActivity();
      if (activeTab === "storage") await loadStorage();
      if (activeTab === "reports") await loadReportUsers();
    }

    loadActiveSection();
  }, [activeTab, isAdmin, loadActivity, loadReportUsers, loadStorage, loadUsers]);

  const dashboardData = useMemo(() => {
    const predictionByClass = stats?.predictions?.by_class || {};
    const imageStats = stats?.predictions?.image_stats;
    const imageByClass = imageStats?.by_summary_class || predictionByClass;
    const tbsStats = stats?.predictions?.tbs_stats;
    const totalImages = toSafeCount(
      imageStats?.total_images,
      toSafeCount(stats?.predictions?.total),
    );
    const totalTbs = toSafeCount(tbsStats?.total_tbs);
    const coverage = tbsStats?.coverage;
    const imagesWithDetectionDetails = toSafeCount(coverage?.images_with_detection_details);
    const imagesWithoutDetectionDetails = toSafeCount(
      coverage?.images_without_detection_details,
      Math.max(totalImages - imagesWithDetectionDetails, 0),
    );
    const rawCoverage = Number(coverage?.coverage_percentage);
    const coveragePercentage = Number.isFinite(rawCoverage)
      ? Math.min(Math.max(rawCoverage, 0), 100)
      : totalImages > 0
        ? (imagesWithDetectionDetails / totalImages) * 100
        : 0;
    const formattedCoverage = new Intl.NumberFormat("id-ID", {
      maximumFractionDigits: 2,
    }).format(coveragePercentage);
    const tbsDetailsUnavailable = totalImages > 0 && (!tbsStats || imagesWithDetectionDetails === 0);
    let coverageStatus = "complete";
    let coverageMessage = "Belum ada foto tersimpan.";
    let coverageCaption = "Statistik TBS akan tersedia setelah ada hasil baru.";

    if (tbsDetailsUnavailable) {
      coverageStatus = "unavailable";
      coverageMessage = "Detail TBS belum tersedia untuk data ini.";
      coverageCaption = "Record tanpa detail multi-deteksi tidak dianggap sebagai nol TBS.";
    } else if (totalImages > 0 && (imagesWithoutDetectionDetails > 0 || coveragePercentage < 100)) {
      coverageStatus = "partial";
      coverageMessage = `Detail TBS tersedia untuk ${imagesWithDetectionDetails} dari ${totalImages} foto (${formattedCoverage}%).`;
      coverageCaption = "Statistik TBS dihitung dari hasil yang memiliki detail multi-deteksi tersimpan.";
    } else if (totalImages > 0) {
      coverageMessage = `Detail TBS tersedia untuk seluruh ${totalImages} foto (${formattedCoverage}%).`;
      coverageCaption = "Seluruh foto memiliki detail multi-deteksi tersimpan.";
    }

    const rawStoragePercentage = Number(storageStats?.usage?.percentage || 0);
    const storagePercentage = Number.isFinite(rawStoragePercentage) ? rawStoragePercentage : 0;

    return {
      hasStats: Boolean(stats),
      totalUsers: toSafeCount(stats?.users?.total),
      activeUsers: toSafeCount(stats?.users?.active),
      regularUsers: toSafeCount(stats?.users?.regular),
      adminUsers: toSafeCount(stats?.users?.admin),
      totalLogs: toSafeCount(stats?.activity_logs?.total),
      totalImages,
      totalTbs,
      tbsDetailsUnavailable,
      imageByClass,
      predictionByClass,
      tbsByClass: tbsStats?.by_class || {},
      avgDetectorConfidence: tbsStats?.avg_detector_confidence,
      recentPredictions: stats?.predictions?.recent || [],
      storagePercentage,
      coverageStatus,
      coverageMessage,
      coverageCaption,
    };
  }, [stats, storageStats]);

  const storageStatusLabel = useMemo(() => {
    if (storageStats?.status === "critical") return "Kritis";
    if (storageStats?.status === "warning") return "Perlu perhatian";
    return "Aman";
  }, [storageStats]);

  const updateUserStatus = async (user) => {
    const nextStatus = !user.is_active;
    setActionUserId(user.id);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      await updateAdminUserStatus(user.id, nextStatus);
      setUsers((current) => current.map((item) => (
        item.id === user.id ? { ...item, is_active: nextStatus } : item
      )));
      setSuccessMessage(`Status akun ${user.name} berhasil diperbarui.`);
      loadStats();
    } catch (error) {
      setErrorMessage(error.message || "Status pengguna gagal diperbarui.");
    } finally {
      setActionUserId("");
      setConfirmation(null);
    }
  };

  const cleanStorage = async () => {
    setIsCleaningStorage(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const response = await cleanupStorage(10);
      setSuccessMessage(response?.message || "Storage berhasil dibersihkan.");
      await Promise.all([loadStorage(), loadStats()]);
    } catch (error) {
      setErrorMessage(error.message || "Cleanup storage gagal.");
    } finally {
      setIsCleaningStorage(false);
      setConfirmation(null);
    }
  };

  const cleanActivity = async () => {
    setIsCleaningLogs(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const response = await cleanupActivityLogs(90);
      setSuccessMessage(response?.message || "Activity log lama berhasil dibersihkan.");
      await Promise.all([loadActivity(), loadStats()]);
    } catch (error) {
      setErrorMessage(error.message || "Activity log gagal dibersihkan.");
    } finally {
      setIsCleaningLogs(false);
      setConfirmation(null);
    }
  };

  const handleConfirmation = () => {
    if (confirmation?.type === "user-status") updateUserStatus(confirmation.user);
    if (confirmation?.type === "storage") cleanStorage();
    if (confirmation?.type === "activity") cleanActivity();
  };

  const confirmationBusy = Boolean(
    (confirmation?.type === "user-status" && actionUserId) ||
    (confirmation?.type === "storage" && isCleaningStorage) ||
    (confirmation?.type === "activity" && isCleaningLogs),
  );

  const confirmationCopy = useMemo(() => {
    if (confirmation?.type === "user-status") {
      const willActivate = !confirmation.user.is_active;
      return {
        title: willActivate ? "Aktifkan akun pengguna?" : "Nonaktifkan akun pengguna?",
        description: willActivate
          ? `Akun ${confirmation.user.name} akan dapat digunakan kembali.`
          : `Akun ${confirmation.user.name} tidak dapat digunakan sampai diaktifkan kembali.`,
        confirmLabel: willActivate ? "Aktifkan akun" : "Nonaktifkan akun",
        danger: !willActivate,
      };
    }
    if (confirmation?.type === "storage") {
      return {
        title: "Bersihkan gambar lama?",
        description: "File gambar prediksi lama akan dihapus sesuai proses backend. Record prediksi tetap disimpan.",
        confirmLabel: "Bersihkan storage",
        danger: true,
      };
    }
    return {
      title: "Hapus activity log lama?",
      description: "Activity log yang berusia lebih dari 90 hari akan dihapus dan tidak dapat dipulihkan.",
      confirmLabel: "Hapus log lama",
      danger: true,
    };
  }, [confirmation]);

  const handleDownloadReport = async () => {
    setIsDownloadingReport(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      await downloadAdminPredictionReport({
        startDate: reportFilter.start_date || undefined,
        endDate: reportFilter.end_date || undefined,
        predictedClass: reportFilter.predicted_class || undefined,
        userIds: selectedReportUsers.map((user) => user.id),
      });
      setSuccessMessage("Laporan Excel berhasil diunduh.");
    } catch (error) {
      setErrorMessage(error.message || "Laporan gagal diunduh.");
    } finally {
      setIsDownloadingReport(false);
    }
  };

  const toggleReportUser = (user) => {
    setSelectedReportUsers((current) => (
      current.some((item) => item.id === user.id)
        ? current.filter((item) => item.id !== user.id)
        : [...current, user]
    ));
  };

  if (!isAdmin) {
    return (
      <main className="admin-page admin-page--denied">
        <EmptyState
          icon="admin"
          title="Akses admin diperlukan"
          description="Halaman ini hanya dapat dibuka oleh akun dengan peran administrator."
        />
      </main>
    );
  }

  const renderSection = () => {
    if (activeTab === "users") {
      return (
        <AdminUsers
          users={users}
          search={usersSearch}
          onSearchChange={(value) => {
            usersSearchRef.current = value;
            setUsersSearch(value);
          }}
          onSearch={() => loadUsers(1)}
          pagination={usersPagination}
          pageSize={USERS_PAGE_SIZE}
          onPageChange={loadUsers}
          isLoading={isLoadingUsers}
          actionUserId={actionUserId}
          onStatusChange={(user) => setConfirmation({ type: "user-status", user })}
        />
      );
    }
    if (activeTab === "predictions") {
      return <AdminPredictions data={dashboardData} isLoading={isLoadingStats} />;
    }
    if (activeTab === "activity") {
      return (
        <AdminActivity
          logs={activityLogs}
          search={activitySearch}
          onSearchChange={(value) => {
            activitySearchRef.current = value;
            setActivitySearch(value);
          }}
          onSearch={() => loadActivity(1)}
          pagination={activityPagination}
          pageSize={ACTIVITY_PAGE_SIZE}
          onPageChange={loadActivity}
          isLoading={isLoadingActivity}
          isCleaning={isCleaningLogs}
          onCleanup={() => setConfirmation({ type: "activity" })}
        />
      );
    }
    if (activeTab === "storage") {
      return (
        <AdminStorage
          storageStats={storageStats}
          percentage={dashboardData.storagePercentage}
          statusLabel={storageStatusLabel}
          isLoading={isLoadingStorage}
          isCleaning={isCleaningStorage}
          onCleanup={() => setConfirmation({ type: "storage" })}
        />
      );
    }
    if (activeTab === "reports") {
      return (
        <AdminReports
          filter={reportFilter}
          onFilterChange={(field, value) => setReportFilter((current) => ({ ...current, [field]: value }))}
          onDownload={handleDownloadReport}
          isDownloading={isDownloadingReport}
          users={reportUsers}
          usersSearch={reportUsersSearch}
          onUsersSearchChange={(value) => {
            reportUsersSearchRef.current = value;
            setReportUsersSearch(value);
          }}
          onUsersSearch={loadReportUsers}
          selectedUsers={selectedReportUsers}
          onToggleUser={toggleReportUser}
          onRemoveUser={(userId) => setSelectedReportUsers((current) => (
            current.filter((user) => user.id !== userId)
          ))}
          onClearUsers={() => setSelectedReportUsers([])}
          isLoadingUsers={isLoadingReportUsers}
        />
      );
    }
    return (
      <AdminOverview
        data={dashboardData}
        isLoading={isLoadingStats || isLoadingStorage}
        onRefresh={() => Promise.all([loadStats(), loadStorage()])}
      />
    );
  };

  return (
    <main className="admin-page">
      <PageHeader
        eyebrow="Administrasi"
        title="Dashboard admin"
        description="Pantau pengguna, prediksi, aktivitas, storage, dan laporan SawitVision."
        actions={(
          <div className="admin-identity">
            <span>Administrator</span>
            <strong>{currentUser?.full_name || currentUser?.name || "Admin"}</strong>
          </div>
        )}
      />

      <div className="admin-workspace">
        <AdminSectionNav
          activeSection={activeTab}
          onChange={(section) => {
            setActiveTab(section);
            setErrorMessage("");
            setSuccessMessage("");
          }}
        />
        <div className="admin-content">
          {errorMessage && <Alert tone="error" role="alert">{errorMessage}</Alert>}
          {successMessage && <Alert tone="success" role="status">{successMessage}</Alert>}
          {renderSection()}
        </div>
      </div>

      <Modal
        open={Boolean(confirmation)}
        onClose={() => {
          if (!confirmationBusy) setConfirmation(null);
        }}
        title={confirmationCopy.title}
        eyebrow="Konfirmasi tindakan"
        role={confirmationCopy.danger ? "alertdialog" : "dialog"}
        closeOnBackdrop={!confirmationBusy}
        className="admin-confirmation-modal"
      >
        <p className="admin-confirmation-copy">{confirmationCopy.description}</p>
        <div className="admin-confirmation-actions">
          <Button
            type="button"
            variant="secondary"
            data-autofocus
            disabled={confirmationBusy}
            onClick={() => setConfirmation(null)}
          >
            Batal
          </Button>
          <Button
            type="button"
            variant={confirmationCopy.danger ? "danger" : "primary"}
            className={confirmationCopy.danger ? "admin-confirm-danger" : ""}
            disabled={confirmationBusy}
            onClick={handleConfirmation}
          >
            {confirmationCopy.danger && <Icon name="trash" size={18} />}
            {confirmationBusy ? "Memproses..." : confirmationCopy.confirmLabel}
          </Button>
        </div>
      </Modal>
    </main>
  );
}

export default AdminDashboardPage;
