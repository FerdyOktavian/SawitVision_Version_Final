import { useEffect, useState } from "react";

import {
  activateServiceWorkerUpdate,
  getServiceWorkerUpdateState,
  subscribeToServiceWorkerUpdates,
} from "../pwa/registerServiceWorker";
import Button from "./ui/Button";
import Icon from "./ui/Icon";

function PwaUpdateBanner() {
  const [updateState, setUpdateState] = useState(
    getServiceWorkerUpdateState,
  );
  const [isOnline, setIsOnline] = useState(
    () => navigator.onLine !== false,
  );

  useEffect(
    () => subscribeToServiceWorkerUpdates(setUpdateState),
    [],
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!isOnline || !updateState.updateAvailable) {
    return null;
  }

  return (
    <aside
      className="app-update-banner"
      role="status"
      aria-labelledby="app-update-title"
      aria-live="polite"
    >
      <div className="app-update-banner-icon" aria-hidden="true">
        <Icon name="refresh" size={20} />
      </div>
      <div className="app-update-banner-copy">
        <strong id="app-update-title">Pembaruan tersedia</strong>
        <span>Versi terbaru SawitVision sudah siap.</span>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={activateServiceWorkerUpdate}
        disabled={updateState.isActivating}
        aria-busy={updateState.isActivating}
      >
        {updateState.isActivating
          ? "Memuat ulang..."
          : "Muat ulang sekarang"}
      </Button>
    </aside>
  );
}

export default PwaUpdateBanner;
