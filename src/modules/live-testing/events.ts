/**
 * The live testing module's published event contract (a small schema registry).
 * Other modules subscribe to these; they never reach into live testing internals.
 * Payloads never contain step targets, typed values, message bodies or payloads:
 * narration and secrets survive the log by construction.
 */
export const LiveTestingEvents = {
  SessionCreated: 'live_testing.session.created',
  SessionStatusChanged: 'live_testing.session.status_changed',
  StepRecorded: 'live_testing.session.step_recorded',
  FindingReported: 'live_testing.session.finding_reported',
} as const;

export type LiveTestingEventType = (typeof LiveTestingEvents)[keyof typeof LiveTestingEvents];
export const LIVE_TESTING_EVENT_VERSION = 1;
