// Pure auto bug report assembly engine for live agent testing
// (FORGE TQ-017). A reported finding plus the recorded step narrations
// become one structured, shareable bug report with a deterministic dedupe
// key. The engine is pure: every refusal is named and typed values are
// never invented.

export const SEVERITY_LABELS = ['trivial', 'minor', 'major', 'critical', 'blocker'];

export interface FindingInput {
  severity: number;
  title: string;
  reproSteps: string | null;
  evidence: string | null;
  suspectedCommit: string | null;
}

export interface StepSummary {
  narration: string | null;
  status: string;
}

export interface BugReportVerdict {
  ok: boolean;
  reason?: string;
  report?: {
    title: string;
    severityLabel: string;
    reproLines: string[];
    environmentLine: string;
    evidence: string | null;
    suspectedCommit: string | null;
    dedupeKey: string;
  };
}

const COMMIT_RE = /^[0-9a-f]{7,40}$/;

export function assembleBugReport(
  sessionId: string,
  session: { platform: string; environment: string; safeMode: boolean },
  finding: FindingInput,
  steps: StepSummary[],
): BugReportVerdict {
  if (!Number.isInteger(finding.severity) || finding.severity < 1 || finding.severity > 5) {
    return { ok: false, reason: 'bugreport-severity-invalid:' + finding.severity };
  }
  if (typeof finding.title !== 'string' || finding.title.trim().length === 0) {
    return { ok: false, reason: 'bugreport-title-empty' };
  }
  if (
    finding.suspectedCommit !== null &&
    finding.suspectedCommit !== undefined &&
    finding.suspectedCommit !== '' &&
    !COMMIT_RE.test(finding.suspectedCommit)
  ) {
    return { ok: false, reason: 'bugreport-suspected-commit-invalid' };
  }
  const reproLines: string[] = [];
  for (const s of steps) {
    if (typeof s.narration === 'string' && s.narration.length > 0) {
      reproLines.push(s.narration);
    }
  }
  const extra = typeof finding.reproSteps === 'string' ? finding.reproSteps.trim() : '';
  if (extra.length > 0) {
    reproLines.push(extra);
  }
  const environmentLine =
    'platform ' +
    session.platform +
    ', environment ' +
    session.environment +
    ', safe mode ' +
    (session.safeMode ? 'on' : 'off');
  const normTitle = finding.title.trim().replace(/\s+/g, ' ').toLowerCase();
  const dedupeKey = sessionId + '|' + finding.severity + '|' + normTitle;
  return {
    ok: true,
    report: {
      title: finding.title.trim(),
      severityLabel: SEVERITY_LABELS[finding.severity - 1]!,
      reproLines,
      environmentLine,
      evidence:
        typeof finding.evidence === 'string' && finding.evidence.length > 0 ? finding.evidence : null,
      suspectedCommit:
        finding.suspectedCommit === '' || finding.suspectedCommit === undefined
          ? null
          : finding.suspectedCommit,
      dedupeKey,
    },
  };
}
