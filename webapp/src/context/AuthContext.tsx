import React, { createContext, useContext, useState, useEffect } from "react";
import { User } from "../types";

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
        setUser(null);
        setAccessToken(null);
        localStorage.clear();
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
