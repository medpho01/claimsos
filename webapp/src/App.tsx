import React, { Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { UploadProvider, useUploadContext } from "./context/UploadContext";
import { UploadQueuePanel } from "./components/modals/PatientPhotosModal/components/UploadQueuePanel";
import LoginPage from "./pages/auth/LoginPage";
import SuperAdminPage from "./pages/superadmin/SuperAdminPage";
import HospitalDetailsPage from "./pages/superadmin/HospitalDetailsPage";
import PanelPatientsPage from "./pages/panels";
import { HospitalPortalLayout } from "./pages/hospital/Layout";
import "./App.css";

import AdminDashboardPage from "./pages/admin/AdminDashboardPage";

// Lazy load hospital portal pages
const HospitalDashboard = React.lazy(() => import("./pages/hospital/Dashboard"));
const HospitalPanelsPage = React.lazy(() => import("./pages/hospital/Panels"));
const HospitalUsersPage = React.lazy(() => import("./pages/hospital/Users"));
const HospitalPanelDetails = React.lazy(() => import("./pages/hospital/PanelDetails"));

// Admin Dashboard 
const DashboardWrapper: React.FC = () => {
  return <AdminDashboardPage />;
};

const PrivateRoute: React.FC<{ children: React.ReactElement; allowedRoles: string[] }> = ({
  children,
  allowedRoles,
}) => {
  const { isAuthenticated, user } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  if (!user || !allowedRoles.includes(user.role)) {
    return <Navigate to="/unauthorized" />;
  }

  return children;
};

const GlobalUploadPanel = () => {
  const {
    uploadQueue,
    isQueueVisible,
    isQueueMinimized,
    setIsQueueMinimized,
    setIsQueueVisible,
    retryUpload,
    cancelUpload,
    clearCompleted
  } = useUploadContext();

  return (
    <UploadQueuePanel
      uploadQueue={uploadQueue}
      isVisible={isQueueVisible}
      isMinimized={isQueueMinimized}
      setIsMinimized={setIsQueueMinimized}
      setIsVisible={setIsQueueVisible}
      onRetry={retryUpload}
      onCancel={cancelUpload}
      onClear={clearCompleted}
      usePortal={true} // Use portal for global display to sit on top of everything
    />
  );
};

const App: React.FC = () => {
  const getRedirectPath = () => {
    try {
      const userStr = localStorage.getItem("user");
      if (!userStr) return "/login";
      const user = JSON.parse(userStr);
      if (user?.role === "superadmin") return "/superadmin";
      if (user?.role === "hospital" && user?.hospital_id) return `/portal/${user.hospital_id}`;
      return "/dashboard";
    } catch {
      localStorage.removeItem("user");
      return "/login";
    }
  };

  return (
    <AuthProvider>
      <UploadProvider>
        <Toaster
          position="top-right"
          richColors
          closeButton
          toastOptions={{
            style: {
              background: 'white',
              border: '1px solid #e2e8f0',
              boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
            },
            duration: 4000,
          }}
        />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/dashboard"
              element={
                <PrivateRoute allowedRoles={["admin"]}>
                  <DashboardWrapper />
                </PrivateRoute>
              }
            />
            <Route
              path="/superadmin"
              element={
                <PrivateRoute allowedRoles={["superadmin"]}>
                  <SuperAdminPage />
                </PrivateRoute>
              }
            />
            <Route
              path="/hospital/:hospitalId"
              element={
                <PrivateRoute allowedRoles={["superadmin", "admin", "hospital"]}>
                  <HospitalDetailsPage />
                </PrivateRoute>
              }
            />
            <Route
              path="/hospital/:hospitalId/panel/:panelId"
              element={
                <PrivateRoute allowedRoles={["superadmin", "admin", "hospital"]}>
                  <PanelPatientsPage />
                </PrivateRoute>
              }
            />

            {/* Hospital Portal Routes with Persistent Layout */}
            <Route
              path="/portal/:hospitalId"
              element={
                <PrivateRoute allowedRoles={["hospital", "superadmin", "admin"]}>
                  <HospitalPortalLayout />
                </PrivateRoute>
              }
            >
              <Route index element={<HospitalDashboard />} />
              <Route path="panels" element={<HospitalPanelsPage />} />
              <Route path="users" element={<HospitalUsersPage />} />
              <Route path="panel/:panelId" element={<HospitalPanelDetails />} />
            </Route>

            <Route path="/unauthorized" element={<div className="error-page">Unauthorized Access</div>} />
            <Route
              path="/"
              element={<Navigate to={getRedirectPath()} />}
            />
          </Routes>
          <GlobalUploadPanel />
        </BrowserRouter>
      </UploadProvider>
    </AuthProvider>
  );
};

export default App;
