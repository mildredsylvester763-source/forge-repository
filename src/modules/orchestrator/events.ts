/**
 * The orchestrator module's published event contract (a small schema registry).
 * Other modules subscribe to these; they never reach into orchestrator internals.
 * Payloads never contain plan step bodies.
 */
export const OrchestratorEvents = {
  PlanCreated: 'orchestrator.plan.created',
  PlanEdited: 'orchestrator.plan.edited',
} as const;

export type OrchestratorEventType = (typeof OrchestratorEvents)[keyof typeof OrchestratorEvents];
export const ORCHESTRATOR_EVENT_VERSION = 1;
