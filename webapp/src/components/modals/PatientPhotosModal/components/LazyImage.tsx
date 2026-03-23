import React, { useState, useEffect } from "react";

interface LazyImageProps {
    thumbnailUrl?: string;
    proxyUrl: string | null;
    alt: string;
    priority?: boolean;
}

export const LazyImage: React.FC<LazyImageProps> = ({ thumbnailUrl, proxyUrl, alt, priority = false }) => {
    const [isLoaded, setIsLoaded] = useState(false);
    const [hasError, setHasError] = useState(false);
    const [currentSrc, setCurrentSrc] = useState<string | null>(null);

    useEffect(() => {
        setIsLoaded(false);
        setHasError(false);

        if (thumbnailUrl) {
            const enhancedThumbnail = thumbnailUrl.replace(/=s\d+$/, "=s400");
            setCurrentSrc(enhancedThumbnail);
        } else {
            setCurrentSrc(proxyUrl);
        }
    }, [thumbnailUrl, proxyUrl]);

    const handleError = () => {
        if (currentSrc !== proxyUrl && proxyUrl) {
            const token = localStorage.getItem("accessToken");
            // API base URL adjustment based on environment
            const API_V2_BASE_URL = process.env.NODE_ENV === "production" ? "" : "http://localhost:8000";
            
            fetch(`${API_V2_BASE_URL}${proxyUrl}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            })
                .then(r => {
                    if (!r.ok) throw new Error("Proxy fetch failed");
                    return r.blob();
                })
                .then(blob => {
                    setCurrentSrc(URL.createObjectURL(blob));
                    setHasError(false);
                })
                .catch(() => {
                    setHasError(true);
                });
        } else {
            setHasError(true);
        }
    };

    return (
        <div className={`relative w-full h-full bg-slate-50 overflow-hidden`}>
            {!hasError ? (
                <>
                    {!isLoaded && (
                        <div className="absolute inset-0 animate-pulse bg-slate-100" />
                    )}
                    <img
                        src={currentSrc || undefined}
                        alt={alt}
                        loading={priority ? "eager" : "lazy"}
                        onLoad={() => setIsLoaded(true)}
                        onError={handleError}
                        className={`w-full h-full object-cover transition-all duration-300 ${isLoaded ? "opacity-100 scale-100" : "opacity-0 scale-105"
                            }`}
                    />
                </>
            ) : (
                <div className="w-full h-full flex items-center justify-center text-slate-400">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                        <circle cx="9" cy="9" r="2" />
                        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                </div>
            )}
        </div>
    );
};
