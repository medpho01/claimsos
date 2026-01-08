import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import SuperAdminPage from "./pages/SuperAdminPage";
import HospitalDetailsPage from "./pages/HospitalDetailsPage";
import "./App.css";

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
              <PrivateRoute allowedRoles={["admin", "hospital"]}>
                <DashboardPage />
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
              <PrivateRoute allowedRoles={["superadmin"]}>
                <HospitalDetailsPage />
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
