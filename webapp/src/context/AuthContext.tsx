import React, { createContext, useContext, useState, useEffect } from "react";
import { User } from "../types";
import apiService, { clearAuthStorage } from "../services/api";

interface AuthContextType {
    user: User | null;
    accessToken: string | null;
    login: (user: User, accessToken: string, refreshToken: string) => void;
    logout: () => void;
    isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(() => {
        const storedUser = localStorage.getItem("user");
        if (storedUser) {
            try {
                return JSON.parse(storedUser);
            } catch (error) {
                console.error("Failed to parse stored user:", error);
                localStorage.removeItem("user");
            }
        }
        return null;
    });

    const [accessToken, setAccessToken] = useState<string | null>(() => {
        return localStorage.getItem("accessToken");
    });

    const login = (userData: User, token: string, refreshToken: string) => {
        setUser(userData);
        setAccessToken(token);
        localStorage.setItem("user", JSON.stringify(userData));
        localStorage.setItem("accessToken", token);
        localStorage.setItem("refreshToken", refreshToken);
    };

    const logout = () => {
        // E2E find: tell the backend to revoke the matching refresh-token row
        // and write a LOGOUT audit_logs entry. Fire-and-forget — UI state
        // tears down immediately either way so the user never waits on it.
        //
        // Snapshot both tokens BEFORE clearing storage and pass them in
        // explicitly. If we let the axios interceptor pick the access token
        // from localStorage at send-time, the synchronous clearAuthStorage()
        // below races with the request and strips the Authorization header,
        // which makes the backend short-circuit (and the audit row never
        // gets written).
        const refreshToken = localStorage.getItem("refreshToken");
        const at = localStorage.getItem("accessToken");
        apiService.logout(refreshToken, at);
        setUser(null);
        setAccessToken(null);
        clearAuthStorage();
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                accessToken,
                login,
                logout,
                isAuthenticated: !!user && !!accessToken,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
};
