const path = require('path');

module.exports = {
    style: {
        postcss: {
            mode: "file",
        },
    },
    webpack: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
        },
    },
    babel: {
        plugins: [
            // FE review H14 — strip console.* in production builds. 252+
            // console.log statements ship with the app, some of them
            // containing PII (form data, IDs). Keep `error` and `warn` so
            // genuine errors still surface in production (e.g. via Sentry).
            ...(process.env.NODE_ENV === 'production'
                ? [['transform-remove-console', { exclude: ['error', 'warn'] }]]
                : []),
        ],
    },
};
