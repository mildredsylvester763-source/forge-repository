import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePipelineInputs, validatePipelineDefinition } from '../src/modules/build-ci/pipeline.ts';

const base = {
  id: 'typed-inputs',
  name: 'Typed inputs',
  triggers: [{ id: 'manual', kind: 'manual' }],
  steps: [{ id: 'run', task: 'quality.verify' }],
};

test('typed pipeline inputs apply defaults and validate required, options and secret references', () => {
  const definition = validatePipelineDefinition({
    ...base,
    inputs: [
      { name: 'region', type: 'string', required: true, options: ['eu-west', 'us-east'] },
      { name: 'retries', type: 'number', default: 2, options: [0, 1, 2, 3] },
      { name: 'publish', type: 'boolean', default: false },
      { name: 'signing_key', type: 'secret_ref', required: true },
    ],
  });
  const values = resolvePipelineInputs(definition, { region: 'us-east', signing_key: 'workspace.release_signing_key' });
  assert.deepEqual(values, {
    region: 'us-east',
    retries: 2,
    publish: false,
    signing_key: 'workspace.release_signing_key',
  });
});

test('typed inputs reject unknown, missing, mistyped and out-of-range values', () => {
  const definition = validatePipelineDefinition({
    ...base,
    inputs: [
      { name: 'region', type: 'string', required: true, options: ['eu-west', 'us-east'] },
      { name: 'retries', type: 'number', default: 2, options: [0, 1, 2, 3] },
      { name: 'signing_key', type: 'secret_ref', required: true },
    ],
  });
  assert.throws(() => resolvePipelineInputs(definition, { region: 'us-east' }), /required value is missing/);
  assert.throws(() => resolvePipelineInputs(definition, { region: 'ap-south', signing_key: 'workspace.key' }), /not in the allowed options/);
  assert.throws(() => resolvePipelineInputs(definition, { region: 3, signing_key: 'workspace.key' }), /does not match declared type/);
  assert.throws(() => resolvePipelineInputs(definition, { region: 'us-east', signing_key: 'plain-secret-value' }), /does not match declared type/);
  assert.throws(() => resolvePipelineInputs(definition, { region: 'us-east', signing_key: 'workspace.key', injected: true }), /undeclared input/);
});

test('definition schema rejects duplicate inputs and required inputs with defaults', () => {
  assert.throws(() => validatePipelineDefinition({
    ...base,
    inputs: [
      { name: 'environment', type: 'string', required: true, default: 'staging' },
      { name: 'environment', type: 'string', default: 'production' },
    ],
  }), /duplicate input name|cannot also define a default/);
});
