/**
 * The plans module's published event contract (a small schema registry).
 * Billing, audit and product surfaces subscribe to these; they never reach into plans internals.
 * Payloads never contain secrets — a plan change is public metadata.
 */
export const PlansEvents = {
  PlanChanged: 'plans.plan.changed',
} as const;

export type PlansEventType = (typeof PlansEvents)[keyof typeof PlansEvents];
export const PLANS_EVENT_VERSION = 1;
