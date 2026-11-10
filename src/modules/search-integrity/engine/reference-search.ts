// Pure reference search engine for search integrity (FORGE AI-069).
// Creative work needs reference imagery: pose, anatomy, environment,
// texture, moodboard, color. The market (PureRef boards, ArtStation packs)
// organizes references by medium and license; this engine filters the pinned
// catalog by AND-matched query terms with optional medium and license
// filters, and returns honest empties. Every refusal is named.

export const REFERENCE_MEDIA = ['pose', 'anatomy', 'environment', 'texture', 'moodboard', 'color'];
export const REFERENCE_LICENSES = ['cc0', 'free', 'public-domain', 'owned'];

export interface ReferenceAsset {
  id: string;
  title: string;
  medium: string;
  tags: string[];
  license: string;
}

export const REFERENCE_CATALOG: ReferenceAsset[] = [
  { id: 'pose-001', title: 'Standing figure turnaround', medium: 'pose', tags: ['standing', 'figure', 'turnaround'], license: 'free' },
  { id: 'pose-002', title: 'Sitting pose sheet', medium: 'pose', tags: ['sitting', 'figure', 'sheet'], license: 'cc0' },
  { id: 'anatomy-001', title: 'Hand anatomy plates', medium: 'anatomy', tags: ['hand', 'anatomy', 'plates'], license: 'public-domain' },
  { id: 'anatomy-002', title: 'Skull study angles', medium: 'anatomy', tags: ['skull', 'study', 'angles'], license: 'free' },
  { id: 'env-001', title: 'Forest clearing light', medium: 'environment', tags: ['forest', 'clearing', 'light'], license: 'cc0' },
  { id: 'env-002', title: 'City rooftop dusk', medium: 'environment', tags: ['city', 'rooftop', 'dusk'], license: 'owned' },
  { id: 'tex-001', title: 'Bark texture pack', medium: 'texture', tags: ['bark', 'texture', 'pack'], license: 'cc0' },
  { id: 'tex-002', title: 'Rust metal surfaces', medium: 'texture', tags: ['rust', 'metal', 'surfaces'], license: 'free' },
  { id: 'mood-001', title: 'Cyberpunk street moodboard', medium: 'moodboard', tags: ['cyberpunk', 'street', 'moodboard'], license: 'free' },
  { id: 'mood-002', title: 'Cozy interior moodboard', medium: 'moodboard', tags: ['cozy', 'interior', 'moodboard'], license: 'cc0' },
  { id: 'col-001', title: 'Sunset palette study', medium: 'color', tags: ['sunset', 'palette', 'study'], license: 'public-domain' },
  { id: 'col-002', title: 'Neon palette grid', medium: 'color', tags: ['neon', 'palette', 'grid'], license: 'free' },
];

export interface ReferencesVerdict {
  ok: boolean;
  reason?: string;
  results?: ReferenceAsset[];
}

export function searchReferences(input: {
  query?: unknown;
  medium?: unknown;
  license?: unknown;
}): ReferencesVerdict {
  const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (query.length === 0) {
    return { ok: false, reason: 'reference-query-missing' };
  }
  const medium =
    input?.medium === undefined || input?.medium === null || input?.medium === ''
      ? ''
      : typeof input?.medium === 'string'
        ? input.medium.trim().toLowerCase()
        : String(input?.medium);
  if (medium.length > 0 && !REFERENCE_MEDIA.includes(medium)) {
    return { ok: false, reason: 'reference-medium-unknown:' + medium };
  }
  const license =
    input?.license === undefined || input?.license === null || input?.license === ''
      ? ''
      : typeof input?.license === 'string'
        ? input.license.trim().toLowerCase()
        : String(input?.license);
  if (license.length > 0 && !REFERENCE_LICENSES.includes(license)) {
    return { ok: false, reason: 'reference-license-unknown:' + license };
  }
  const terms = query.split(/\s+/).filter((t) => t.length > 0);
  const results = REFERENCE_CATALOG.filter((asset) => {
    if (medium.length > 0 && asset.medium !== medium) {
      return false;
    }
    if (license.length > 0 && asset.license !== license) {
      return false;
    }
    const haystack = (asset.title + ' ' + asset.tags.join(' ')).toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
  return { ok: true, results };
}
