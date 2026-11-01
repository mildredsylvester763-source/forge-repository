// Pure persona engine for live agent testing (FORGE TQ-014). Personas are
// deterministic trait vectors, not prose: familiarity, patience,
// exploratory drive and accessibility needs drive the checklist a session
// runs and the pacing it prefers. Unknown personas are refused by name,
// never silently substituted. Profiles are always fresh copies: callers
// can never mutate the shared catalog.

export interface PersonaProfile {
  name: string;
  familiarity: number;
  patience: number;
  exploratory: number;
  a11yNeeds: boolean;
  keyboardOnly: boolean;
  prefersSlowPacing: boolean;
}

const PERSONAS: Record<string, PersonaProfile> = {
  'new-user': {
    name: 'new-user',
    familiarity: 10,
    patience: 80,
    exploratory: 70,
    a11yNeeds: false,
    keyboardOnly: false,
    prefersSlowPacing: true,
  },
  'power-user': {
    name: 'power-user',
    familiarity: 95,
    patience: 40,
    exploratory: 50,
    a11yNeeds: false,
    keyboardOnly: false,
    prefersSlowPacing: false,
  },
  'impatient-user': {
    name: 'impatient-user',
    familiarity: 50,
    patience: 10,
    exploratory: 30,
    a11yNeeds: false,
    keyboardOnly: false,
    prefersSlowPacing: false,
  },
  'screen-reader-user': {
    name: 'screen-reader-user',
    familiarity: 60,
    patience: 70,
    exploratory: 40,
    a11yNeeds: true,
    keyboardOnly: true,
    prefersSlowPacing: true,
  },
  'low-vision-user': {
    name: 'low-vision-user',
    familiarity: 60,
    patience: 60,
    exploratory: 40,
    a11yNeeds: true,
    keyboardOnly: false,
    prefersSlowPacing: true,
  },
  'motor-impaired-user': {
    name: 'motor-impaired-user',
    familiarity: 55,
    patience: 65,
    exploratory: 35,
    a11yNeeds: true,
    keyboardOnly: true,
    prefersSlowPacing: true,
  },
};

export interface PersonaVerdict {
  ok: boolean;
  reason?: string;
  profile?: PersonaProfile;
}

export function listPersonas(): string[] {
  return Object.keys(PERSONAS).sort();
}

export function getPersona(name: unknown): PersonaVerdict {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'persona-missing' };
  }
  const key = name.trim().toLowerCase();
  if (!(key in PERSONAS)) {
    return { ok: false, reason: 'persona-unknown:' + name };
  }
  return { ok: true, profile: { ...PERSONAS[key]! } };
}

export function deriveChecklist(profile: PersonaProfile): string[] {
  const checks: string[] = ['smoke-critical-path'];
  if (profile.familiarity <= 30) {
    checks.push('onboarding-flow', 'empty-states', 'help-affordances');
  }
  if (profile.exploratory >= 60) {
    checks.push('edge-case-inputs', 'error-paths');
  }
  if (profile.a11yNeeds) {
    checks.push('keyboard-navigation', 'focus-order', 'screen-reader-labels', 'contrast-checks');
  }
  if (profile.keyboardOnly) {
    checks.push('keyboard-only-trap-scan');
  }
  if (profile.patience <= 20) {
    checks.push('loading-feedback');
  }
  return checks;
}

export function paceMultiplier(profile: PersonaProfile): number {
  if (profile.patience >= 70) {
    return 1.5;
  }
  if (profile.patience >= 40) {
    return 1.0;
  }
  return 0.75;
}
