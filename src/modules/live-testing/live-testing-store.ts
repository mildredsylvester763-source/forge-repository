import { randomUUID } from 'node:crypto';

export interface LiveSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly workspace: string;
  readonly title: string;
  readonly goal: string;
  readonly platform: string;
  readonly status: string;
  readonly environment: string;
  readonly safeMode: boolean;
  readonly persona: string | null;
  readonly deviceProfile: unknown;
  readonly goalTasks: unknown;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewLiveSession {
  userId: string;
  workspace: string;
  title: string;
  goal: string;
  platform: string;
  environment: string;
  safeMode: boolean;
  persona: string | null;
  deviceProfile: unknown;
  goalTasks: unknown;
  now: number;
}

export interface LiveStepRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly narration: string;
  readonly payload: unknown;
  readonly occurredAt: number;
}

export interface NewLiveStep {
  sessionId: string;
  seq: number;
  actor: string;
  action: string;
  target: string | null;
  narration: string;
  payload: unknown;
  occurredAt: number;
}

export interface LiveMessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface NewLiveMessage {
  sessionId: string;
  role: string;
  body: string;
  now: number;
}

export interface LiveFindingRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly severity: number;
  readonly title: string;
  readonly reproSteps: string[];
  readonly evidence: unknown;
  readonly suspectedCommit: string | null;
  readonly createdAt: number;
}

export interface NewLiveFinding {
  sessionId: string;
  severity: number;
  title: string;
  reproSteps: string[];
  evidence: unknown;
  suspectedCommit: string | null;
  now: number;
}

export interface CustomPersonaRecord {
  readonly id: string;
  readonly userId: string;
  readonly workspace: string;
  readonly name: string;
  readonly traits: string[];
  readonly checklist: string[];
  readonly paceMultiplier: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewCustomPersona {
  userId: string;
  workspace: string;
  name: string;
  traits: string[];
  checklist: string[];
  paceMultiplier: number;
  now: number;
}

export interface ParticipantRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly role: string;
  readonly state: string;
  readonly invitedBy: string;
  readonly createdAt: number;
}

export interface NewParticipant {
  sessionId: string;
  userId: string;
  role: string;
  invitedBy: string;
  now: number;
}

/**
 * The live testing module's storage contract: sessions, their recorded
 * steps, chat messages, findings, custom personas and collaborators.
 * SQLite and PostgreSQL adapters sit behind the same interface.
 */
export interface LiveTestingStore {
  createSession(session: NewLiveSession): Promise<LiveSessionRecord>;
  findSession(id: string): Promise<LiveSessionRecord | null>;
  saveSession(session: LiveSessionRecord): Promise<LiveSessionRecord>;
  listSessionsByUser(userId: string, take: number): Promise<LiveSessionRecord[]>;
  appendStep(step: NewLiveStep): Promise<LiveStepRecord>;
  listStepsBySession(sessionId: string): Promise<LiveStepRecord[]>;
  appendMessage(message: NewLiveMessage): Promise<LiveMessageRecord>;
  listMessagesBySession(sessionId: string): Promise<LiveMessageRecord[]>;
  appendFinding(finding: NewLiveFinding): Promise<LiveFindingRecord>;
  listFindingsBySession(sessionId: string): Promise<LiveFindingRecord[]>;
  createPersona(persona: NewCustomPersona): Promise<CustomPersonaRecord>;
  findPersona(userId: string, workspace: string, name: string): Promise<CustomPersonaRecord | null>;
  findPersonaById(id: string): Promise<CustomPersonaRecord | null>;
  listPersonas(userId: string, workspace: string | null): Promise<CustomPersonaRecord[]>;
  deletePersona(id: string): Promise<void>;
  createParticipant(participant: NewParticipant): Promise<ParticipantRecord>;
  findParticipantById(id: string): Promise<ParticipantRecord | null>;
  findParticipantBySessionAndUser(sessionId: string, userId: string): Promise<ParticipantRecord | null>;
  listParticipantsBySession(sessionId: string): Promise<ParticipantRecord[]>;
  saveParticipant(participant: ParticipantRecord): Promise<ParticipantRecord>;
  deleteParticipant(id: string): Promise<void>;
}

/** Development and test store. */
export class InMemoryLiveTestingStore implements LiveTestingStore {
  private readonly sessionsById = new Map<string, LiveSessionRecord>();
  private readonly sessionsByUser = new Map<string, string[]>();
  private readonly stepsBySession = new Map<string, LiveStepRecord[]>();
  private readonly messagesBySession = new Map<string, LiveMessageRecord[]>();
  private readonly findingsBySession = new Map<string, LiveFindingRecord[]>();
  private readonly personasById = new Map<string, CustomPersonaRecord>();
  private readonly participantsById = new Map<string, ParticipantRecord>();

  async createSession(session: NewLiveSession): Promise<LiveSessionRecord> {
    const record: LiveSessionRecord = {
      id: randomUUID(),
      userId: session.userId,
      workspace: session.workspace,
      title: session.title,
      goal: session.goal,
      platform: session.platform,
      status: 'planned',
      environment: session.environment,
      safeMode: session.safeMode,
      persona: session.persona,
      deviceProfile: session.deviceProfile,
      goalTasks: session.goalTasks,
      startedAt: null,
      endedAt: null,
      createdAt: session.now,
      updatedAt: session.now,
    };
    this.sessionsById.set(record.id, record);
    const ids = this.sessionsByUser.get(session.userId) ?? [];
    ids.unshift(record.id);
    this.sessionsByUser.set(session.userId, ids);
    return record;
  }

  async findSession(id: string): Promise<LiveSessionRecord | null> {
    return this.sessionsById.get(id) ?? null;
  }

  async saveSession(session: LiveSessionRecord): Promise<LiveSessionRecord> {
    if (!this.sessionsById.has(session.id)) return session;
    this.sessionsById.set(session.id, session);
    return session;
  }

  async listSessionsByUser(userId: string, take: number): Promise<LiveSessionRecord[]> {
    const ids = this.sessionsByUser.get(userId) ?? [];
    const out: LiveSessionRecord[] = [];
    for (const id of ids.slice(0, take)) {
      const row = this.sessionsById.get(id);
      if (row) out.push(row);
    }
    return out;
  }

  async appendStep(step: NewLiveStep): Promise<LiveStepRecord> {
    const record: LiveStepRecord = { id: randomUUID(), ...step };
    const list = this.stepsBySession.get(step.sessionId) ?? [];
    list.push(record);
    this.stepsBySession.set(step.sessionId, list);
    return record;
  }

  async listStepsBySession(sessionId: string): Promise<LiveStepRecord[]> {
    return (this.stepsBySession.get(sessionId) ?? []).slice();
  }

  async appendMessage(message: NewLiveMessage): Promise<LiveMessageRecord> {
    const record: LiveMessageRecord = {
      id: randomUUID(),
      sessionId: message.sessionId,
      role: message.role,
      body: message.body,
      createdAt: message.now,
    };
    const list = this.messagesBySession.get(message.sessionId) ?? [];
    list.push(record);
    this.messagesBySession.set(message.sessionId, list);
    return record;
  }

  async listMessagesBySession(sessionId: string): Promise<LiveMessageRecord[]> {
    return (this.messagesBySession.get(sessionId) ?? []).slice();
  }

  async appendFinding(finding: NewLiveFinding): Promise<LiveFindingRecord> {
    const record: LiveFindingRecord = {
      id: randomUUID(),
      sessionId: finding.sessionId,
      severity: finding.severity,
      title: finding.title,
      reproSteps: finding.reproSteps,
      evidence: finding.evidence,
      suspectedCommit: finding.suspectedCommit,
      createdAt: finding.now,
    };
    const list = this.findingsBySession.get(finding.sessionId) ?? [];
    list.push(record);
    this.findingsBySession.set(finding.sessionId, list);
    return record;
  }

  async listFindingsBySession(sessionId: string): Promise<LiveFindingRecord[]> {
    return (this.findingsBySession.get(sessionId) ?? []).slice();
  }

  async createPersona(persona: NewCustomPersona): Promise<CustomPersonaRecord> {
    const record: CustomPersonaRecord = {
      id: randomUUID(),
      userId: persona.userId,
      workspace: persona.workspace,
      name: persona.name,
      traits: persona.traits,
      checklist: persona.checklist,
      paceMultiplier: persona.paceMultiplier,
      createdAt: persona.now,
      updatedAt: persona.now,
    };
    this.personasById.set(record.id, record);
    return record;
  }

  async findPersona(userId: string, workspace: string, name: string): Promise<CustomPersonaRecord | null> {
    for (const row of this.personasById.values()) {
      if (row.userId === userId && row.workspace === workspace && row.name === name) return row;
    }
    return null;
  }

  async findPersonaById(id: string): Promise<CustomPersonaRecord | null> {
    return this.personasById.get(id) ?? null;
  }

  async listPersonas(userId: string, workspace: string | null): Promise<CustomPersonaRecord[]> {
    const out: CustomPersonaRecord[] = [];
    for (const row of this.personasById.values()) {
      if (row.userId !== userId) continue;
      if (workspace !== null && row.workspace !== workspace) continue;
      out.push(row);
    }
    return out;
  }

  async deletePersona(id: string): Promise<void> {
    this.personasById.delete(id);
  }

  async createParticipant(participant: NewParticipant): Promise<ParticipantRecord> {
    const record: ParticipantRecord = {
      id: randomUUID(),
      sessionId: participant.sessionId,
      userId: participant.userId,
      role: participant.role,
      state: 'invited',
      invitedBy: participant.invitedBy,
      createdAt: participant.now,
    };
    this.participantsById.set(record.id, record);
    return record;
  }

  async findParticipantById(id: string): Promise<ParticipantRecord | null> {
    return this.participantsById.get(id) ?? null;
  }

  async findParticipantBySessionAndUser(sessionId: string, userId: string): Promise<ParticipantRecord | null> {
    for (const row of this.participantsById.values()) {
      if (row.sessionId === sessionId && row.userId === userId) return row;
    }
    return null;
  }

  async listParticipantsBySession(sessionId: string): Promise<ParticipantRecord[]> {
    const out: ParticipantRecord[] = [];
    for (const row of this.participantsById.values()) {
      if (row.sessionId === sessionId) out.push(row);
    }
    return out;
  }

  async saveParticipant(participant: ParticipantRecord): Promise<ParticipantRecord> {
    if (!this.participantsById.has(participant.id)) return participant;
    this.participantsById.set(participant.id, participant);
    return participant;
  }

  async deleteParticipant(id: string): Promise<void> {
    this.participantsById.delete(id);
  }
}
