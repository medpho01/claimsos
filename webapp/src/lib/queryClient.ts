import { QueryClient } from '@tanstack/react-query';

/**
 * Shared QueryClient.
 *
 * Frontend review state-mgmt observations: every page does its own
 * `useEffect → fetch → useState` dance. Three hospital sub-pages fan
 * out across panels to assemble a patient list. There is no shared
 * cache. After a mutation only the screen that did the mutation sees
 * the fresh data — other tabs / pages show stale state until manual
 * refresh.
 *
 * TanStack Query (react-query) gives us:
 *   - Per-key request cache, shared across consumers
 *   - stale-while-revalidate so common queries don't re-fetch unless
 *     they've been stale for a while
 *   - Background re-fetch on focus
 *   - Mutation hooks with cache invalidation
 *
 * This file owns the singleton. Other files just `import { queryClient }`
 * if they need imperative access (rare), otherwise consume via the
 * `useQuery` / `useMutation` hooks plus the `QueryClientProvider`
 * mounted at App root.
 *
 * Default options are tuned for an admin tool where staleness for a
 * couple of minutes is fine but we don't want surprise refetches on
 * window focus mid-form.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,           // 1 minute fresh
      gcTime: 5 * 60_000,          // 5 minute cache retention
      refetchOnWindowFocus: false, // avoid surprises
      retry: 1,                    // a single retry on transient failures
    },
  },
});
