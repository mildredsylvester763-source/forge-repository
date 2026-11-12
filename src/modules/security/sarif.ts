import type { Finding, Severity } from './findings.ts';

/** SARIF 2.1.0, the standard format GitHub's code scanning and most security dashboards read. Never contains a secret. */

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { high: 'error', medium: 'warning', low: 'note' };

export function toSarif(findings: readonly Finding[]): Record<string, unknown> {
  const rules = new Map<string, { id: string; shortDescription: { text: string }; help: { text: string }; defaultConfiguration: { level: string } }>();
  for (const f of findings) {
    if (!rules.has(f.ruleId)) rules.set(f.ruleId, { id: f.ruleId, shortDescription: { text: f.message }, help: { text: f.fix }, defaultConfiguration: { level: LEVEL[f.severity] } });
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'FORGE safety kit', rules: [...rules.values()] } },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: LEVEL[f.severity],
          message: { text: f.detail ? `${f.message} (${f.detail})` : f.message },
          locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: Math.max(1, f.line) } } }],
          partialFingerprints: { 'forge/v1': f.fingerprint },
          ...(f.commit ? { properties: { commit: f.commit } } : {}),
        })),
      },
    ],
  };
}
