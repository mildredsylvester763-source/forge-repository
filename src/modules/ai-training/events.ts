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
  ModelVersionRegistered: 'ai_training.model.version.registered',
  ModelCardCreated: 'ai_training.model.card.created',
  ModelPromoted: 'ai_training.model.promoted',
  ModelPinned: 'ai_training.model.pinned',
  ModelUnpinned: 'ai_training.model.unpinned',
  SlotsReserved: 'ai_training.slots.reserved',
  SlotsReleased: 'ai_training.slots.released',
  OnPremPackageBuilt: 'ai_training.onprem.package.built',
  ProviderRegistered: 'ai_training.provider.registered',
  ByokKeyRegistered: 'ai_training.byok.key.registered',
  GatewayLogRecorded: 'ai_training.gateway.log.recorded',
  CapabilityMatrixSaved: 'ai_training.capability.matrix.saved',
  OutputSchemaRegistered: 'ai_training.output.schema.registered',
  RollbackPlanned: 'ai_training.rollback.planned',
  ServingPlanCreated: 'ai_training.serving.plan.created',
} as const;

export type AiTrainingEventType = (typeof AiTrainingEvents)[keyof typeof AiTrainingEvents];

export const AI_TRAINING_EVENT_VERSION = 1;
