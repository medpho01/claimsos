import React, { useState, useEffect } from "react";

interface LazyImageProps {
    thumbnailUrl?: string;
    proxyUrl: string;
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
            // Increase thumbnail size
            const enhancedThumbnail = thumbnailUrl.replace(/=s\d+$/, "=s400");
            setCurrentSrc(enhancedThumbnail);
        } else {
            setCurrentSrc(proxyUrl);
        }
    }, [thumbnailUrl, proxyUrl]);

    const handleError = () => {
        if (currentSrc !== proxyUrl) {
            setCurrentSrc(proxyUrl);
            setHasError(false);
        } else {
            setHasError(true);
        }
    };

    return (
        <div className={`relative w-full h-full bg-slate-100 overflow-hidden ${isLoaded ? "" : "animate-pulse"}`}>
            {!hasError ? (
                <img
                    src={currentSrc || ""}
                    alt={alt}
                    loading={priority ? "eager" : "lazy"}
                    onLoad={() => setIsLoaded(true)}
                    onError={handleError}
                    className={`w-full h-full object-cover transition-all duration-300 ${isLoaded ? "opacity-100 scale-100" : "opacity-0 scale-105"
                        }`}
                />
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
