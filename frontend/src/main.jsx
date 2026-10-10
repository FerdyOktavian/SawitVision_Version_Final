import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.jsx";
import PwaUpdateBanner from "./components/PwaUpdateBanner";
import { registerServiceWorker } from "./pwa/registerServiceWorker";
import { initializeTheme } from "./utils/theme";

initializeTheme();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <PwaUpdateBanner />
    <App />
  </StrictMode>,
);

registerServiceWorker();
