import {
  IMMUTABLE_FLOOR,
  SAFETY_CATEGORIES,
  type SafetyCategory,
  type ToggleScope,
  type ToggleSnapshot,
} from './engine/toggle-state-engine.ts';

export interface SafetyCatalogItem {
  readonly id: SafetyCategory | typeof IMMUTABLE_FLOOR.id;
  readonly label: string;
  readonly description: string;
}

export const SAFETY_CATALOG: readonly SafetyCatalogItem[] = Object.freeze(([
  { id: 'content', label: 'Content safety', description: 'Checks content against Forge safety rules.' },
  { id: 'action', label: 'Action guardrails', description: 'Applies safety checks before Forge takes an action.' },
  { id: 'tool', label: 'Tool restrictions', description: 'Applies safety limits when Forge uses tools.' },
  { id: 'data_access', label: 'Data access limits', description: 'Limits access to data according to the applicable safety rules.' },
  { id: 'region_restrictions', label: 'Regional restrictions', description: 'Applies location-based restrictions where they are configured.' },
  { id: 'persona_guards', label: 'Persona safeguards', description: 'Keeps persona and role behavior within configured safety boundaries.' },
  { id: 'rate_limits', label: 'Rate limits', description: 'Applies configured limits to repeated or rapid activity.' },
  { id: 'verbosity_limits', label: 'Response detail limits', description: 'Applies configured limits to response detail where required.' },
  { id: 'financial', label: 'Financial protections', description: 'Applies safety checks to financial actions and related requests.' },
  { id: 'behavioural', label: 'Behavior safeguards', description: 'Applies configured safeguards to behavior and interaction patterns.' },
  { id: 'personalization', label: 'Safety personalization', description: 'Allows safety settings to use personal context only under the applicable consent rules.' },
  { id: 'dual_use_review', label: 'Dual-use review', description: 'Reviews offensive-adjacent or dual-use work under Forge policy.' },
  { id: 'authorization_review', label: 'Authorization review', description: 'Checks authorization requirements for sensitive tools or work.' },
  { id: 'jurisdictional_compliance', label: 'Legal requirements', description: 'Keeps protections required by applicable law in force.' },
  { id: 'minor_ceiling', label: 'Minor protection ceiling', description: 'Keeps the stronger protections for accounts identified as minors.' },
  { id: IMMUTABLE_FLOOR.id, label: 'Child-safety floor', description: 'A separate child-safety floor that no role, toggle, or override can switch off.' },
] satisfies SafetyCatalogItem[]).map((item) => Object.freeze(item)));

export interface SafetyTransparencyRow extends SafetyCatalogItem {
  readonly enabled: boolean;
  readonly source: 'default' | 'jurisdiction' | 'owner_admin' | 'fail_safe' | 'immutable_floor';
  readonly version: number;
  readonly canToggle: boolean;
}
export interface SafetyTransparencySnapshot {
  readonly rows: readonly SafetyTransparencyRow[];
  readonly degraded: boolean;
}

/** Builds a plain-data response from the same snapshot returned by the execution-time service. */
export function buildSafetyTransparency(snapshot: ToggleSnapshot, scope: ToggleScope): SafetyTransparencySnapshot {
  const byCategory = new Map(snapshot.states.map((state) => [state.category, state]));
  const rows = SAFETY_CATALOG.map((item): SafetyTransparencyRow => {
    if (item.id === IMMUTABLE_FLOOR.id) {
      return Object.freeze({ ...item, enabled: true, source: 'immutable_floor', version: 0, canToggle: false });
    }
    const state = byCategory.get(item.id);
    if (!state) {
      // Missing state never becomes an optimistic user-facing claim; fail closed and expose degraded status.
      return Object.freeze({ ...item, enabled: true, source: 'fail_safe', version: 0, canToggle: false });
    }
    const protectedFromOwnerOff = item.id === 'jurisdictional_compliance' || item.id === 'minor_ceiling';
    const canToggle = scope.lane === 'owner_admin' && !protectedFromOwnerOff && !snapshot.degraded;
    return Object.freeze({
      ...item,
      enabled: state.enabled,
      source: state.source,
      version: state.version,
      canToggle,
    });
  });
  const complete = rows.length === SAFETY_CATALOG.length && SAFETY_CATALOG.every((item) =>
    item.id === IMMUTABLE_FLOOR.id || byCategory.has(item.id as SafetyCategory),
  );
  return Object.freeze({ rows: Object.freeze(rows), degraded: snapshot.degraded || !complete });
}

// Guard the catalog and state registry against silent drift when a protection is added.
if (SAFETY_CATALOG.length !== SAFETY_CATEGORIES.length + 1 ||
    SAFETY_CATEGORIES.some((category) => !SAFETY_CATALOG.some((item) => item.id === category))) {
  throw new Error('Safety catalog must cover every safety category and the immutable floor');
}
