import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import apiService from "../../services/api";
import { Building2, Loader2 } from "lucide-react";

const LoginPage: React.FC = () => {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();
    const { login } = useAuth();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        try {
            const response = await apiService.login(username, password);
            const { accessToken, refreshToken, user } = response.data.data;

            login(user, accessToken, refreshToken);

            // Redirect based on role
            if (user.role === "superadmin") {
                navigate("/superadmin");
            } else if (user.role === "hospital" && user.hospital_id) {
                navigate(`/portal/${user.hospital_id}`);
            } else {
                navigate("/dashboard");
            }
        } catch (err: any) {
            setError(err.response?.data?.message || "Login failed. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        // UI Revamp PR F.1: Tailwind re-skin with brand tokens. Replaces styles/Login.css.
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-brand-50 dark:from-slate-950 dark:via-slate-900 dark:to-brand-700/10 p-4">
            <div className="w-full max-w-md">
                {/* Brand mark */}
                <div className="flex flex-col items-center mb-6">
                    <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-brand-600 to-brand-700 flex items-center justify-center shadow-lg shadow-brand-700/20 mb-4">
                        <Building2 className="h-7 w-7 text-white" />
                    </div>
                    <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50 tracking-tight">
                        Finclarity Claim OS
                    </h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        Sign in to your account
                    </p>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-slate-900/5 border border-slate-200 dark:border-slate-800 p-8">
                    <form onSubmit={handleSubmit} className="space-y-5">
                        {error && (
                            <div className="rounded-md bg-danger-50 dark:bg-danger-700/20 border border-danger-100 dark:border-danger-700/40 px-3 py-2.5 text-sm text-danger-700 dark:text-danger-50">
                                {error}
                            </div>
                        )}

                        <div className="space-y-1.5">
                            <label
                                htmlFor="username"
                                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                            >
                                Username
                            </label>
                            <input
                                id="username"
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                required
                                placeholder="Enter your username"
                                disabled={loading}
                                autoComplete="username"
                                className="w-full px-3 py-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-shadow"
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label
                                htmlFor="password"
                                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                            >
                                Password
                            </label>
                            <input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                placeholder="Enter your password"
                                disabled={loading}
                                autoComplete="current-password"
                                className="w-full px-3 py-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-shadow"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                            {loading ? "Signing in..." : "Sign in"}
                        </button>
                    </form>
                </div>

                <p className="text-center text-xs text-slate-500 dark:text-slate-500 mt-6">
                    Secure portal · Authorized access only
                </p>
            </div>
        </div>
    );
};

export default LoginPage;
