/**
 * The AI training module's published event contract (a small schema
 * registry). Other modules subscribe to these; they never reach into AI
 * training internals. Payloads never contain asset bodies, dataset items,
 * probe prompts or case content: only names, versions and counts survive
 * the log by construction.
 */
export const AiTrainingEvents = {
  AssetCreated: 'ai_training.asset.created',
  DatasetCreated: 'ai_training.dataset.created',
  RunCreated: 'ai_training.run.created',
  SafetyGradeRecorded: 'ai_training.safety.grade.recorded',
  ExperimentDefined: 'ai_training.experiment.defined',
  MiningBatchCreated: 'ai_training.mining.batch.created',
} as const;

export type AiTrainingEventType = (typeof AiTrainingEvents)[keyof typeof AiTrainingEvents];

export const AI_TRAINING_EVENT_VERSION = 1;
