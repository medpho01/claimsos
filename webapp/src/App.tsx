import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import LoginPage from "./pages/auth/LoginPage";
import SuperAdminPage from "./pages/superadmin/SuperAdminPage";
import HospitalDetailsPage from "./pages/superadmin/HospitalDetailsPage";
import PanelPatientsPage from "./pages/panels";
import "./App.css";

import AdminDashboardPage from "./pages/admin/AdminDashboardPage";

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

const App: React.FC = () => {
  const getRedirectPath = () => {
    try {
      const userStr = localStorage.getItem("user");
      if (!userStr) return "/login";
      const user = JSON.parse(userStr);
      return user?.role === "superadmin" ? "/superadmin" : "/dashboard";
    } catch {
      localStorage.removeItem("user");
      return "/login";
    }
  };

  return (
    <AuthProvider>
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
              <PrivateRoute allowedRoles={["superadmin", "admin"]}>
                <HospitalDetailsPage />
              </PrivateRoute>
            }
          />
          <Route
            path="/hospital/:hospitalId/panel/:panelId"
            element={
              <PrivateRoute allowedRoles={["superadmin", "admin"]}>
                <PanelPatientsPage />
              </PrivateRoute>
            }
          />
          <Route path="/unauthorized" element={<div className="error-page">Unauthorized Access</div>} />
          <Route
            path="/"
            element={<Navigate to={getRedirectPath()} />}
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
};

export default App;
