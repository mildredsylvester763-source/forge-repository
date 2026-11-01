// Pure creative tool operation engine for live agent testing (FORGE
// TQ-027). The AI tester drives the manhwa, 3D and music editors with an
// exact per-editor operation vocabulary. Every operation is a state
// transition over a pure creative state: layers, objects and notes move
// only under their own limits, and the undo and redo stacks follow the
// classic law that any new edit clears the redo stack. A refusal is
// always named, never guessed.

export type CreativeEditor = 'manhwa' | 'three-d' | 'music';

const EDITORS: CreativeEditor[] = ['manhwa', 'three-d', 'music'];

interface CreativeOp {
  operation: string;
  text: string;
  kind: 'edit' | 'undo' | 'redo';
}

const EDITOR_OPS: Record<CreativeEditor, CreativeOp[]> = {
  manhwa: [
    { operation: 'draw', text: 'Drawing on the canvas', kind: 'edit' },
    { operation: 'paint', text: 'Painting a fill', kind: 'edit' },
    { operation: 'layer-add', text: 'Adding a layer', kind: 'edit' },
    { operation: 'layer-merge', text: 'Merging two layers', kind: 'edit' },
    { operation: 'layer-hide', text: 'Hiding a layer', kind: 'edit' },
    { operation: 'undo', text: 'Undoing the last edit', kind: 'undo' },
    { operation: 'redo', text: 'Redoing the last edit', kind: 'redo' },
  ],
  'three-d': [
    { operation: 'object-add', text: 'Adding a 3D object', kind: 'edit' },
    { operation: 'object-move', text: 'Moving a 3D object', kind: 'edit' },
    { operation: 'object-rotate', text: 'Rotating a 3D object', kind: 'edit' },
    { operation: 'camera-orbit', text: 'Orbiting the camera', kind: 'edit' },
    { operation: 'undo', text: 'Undoing the last edit', kind: 'undo' },
    { operation: 'redo', text: 'Redoing the last edit', kind: 'redo' },
  ],
  music: [
    { operation: 'note-place', text: 'Placing a note', kind: 'edit' },
    { operation: 'note-drag', text: 'Dragging a note', kind: 'edit' },
    { operation: 'clip-trim', text: 'Trimming a clip', kind: 'edit' },
    { operation: 'instrument-select', text: 'Selecting an instrument', kind: 'edit' },
    { operation: 'undo', text: 'Undoing the last edit', kind: 'undo' },
    { operation: 'redo', text: 'Redoing the last edit', kind: 'redo' },
  ],
};

export interface CreativeState {
  layers: number;
  objects: number;
  notes: number;
  undoDepth: number;
  redoDepth: number;
}

export const INITIAL_CREATIVE_STATE: CreativeState = {
  layers: 1,
  objects: 0,
  notes: 0,
  undoDepth: 0,
  redoDepth: 0,
};

export interface CreativeVerdict {
  ok: boolean;
  reason?: string;
  editor?: string;
  operation?: string;
  text?: string;
  state?: CreativeState;
}

export interface CreativeIntent {
  editor?: unknown;
  operation?: unknown;
}

function norm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function creativeEditorCatalog(): Record<string, string[]> {
  const catalog: Record<string, string[]> = {};
  for (const e of EDITORS) {
    catalog[e] = EDITOR_OPS[e].map((x) => x.operation);
  }
  return catalog;
}

export function applyCreativeOperation(
  state: unknown,
  input: CreativeIntent,
): CreativeVerdict {
  const e = norm(input?.editor);
  if (e.length === 0) {
    return { ok: false, reason: 'creative-editor-missing' };
  }
  if (!EDITORS.includes(e as CreativeEditor)) {
    return { ok: false, reason: 'creative-editor-unknown:' + e };
  }
  const o = norm(input?.operation);
  if (o.length === 0) {
    return { ok: false, reason: 'creative-operation-missing' };
  }
  const spec = EDITOR_OPS[e as CreativeEditor].find((x) => x.operation === o);
  if (!spec) {
    return { ok: false, reason: 'creative-operation-unknown:' + o + ':' + e };
  }
  let base: CreativeState = INITIAL_CREATIVE_STATE;
  if (state !== null && typeof state === 'object' && !Array.isArray(state)) {
    const raw = state as Record<string, unknown>;
    base = {
      layers: Number.isFinite(Number(raw.layers)) ? Number(raw.layers) : 1,
      objects: Number.isFinite(Number(raw.objects)) ? Number(raw.objects) : 0,
      notes: Number.isFinite(Number(raw.notes)) ? Number(raw.notes) : 0,
      undoDepth: Number.isFinite(Number(raw.undoDepth)) ? Number(raw.undoDepth) : 0,
      redoDepth: Number.isFinite(Number(raw.redoDepth)) ? Number(raw.redoDepth) : 0,
    };
  }
  const next: CreativeState = { ...base };
  if (spec.kind === 'undo') {
    if (next.undoDepth === 0) {
      return { ok: false, reason: 'creative-undo-empty' };
    }
    next.undoDepth = next.undoDepth - 1;
    next.redoDepth = next.redoDepth + 1;
    return { ok: true, editor: e, operation: o, text: spec.text, state: next };
  }
  if (spec.kind === 'redo') {
    if (next.redoDepth === 0) {
      return { ok: false, reason: 'creative-redo-empty' };
    }
    next.redoDepth = next.redoDepth - 1;
    next.undoDepth = next.undoDepth + 1;
    return { ok: true, editor: e, operation: o, text: spec.text, state: next };
  }
  if (o === 'layer-add') {
    if (next.layers >= 50) {
      return { ok: false, reason: 'creative-layer-limit:50' };
    }
    next.layers = next.layers + 1;
  } else if (o === 'layer-merge') {
    if (next.layers <= 1) {
      return { ok: false, reason: 'creative-layer-floor:1' };
    }
    next.layers = next.layers - 1;
  } else if (o === 'object-add') {
    if (next.objects >= 200) {
      return { ok: false, reason: 'creative-object-limit:200' };
    }
    next.objects = next.objects + 1;
  } else if (o === 'note-place') {
    if (next.notes >= 500) {
      return { ok: false, reason: 'creative-note-limit:500' };
    }
    next.notes = next.notes + 1;
  }
  next.undoDepth = next.undoDepth + 1;
  next.redoDepth = 0;
  return { ok: true, editor: e, operation: o, text: spec.text, state: next };
}
