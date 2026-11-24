/**
 * AI-018 - experiment tracking: configs, metrics, loss curves, comparisons, pure engine.
 * Catalog row: "Experiment tracking: configs, metrics, loss curves, comparisons" -
 * internal forge machinery, never sold. Distinct from AI-029 in-product A/B
 * experiments (people variants) and from training-run metrics: this engine tracks
 * the training experiments an operator defines, point by point. Deterministic
 * and side-effect free.
 */

export interface TrackedPoint {
  step: number;
  metric: string;
  value: number;
}

export interface TrackedExperiment {
  experimentId: string;
  config: Record<string, string | number | boolean>;
  metrics: readonly string[];
  points: readonly TrackedPoint[];
  pointCount: number;
  fingerprint: string;
}

export interface TrackedCurve {
  metric: string;
  points: TrackedPoint[];
}

export interface TrackedComparison {
  metric: string;
  a: { experimentId: string; last: number; count: number };
  b: { experimentId: string; last: number; count: number };
  delta: number;
}

export type TrackingResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function localHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function curveFor(experiment: TrackedExperiment, metric: string): TrackedCurve {
  const points = experiment.points
    .filter((p) => p.metric === metric)
    .map((p) => ({ ...p }))
    .sort((x, y) => x.step - y.step || x.value - y.value);
  return { metric, points };
}

function lastPoint(experiment: TrackedExperiment, metric: string): TrackedPoint | null {
  let best: TrackedPoint | null = null;
  for (const point of experiment.points) {
    if (point.metric !== metric) continue;
    if (best === null || point.step >= best.step) best = point;
  }
  return best;
}

function countFor(experiment: TrackedExperiment, metric: string): number {
  let count = 0;
  for (const point of experiment.points) {
    if (point.metric === metric) count += 1;
  }
  return count;
}

export function defineTrackedExperiment(input: { experimentId: string; config: unknown; metrics: unknown }): TrackingResult<TrackedExperiment> {
  const experimentId = typeof input.experimentId === 'string' ? input.experimentId.trim() : '';
  if (experimentId === '') return { ok: false, reason: 'experiment-tracking-no-id' };
  if (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config)) return { ok: false, reason: 'experiment-tracking-no-config' };
  const configRaw = input.config as Record<string, unknown>;
  const configKeys = Object.keys(configRaw);
  if (configKeys.length === 0) return { ok: false, reason: 'experiment-tracking-no-config' };
  const config: Record<string, string | number | boolean> = {};
  for (const key of configKeys) {
    const raw = configRaw[key];
    if (typeof raw === 'string' || typeof raw === 'boolean' || isFiniteNumber(raw)) config[key] = raw;
    else return { ok: false, reason: 'experiment-tracking-config-invalid:' + key };
  }
  if (!Array.isArray(input.metrics) || input.metrics.length === 0) return { ok: false, reason: 'experiment-tracking-no-metrics' };
  const metrics: string[] = [];
  for (let i = 0; i < input.metrics.length; i++) {
    const name = input.metrics[i];
    if (typeof name !== 'string' || name.trim() === '') return { ok: false, reason: 'experiment-tracking-metric-invalid:' + String(i) };
    if (metrics.includes(name)) return { ok: false, reason: 'experiment-tracking-metric-duplicate:' + name };
    metrics.push(name);
  }
  const sortedConfigKeys = Object.keys(config).sort();
  return {
    ok: true,
    value: {
      experimentId,
      config,
      metrics,
      points: [],
      pointCount: 0,
      fingerprint: 'ext_' + localHash(experimentId + '\u0000' + sortedConfigKeys.join('|') + '\u0000' + metrics.join('|')),
    },
  };
}

export function logTrackedPoint(experiment: TrackedExperiment, input: { step: unknown; metric: string; value: unknown }): TrackingResult<{ experiment: TrackedExperiment; point: TrackedPoint }> {
  const metric = typeof input.metric === 'string' ? input.metric.trim() : '';
  if (!experiment.metrics.includes(metric)) return { ok: false, reason: 'experiment-tracking-unknown-metric:' + input.metric };
  if (!isFiniteNumber(input.step) || !Number.isInteger(input.step) || input.step < 0) return { ok: false, reason: 'experiment-tracking-bad-step' };
  if (!isFiniteNumber(input.value)) return { ok: false, reason: 'experiment-tracking-bad-value' };
  const point: TrackedPoint = { step: input.step, metric, value: input.value };
  return {
    ok: true,
    value: {
      experiment: { ...experiment, points: [...experiment.points, point], pointCount: experiment.pointCount + 1 },
      point,
    },
  };
}

export function trackedCurves(experiment: TrackedExperiment, metric?: string): TrackingResult<{ experimentId: string; curves: TrackedCurve[] }> {
  if (metric !== undefined) {
    if (!experiment.metrics.includes(metric)) return { ok: false, reason: 'experiment-tracking-unknown-metric:' + metric };
    return { ok: true, value: { experimentId: experiment.experimentId, curves: [curveFor(experiment, metric)] } };
  }
  const curves: TrackedCurve[] = [];
  for (const metric of experiment.metrics) curves.push(curveFor(experiment, metric));
  return { ok: true, value: { experimentId: experiment.experimentId, curves } };
}

export function compareTrackedExperiments(a: TrackedExperiment, b: TrackedExperiment, metric: string): TrackingResult<TrackedComparison> {
  const name = typeof metric === 'string' ? metric.trim() : '';
  if (name === '') return { ok: false, reason: 'experiment-tracking-compare-no-metric' };
  if (!a.metrics.includes(name)) return { ok: false, reason: 'experiment-tracking-unknown-metric:' + name };
  if (!b.metrics.includes(name)) return { ok: false, reason: 'experiment-tracking-unknown-metric:' + name };
  const lastA = lastPoint(a, name);
  const lastB = lastPoint(b, name);
  if (lastA === null || lastB === null) return { ok: false, reason: 'experiment-tracking-compare-empty:' + name };
  return {
    ok: true,
    value: {
      metric: name,
      a: { experimentId: a.experimentId, last: lastA.value, count: countFor(a, name) },
      b: { experimentId: b.experimentId, last: lastB.value, count: countFor(b, name) },
      delta: Math.round((lastB.value - lastA.value) * 10000) / 10000,
    },
  };
}
