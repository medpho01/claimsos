import React, { Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { UploadProvider, useUploadContext } from "./context/UploadContext";
import { ConfirmProvider } from "./lib/confirm";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { UploadQueuePanel } from "./components/modals/PatientPhotosModal/components/UploadQueuePanel";
import LoginPage from "./pages/auth/LoginPage";
import SuperAdminPage from "./pages/superadmin/SuperAdminPage";
// HospitalDetailsPage + PanelPatientsPage have been removed — the legacy
// /hospital/:id routes redirect to /portal/:id. The HospitalDetailsPage
// folder is now a leaf module: only its components/hooks/utils are
// imported by the new portal layout.
import { HospitalPortalLayout } from "./pages/hospital/Layout";
import "./App.css";

import AdminDashboardPage from "./pages/admin/AdminDashboardPage";

// Lazy load hospital portal pages
const HospitalDashboard = React.lazy(() => import("./pages/hospital/Dashboard"));
const HospitalPatientsPage = React.lazy(() => import("./pages/hospital/Patients"));
const HospitalPatientDetail = React.lazy(() => import("./pages/hospital/PatientDetail"));
const HospitalPatientEdit = React.lazy(() => import("./pages/hospital/PatientEdit"));
const HospitalPanelsPage = React.lazy(() => import("./pages/hospital/Panels"));
const HospitalPanelDetails = React.lazy(() => import("./pages/hospital/PanelDetails"));
const HospitalProfilePage = React.lazy(() => import("./pages/hospital/Profile"));
const HospitalCashlessSettings = React.lazy(() => import("./pages/hospital/CashlessSettings"));
const HospitalDirectory = React.lazy(() => import("./pages/HospitalDirectory"));
const PublicHospitalProfile = React.lazy(() => import("./pages/PublicHospitalProfile"));

// Lazy load doctor pages
// Intelligence Layer (Waves 1-5) — admin + hospital surfaces
const SuperadminEvalDashboard = React.lazy(() => import("./pages/superadmin/EvalDashboard"));
const SuperadminCostDashboard = React.lazy(() => import("./pages/superadmin/CostDashboard"));
const SuperadminOntologyManager = React.lazy(() => import("./pages/superadmin/OntologyManager"));
const SuperadminRulesConfigurator = React.lazy(() => import("./pages/superadmin/RulesConfigurator"));
const SuperadminKbPatternReview = React.lazy(() => import("./pages/superadmin/KbPatternReview"));
const HospitalAdjudicationView = React.lazy(() => import("./pages/hospital/AdjudicationView"));
const HospitalActionQueue = React.lazy(() => import("./pages/hospital/ActionQueue"));
const HospitalClaimAISummary = React.lazy(() => import("./pages/hospital/ClaimAISummary"));

const RegisterDoctor = React.lazy(() => import("./pages/auth/RegisterDoctor"));
const DoctorDirectory = React.lazy(() => import("./pages/doctors/DoctorDirectory"));
const PublicDoctorProfile = React.lazy(() => import("./pages/doctor/PublicDoctorProfile"));
const DoctorProfilePage = React.lazy(() => import("./pages/doctor/DoctorProfilePage"));

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

// UI Revamp: legacy /hospital/:id routes redirect to the new workspace.
const HospitalLegacyRedirect: React.FC = () => {
  const { isAuthenticated, user } = useAuth();
  const { hospitalId } = useParams<{ hospitalId: string }>();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!user || !["superadmin", "admin", "hospital"].includes(user.role))
    return <Navigate to="/unauthorized" replace />;
  return <Navigate to={`/portal/${hospitalId}`} replace />;
};

const HospitalPanelLegacyRedirect: React.FC = () => {
  const { isAuthenticated, user } = useAuth();
  const { hospitalId, panelId } = useParams<{ hospitalId: string; panelId: string }>();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!user || !["superadmin", "admin", "hospital"].includes(user.role))
    return <Navigate to="/unauthorized" replace />;
  return <Navigate to={`/portal/${hospitalId}/panel/${panelId}`} replace />;
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
      if (user?.role === "doctor") return "/doctor/profile";
      return "/dashboard";
    } catch {
      localStorage.removeItem("user");
      return "/login";
    }
  };

  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <UploadProvider>
        <ConfirmProvider>
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
              path="/public-profile/:token"
              element={
                <Suspense fallback={<div>Loading...</div>}>
                  <PublicHospitalProfile />
                </Suspense>
              }
            />
            <Route
              path="/hospitals/share/:token"
              element={
                <Suspense fallback={<div>Loading...</div>}>
                  <PublicHospitalProfile />
                </Suspense>
              }
            />
            <Route
              path="/dashboard"
              element={
                <PrivateRoute allowedRoles={["admin"]}>
                  <DashboardWrapper />
                </PrivateRoute>
              }
            />
            {/*
              QA C-1: every superadmin section is now a real URL
              (`/superadmin/dashboard`, `/superadmin/hospitals`, etc.) so
              refresh / browser back-forward / "open in new tab" all work.
              `/superadmin` alone redirects to the dashboard tab.
            */}
            <Route
              path="/superadmin"
              element={<Navigate to="/superadmin/dashboard" replace />}
            />
            {/* Intelligence Layer admin pages — declared BEFORE /superadmin/:tab so they win. */}
            <Route
              path="/superadmin/eval"
              element={
                <PrivateRoute allowedRoles={["superadmin"]}>
                  <Suspense fallback={<div>Loading...</div>}><SuperadminEvalDashboard /></Suspense>
                </PrivateRoute>
              }
            />
            <Route
              path="/superadmin/cost"
              element={
                <PrivateRoute allowedRoles={["superadmin"]}>
                  <Suspense fallback={<div>Loading...</div>}><SuperadminCostDashboard /></Suspense>
                </PrivateRoute>
              }
            />
            <Route
              path="/superadmin/ontology"
              element={
                <PrivateRoute allowedRoles={["superadmin"]}>
                  <Suspense fallback={<div>Loading...</div>}><SuperadminOntologyManager /></Suspense>
                </PrivateRoute>
              }
            />
            <Route
              path="/superadmin/rules"
              element={
                <PrivateRoute allowedRoles={["superadmin"]}>
                  <Suspense fallback={<div>Loading...</div>}><SuperadminRulesConfigurator /></Suspense>
                </PrivateRoute>
              }
            />
            <Route
              path="/superadmin/kb-patterns"
              element={
                <PrivateRoute allowedRoles={["superadmin"]}>
                  <Suspense fallback={<div>Loading...</div>}><SuperadminKbPatternReview /></Suspense>
                </PrivateRoute>
              }
            />
            <Route
              path="/superadmin/:tab"
              element={
                <PrivateRoute allowedRoles={["superadmin"]}>
                  <SuperAdminPage />
                </PrivateRoute>
              }
            />
            {/*
              UI Revamp: the legacy /hospital/:id and /hospital/:id/panel/:panelId
              routes are consolidated into the new Hospital Workspace at
              /portal/:hospitalId (per wireframe `hw-overview`). Both routes
              now redirect, preserving existing deep links and bookmarks.
            */}
            <Route
              path="/hospital/:hospitalId"
              element={<HospitalLegacyRedirect />}
            />
            <Route
              path="/hospital/:hospitalId/panel/:panelId"
              element={<HospitalPanelLegacyRedirect />}
            />
            <Route
              path="/hospitals"
              element={
                <Suspense fallback={<div>Loading...</div>}>
                  <HospitalDirectory />
                </Suspense>
              }
            />

            {/* Doctor Pages */}
            <Route
              path="/register/doctor"
              element={
                <Suspense fallback={<div>Loading...</div>}>
                  <RegisterDoctor />
                </Suspense>
              }
            />
            <Route
              path="/doctors"
              element={
                <Suspense fallback={<div>Loading...</div>}>
                  <DoctorDirectory />
                </Suspense>
              }
            />
            <Route
              path="/public-doctor/:token"
              element={
                <Suspense fallback={<div>Loading...</div>}>
                  <PublicDoctorProfile />
                </Suspense>
              }
            />
            <Route
              path="/doctor/profile"
              element={
                <PrivateRoute allowedRoles={["doctor"]}>
                  <Suspense fallback={<div>Loading...</div>}>
                    <DoctorProfilePage />
                  </Suspense>
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
              {/* UI Revamp: unified patient list across panels (hw-patients) */}
              <Route path="patients" element={<HospitalPatientsPage />} />
              <Route path="patient/:patientId" element={<HospitalPatientDetail />} />
              <Route path="patient/:patientId/edit" element={<HospitalPatientEdit />} />
              <Route path="panels" element={<HospitalPanelsPage />} />
              {/* Users tab lives inside Hospital Profile now (matches wireframe). */}
              <Route path="users" element={<Navigate to="../profile?tab=users" replace />} />
              <Route path="panel/:panelId" element={<HospitalPanelDetails />} />
              <Route path="profile" element={<Suspense fallback={<div>Loading...</div>}><HospitalProfilePage /></Suspense>} />
              <Route path="settings/cashless" element={<Suspense fallback={<div>Loading...</div>}><HospitalCashlessSettings /></Suspense>} />
              {/* Intelligence Layer hospital surfaces */}
              <Route path="patient/:patientId/adjudication" element={<Suspense fallback={<div>Loading...</div>}><HospitalAdjudicationView /></Suspense>} />
              <Route path="patient/:patientId/ai-summary" element={<Suspense fallback={<div>Loading...</div>}><HospitalClaimAISummary /></Suspense>} />
              <Route path="actions" element={<Suspense fallback={<div>Loading...</div>}><HospitalActionQueue /></Suspense>} />
            </Route>

            <Route path="/unauthorized" element={<div className="error-page">Unauthorized Access</div>} />
            <Route
              path="/"
              element={<Navigate to={getRedirectPath()} />}
            />
          </Routes>
          <GlobalUploadPanel />
        </BrowserRouter>
        </ConfirmProvider>
      </UploadProvider>
    </AuthProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
