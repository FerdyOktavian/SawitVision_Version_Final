import { useEffect, useMemo, useRef, useState } from "react";
import {
  getCurrentUser,
  logoutUser,
  saveStoredUser,
  updateProfile,
  deleteMyAccount,
} from "../services/api";
import Alert from "../components/ui/Alert";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import FormField from "../components/ui/FormField";
import Icon from "../components/ui/Icon";
import LoadingState from "../components/ui/LoadingState";
import Modal from "../components/ui/Modal";
import PageHeader from "../components/ui/PageHeader";
import SegmentedControl from "../components/ui/SegmentedControl";
import { getStoredTheme, saveTheme } from "../utils/theme";

function normalizePhone(value = "") {
  return String(value).replace(/[^\d+]/g, "");
}

function resolveUser(response) {
  return response?.user || response?.data || response || null;
}

function ProfilePage({
  currentUser,
  onUserUpdated,
  onLogout,
  serverActionsUnavailable = false,
}) {
  const currentUserRef = useRef(currentUser);
  const onUserUpdatedRef = useRef(onUserUpdated);
  const initiallyServerUnavailableRef = useRef(serverActionsUnavailable);
  const [profile, setProfile] = useState(() => (
    serverActionsUnavailable ? currentUser : null
  ));
  const [fullName, setFullName] = useState(() => (
    serverActionsUnavailable ? currentUser?.full_name || "" : ""
  ));
  const [phoneNumber, setPhoneNumber] = useState(() => (
    serverActionsUnavailable ? currentUser?.phone_number || "" : ""
  ));
  const [fieldErrors, setFieldErrors] = useState({});
  const [isLoading, setIsLoading] = useState(
    () => !serverActionsUnavailable,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [theme, setTheme] = useState(() => getStoredTheme());

  useEffect(() => {
    let mounted = true;

    if (initiallyServerUnavailableRef.current) {
      return undefined;
    }

    async function loadProfile() {
      setIsLoading(true);
      setMessage("");

      try {
        const response = await getCurrentUser();
        const user = resolveUser(response);

        if (!mounted) return;

        setProfile(user);
        setFullName(user?.full_name || "");
        setPhoneNumber(user?.phone_number || "");

        if (user) {
          saveStoredUser(user);
          onUserUpdatedRef.current?.(user);
        }
      } catch (error) {
        if (!mounted) return;

        if (currentUserRef.current) {
          setProfile(currentUserRef.current);
          setFullName(currentUserRef.current?.full_name || "");
          setPhoneNumber(currentUserRef.current?.phone_number || "");
        } else {
          setMessageType("error");
          setMessage(error.message || "Profil gagal dimuat.");
        }
      } finally {
        if (mounted) setIsLoading(false);
      }
    }

    loadProfile();
    return () => {
      mounted = false;
    };
  }, []);

  const initials = useMemo(() => {
    const name = profile?.full_name || fullName || "Pengguna";
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("");
  }, [profile?.full_name, fullName]);

  const isDirty = useMemo(() => {
    const storedName = profile?.full_name || "";
    const storedPhone = profile?.phone_number || "";
    return (
      fullName.trim() !== storedName.trim() ||
      normalizePhone(phoneNumber) !== normalizePhone(storedPhone)
    );
  }, [fullName, phoneNumber, profile]);

  const handleCancelEdit = () => {
    setFullName(profile?.full_name || "");
    setPhoneNumber(profile?.phone_number || "");
    setFieldErrors({});
    setMessage("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (serverActionsUnavailable) return;
    setMessage("");
    setFieldErrors({});

    const cleanName = fullName.trim();
    const cleanPhone = normalizePhone(phoneNumber);

    if (cleanName.length < 2) {
      setFieldErrors({ fullName: "Nama minimal terdiri dari 2 karakter." });
      setMessageType("error");
      setMessage("Nama minimal terdiri dari 2 karakter.");
      return;
    }

    if (cleanPhone.length < 8) {
      setFieldErrors({ phoneNumber: "Nomor telepon belum valid." });
      setMessageType("error");
      setMessage("Nomor telepon belum valid.");
      return;
    }

    setIsSaving(true);

    try {
      await updateProfile({
        full_name: cleanName,
        phone_number: cleanPhone,
      });
      const freshResponse = await getCurrentUser();
      const updatedUser = resolveUser(freshResponse);

      if (!updatedUser) {
        throw new Error("Data pengguna terbaru tidak ditemukan.");
      }

      setProfile(updatedUser);
      setFullName(updatedUser.full_name || cleanName);
      setPhoneNumber(updatedUser.phone_number || cleanPhone);
      saveStoredUser(updatedUser);
      onUserUpdated?.(updatedUser);
      setMessageType("success");
      setMessage("Profil berhasil diperbarui dan disimpan.");
    } catch (error) {
      setMessageType("error");
      setMessage(error.message || "Profil gagal diperbarui.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logoutUser();
    } finally {
      onLogout?.();
    }
  };

  const handleDeleteAccount = async () => {
    if (serverActionsUnavailable) return;

    setIsDeleting(true);
    setMessage("");

    try {
      await deleteMyAccount();
      await logoutUser();
      onLogout?.();
    } catch (error) {
      setMessageType("error");
      setMessage(error.message || "Akun gagal dihapus.");
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const closeLogoutDialog = () => {
    if (!isLoggingOut) setShowLogoutDialog(false);
  };

  const closeDeleteDialog = () => {
    if (!isDeleting) setShowDeleteDialog(false);
  };

  if (isLoading) {
    return (
      <main className="profile-page">
        <PageHeader
          eyebrow="Akun"
          title="Profil"
          description="Kelola informasi akun dan sesi SawitVision Anda."
        />
        <Card className="profile-loading-card">
          <LoadingState
            title="Memuat profil..."
            description="Tunggu sebentar, data akun sedang disiapkan."
          />
        </Card>
      </main>
    );
  }

  const profileStatus = profile?.status;
  const isBusy = isSaving || isDeleting || isLoggingOut;

  return (
    <main className="profile-page">
      <PageHeader
        eyebrow="Akun"
        title="Profil"
        description="Periksa identitas akun, perbarui informasi login, dan kelola sesi Anda."
      />

      {serverActionsUnavailable && (
        <Alert tone="warning" role="note">
          Perubahan profil dan penghapusan akun memerlukan koneksi server.
        </Alert>
      )}

      <Card className="profile-identity" aria-labelledby="profile-identity-title">
        <div className="profile-avatar" aria-hidden="true">{initials}</div>
        <div className="profile-identity__primary">
          <p id="profile-identity-title">Identitas akun</p>
          <h2>{profile?.full_name || "Pengguna SawitVision"}</h2>
          <span>{profile?.phone_number || "Nomor telepon belum tersedia"}</span>
        </div>
        <dl className="profile-identity__metadata">
          <div>
            <dt>Peran</dt>
            <dd>{profile?.role === "admin" ? "Administrator" : "Pengguna"}</dd>
          </div>
          {profileStatus && (
            <div>
              <dt>Status</dt>
              <dd>{profileStatus}</dd>
            </div>
          )}
        </dl>
      </Card>

      <div className="profile-layout">
        <Card className="profile-section profile-editor" aria-labelledby="profile-editor-title">
          <header className="profile-section__header">
            <div>
              <p>Informasi profil</p>
              <h2 id="profile-editor-title">Data pengguna</h2>
            </div>
          </header>

          <form className="profile-form" onSubmit={handleSubmit} noValidate>
            <FormField
              id="profile-full-name"
              label="Nama lengkap"
              hint="Nama ini ditampilkan sebagai identitas akun Anda."
              error={fieldErrors.fullName}
              type="text"
              value={fullName}
              onChange={(event) => {
                setFullName(event.target.value);
                setFieldErrors((errors) => ({ ...errors, fullName: undefined }));
              }}
              placeholder="Masukkan nama"
              autoComplete="name"
              disabled={isBusy}
              required
            />

            <FormField
              id="profile-phone-number"
              label="Nomor telepon"
              hint="Nomor baru akan digunakan untuk login berikutnya."
              error={fieldErrors.phoneNumber}
              type="tel"
              value={phoneNumber}
              onChange={(event) => {
                setPhoneNumber(event.target.value);
                setFieldErrors((errors) => ({ ...errors, phoneNumber: undefined }));
              }}
              placeholder="Contoh: 081234567890"
              inputMode="tel"
              autoComplete="tel"
              disabled={isBusy}
              required
            />

            {message && (
              <Alert tone={messageType} role={messageType === "error" ? "alert" : "status"}>
                {message}
              </Alert>
            )}

            <div className="profile-form__actions">
              <Button
                type="button"
                variant="secondary"
                onClick={handleCancelEdit}
                disabled={!isDirty || isBusy}
              >
                Batalkan
              </Button>
              <Button
                type="submit"
                disabled={!isDirty || isBusy || serverActionsUnavailable}
              >
                <Icon name="check" size={18} />
                {isSaving ? "Menyimpan..." : "Simpan perubahan"}
              </Button>
            </div>
          </form>
        </Card>

        <aside className="profile-actions" aria-label="Tindakan akun">
          <Card className="profile-section profile-appearance" aria-labelledby="profile-appearance-title">
            <header className="profile-section__header">
              <div>
                <p>Tampilan</p>
                <h2 id="profile-appearance-title">Tema</h2>
              </div>
            </header>
            <p className="profile-section__description">
              Atur tampilan SawitVision di perangkat ini.
            </p>
            <SegmentedControl
              value={theme}
              onChange={(nextTheme) => setTheme(saveTheme(nextTheme))}
              label="Pilih tema tampilan"
              options={[
                { value: "light", label: "Terang" },
                { value: "dark", label: "Gelap" },
              ]}
            />
          </Card>

          <Card className="profile-section profile-session" aria-labelledby="profile-session-title">
            <header className="profile-section__header">
              <div>
                <p>Sesi</p>
                <h2 id="profile-session-title">Akses akun</h2>
              </div>
              <Icon name="logout" size={20} />
            </header>
            <p className="profile-section__description">
              Keluar dengan aman dari akun yang sedang digunakan di perangkat ini.
            </p>
            <Button
              type="button"
              variant="secondary"
              block
              onClick={() => setShowLogoutDialog(true)}
              disabled={isBusy}
            >
              <Icon name="logout" size={18} />
              Keluar dari akun
            </Button>
          </Card>

          {profile?.role !== "admin" && (
            <section className="profile-danger" aria-labelledby="profile-danger-title">
              <div className="profile-danger__heading">
                <Icon name="warning" size={20} />
                <div>
                  <p>Tindakan berisiko</p>
                  <h2 id="profile-danger-title">Hapus akun</h2>
                </div>
              </div>
              <p>
                Data akun akan dihapus sesuai proses yang berlaku saat ini. Tindakan ini tidak dapat dibatalkan.
              </p>
              <Button
                type="button"
                variant="danger"
                block
                onClick={() => setShowDeleteDialog(true)}
                disabled={isBusy || serverActionsUnavailable}
              >
                <Icon name="trash" size={18} />
                Hapus akun
              </Button>
            </section>
          )}
        </aside>
      </div>

      <Modal
        open={showLogoutDialog}
        onClose={closeLogoutDialog}
        title="Keluar dari akun?"
        eyebrow="Konfirmasi sesi"
        closeOnBackdrop={!isLoggingOut}
        className="profile-confirmation-modal"
      >
        <p className="profile-dialog-copy">
          Anda perlu masuk kembali untuk menggunakan SawitVision.
        </p>
        <div className="profile-dialog-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={closeLogoutDialog}
            disabled={isLoggingOut}
            data-autofocus
          >
            Batal
          </Button>
          <Button type="button" onClick={handleLogout} disabled={isLoggingOut}>
            <Icon name="logout" size={18} />
            {isLoggingOut ? "Sedang keluar..." : "Keluar"}
          </Button>
        </div>
      </Modal>

      <Modal
        open={showDeleteDialog}
        onClose={closeDeleteDialog}
        title="Hapus akun secara permanen?"
        eyebrow="Tindakan permanen"
        role="alertdialog"
        closeOnBackdrop={!isDeleting}
        className="profile-confirmation-modal profile-delete-modal"
      >
        <Alert tone="warning">
          Data akun akan dihapus sesuai proses backend yang berlaku saat ini. Tindakan ini tidak dapat dibatalkan.
        </Alert>
        <p className="profile-dialog-copy">
          Pastikan Anda memang ingin menghapus akun <strong>{profile?.full_name || "ini"}</strong> sebelum melanjutkan.
        </p>
        <div className="profile-dialog-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={closeDeleteDialog}
            disabled={isDeleting}
            data-autofocus
          >
            Batal
          </Button>
          <Button
            type="button"
            variant="danger"
            className="profile-delete-confirm"
            onClick={handleDeleteAccount}
            disabled={isDeleting || serverActionsUnavailable}
          >
            <Icon name="trash" size={18} />
            {isDeleting ? "Menghapus akun..." : "Hapus akun"}
          </Button>
        </div>
      </Modal>
    </main>
  );
}

export default ProfilePage;
