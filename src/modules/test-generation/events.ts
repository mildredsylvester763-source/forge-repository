/**
 * The test generation module's published event contract (a small schema registry).
 * Other modules subscribe to these; they never reach into test generation internals.
 * Payloads never contain generated case bodies.
 */
export const TestGenerationEvents = {
  SuiteGenerated: 'test_generation.suite.generated',
} as const;

export type TestGenerationEventType = (typeof TestGenerationEvents)[keyof typeof TestGenerationEvents];
export const TEST_GENERATION_EVENT_VERSION = 1;
