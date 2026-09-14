/**
 * Run-control behaviour tests for the Claim AI Summary surface.
 *
 * These exist because the cost-consent flow is not the kind of thing you can
 * verify by reading: it is four HTTP outcomes (202 / 428 / 409 / 400), a
 * server-initiated pause that arrives through a POLL rather than a click, and
 * a set of end-states whose whole job is to stop a user believing a document
 * was read when it was not. Every assertion below is on rendered text a
 * hospital operator would actually see.
 *
 * What is deliberately NOT mocked: the page, all five run-control components,
 * the real TanStack Query hooks, and `runConsentApi`'s HTTP handling. Only
 * `apiService` (the axios wrapper) and the four heavy data panels are stubbed,
 * so the thing under test is the flow itself.
 */

import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import apiService from '@/services/api';
import { ClaimAISummary } from '../index';
import type {
  IntelligenceStatus,
  IntelligenceRunStatus,
} from '@/hooks/intelligence/useIntelligenceStatus';
import type { RunCostEstimate } from '../components/runConsentApi';

jest.mock('@/services/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

// The panels do their own fetching and rendering; none of it is under test.
jest.mock('../panels/DocumentsPanel', () => ({
  DocumentsPanel: () => <div data-testid="documents-panel" />,
}));
jest.mock('../panels/HarmonisedEpisodePanel', () => ({
  HarmonisedEpisodePanel: () => <div data-testid="harmonised-panel" />,
}));
jest.mock('../panels/AuditTrailPanel', () => ({
  AuditTrailPanel: () => <div data-testid="audit-panel" />,
}));
jest.mock('../panels/StageAdjudicationPanel', () => ({
  StageAdjudicationPanel: () => <div data-testid="stage-panel" />,
}));

// jsdom ships none of these, and the Radix dialog the consent gate is built on
// touches them on mount. Without the stubs the whole suite fails on a
// ReferenceError that has nothing to do with the behaviour under test.
beforeAll(() => {
  if (!window.matchMedia) {
    (window as any).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (!(window as any).ResizeObserver) {
    (window as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!(Element.prototype as any).hasPointerCapture) {
    (Element.prototype as any).hasPointerCapture = () => false;
    (Element.prototype as any).setPointerCapture = () => {};
    (Element.prototype as any).releasePointerCapture = () => {};
  }
});

const mockGet = apiService.get as jest.Mock;
const mockPost = apiService.post as jest.Mock;

const CLAIM_ID = 'claim-abc-123';
const RUN_ID = 'run-xyz-789';

// ───────────────────────────── fixtures ──────────────────────────────

function makeEstimate(over: Partial<RunCostEstimate> = {}): RunCostEstimate {
  return {
    estimate_token: 'tok-v1',
    computed_at: '2026-09-14T10:00:00.000Z',
    docs_total: 3,
    pages_total: 24,
    pixel_pages_total: 18,
    typed_pages_total: 6,
    est_page_cost_inr: 0.9,
    ocr_inr: 16.2,
    extraction_inr: 9.4,
    fixed_inr: 2.4,
    total_inr: 28,
    recommended_budget_inr: 40,
    claim_ocr_headroom_inr: 60,
    claim_reasoning_headroom_inr: 60,
    prior_claim_spend_inr: 0,
    docs: [
      {
        doc_id: 'doc-1',
        file_name: 'discharge-summary.pdf',
        total_pages: 12,
        pixel_pages: 10,
        degraded: false,
        est_ocr_inr: 9,
        est_sections: 4,
        est_extraction_inr: 5,
        est_total_inr: 14,
      },
    ],
    notes: [],
    ...over,
  };
}

function makeRun(over: Partial<IntelligenceRunStatus> = {}): IntelligenceRunStatus {
  return {
    id: RUN_ID,
    status: 'running',
    phase: 'page_read',
    total_docs: 3,
    docs_completed: 1,
    docs_failed: 0,
    triggered_at: '2026-09-14T10:00:00.000Z',
    finished_at: null,
    error: null,
    ...over,
  };
}

function makeStatus(over: Partial<IntelligenceStatus> = {}): IntelligenceStatus {
  return {
    claim_id: CLAIM_ID,
    sections: { total: 8, classified: 4, extracted: 2 },
    segmenter: { pending: false },
    harmoniser: {
      status: 'absent',
      generated_at: null,
      cost_inr: null,
      error_message: null,
    },
    adjudication: { latest_at: null, readiness_score: null, recommended_action: null },
    rules_v2: { latest_at: null, total: 0, failed: 0, skipped: 0, rule_set_id: null },
    run: null,
    unreadable: null,
    is_pending: false,
    pending_components: [],
    eta_seconds: null,
    last_updated_at: '2026-09-14T10:00:00.000Z',
    ...over,
  };
}

/** An axios-shaped rejection, which is what `runConsentApi` actually parses. */
function httpError(status: number, data: any) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}

// ───────────────────────────── harness ───────────────────────────────

/**
 * /status is polled, so tests hand over a QUEUE of successive bodies. The last
 * one sticks — that is what lets a test model "the server paused the run while
 * the user was watching" without racing the poll interval.
 */
let statusQueue: IntelligenceStatus[] = [];

function setStatusSequence(...bodies: IntelligenceStatus[]) {
  statusQueue = [...bodies];
}

function currentStatus(): IntelligenceStatus {
  return statusQueue.length > 1
    ? (statusQueue.shift() as IntelligenceStatus)
    : statusQueue[0];
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/patient/${CLAIM_ID}?tab=ai-summary`]}>
        <ClaimAISummary claimIdOverride={CLAIM_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  setStatusSequence(makeStatus());

  mockGet.mockImplementation(async (url: string) => {
    if (url.includes('/intelligence/status')) return { data: currentStatus() };
    if (url.includes('/unreadable')) throw httpError(404, { error: 'not_found' });
    // Everything else the page's sibling hooks ask for.
    if (url.includes('/dossier')) return { data: null };
    if (url.includes('/harmonised')) return { data: null };
    if (url.includes('/rules-v2')) return { data: null };
    if (url.includes('/adjudication')) return { data: null };
    return { data: null };
  });
  mockPost.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  statusQueue = [];
});

/**
 * This repo is on @testing-library/user-event v13, which has no `.setup()` and
 * whose APIs are synchronous. Every interaction here kicks off async work
 * (a POST, then a status refetch), so each one is wrapped in `act` with an
 * awaited microtask flush — otherwise the assertions race the state updates
 * and React logs act() warnings for every single one.
 */
const user = {
  click: async (el: Element) => {
    await act(async () => {
      userEvent.click(el as HTMLElement);
    });
  },
  clear: async (el: Element) => {
    await act(async () => {
      userEvent.clear(el as HTMLElement);
    });
  },
  type: async (el: Element, text: string) => {
    await act(async () => {
      userEvent.type(el as HTMLElement, text);
    });
  },
};

const runButton = () =>
  screen.getByRole('button', { name: /Run Analysis|Re-run AI Analysis|Checking cost|Starting/i });

// ═══════════════════ 1. consent gate: 428 + embedded estimate ═════════

describe('cost consent — the 428 gate', () => {
  it('asks for approval before anything starts, and starts only after it', async () => {
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (!url.includes('/analyze')) return { data: { ok: true } };
      if (body.approved_budget_inr == null) {
        throw httpError(428, {
          ok: false,
          error: 'budget_approval_required',
          message: 'This run needs a budget approval before it can start.',
          estimate: makeEstimate(),
          min_budget_inr: 5,
          max_budget_inr: 1000,
        });
      }
      return {
        data: {
          ok: true,
          claim_id: CLAIM_ID,
          run_id: RUN_ID,
          approved_budget_inr: body.approved_budget_inr,
          estimate: makeEstimate(),
          docs_total: 3,
          docs_enqueued_for_segmentation: 3,
          warnings: [],
          message: 'started',
        },
      };
    });

    renderPage();
    await screen.findByRole('button', { name: /Run Analysis/i });

    // Idle: no run has been created and the page says so.
    expect(screen.getByText(/You approve a budget before anything runs/i)).toBeInTheDocument();

    await user.click(runButton());

    // Awaiting approval — the estimate the server embedded in its 428 is on
    // screen, broken down, and nothing has been created yet.
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Approve a budget before this analysis runs/i),
    ).toBeInTheDocument();
    // The estimate the 428 carried is broken down, not just totalled.
    expect(
      within(dialog).getByText(/scanned or photographed and must be read/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('18')).toBeInTheDocument(); // pixel pages
    expect(within(dialog).getByText('₹28')).toBeInTheDocument(); // estimated cost
    expect(
      within(dialog).getByText(/Nothing has started yet and nothing has been charged/i),
    ).toBeInTheDocument();

    // Exactly one POST so far, and it carried no budget.
    const analyzeCalls = mockPost.mock.calls.filter((c) => String(c[0]).includes('/analyze'));
    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0][1].approved_budget_inr).toBeUndefined();

    // The input is seeded with the RECOMMENDED budget, not the bare estimate.
    const input = within(dialog).getByLabelText(/Budget I approve for this run/i);
    expect(input).toHaveValue(40);

    // Once approved, the run starts — and the approval carries the token.
    setStatusSequence(
      makeStatus({
        run: makeRun({ approved_budget_inr: 40, spend_so_far_inr: 3.2 }),
        is_pending: true,
        pending_components: ['segmenter'],
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: /Approve .* and start/i }));

    await waitFor(() => {
      const second = mockPost.mock.calls.filter((c) => String(c[0]).includes('/analyze'))[1];
      expect(second[1]).toMatchObject({
        force: true,
        approved_budget_inr: 40,
        estimate_token: 'tok-v1',
      });
    });

    // Running: progress banner with the live budget meter.
    expect(await screen.findByText(/AI Analysis in progress/i)).toBeInTheDocument();
    expect(screen.getByText(/Spent ₹3.20 of ₹40 approved/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pause/i })).toBeEnabled();
  }, 20000);

  it('shows a distinct "estimating" state while the quote is in flight', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('/analyze')) {
        await held;
        throw httpError(428, {
          error: 'budget_approval_required',
          estimate: makeEstimate(),
          min_budget_inr: 5,
          max_budget_inr: 1000,
        });
      }
      return { data: { ok: true } };
    });

    renderPage();
    const btn = await screen.findByRole('button', { name: /Run Analysis/i });
    await user.click(btn);

    // Estimating: its own label, and the button cannot be double-fired.
    expect(await screen.findByRole('button', { name: /Checking cost/i })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    release!();
    // …and it hands off to awaiting-approval, not to a dead end.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  }, 20000);

  it('declining the pre-flight dialog creates nothing and leaves no wreckage', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('/analyze')) {
        throw httpError(428, {
          error: 'budget_approval_required',
          estimate: makeEstimate(),
          min_budget_inr: 5,
          max_budget_inr: 1000,
        });
      }
      return { data: { ok: true } };
    });

    renderPage();
    await user.click(await screen.findByRole('button', { name: /Run Analysis/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Don't run/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Back to idle, one POST total, no error shouting at the user.
    expect(screen.getByRole('button', { name: /Run Analysis/i })).toBeEnabled();
    expect(mockPost.mock.calls.filter((c) => String(c[0]).includes('/analyze'))).toHaveLength(1);
  }, 20000);
});

// ═══════════════════ 2. 409 estimate_stale re-prompts ════════════════

describe('cost consent — 409 estimate_stale', () => {
  it('replaces the numbers and makes the user approve again, rather than failing', async () => {
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (!url.includes('/analyze')) return { data: { ok: true } };
      if (body.approved_budget_inr == null) {
        throw httpError(428, {
          error: 'budget_approval_required',
          estimate: makeEstimate(),
          min_budget_inr: 5,
          max_budget_inr: 1000,
        });
      }
      // The document set moved under the quote.
      throw httpError(409, {
        error: 'estimate_stale',
        estimate: makeEstimate({
          estimate_token: 'tok-v2',
          docs_total: 4,
          pages_total: 31,
          total_inr: 44,
          recommended_budget_inr: 60,
        }),
      });
    });

    renderPage();
    await user.click(await screen.findByRole('button', { name: /Run Analysis/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Approve .* and start/i }));

    // The dialog is STILL open, says why, and now shows the fresh quote.
    expect(
      await within(dialog).findByText(/documents on this claim changed since the last quote/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/Budget I approve for this run/i)).toHaveValue(60),
    );
    expect(within(dialog).getByRole('button', { name: /Approve .* and start/i })).toBeEnabled();

    // No run was started and nothing crashed.
    expect(screen.queryByText(/AI Analysis in progress/i)).not.toBeInTheDocument();
  }, 20000);
});

// ═══════════════════ 3. 400 budget_out_of_range is correctable ═══════

describe('cost consent — 400 budget_out_of_range', () => {
  it('is shown as a correctable input error, not a crash, and never clamps', async () => {
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (!url.includes('/analyze')) return { data: { ok: true } };
      if (body.approved_budget_inr == null) {
        throw httpError(428, {
          error: 'budget_approval_required',
          estimate: makeEstimate(),
          min_budget_inr: 5,
          max_budget_inr: 1000,
        });
      }
      throw httpError(400, {
        error: 'budget_out_of_range',
        min_budget_inr: 5,
        max_budget_inr: 1000,
      });
    });

    renderPage();
    await user.click(await screen.findByRole('button', { name: /Run Analysis/i }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(/Budget I approve for this run/i);

    // A client-side out-of-range number is refused before it ever leaves.
    await user.clear(input);
    await user.type(input, '4000');
    await user.click(within(dialog).getByRole('button', { name: /Approve .* and start/i }));
    expect(
      await within(dialog).findByText(/Nothing is adjusted for you — type a number in range/i),
    ).toBeInTheDocument();
    // It was NOT clamped to the max.
    expect(input).toHaveValue(4000);
    expect(mockPost.mock.calls.filter((c) => String(c[0]).includes('/analyze'))).toHaveLength(1);

    // And a server-side refusal lands in the same place: inline, recoverable.
    await user.clear(input);
    await user.type(input, '900');
    await user.click(within(dialog).getByRole('button', { name: /Approve .* and start/i }));
    // This time the number DID leave the client and the server refused it.
    await waitFor(() =>
      expect(
        mockPost.mock.calls.filter((c) => String(c[0]).includes('/analyze')),
      ).toHaveLength(2),
    );
    expect(
      await within(dialog).findByText(/Budget must be between ₹5 and ₹1,000/i),
    ).toBeInTheDocument();
    // …and it is the SERVER's message, not the leftover client-side one.
    expect(
      within(dialog).queryByText(/Nothing is adjusted for you/i),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Approve .* and start/i })).toBeEnabled();
    expect(screen.queryByText(/AI Analysis in progress/i)).not.toBeInTheDocument();
  }, 25000);
});

// ═══════════════ 4. server-initiated mid-run consent pause ═══════════

describe('mid-run cost consent — the server pauses and asks', () => {
  const pausedForConsent = makeStatus({
    run: makeRun({
      status: 'paused',
      pause_reason: 'cost_consent_required',
      paused_at: '2026-09-14T10:05:00.000Z',
      approved_budget_inr: 40,
      spend_so_far_inr: 39.5,
      spend_at_pause_inr: 39.5,
      projected_remaining_inr: 22,
      suggested_additional_budget_inr: 30,
      can_resume: true,
      can_cancel: true,
      docs_completed: 2,
    }),
    is_pending: false,
    pending_components: [],
  });

  it('renders spend-so-far, remaining estimate, approve-more and decline', async () => {
    setStatusSequence(pausedForConsent);
    renderPage();

    expect(
      await screen.findByText(/Paused — this run needs more budget/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/₹39.50/)).toBeInTheDocument();
    expect(screen.getByText(/₹22/)).toBeInTheDocument();
    expect(
      screen.getByText(/Everything already analysed is kept either way/i),
    ).toBeInTheDocument();

    // Both answers are real buttons.
    expect(screen.getByRole('button', { name: /Approve ₹30 more/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Finish with what we have/i })).toBeEnabled();

    // No spinner is claiming work is happening.
    expect(screen.queryByText(/AI Analysis in progress/i)).not.toBeInTheDocument();
    // And the partial results stay visible beside the question.
    expect(screen.getByTestId('documents-panel')).toBeInTheDocument();
    expect(
      screen.getByText(/it is real, but it is not the whole claim yet/i),
    ).toBeInTheDocument();
  }, 20000);

  it('approve-more resumes with a NEW TOTAL, not a delta', async () => {
    setStatusSequence(pausedForConsent);
    renderPage();

    await screen.findByText(/Paused — this run needs more budget/i);
    setStatusSequence(
      makeStatus({
        run: makeRun({ approved_budget_inr: 70, spend_so_far_inr: 39.5, resume_count: 1 }),
        is_pending: true,
        pending_components: ['docExtractor'],
      }),
    );
    await user.click(screen.getByRole('button', { name: /Approve ₹30 more/i }));

    await waitFor(() => {
      const resume = mockPost.mock.calls.find((c) => String(c[0]).includes('/resume'));
      expect(resume).toBeTruthy();
      // 40 approved + 30 more = 70 TOTAL.
      expect(resume![1]).toMatchObject({ run_id: RUN_ID, approved_budget_inr: 70 });
    });
    expect(await screen.findByText(/AI Analysis in progress/i)).toBeInTheDocument();
  }, 20000);

  it('a rejected top-up explains itself instead of silently doing nothing', async () => {
    setStatusSequence(pausedForConsent);
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('/resume')) {
        throw httpError(400, {
          error: 'budget_not_increased',
          approved_budget_inr: 40,
          requested: 40,
        });
      }
      return { data: { ok: true } };
    });

    renderPage();
    await screen.findByText(/Paused — this run needs more budget/i);
    await user.click(screen.getByRole('button', { name: /Approve ₹30 more/i }));

    expect(
      await screen.findByText(/Resuming needs MORE than the ₹40 already approved/i),
    ).toBeInTheDocument();
    // Still paused, still offering both answers.
    expect(screen.getByRole('button', { name: /Finish with what we have/i })).toBeEnabled();
  }, 20000);

  it('decline ends the run as `partial` and reads as deliberate, not broken', async () => {
    setStatusSequence(pausedForConsent);
    renderPage();

    await screen.findByText(/Paused — this run needs more budget/i);

    const declined = makeStatus({
      run: makeRun({
        status: 'partial',
        end_reason: 'budget_declined',
        finished_at: '2026-09-14T10:06:00.000Z',
        phase: null,
        approved_budget_inr: 40,
        spend_so_far_inr: 39.5,
        docs_completed: 2,
      }),
      is_pending: false,
      pending_components: [],
    });
    setStatusSequence(declined);
    let cancelBody: any = null;
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (url.includes('/cancel')) {
        cancelBody = body;
        return {
          data: { ok: true, run: declined.run, unreadable: null, message: 'ended' },
        };
      }
      return { data: { ok: true } };
    });

    await user.click(screen.getByRole('button', { name: /Finish with what we have/i }));

    await waitFor(() => expect(cancelBody).toMatchObject({ reason: 'budget_declined' }));

    // The outcome notice says what happened, in the user's own words.
    expect(
      await screen.findByText(/Run ended — you chose to finish with what we had/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Everything that was analysed before the run stopped has been kept/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Spent ₹39.50 of ₹40 approved/i)).toBeInTheDocument();
    // Not an error surface.
    expect(screen.queryByText(/Analysis failed/i)).not.toBeInTheDocument();
    // And there is a way forward.
    expect(screen.getByRole('button', { name: /Run the analysis again/i })).toBeEnabled();
  }, 20000);
});

// ═══════════════════ 5. paused BY THE USER is a different thing ══════

describe('user-requested pause', () => {
  it('offers a plain Resume and never asks for money', async () => {
    setStatusSequence(
      makeStatus({
        run: makeRun({ approved_budget_inr: 40, spend_so_far_inr: 12 }),
        is_pending: true,
        pending_components: ['docSegmenter'],
      }),
    );
    renderPage();
    await screen.findByText(/AI Analysis in progress/i);

    setStatusSequence(
      makeStatus({
        run: makeRun({
          status: 'paused',
          pause_reason: 'user_requested',
          paused_at: '2026-09-14T10:05:00.000Z',
          approved_budget_inr: 40,
          spend_so_far_inr: 12,
          spend_at_pause_inr: 12,
          can_resume: true,
          can_cancel: true,
        }),
        is_pending: false,
      }),
    );
    await user.click(screen.getByRole('button', { name: /Pause/i }));

    expect(await screen.findByText(/^Paused by you$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Resume$/i })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /Approve .* more/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Spent so far ₹12 of ₹40 approved/i)).toBeInTheDocument();
  }, 20000);
});

// ═══════════ 6. the unreadable-pages surface cannot go silent ════════

describe('unreadable pages — the end-of-run decision', () => {
  const terminalWithHoles = makeStatus({
    run: makeRun({
      status: 'partial',
      end_reason: 'unreadable_pages',
      finished_at: '2026-09-14T10:20:00.000Z',
      phase: null,
      approved_budget_inr: 40,
      spend_so_far_inr: 39.9,
      docs_completed: 3,
    }),
    unreadable: {
      pages_total: 6,
      documents_affected: 2,
      by_reason: {
        cost_budget: 4,
        vision_failed: 2,
        latency_budget: 0,
        page_budget: 0,
        render_failed: 0,
      },
      decision_required: true,
    },
    is_pending: false,
  });

  it('renders grouped page_ranges, by_reason counts, per-doc action and cost-to-finish', async () => {
    setStatusSequence(terminalWithHoles);
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/intelligence/status')) return { data: currentStatus() };
      if (url.includes('/unreadable')) {
        return {
          data: {
            run_id: RUN_ID,
            claim_id: CLAIM_ID,
            run_status: 'partial',
            end_reason: 'unreadable_pages',
            unreadable_pages_total: 6,
            readable_pages_total: 18,
            documents_affected: 2,
            documents_fully_unreadable: 1,
            by_reason: {
              cost_budget: 4,
              vision_failed: 2,
              latency_budget: 0,
              page_budget: 0,
              render_failed: 0,
            },
            documents: [
              {
                doc_id: 'doc-1',
                file_name: 'discharge-summary.pdf',
                total_pages: 12,
                unreadable_page_numbers: [4, 5, 6, 7],
                page_ranges: '4-7',
                reasons: ['cost_budget'],
                primary_action: 'approve_more_budget',
                affected_section_categories: ['final_bill', 'discharge_summary'],
              },
              {
                doc_id: 'doc-2',
                file_name: 'lab-report.pdf',
                total_pages: 2,
                unreadable_page_numbers: [1, 2],
                page_ranges: '1-2',
                reasons: ['vision_failed'],
                primary_action: 'retry_document',
                affected_section_categories: ['lab_report'],
              },
            ],
            suggested_actions: ['approve_more_budget', 'retry_document'],
            est_cost_to_finish_inr: 12.5,
            decision_required: true,
            acknowledged_at: null,
            acknowledged_by: null,
          },
        };
      }
      return { data: null };
    });

    renderPage();

    // The banner appears the moment /status says pages were lost — the
    // grouped detail is a second request and UPGRADES it when it lands.
    expect(await screen.findByText(/6 pages were not read/i)).toBeInTheDocument();
    expect(await screen.findByText(/18 of 24 pages were read/i)).toBeInTheDocument();
    expect(screen.getByText(/across 2 documents/i)).toBeInTheDocument();
    // by_reason chips, zero-count reasons suppressed.
    expect(screen.getByText(/4 · Out of budget/i)).toBeInTheDocument();
    expect(screen.getByText(/2 · Unreadable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Out of time/i)).not.toBeInTheDocument();
    // Grouped ranges, and WHAT was lost — not just where.
    expect(screen.getByText('4-7')).toBeInTheDocument();
    expect(screen.getByText(/Missing from the analysis: final bill, discharge summary/i)).toBeInTheDocument();
    expect(screen.getByText(/None of its 2 pages could be read/i)).toBeInTheDocument();
    // Per-document primary_action.
    expect(screen.getByRole('button', { name: /Approve more budget/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry this document/i })).toBeInTheDocument();
    // The cost to finish.
    expect(screen.getByText(/should cost about ₹12.50/i)).toBeInTheDocument();
  }, 20000);

  it('still declares the holes when the grouped detail fetch fails', async () => {
    // THE REGRESSION THIS GUARDS: /status knows pages were lost, the detail
    // request 404s, and the page used to render NOTHING — which reads exactly
    // like a clean, complete run.
    setStatusSequence(terminalWithHoles);
    renderPage();

    expect(await screen.findByText(/6 pages were not read/i)).toBeInTheDocument();
    expect(screen.getByText(/across 2 documents/i)).toBeInTheDocument();
    expect(screen.getByText(/4 · Out of budget/i)).toBeInTheDocument();
    expect(
      screen.getByText(/page-by-page breakdown could not be loaded/i),
    ).toBeInTheDocument();
    // It must not invent a denominator it does not have.
    expect(screen.queryByText(/0 of 6 pages were read/i)).not.toBeInTheDocument();
    // And it must still offer a way forward.
    expect(
      screen.getByRole('button', { name: /Run again with more budget|Run the analysis again/i }),
    ).toBeEnabled();
  }, 20000);

  it('"run again with more budget" pre-fills the consent dialog from the cost-to-finish', async () => {
    setStatusSequence(terminalWithHoles);
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/intelligence/status')) return { data: currentStatus() };
      if (url.includes('/unreadable')) {
        return {
          data: {
            run_id: RUN_ID,
            claim_id: CLAIM_ID,
            run_status: 'partial',
            end_reason: 'unreadable_pages',
            unreadable_pages_total: 6,
            readable_pages_total: 18,
            documents_affected: 1,
            documents_fully_unreadable: 0,
            by_reason: {
              cost_budget: 6,
              vision_failed: 0,
              latency_budget: 0,
              page_budget: 0,
              render_failed: 0,
            },
            documents: [
              {
                doc_id: 'doc-1',
                file_name: 'discharge-summary.pdf',
                total_pages: 12,
                unreadable_page_numbers: [7, 8, 9, 10, 11, 12],
                page_ranges: '7-12',
                reasons: ['cost_budget'],
                primary_action: 'approve_more_budget',
                affected_section_categories: ['final_bill'],
              },
            ],
            suggested_actions: ['approve_more_budget'],
            est_cost_to_finish_inr: 12.5,
            decision_required: true,
            acknowledged_at: null,
            acknowledged_by: null,
          },
        };
      }
      return { data: null };
    });
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (url.includes('/analyze') && body.approved_budget_inr == null) {
        throw httpError(428, {
          error: 'budget_approval_required',
          // Deliberately LOWER than the pre-fill, so the assertion below can
          // only pass if the pre-fill actually won.
          estimate: makeEstimate({ recommended_budget_inr: 8 }),
          min_budget_inr: 5,
          max_budget_inr: 1000,
        });
      }
      return { data: { ok: true } };
    });

    renderPage();
    await screen.findByText(/6 pages were not read/i);
    // Wait for the grouped detail to upgrade the banner — the priced CTA only
    // exists once the server has told us what finishing would cost.
    await user.click(
      await screen.findByRole('button', { name: /Run again with more budget/i }),
    );

    const dialog = await screen.findByRole('dialog');
    // ceil(12.5 * 1.25 / 10) * 10 = 20, and 20 > the 8 recommended.
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/Budget I approve for this run/i)).toHaveValue(20),
    );
  }, 20000);

  it('acknowledging is an explicit click that clears the banner', async () => {
    setStatusSequence(terminalWithHoles);
    renderPage();
    await screen.findByText(/6 pages were not read/i);

    setStatusSequence(
      makeStatus({
        run: terminalWithHoles.run,
        unreadable: {
          ...terminalWithHoles.unreadable!,
          decision_required: false,
        },
        is_pending: false,
      }),
    );
    await user.click(screen.getByRole('button', { name: /Dismiss/i }));

    await waitFor(() =>
      expect(
        mockPost.mock.calls.some((c) => String(c[0]).includes('/unreadable/acknowledge')),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByText(/6 pages were not read/i)).not.toBeInTheDocument(),
    );
  }, 20000);
});

// ═══════════════════ 7. failure + kill switch are legible ════════════

describe('terminal failure states', () => {
  it('a failed run says so and offers a re-run', async () => {
    setStatusSequence(
      makeStatus({
        run: makeRun({
          status: 'failed',
          end_reason: 'orchestrator_error',
          error: 'docSegmenter crashed on doc-2',
          finished_at: '2026-09-14T10:09:00.000Z',
          phase: null,
        }),
        is_pending: false,
      }),
    );
    renderPage();

    expect(await screen.findByText(/Analysis failed/i)).toBeInTheDocument();
    expect(screen.getByText(/docSegmenter crashed on doc-2/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run the analysis again/i })).toBeEnabled();
  }, 20000);

  it('a 503 kill switch is a message, not a spinner that never ends', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('/analyze')) {
        throw httpError(503, { error: 'ai_disabled', message: 'AI analysis is currently paused.' });
      }
      return { data: { ok: true } };
    });

    renderPage();
    await user.click(await screen.findByRole('button', { name: /Run Analysis/i }));

    expect(await screen.findByText(/AI analysis is currently paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Analysis/i })).toBeEnabled();
  }, 20000);

  it('a 428 with no estimate does not strand the user in an empty dialog', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('/analyze')) {
        throw httpError(428, { error: 'budget_approval_required' });
      }
      return { data: { ok: true } };
    });

    renderPage();
    await user.click(await screen.findByRole('button', { name: /Run Analysis/i }));

    expect(
      await screen.findByText(/did not send a cost estimate/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Analysis/i })).toBeEnabled();
  }, 20000);
});
