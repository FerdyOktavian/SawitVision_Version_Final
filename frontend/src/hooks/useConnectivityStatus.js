import { useSyncExternalStore } from "react";

function subscribe(onStoreChange) {
  globalThis.addEventListener?.("online", onStoreChange);
  globalThis.addEventListener?.("offline", onStoreChange);

  return () => {
    globalThis.removeEventListener?.("online", onStoreChange);
    globalThis.removeEventListener?.("offline", onStoreChange);
  };
}

function getSnapshot() {
  return globalThis.navigator?.onLine !== false;
}

export default function useConnectivityStatus() {
  const isOnline = useSyncExternalStore(subscribe, getSnapshot, () => true);

  return {
    isOnline,
    definitelyOffline: !isOnline,
  };
}
