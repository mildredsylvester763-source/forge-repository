/**
 * Training-data module events (AI-001/002/007..012). One event per state change;
 * read paths (lineage, chains, Borda tallies, encode/decode, lists) emit nothing.
 */

export const TrainingDataEvents = {
  LakeRecordAdmitted: 'training_data.lake_record_admitted',
  LakeBatchComposed: 'training_data.lake_batch_composed',
  ConsentGranted: 'training_data.consent_granted',
  ConsentRevoked: 'training_data.consent_revoked',
  SyntheticRegistered: 'training_data.synthetic_registered',
  LabelSubmitted: 'training_data.label_submitted',
  PreferenceStored: 'training_data.preference_stored',
  CodedataRegistered: 'training_data.codedata_registered',
  CodedataDeployed: 'training_data.codedata_deployed',
  CreativeRegistered: 'training_data.creative_registered',
  CreativeApproved: 'training_data.creative_approved',
  CreativeRejected: 'training_data.creative_rejected',
  CreativePublished: 'training_data.creative_published',
  CreativeRevised: 'training_data.creative_revised',
  TokenizerRegistered: 'training_data.tokenizer_registered',
} as const;

export type TrainingDataEventType = (typeof TrainingDataEvents)[keyof typeof TrainingDataEvents];

export const TRAINING_DATA_EVENT_VERSION = 1;
