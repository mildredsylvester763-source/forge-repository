/**
 * FORGE TQ-040 Cross-browser and cross-device matrix engine.
 *
 * Market laws (BrowserStack, Sauce Labs, Playwright):
 * - A visual matrix is the cartesian product of browsers, platforms and
 *   viewports; market coverage is the share of combos actually tested
 *   (pass + fail) out of all planned combos; skips are not tested.
 * - Impossible market combinations are excluded from the plan: Safari
 *   on Android does not exist, so those combos are counted as
 *   unsupportedSkipped rather than planned.
 * - A matrix meets its threshold only when coverage reaches it AND no
 *   combo failed.
 *
 * Pure engine: no framework imports, no I/O, fully deterministic.
 */

export const MATRIX_BROWSERS: readonly string[] = ['chrome', 'firefox', 'safari', 'edge'];
export const MATRIX_PLATFORMS: readonly string[] = ['desktop', 'android', 'ios'];
export const MATRIX_VIEWPORTS: readonly string[] = ['1280x720', '1920x1080', '375x667', '768x1024'];
export const MATRIX_STATUSES: readonly string[] = ['pass', 'fail', 'skip'];
export const MATRIX_COMBO_LIMIT = 60;
export const MATRIX_THRESHOLD_DEFAULT = 100;

export interface MatrixPlanInput {
  browsers?: unknown;
  platforms?: unknown;
  viewports?: unknown;
}

export interface MatrixCombo {
  id: string;
  browser: string;
  platform: string;
  viewport: string;
}

export interface MatrixPlanResult {
  ok: boolean;
  reason?: string;
  combos?: MatrixCombo[];
  count?: number;
  unsupportedSkipped?: number;
}

export interface MatrixScoreInput {
  combos?: unknown;
  results?: unknown;
  threshold?: unknown;
}

export interface MatrixScoreResult {
  ok: boolean;
  reason?: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  coverage?: number;
  threshold?: number;
  meets?: boolean;
}

export function planMatrix(input: MatrixPlanInput): MatrixPlanResult {
  const browsers = input?.browsers === undefined ? [...MATRIX_BROWSERS] : input.browsers;
  const platforms = input?.platforms === undefined ? [...MATRIX_PLATFORMS] : input.platforms;
  const viewports = input?.viewports === undefined ? [...MATRIX_VIEWPORTS] : input.viewports;
  if (!Array.isArray(browsers) || browsers.length === 0) return { ok: false, reason: 'matrix-browsers-missing' };
  if (!Array.isArray(platforms) || platforms.length === 0) return { ok: false, reason: 'matrix-platforms-missing' };
  if (!Array.isArray(viewports) || viewports.length === 0) return { ok: false, reason: 'matrix-viewports-missing' };
  for (const browser of browsers) {
    if (!MATRIX_BROWSERS.includes(String(browser))) {
      return { ok: false, reason: 'matrix-browser-unknown:' + String(browser) };
    }
  }
  for (const platform of platforms) {
    if (!MATRIX_PLATFORMS.includes(String(platform))) {
      return { ok: false, reason: 'matrix-platform-unknown:' + String(platform) };
    }
  }
  for (const viewport of viewports) {
    if (!MATRIX_VIEWPORTS.includes(String(viewport))) {
      return { ok: false, reason: 'matrix-viewport-unknown:' + String(viewport) };
    }
  }
  const combos: MatrixCombo[] = [];
  let unsupportedSkipped = 0;
  for (const browser of browsers) {
    for (const platform of platforms) {
      if (String(browser) === 'safari' && String(platform) === 'android') {
        unsupportedSkipped += viewports.length;
        continue;
      }
      for (const viewport of viewports) {
        combos.push({
          id: 'c' + (combos.length + 1),
          browser: String(browser),
          platform: String(platform),
          viewport: String(viewport),
        });
      }
    }
  }
  if (combos.length === 0) return { ok: false, reason: 'matrix-combos-empty' };
  if (combos.length > MATRIX_COMBO_LIMIT) return { ok: false, reason: 'matrix-combo-limit:' + combos.length };
  return { ok: true, combos, count: combos.length, unsupportedSkipped };
}

export function scoreMatrix(input: MatrixScoreInput): MatrixScoreResult {
  const combosRaw = Array.isArray(input?.combos) ? (input.combos as unknown[]) : [];
  if (combosRaw.length === 0) return { ok: false, reason: 'matrix-combos-empty' };
  const ids: string[] = [];
  for (let i = 0; i < combosRaw.length; i++) {
    const combo = combosRaw[i] as Record<string, unknown>;
    const id = combo && typeof combo.id === 'string' ? String(combo.id) : '';
    if (id.length === 0) return { ok: false, reason: 'matrix-combo-id-missing:' + (i + 1) };
    ids.push(id);
  }
  const results: unknown = input?.results;
  if (typeof results !== 'object' || results === null || Array.isArray(results)) {
    return { ok: false, reason: 'matrix-results-invalid' };
  }
  const resultMap = results as Record<string, unknown>;
  for (const key of Object.keys(resultMap)) {
    if (!ids.includes(key)) return { ok: false, reason: 'matrix-combo-unknown:' + key };
  }
  for (const id of ids) {
    if (resultMap[id] === undefined) return { ok: false, reason: 'matrix-result-missing:' + id };
  }
  const rawThreshold: unknown = input?.threshold;
  const threshold = rawThreshold === undefined ? MATRIX_THRESHOLD_DEFAULT : rawThreshold;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    return { ok: false, reason: 'matrix-threshold-invalid:' + String(threshold) };
  }
  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;
  for (const id of ids) {
    const status = resultMap[id];
    if (typeof status !== 'string' || !MATRIX_STATUSES.includes(status)) {
      return { ok: false, reason: 'matrix-status-invalid:' + String(status) + ':' + id };
    }
    if (status === 'pass') passCount++;
    else if (status === 'fail') failCount++;
    else skipCount++;
  }
  const total = ids.length;
  const coverage = Number((((passCount + failCount) / total) * 100).toFixed(2));
  return {
    ok: true,
    total,
    passed: passCount,
    failed: failCount,
    skipped: skipCount,
    coverage,
    threshold,
    meets: coverage >= threshold && failCount === 0,
  };
}
