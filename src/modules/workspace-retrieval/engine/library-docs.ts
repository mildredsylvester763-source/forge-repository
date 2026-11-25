// Pure versioned library docs engine for workspace retrieval (FORGE AI-062).
// Docs are pinned to the EXACT version in use: a search never returns entries
// from another version. Every refusal is named, never silent.

export interface DocsetEntry {
  symbol: string;
  kind: string;
  summary: string;
}

export interface LibraryRecord {
  name: string;
  versions: string[];
  docs: Record<string, DocsetEntry[]>;
}

export const LIBRARY_CATALOG: LibraryRecord[] = [
  {
    name: 'react',
    versions: ['18.2.0', '19.0.0'],
    docs: {
      '18.2.0': [
        { symbol: 'useState', kind: 'hook', summary: 'Adds state to a function component' },
        { symbol: 'useMemo', kind: 'hook', summary: 'Caches a computed value between renders' },
      ],
      '19.0.0': [
        { symbol: 'useState', kind: 'hook', summary: 'Adds state with actions support' },
        { symbol: 'use', kind: 'hook', summary: 'Reads a promise or context during render' },
      ],
    },
  },
  {
    name: 'express',
    versions: ['4.18.2'],
    docs: {
      '4.18.2': [
        { symbol: 'app.get', kind: 'method', summary: 'Routes GET requests to a handler' },
        { symbol: 'app.listen', kind: 'method', summary: 'Starts the HTTP server on a port' },
      ],
    },
  },
  {
    name: 'typeorm',
    versions: ['0.3.17', '0.3.20'],
    docs: {
      '0.3.17': [
        { symbol: 'Repository.find', kind: 'method', summary: 'Loads rows matching the where clause' },
      ],
      '0.3.20': [
        { symbol: 'Repository.find', kind: 'method', summary: 'Loads rows matching the where clause' },
        { symbol: 'DataSource', kind: 'class', summary: 'Entry point for database connections' },
      ],
    },
  },
];

export interface DocsVerdict {
  ok: boolean;
  reason?: string;
  library?: string;
  version?: string;
  results?: DocsetEntry[];
}

function normLib(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function checkLibrary(input: { library?: unknown; version?: unknown }): DocsVerdict {
  const library = normLib(input?.library);
  if (library.length === 0) {
    return { ok: false, reason: 'docs-library-missing' };
  }
  const record = LIBRARY_CATALOG.find((l) => l.name === library);
  if (!record) {
    return { ok: false, reason: 'docs-library-unknown:' + library };
  }
  const version = typeof input?.version === 'string' ? input.version.trim() : '';
  if (version.length === 0) {
    return { ok: false, reason: 'docs-version-missing' };
  }
  if (!record.versions.includes(version)) {
    return { ok: false, reason: 'docs-version-unknown:' + library + ':' + version };
  }
  return { ok: true, library, version };
}

export function searchLibraryDocs(input: {
  library?: unknown;
  version?: unknown;
  query?: unknown;
}): DocsVerdict {
  const checked = checkLibrary(input);
  if (!checked.ok) {
    return checked;
  }
  const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (query.length === 0) {
    return { ok: false, reason: 'docs-query-missing' };
  }
  const terms = query.split(/\s+/).filter((t) => t.length > 0);
  const record = LIBRARY_CATALOG.find((l) => l.name === checked.library);
  const entries = record?.docs[checked.version ?? ''] ?? [];
  const results = entries.filter((entry) => {
    const haystack = (entry.symbol + ' ' + entry.kind + ' ' + entry.summary).toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
  return { ok: true, library: checked.library, version: checked.version, results };
}
