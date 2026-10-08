function register() {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    // PWA support is progressive enhancement; app startup must continue.
  });
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  if (document.readyState === "complete") {
    queueMicrotask(register);
    return;
  }

  window.addEventListener("load", register, { once: true });
}
