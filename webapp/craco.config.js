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
    jest: {
        configure: {
            // CRA derives jest aliases from tsconfig `baseUrl` only, which
            // yields `^src/(.*)$` — it does NOT read tsconfig `paths`. Every
            // module in this app imports through the `@/` alias, so without
            // this mapping no test that touches app code can resolve its
            // imports. Mirrors the webpack alias above.
            moduleNameMapper: {
                '^@/(.*)$': '<rootDir>/src/$1',
                // react-router-dom@7's package.json declares `main:
                // ./dist/main.js`, a file it does not ship — the real CJS
                // entry is only reachable through its `exports` map. Webpack 5
                // reads `exports` so the app builds; jest 27 (what CRA 5 pins)
                // reads `main` and fails to resolve the module at all. Point
                // it straight at the CJS build. Test-only: the webpack build
                // is untouched by this.
                '^react-router-dom$':
                    '<rootDir>/node_modules/react-router-dom/dist/index.js',
                // …and its `react-router/dom` subpath is exports-map-only too,
                // so jest 27 cannot follow it either.
                '^react-router/dom$':
                    '<rootDir>/node_modules/react-router/dist/development/dom-export.js',
                '^react-router$':
                    '<rootDir>/node_modules/react-router/dist/development/index.js',
            },
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
