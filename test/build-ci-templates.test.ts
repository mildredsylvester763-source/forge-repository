import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { SqliteBuildCiStore } from '../src/modules/build-ci/sqlite-store.ts';
import { SqlitePipelineTemplateStore } from '../src/modules/build-ci/templates.ts';
import { validatePipelineDefinition } from '../src/modules/build-ci/pipeline.ts';

test('SQLite templates are immutable, explicitly shared, revocable and provenance-aware', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    migrateBuildCiSqlite(db);
    const pipelines = new SqliteBuildCiStore(db);
    const templates = new SqlitePipelineTemplateStore(db);
    const definition = validatePipelineDefinition({
      id: 'source-quality',
      name: 'Source quality',
      triggers: [{ id: 'manual', kind: 'manual' }],
      steps: [{ id: 'verify', task: 'quality.verify' }],
    });
    const source = await pipelines.saveVersion({ workspaceId: 'publisher', definition, createdBy: 'owner' });
    const template = await templates.create({
      templateId: 'template-quality',
      publisherWorkspaceId: 'publisher',
      source,
      name: 'Quality template',
      visibility: 'workspace',
      changelog: 'Initial release',
      createdBy: 'owner',
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    assert.equal(template.version, 1);
    assert.equal(await templates.canAccess('template-quality', 'consumer'), false);
    assert.equal((await templates.listAccessible('consumer')).length, 0);

    await templates.grant('template-quality', 'publisher', 'consumer', 'owner', '2026-11-04T00:01:00.000Z');
    assert.equal(await templates.canAccess('template-quality', 'consumer'), true);
    assert.equal((await templates.listAccessible('consumer')).length, 1);

    const sourceV2 = await pipelines.saveVersion({
      workspaceId: 'publisher',
      definition: validatePipelineDefinition({ ...definition, name: 'Quality template v2' }),
      createdBy: 'owner',
    });
    const templateV2 = await templates.publishVersion({
      templateId: 'template-quality',
      publisherWorkspaceId: 'publisher',
      source: sourceV2,
      changelog: 'Improved checks',
      createdBy: 'owner',
      createdAt: '2026-11-04T00:02:00.000Z',
    });
    assert.equal(templateV2.version, 2);
    assert.equal((await templates.getTemplate('template-quality'))?.currentVersion, 2);
    assert.equal((await templates.getVersion('template-quality', 2))?.definitionHash, sourceV2.definitionHash);

    const imported = await pipelines.saveVersion({
      workspaceId: 'consumer',
      definition: validatePipelineDefinition({ ...templateV2.definition, id: 'consumer-quality' }),
      createdBy: 'consumer-owner',
      templateSource: {
        templateId: 'template-quality',
        templateVersion: templateV2.version,
        templateHash: templateV2.definitionHash,
        publisherWorkspaceId: 'publisher',
      },
    });
    assert.deepEqual((await pipelines.getLatestVersion('consumer', 'consumer-quality'))?.templateSource, imported.templateSource);

    assert.throws(() => db.prepare("UPDATE build_pipeline_template_versions SET changelog = 'tampered' WHERE template_id = ?").run('template-quality'));
    assert.throws(() => db.prepare('DELETE FROM build_pipeline_template_versions WHERE template_id = ?').run('template-quality'));

    await templates.revoke('template-quality', 'publisher', 'consumer', '2026-11-04T00:03:00.000Z');
    assert.equal(await templates.canAccess('template-quality', 'consumer'), false);
    assert.equal((await templates.listAccessible('consumer')).length, 0);
  } finally {
    db.close();
  }
});
