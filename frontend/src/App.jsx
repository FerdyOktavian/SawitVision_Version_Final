import { useEffect, useState } from "react";

import AppHeader from "./components/AppHeader";
import AppFooter from "./components/AppFooter";
import BottomNav from "./components/BottomNav";

import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotAccountPage from "./pages/ForgotAccountPage";
import PredictionPage from "./pages/PredictionPage";
import SavedPhotosPage from "./pages/SavedPhotosPage";
import HistoryPage from "./pages/HistoryPage";
import ProfilePage from "./pages/ProfilePage";
import AboutPage from "./pages/AboutPage";
import AdminDashboardPage from "./pages/admin/AdminDashboardPage";
import Icon from "./components/ui/Icon";
import LoadingState from "./components/ui/LoadingState";

import {
  clearAuthSession,
  getCurrentUser,
  getStoredUser,
} from "./services/api";

import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/ui.css";
import "./styles/auth.css";
import "./styles/home.css";
import "./styles/navigation.css";
import "./styles/footer.css";
import "./styles/prediction.css";
import "./styles/saved-photos.css";
import "./styles/history.css";
import "./styles/profile.css";
import "./styles/about.css";
import "./styles/admin.css";

const ACTIVE_PAGE_KEY = "sawitvision_v3_active_page";

const VALID_PAGES = [
  "home",
  "prediction",
  "saved-photos",
  "history",
  "profile",
  "about",
  "admin",
];

function getInitialActivePage() {
  const savedPage = localStorage.getItem(ACTIVE_PAGE_KEY);

  if (savedPage && VALID_PAGES.includes(savedPage)) {
    return savedPage;
  }

  return "home";
}

function App() {
  // =====================================================
  // AUTH PAGE
  // login | register | forgot-account
  // =====================================================
  const [authPage, setAuthPage] = useState("login");

  // Data akun yang ditemukan dari fitur lupa akun.
  // Nantinya bisa digunakan untuk mengisi form login otomatis.
  const [recoveredAccount, setRecoveredAccount] = useState(null);

  const [activePage, setActivePage] = useState(() => getInitialActivePage());

  const [currentUser, setCurrentUser] = useState(() => getStoredUser());

  const [isCheckingSession, setIsCheckingSession] = useState(true);

  // =====================================================
  // CEK SESSION SAAT APP PERTAMA DIBUKA / REFRESH
  // =====================================================
  useEffect(() => {
    const checkSession = async () => {
      const storedUser = getStoredUser();

      if (!storedUser) {
        setCurrentUser(null);
        setIsCheckingSession(false);

        localStorage.removeItem(ACTIVE_PAGE_KEY);

        return;
      }

      try {
        const response = await getCurrentUser();

        // Aman untuk dua kemungkinan response:
        // { user: {...} }
        // atau langsung {...}
        const freshUser = response?.user || response;

        setCurrentUser(freshUser);

        // Kalau page terakhir admin,
        // tapi user sekarang bukan admin,
        // paksa kembali ke home.
        const savedPage = localStorage.getItem(ACTIVE_PAGE_KEY);

        if (savedPage === "admin" && freshUser?.role !== "admin") {
          setActivePage("home");

          localStorage.setItem(ACTIVE_PAGE_KEY, "home");
        }
      } catch {
        clearAuthSession();

        localStorage.removeItem(ACTIVE_PAGE_KEY);

        setCurrentUser(null);
        setActivePage("home");
      } finally {
        setIsCheckingSession(false);
      }
    };

    checkSession();
  }, []);

  // =====================================================
  // NAVIGASI
  // =====================================================
  const handleNavigate = (pageName) => {
    if (!VALID_PAGES.includes(pageName)) {
      return;
    }

    // Proteksi tambahan frontend admin.
    if (pageName === "admin" && currentUser?.role !== "admin") {
      setActivePage("home");

      localStorage.setItem(ACTIVE_PAGE_KEY, "home");

      return;
    }

    setActivePage(pageName);

    localStorage.setItem(ACTIVE_PAGE_KEY, pageName);

    window.scrollTo({
      top: 0,
      left: 0,
      behavior: "auto",
    });
  };

  // =====================================================
  // LOGIN
  // =====================================================
  const handleLoginSuccess = (user) => {
    setCurrentUser(user);

    setRecoveredAccount(null);

    setActivePage("home");

    localStorage.setItem(ACTIVE_PAGE_KEY, "home");
  };

  // =====================================================
  // REGISTER
  // =====================================================
  const handleRegisterSuccess = () => {
    setRecoveredAccount(null);

    setAuthPage("login");
  };

  // =====================================================
  // LUPA AKUN
  // =====================================================

  // Dibuka dari LoginPage
  const handleGoToForgotAccount = () => {
    setRecoveredAccount(null);

    setAuthPage("forgot-account");
  };

  // Ketika akun berhasil ditemukan berdasarkan nomor telepon.
  const handleAccountRecovered = (account) => {
    setRecoveredAccount(account);

    setAuthPage("login");
  };

  // Kembali dari halaman lupa akun ke login.
  const handleBackToLogin = () => {
    setAuthPage("login");
  };

  // =====================================================
  // LOGOUT
  // =====================================================
  const handleLogout = () => {
    clearAuthSession();

    localStorage.removeItem(ACTIVE_PAGE_KEY);

    setCurrentUser(null);
    setActivePage("home");
    setAuthPage("login");
    setRecoveredAccount(null);
  };

  // =====================================================
  // RENDER PAGE
  // =====================================================
  const renderActivePage = () => {
    if (activePage === "home") {
      return (
        <HomePage
          currentUser={currentUser}
          onStartPrediction={() => handleNavigate("prediction")}
          onOpenHistory={() => handleNavigate("history")}
          onOpenProfile={() => handleNavigate("profile")}
        />
      );
    }

    if (activePage === "prediction") {
      return (
        <PredictionPage
          currentUser={currentUser}
          onOpenHistory={() => handleNavigate("history")}
          onOpenSavedPhotos={() => handleNavigate("saved-photos")}
        />
      );
    }

    if (activePage === "saved-photos") {
      return (
        <SavedPhotosPage
          currentUser={currentUser}
          onBack={() => handleNavigate("prediction")}
        />
      );
    }

    if (activePage === "history") {
      return (
        <HistoryPage
          currentUser={currentUser}
          onStartPrediction={() => handleNavigate("prediction")}
        />
      );
    }

    if (activePage === "profile") {
      return (
        <ProfilePage
          currentUser={currentUser}
          onUserUpdated={(updatedUser) => {
            setCurrentUser(updatedUser);
          }}
          onLogout={handleLogout}
        />
      );
    }

    if (activePage === "about") {
      return (
        <AboutPage
          currentUser={currentUser}
          onStartPrediction={() => handleNavigate("prediction")}
          onOpenHistory={() => handleNavigate("history")}
        />
      );
    }

    if (activePage === "admin" && currentUser?.role === "admin") {
      return <AdminDashboardPage currentUser={currentUser} />;
    }

    return (
      <HomePage
        currentUser={currentUser}
        onStartPrediction={() => handleNavigate("prediction")}
        onOpenHistory={() => handleNavigate("history")}
        onOpenProfile={() => handleNavigate("profile")}
      />
    );
  };

  // =====================================================
  // LOADING SESSION
  // =====================================================
  if (isCheckingSession) {
    return (
      <main className="app-loading-page">
        <div className="app-loading-card" aria-labelledby="app-loading-title">
          <div className="app-loading-mark" aria-hidden="true">
            <Icon name="leaf" size={30} />
          </div>
          <h1 id="app-loading-title">SawitVision</h1>
          <LoadingState
            title="Memeriksa sesi pengguna..."
            description="Menyiapkan ruang kerja Anda."
          />
        </div>
      </main>
    );
  }

  // =====================================================
  // BELUM LOGIN
  // =====================================================
  if (!currentUser) {
    // ===================================================
    // REGISTER
    // ===================================================
    if (authPage === "register") {
      return (
        <RegisterPage
          onGoToLogin={() => {
            setRecoveredAccount(null);
            setAuthPage("login");
          }}
          onRegisterSuccess={handleRegisterSuccess}
        />
      );
    }

    // ===================================================
    // LUPA AKUN
    // ===================================================
    if (authPage === "forgot-account") {
      return (
        <ForgotAccountPage
          onGoToLogin={handleBackToLogin}
          onAccountRecovered={handleAccountRecovered}
        />
      );
    }

    // ===================================================
    // LOGIN
    // ===================================================
    return (
      <LoginPage
        onLoginSuccess={handleLoginSuccess}
        onGoToRegister={() => {
          setRecoveredAccount(null);
          setAuthPage("register");
        }}
        onGoToForgotAccount={handleGoToForgotAccount}
        recoveredAccount={recoveredAccount}
      />
    );
  }

  // =====================================================
  // SUDAH LOGIN
  // =====================================================
  return (
    <div className="app-shell">
      <AppHeader currentUser={currentUser} onNavigate={handleNavigate} />

      {renderActivePage()}

      {activePage !== "admin" && <AppFooter />}

      <BottomNav
        activePage={activePage === "saved-photos" ? "prediction" : activePage}
        onNavigate={handleNavigate}
        currentUser={currentUser}
      />
    </div>
  );
}

export default App;
