// Pure research mode engine (FORGE AI-066). A multi-step investigation is a
// validated plan over the canonical steps search, read, cross-check, draft
// (in that order), and the written report separates verified findings (two
// or more sources) from unverified ones. Every refusal is named, never
// silent.

export const RESEARCH_STEPS: string[] = ['search', 'read', 'cross-check', 'draft'];

export interface ResearchPlanVerdict {
  ok: boolean;
  reason?: string;
  topic?: string;
  steps?: string[];
  stepCount?: number;
}

export interface ResearchFinding {
  claim: string;
  sources: string[];
  verified: boolean;
}

export interface ResearchReportVerdict {
  ok: boolean;
  reason?: string;
  topic?: string;
  summary?: string;
  findings?: ResearchFinding[];
  verifiedCount?: number;
  unverifiedCount?: number;
  openQuestions?: string[];
}

export function planResearch(input: { topic?: unknown; steps?: unknown }): ResearchPlanVerdict {
  const topic = typeof input?.topic === 'string' ? input.topic.trim() : '';
  if (topic.length === 0) {
    return { ok: false, reason: 'research-topic-missing' };
  }
  let steps = [...RESEARCH_STEPS];
  if (input?.steps !== undefined && input?.steps !== null) {
    if (!Array.isArray(input.steps)) {
      return { ok: false, reason: 'research-steps-not-array' };
    }
    if (input.steps.length === 0) {
      return { ok: false, reason: 'research-steps-empty' };
    }
    const seen = new Set<string>();
    for (const raw of input.steps) {
      const s = typeof raw === 'string' ? raw.trim().toLowerCase() : String(raw);
      if (!RESEARCH_STEPS.includes(s)) {
        return { ok: false, reason: 'research-step-unknown:' + s };
      }
      if (seen.has(s)) {
        return { ok: false, reason: 'research-step-duplicate:' + s };
      }
      seen.add(s);
    }
    const order: number[] = (input.steps as string[]).map((s) =>
      RESEARCH_STEPS.indexOf(s.trim().toLowerCase()),
    );
    for (let i = 1; i < order.length; i++) {
      if (order[i]! < order[i - 1]!) {
        return { ok: false, reason: 'research-steps-out-of-order' };
      }
    }
    steps = (input.steps as string[]).map((s) => s.trim().toLowerCase());
  }
  return { ok: true, topic, steps, stepCount: steps.length };
}

export function buildResearchReport(input: {
  topic?: unknown;
  findings?: unknown;
  openQuestions?: unknown;
}): ResearchReportVerdict {
  const planned = planResearch({ topic: input?.topic });
  if (!planned.ok) {
    return { ok: false, reason: planned.reason };
  }
  const topic = planned.topic ?? '';
  if (!Array.isArray(input?.findings) || (input.findings as unknown[]).length === 0) {
    return { ok: false, reason: 'research-findings-empty' };
  }
  const findings: ResearchFinding[] = [];
  let verifiedCount = 0;
  for (const raw of input.findings as Record<string, unknown>[]) {
    const claim = typeof raw?.claim === 'string' ? raw.claim.trim() : '';
    if (claim.length === 0) {
      return { ok: false, reason: 'research-claim-missing' };
    }
    if (!Array.isArray(raw?.sources) || (raw.sources as unknown[]).length === 0) {
      return { ok: false, reason: 'research-source-missing' };
    }
    const sources: string[] = [];
    for (const s of raw.sources as unknown[]) {
      if (typeof s !== 'string' || s.trim().length === 0) {
        return { ok: false, reason: 'research-source-blank' };
      }
      sources.push(s.trim());
    }
    const verified = sources.length >= 2;
    if (verified) {
      verifiedCount++;
    }
    findings.push({ claim, sources, verified });
  }
  let openQuestions: string[] = [];
  if (input?.openQuestions !== undefined && input?.openQuestions !== null) {
    if (!Array.isArray(input.openQuestions)) {
      return { ok: false, reason: 'research-questions-not-array' };
    }
    for (const q of input.openQuestions as unknown[]) {
      if (typeof q !== 'string' || q.trim().length === 0) {
        return { ok: false, reason: 'research-question-blank' };
      }
    }
    openQuestions = (input.openQuestions as string[]).map((q) => q.trim());
  }
  return {
    ok: true,
    topic,
    summary: 'Investigation of ' + topic + ' with ' + findings.length + ' findings',
    findings,
    verifiedCount,
    unverifiedCount: findings.length - verifiedCount,
    openQuestions,
  };
}
