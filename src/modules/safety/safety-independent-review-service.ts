import type { EventEnvelope, EventStore } from '../../kernel/events.ts';

export const SAFETY_INDEPENDENT_REVIEW_FEATURE_ID = 'TS-799';
export const SAFETY_INDEPENDENT_REVIEW_EVENT = 'safety.independent_review.completed';

/** Independence must come from trusted reviewer governance, never a request-body claim. */
export interface SafetyIndependentReviewerAccess {
  canUse(reviewerId: string, featureId: string): Promise<{ readonly allowed: boolean }>;
  isIndependentReviewer(reviewerId: string): Promise<boolean>;
}
export interface SafetyIndependentReviewRecord {
  readonly reviewId: string;
  readonly periodId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly reportReference: string;
  readonly outcome: 'completed' | 'remediation_required';
}
export type SafetyIndependentReviewResult =
  | { readonly ok: true; readonly event: EventEnvelope }
  | { readonly ok: false; readonly reason: 'reviewer_invalid' | 'feature_unavailable' | 'reviewer_not_independent' | 'authorization_unavailable' | 'review_invalid' | 'event_store_unavailable' };

/** TS-799 records a completed review; periodic scheduling and reviewer onboarding remain external adapters. */
export class SafetyIndependentReviewService {
  private readonly access: SafetyIndependentReviewerAccess;
  private readonly events: EventStore;

  constructor(input: { readonly access: SafetyIndependentReviewerAccess; readonly events: EventStore }) {
    this.access = input.access;
    this.events = input.events;
  }

  async recordCompletion(reviewerId: string, input: unknown): Promise<SafetyIndependentReviewResult> {
    if (!isId(reviewerId)) return { ok: false, reason: 'reviewer_invalid' };
    let allowed: boolean;
    let independent: boolean;
    try {
      allowed = (await this.access.canUse(reviewerId, SAFETY_INDEPENDENT_REVIEW_FEATURE_ID)).allowed === true;
      if (!allowed) return { ok: false, reason: 'feature_unavailable' };
      independent = await this.access.isIndependentReviewer(reviewerId);
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
    if (!independent) return { ok: false, reason: 'reviewer_not_independent' };
    const review = validateReview(input);
    if (!review) return { ok: false, reason: 'review_invalid' };
    try {
      const event = await this.events.append({
        type: SAFETY_INDEPENDENT_REVIEW_EVENT,
        version: 1,
        actor: { kind: 'user', id: reviewerId },
        subject: { type: 'safety_independent_review', id: review.reviewId },
        payload: {
          reviewId: review.reviewId,
          periodId: review.periodId,
          periodStart: review.periodStart,
          periodEnd: review.periodEnd,
          reportReference: review.reportReference,
          outcome: review.outcome,
          independentlyReviewed: true,
        },
      });
      return { ok: true, event };
    } catch {
      return { ok: false, reason: 'event_store_unavailable' };
    }
  }
}

function validateReview(value: unknown): SafetyIndependentReviewRecord | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !['reviewId', 'periodId', 'periodStart', 'periodEnd', 'reportReference', 'outcome'].includes(key))) return null;
  if (!isId(value.reviewId) || !isId(value.periodId) || !isId(value.reportReference)) return null;
  if (typeof value.periodStart !== 'string' || typeof value.periodEnd !== 'string') return null;
  const start = Date.parse(value.periodStart);
  const end = Date.parse(value.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (value.outcome !== 'completed' && value.outcome !== 'remediation_required') return null;
  return Object.freeze({
    reviewId: value.reviewId,
    periodId: value.periodId,
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
    reportReference: value.reportReference,
    outcome: value.outcome,
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
