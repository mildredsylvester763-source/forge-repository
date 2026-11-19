import type { GateId } from './plan-engine.ts';

type SectionCode = 'DP' | 'OB' | 'CG' | 'RV' | 'BD' | 'SC';
type RowRange = readonly [number, number];

/**
 * Plan-from assignments transcribed from FORGE Feature — Catalog Part 02 With Plans,
 * sections 4–9 (8 Nov 2026). Ranges are expanded into one key per catalog row at
 * module initialization; the source remains compact and the generated registry is
 * checked against the document's published group counts.
 *
 * The seven SC rows marked "Not tiered here" are intentionally excluded. They belong
 * to the separate Trust Stack/security-platform policy and must not be silently
 * converted into ordinary subscription gates.
 */
const ROW_RANGES: Readonly<Record<Exclude<GateId, 'not_tiered'>, Readonly<Record<SectionCode, readonly RowRange[]>>>> = {
  free: {
    DP: [[1, 3], [17, 17], [19, 21], [33, 33], [42, 42], [48, 48], [51, 52], [57, 57], [62, 63], [67, 67], [76, 79]],
    OB: [[1, 9], [11, 11], [29, 29], [34, 34], [41, 41]],
    CG: [[1, 2], [5, 12], [14, 15], [17, 18], [20, 25], [36, 36], [38, 39], [41, 41], [45, 45], [47, 60], [62, 62], [70, 70], [72, 72], [76, 77], [79, 79], [81, 81], [85, 85], [87, 88], [90, 90]],
    RV: [[1, 1], [4, 4], [7, 10], [25, 25], [38, 38], [53, 53], [56, 56]],
    BD: [[1, 3], [12, 13], [15, 16], [22, 22], [29, 30], [35, 35], [47, 47], [52, 53], [59, 60]],
    SC: [[1, 1], [6, 6], [10, 10], [54, 54], [66, 71], [75, 76]],
  },
  plus: {
    DP: [[6, 7], [9, 10], [18, 18], [22, 23], [25, 26], [30, 32], [34, 34], [41, 41], [45, 47], [49, 50], [55, 55], [58, 58], [68, 69]],
    OB: [[10, 10], [13, 13], [16, 16], [18, 18], [28, 28], [30, 33], [37, 37], [40, 40], [42, 42], [52, 53], [55, 55], [57, 57], [59, 59], [67, 68], [75, 75]],
    CG: [[13, 13], [19, 19], [26, 26], [29, 29], [34, 35], [40, 40], [44, 44], [63, 64], [68, 68], [74, 75], [80, 80], [82, 84], [86, 86], [89, 89]],
    RV: [[11, 11], [22, 24], [28, 29], [36, 37], [39, 41], [52, 52], [57, 58]],
    BD: [[4, 6], [14, 14], [17, 19], [24, 24], [28, 28], [33, 34], [36, 36], [42, 42], [44, 46], [48, 49], [54, 54], [57, 57]],
    SC: [[4, 5], [7, 7], [25, 25], [74, 74], [78, 79]],
  },
  pro: {
    DP: [[4, 5], [8, 8], [11, 11], [15, 16], [24, 24], [27, 29], [35, 40], [43, 44], [53, 53], [59, 60], [64, 64], [66, 66], [70, 70], [92, 92]],
    OB: [[12, 12], [14, 15], [19, 21], [23, 23], [25, 25], [27, 27], [35, 36], [38, 38], [44, 48], [56, 56], [58, 58], [60, 61], [71, 73]],
    CG: [[3, 4], [16, 16], [30, 33], [46, 46], [61, 61], [65, 67], [73, 73], [78, 78]],
    RV: [[2, 3], [12, 12], [26, 26], [30, 33], [42, 42], [55, 55], [59, 59]],
    BD: [[7, 11], [20, 21], [23, 23], [26, 27], [37, 41], [51, 51], [55, 55]],
    SC: [[2, 3], [8, 9], [12, 13], [15, 19], [26, 29], [31, 31], [34, 34], [56, 56], [64, 65], [77, 77]],
  },
  team: {
    DP: [[12, 13]],
    OB: [[17, 17], [22, 22], [43, 43], [49, 51], [54, 54], [64, 66], [74, 74]],
    CG: [[27, 28], [37, 37], [42, 43], [69, 69], [71, 71]],
    RV: [[5, 6], [13, 21], [27, 27], [43, 48], [51, 51], [54, 54]],
    BD: [[32, 32], [43, 43]],
    SC: [[11, 11], [24, 24], [45, 46]],
  },
  enterprise: {
    DP: [[14, 14], [54, 54], [56, 56], [61, 61], [72, 72], [82, 82], [84, 89]],
    OB: [[24, 24], [62, 63], [69, 70]],
    CG: [],
    RV: [[34, 34], [49, 50], [60, 60]],
    BD: [[25, 25], [31, 31], [50, 50], [56, 56], [58, 58]],
    SC: [[14, 14], [30, 30], [32, 33], [35, 40], [42, 42], [44, 44], [47, 47], [53, 53], [55, 55], [57, 61], [73, 73], [80, 80]],
  },
  internal: {
    DP: [[65, 65], [71, 71], [73, 75], [80, 81], [83, 83], [90, 91], [93, 94]],
    OB: [[26, 26], [39, 39]],
    CG: [],
    RV: [],
    BD: [],
    SC: [[43, 43], [48, 52], [72, 72]],
  },
  engine: {
    DP: [],
    OB: [],
    CG: [],
    RV: [[35, 35]],
    BD: [],
    SC: [],
  },
};

export const PART02_NOT_TIERED_FEATURES = Object.freeze([
  'SC-020',
  'SC-021',
  'SC-022',
  'SC-023',
  'SC-041',
  'SC-062',
  'SC-063',
] as const);

const EXPECTED_COUNTS: Readonly<Record<Exclude<GateId, 'not_tiered'>, number>> = {
  free: 121,
  plus: 103,
  pro: 112,
  team: 46,
  enterprise: 48,
  internal: 21,
  engine: 1,
};

function buildPart02FeatureGates(): Readonly<Record<string, GateId>> {
  const gates: Record<string, GateId> = {};
  const counts: Record<string, number> = {};
  for (const [gate, sections] of Object.entries(ROW_RANGES) as Array<[Exclude<GateId, 'not_tiered'>, typeof ROW_RANGES[Exclude<GateId, 'not_tiered'>]]>) {
    for (const [section, ranges] of Object.entries(sections) as Array<[SectionCode, readonly RowRange[]]>) {
      for (const [start, end] of ranges) {
        if (start < 1 || end < start) throw new Error('Invalid Part 02 feature range: ' + section);
        for (let number = start; number <= end; number += 1) {
          const featureId = section + '-' + String(number).padStart(3, '0');
          if (gates[featureId] !== undefined) throw new Error('Duplicate Part 02 feature gate: ' + featureId);
          gates[featureId] = gate;
          counts[gate] = (counts[gate] ?? 0) + 1;
        }
      }
    }
  }
  for (const [gate, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (counts[gate] !== expected) throw new Error('Part 02 ' + gate + ' gate count mismatch: expected ' + expected + ', got ' + (counts[gate] ?? 0));
  }
  if (Object.keys(gates).length !== 452) throw new Error('Part 02 feature gate registry must contain 452 tiered rows');
  return Object.freeze(gates);
}

export const PART02_FEATURE_GATES = buildPart02FeatureGates();
