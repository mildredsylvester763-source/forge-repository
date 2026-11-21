import { createHash } from 'node:crypto';
import { canonicalJson } from '../../kernel/canonical.ts';
import { IMMUTABLE_FLOOR, SAFETY_CATEGORIES } from './engine/toggle-state-engine.ts';
import { SAFETY_CATALOG, type SafetyCatalogItem } from './safety-catalog.ts';

export const SAFETY_PUBLIC_MANIFEST_FEATURE_ID = 'TS-800';
export interface SafetyPublicManifestSystem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}
export interface SafetyPublicManifest {
  readonly schemaVersion: 1;
  readonly coverage: 'canonical_policy_definitions_only';
  readonly systems: readonly SafetyPublicManifestSystem[];
  readonly immutableFloor: SafetyPublicManifestSystem & { readonly enabled: true; readonly mutable: false };
  readonly sha256: string;
}
export type SafetyPublicManifestResult =
  | { readonly ok: true; readonly manifest: SafetyPublicManifest }
  | { readonly ok: false; readonly reason: 'catalog_invalid' };

/** Builds a public, deterministic manifest from the one canonical safety catalog. */
export function buildSafetyPublicManifest(catalog: readonly SafetyCatalogItem[] = SAFETY_CATALOG): SafetyPublicManifestResult {
  if (!isCompleteCatalog(catalog)) return { ok: false, reason: 'catalog_invalid' };
  const floorEntry = catalog.find((item) => item.id === IMMUTABLE_FLOOR.id)!;
  const payload = {
    schemaVersion: 1 as const,
    coverage: 'canonical_policy_definitions_only' as const,
    systems: Object.freeze(catalog.filter((item) => item.id !== IMMUTABLE_FLOOR.id).map(toSystem)),
    immutableFloor: Object.freeze({ ...toSystem(floorEntry), enabled: true as const, mutable: false as const }),
  };
  const sha256 = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  return {
    ok: true,
    manifest: Object.freeze({ ...payload, sha256 }),
  };
}

function toSystem(item: SafetyCatalogItem): SafetyPublicManifestSystem {
  return Object.freeze({ id: item.id, label: item.label, description: item.description });
}
function isCompleteCatalog(value: unknown): value is readonly SafetyCatalogItem[] {
  if (!Array.isArray(value) || value.length !== SAFETY_CATEGORIES.length + 1) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.label !== 'string' || row.label.trim().length === 0 ||
        typeof row.description !== 'string' || row.description.trim().length === 0 || ids.has(row.id) ||
        Object.keys(row).some((key) => !['id', 'label', 'description'].includes(key))) return false;
    ids.add(row.id);
  }
  return SAFETY_CATEGORIES.every((category) => ids.has(category)) && ids.has(IMMUTABLE_FLOOR.id);
}
