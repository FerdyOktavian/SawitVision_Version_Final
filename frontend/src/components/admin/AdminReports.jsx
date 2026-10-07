import Button from "../ui/Button";
import Card from "../ui/Card";
import Icon from "../ui/Icon";

function AdminReports({
  filter,
  onFilterChange,
  onDownload,
  isDownloading,
  users,
  usersSearch,
  onUsersSearchChange,
  onUsersSearch,
  selectedUsers,
  onToggleUser,
  onRemoveUser,
  onClearUsers,
  isLoadingUsers,
}) {
  const selectedUserIds = new Set(selectedUsers.map((user) => user.id));

  return (
    <section className="admin-section" aria-labelledby="admin-reports-title">
      <header className="admin-section-header">
        <div>
          <p>Laporan Excel</p>
          <h2 id="admin-reports-title">Unduh laporan prediksi</h2>
        </div>
      </header>

      <Card className="admin-report-card">
        <div className="admin-report-intro">
          <span aria-hidden="true"><Icon name="download" size={23} /></span>
          <div>
            <h3>Laporan global SawitVision</h3>
            <p>Gunakan filter yang tersedia, lalu unduh data prediksi dalam format Excel.</p>
          </div>
        </div>

        <div className="admin-report-form">
          <label>
            <span>Tanggal awal</span>
            <input
              type="date"
              value={filter.start_date}
              onChange={(event) => onFilterChange("start_date", event.target.value)}
              disabled={isDownloading}
            />
          </label>
          <label>
            <span>Tanggal akhir</span>
            <input
              type="date"
              value={filter.end_date}
              onChange={(event) => onFilterChange("end_date", event.target.value)}
              disabled={isDownloading}
            />
          </label>
          <label>
            <span>Kelas ringkasan</span>
            <select
              value={filter.predicted_class}
              onChange={(event) => onFilterChange("predicted_class", event.target.value)}
              disabled={isDownloading}
            >
              <option value="">Semua kelas</option>
              <option value="belum_masak">Belum Matang</option>
              <option value="masak">Matang</option>
              <option value="terlalu_masak">Terlalu Matang</option>
            </select>
          </label>
        </div>

        <fieldset className="admin-report-user-filter" disabled={isDownloading}>
          <legend>Pengguna</legend>
          <p className="admin-report-user-filter__hint">
            Tanpa pilihan khusus, laporan mencakup semua pengguna.
          </p>

          <form
            className="admin-report-user-search"
            onSubmit={(event) => {
              event.preventDefault();
              onUsersSearch();
            }}
          >
            <label htmlFor="admin-report-user-search">Cari nama pengguna</label>
            <div>
              <input
                id="admin-report-user-search"
                type="search"
                value={usersSearch}
                onChange={(event) => onUsersSearchChange(event.target.value)}
                placeholder="Masukkan nama pengguna..."
                disabled={isDownloading}
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={isDownloading || isLoadingUsers}
              >
                {isLoadingUsers ? "Mencari..." : "Cari"}
              </Button>
            </div>
          </form>

          <div className="admin-report-selected-users" aria-live="polite">
            <div className="admin-report-selected-users__header">
              <span>
                {selectedUsers.length > 0
                  ? `${selectedUsers.length} pengguna dipilih`
                  : "Semua pengguna"}
              </span>
              {selectedUsers.length > 0 && (
                <button type="button" onClick={onClearUsers}>
                  Pilih semua pengguna
                </button>
              )}
            </div>

            {selectedUsers.length > 0 && (
              <div className="admin-report-user-chips">
                {selectedUsers.map((user) => (
                  <span className="admin-report-user-chip" key={user.id}>
                    {user.name || "Tanpa nama"}
                    <button
                      type="button"
                      onClick={() => onRemoveUser(user.id)}
                      aria-label={`Hapus ${user.name || "pengguna"} dari filter`}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="admin-report-user-options" aria-label="Hasil pencarian pengguna">
            {isLoadingUsers ? (
              <p>Memuat pengguna...</p>
            ) : users.length === 0 ? (
              <p>Tidak ada pengguna yang ditemukan.</p>
            ) : (
              users.map((user) => (
                <label key={user.id}>
                  <input
                    type="checkbox"
                    checked={selectedUserIds.has(user.id)}
                    onChange={() => onToggleUser(user)}
                  />
                  <span>
                    <strong>{user.name || "Tanpa nama"}</strong>
                    <small>{user.phone_number || "Nomor telepon tidak tersedia"}</small>
                  </span>
                </label>
              ))
            )}
          </div>
        </fieldset>

        <div className="admin-report-actions">
          <Button type="button" onClick={onDownload} disabled={isDownloading}>
            <Icon name="download" size={18} />
            {isDownloading ? "Menyiapkan laporan..." : "Unduh laporan Excel"}
          </Button>
        </div>
      </Card>
    </section>
  );
}

export default AdminReports;
