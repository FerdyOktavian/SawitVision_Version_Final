const MANAGED_RELOAD_KEY = "sawitvision_pwa_managed_reload";
const ACTIVATION_TIMEOUT_MS = 15000;

const listeners = new Set();

let registration = null;
let registrationPromise = null;
let waitingWorker = null;
let activationPromise = null;
let state = {
  updateAvailable: false,
  isActivating: false,
};

function readManagedReloadGuard() {
  let guarded = false;

  try {
    guarded = sessionStorage.getItem(MANAGED_RELOAD_KEY) === "1";

    if (guarded) {
      sessionStorage.removeItem(MANAGED_RELOAD_KEY);
    }
  } catch {
    // Fall through to the navigation-history guard.
  }

  try {
    const historyState = window.history.state;
    const historyGuarded = (
      historyState?.[MANAGED_RELOAD_KEY] === true
    );

    if (historyGuarded) {
      const nextState = { ...historyState };
      delete nextState[MANAGED_RELOAD_KEY];
      window.history.replaceState(nextState, "", window.location.href);
    }

    return guarded || historyGuarded;
  } catch {
    return guarded;
  }
}

function isReloadNavigation() {
  const navigation = performance.getEntriesByType?.("navigation")?.[0];
  return navigation?.type === "reload";
}

const arrivedAfterManagedReload = readManagedReloadGuard();
const shouldActivateOnStartup = (
  isReloadNavigation() && !arrivedAfterManagedReload
);
let startupActivationHandled = false;

function publishState(nextState) {
  state = { ...state, ...nextState };
  listeners.forEach((listener) => listener(state));
}

function markManagedReload() {
  try {
    sessionStorage.setItem(MANAGED_RELOAD_KEY, "1");
  } catch {
    // The history-state guard below remains available when storage is blocked.
  }

  try {
    window.history.replaceState(
      {
        ...(window.history.state || {}),
        [MANAGED_RELOAD_KEY]: true,
      },
      "",
      window.location.href,
    );
  } catch {
    // An in-memory guard still guarantees one reload in this document.
  }
}

function clearWaitingWorker(worker) {
  if (waitingWorker !== worker) return;

  waitingWorker = null;
  publishState({
    updateAvailable: false,
    isActivating: false,
  });
}

function trackWaitingWorker(worker) {
  if (!worker || worker === waitingWorker) return;

  waitingWorker = worker;
  publishState({
    updateAvailable: true,
    isActivating: false,
  });

  worker.addEventListener("statechange", () => {
    if (
      worker.state === "redundant"
      || (worker.state === "activated" && !activationPromise)
    ) {
      clearWaitingWorker(worker);
    }
  });

  if (shouldActivateOnStartup && !startupActivationHandled) {
    startupActivationHandled = true;
    void activateServiceWorkerUpdate();
  }
}

function inspectRegistration(nextRegistration) {
  registration = nextRegistration;

  if (registration.waiting) {
    trackWaitingWorker(registration.waiting);
  }

  registration.addEventListener("updatefound", () => {
    const installingWorker = registration.installing;

    if (!installingWorker) return;

    installingWorker.addEventListener("statechange", () => {
      if (
        installingWorker.state === "installed"
        && navigator.serviceWorker.controller
        && registration.waiting
      ) {
        trackWaitingWorker(registration.waiting);
      }
    });
  });
}

async function register() {
  try {
    const nextRegistration = await navigator.serviceWorker.register(
      "/sw.js",
      { scope: "/" },
    );

    inspectRegistration(nextRegistration);

    if (navigator.onLine !== false) {
      try {
        await nextRegistration.update();

        if (nextRegistration.waiting) {
          trackWaitingWorker(nextRegistration.waiting);
        }
      } catch {
        // Update discovery is best-effort and must not block app startup.
      }
    }

    return nextRegistration;
  } catch {
    // PWA support is progressive enhancement; app startup must continue.
    return null;
  }
}

export function getServiceWorkerUpdateState() {
  return state;
}

export function subscribeToServiceWorkerUpdates(listener) {
  listeners.add(listener);
  listener(state);

  return () => listeners.delete(listener);
}

export function activateServiceWorkerUpdate() {
  const worker = registration?.waiting || waitingWorker;

  if (!worker) {
    return Promise.resolve(false);
  }

  if (activationPromise) {
    return activationPromise;
  }

  publishState({
    updateAvailable: true,
    isActivating: true,
  });

  activationPromise = new Promise((resolve) => {
    let reloadStarted = false;

    const reloadOnce = () => {
      if (reloadStarted) return;

      reloadStarted = true;
      markManagedReload();
      window.location.reload();
    };

    const handleControllerChange = () => {
      window.clearTimeout(activationTimeout);
      reloadOnce();
      resolve(true);
    };

    const activationTimeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
      activationPromise = null;
      publishState({
        updateAvailable: Boolean(registration?.waiting),
        isActivating: false,
      });
      resolve(false);
    }, ACTIVATION_TIMEOUT_MS);

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
      { once: true },
    );

    worker.addEventListener("statechange", () => {
      if (worker.state !== "activated") return;

      // With clientsClaim disabled, activation may precede controllerchange.
      // The next navigation is safe to load through the newly active worker.
      window.setTimeout(reloadOnce, 100);
    });

    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch {
      window.clearTimeout(activationTimeout);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
      activationPromise = null;
      publishState({
        updateAvailable: true,
        isActivating: false,
      });
      resolve(false);
    }
  });

  return activationPromise;
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  const startRegistration = () => {
    if (!registrationPromise) {
      registrationPromise = register();
    }
  };

  if (document.readyState === "complete") {
    queueMicrotask(startRegistration);
    return;
  }

  window.addEventListener("load", startRegistration, { once: true });
}
