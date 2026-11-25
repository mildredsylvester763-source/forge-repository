/**
 * The test quality module's published event contract (a small schema registry).
 * Other modules subscribe to these; they never reach into test quality internals.
 * Payloads never contain golden content bodies.
 */
export const TestQualityEvents = {
  GoldenWritten: 'test_quality.golden.written',
  GoldenUpdated: 'test_quality.golden.updated',
} as const;

export type TestQualityEventType = (typeof TestQualityEvents)[keyof typeof TestQualityEvents];
export const TEST_QUALITY_EVENT_VERSION = 1;
