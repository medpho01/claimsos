import React from 'react';

interface SkeletonProps {
    width?: string | number;
    height?: string | number;
    borderRadius?: string | number;
    className?: string;
    style?: React.CSSProperties;
}

export const Skeleton: React.FC<SkeletonProps> = ({
    width = '100%',
    height = '1rem',
    borderRadius = '4px',
    className = '',
    style = {}
}) => {
    return (
        <div
            className={`skeleton ${className}`}
            style={{
                width: typeof width === 'number' ? `${width}px` : width,
                height: typeof height === 'number' ? `${height}px` : height,
                borderRadius: typeof borderRadius === 'number' ? `${borderRadius}px` : borderRadius,
                ...style
            }}
        />
    );
};

export const SkeletonCircle: React.FC<{ size?: number }> = ({ size = 40 }) => {
    return <Skeleton width={size} height={size} borderRadius="50%" />;
};

export const SkeletonText: React.FC<{ lines?: number; width?: string }> = ({ lines = 1, width = '100%' }) => {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {Array.from({ length: lines }).map((_, i) => (
                <Skeleton
                    key={i}
                    width={i === lines - 1 && lines > 1 ? '70%' : width}
                    height="0.875rem"
                />
            ))}
        </div>
    );
};

// Table row skeleton
export const TableRowSkeleton: React.FC<{ columns?: number }> = ({ columns = 5 }) => {
    return (
        <tr className="skeleton-row">
            <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <Skeleton width={36} height={36} borderRadius={8} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                        <Skeleton width={120} height={14} />
                        <Skeleton width={80} height={12} />
                    </div>
                </div>
            </td>
            <td><Skeleton width={100} height={14} /></td>
            <td><Skeleton width={90} height={14} /></td>
            <td><Skeleton width={80} height={24} borderRadius={12} /></td>
            <td><Skeleton width={70} height={24} borderRadius={12} /></td>
            {columns > 5 && <td><Skeleton width={80} height={28} borderRadius={6} /></td>}
        </tr>
    );
};

// Photo grid skeleton
export const PhotoGridSkeleton: React.FC<{ count?: number }> = ({ count = 8 }) => {
    return (
        <div className="skeleton-photo-grid">
            {Array.from({ length: count }).map((_, i) => (
                <Skeleton
                    key={i}
                    height={0}
                    className="skeleton-photo-item"
                    style={{ paddingBottom: '100%', height: 0 }}
                    borderRadius={12}
                />
            ))}
        </div>
    );
};

// Stats card skeleton
export const StatsCardSkeleton: React.FC = () => {
    return (
        <div className="stat-card-mini skeleton-card">
            <Skeleton width={40} height={40} borderRadius={10} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                <Skeleton width={40} height={20} />
                <Skeleton width={70} height={12} />
            </div>
        </div>
    );
};

// Add global skeleton styles
const skeletonStyles = `
    .skeleton {
        background: linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%);
        background-size: 200% 100%;
        animation: shimmer 1.5s ease-in-out infinite;
    }

    @keyframes shimmer {
        0% {
            background-position: -200% 0;
        }
        100% {
            background-position: 200% 0;
        }
    }

    .skeleton-row td {
        padding: 1rem 1.5rem;
        border-bottom: 1px solid #e2e8f0;
    }

    .skeleton-card {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1rem 1.25rem;
        background: white;
        border-radius: 12px;
        border: 1px solid #e2e8f0;
    }

    .skeleton-photo-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 1rem;
    }

    .skeleton-photo-item {
        position: relative;
    }
`;

// Inject styles once
if (typeof document !== 'undefined') {
    const styleId = 'skeleton-styles';
    if (!document.getElementById(styleId)) {
        const styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = skeletonStyles;
        document.head.appendChild(styleEl);
    }
}

export default Skeleton;
