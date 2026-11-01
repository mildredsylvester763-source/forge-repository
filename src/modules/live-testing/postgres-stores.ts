import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type {
  CustomPersonaRecord,
  LiveFindingRecord,
  LiveMessageRecord,
  LiveSessionRecord,
  LiveStepRecord,
  LiveTestingStore,
  NewCustomPersona,
  NewLiveFinding,
  NewLiveMessage,
  NewLiveSession,
  NewLiveStep,
  NewParticipant,
  ParticipantRecord,
} from './live-testing-store.ts';

interface SessionRow {
  id: string;
  user_id: string;
  workspace: string;
  title: string;
  goal: string;
  platform: string;
  status: string;
  environment: string;
  safe_mode: boolean | number;
  persona: string | null;
  device_profile: string;
  goal_tasks: string;
  started_at: string | number | null;
  ended_at: string | number | null;
  created_at: string | number;
  updated_at: string | number;
}

interface StepRow {
  id: string;
  session_id: string;
  seq: number;
  actor: string;
  action: string;
  target: string | null;
  narration: string;
  payload: string;
  occurred_at: string | number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  body: string;
  created_at: string | number;
}

interface FindingRow {
  id: string;
  session_id: string;
  severity: number;
  title: string;
  repro_steps: string;
  evidence: string;
  suspected_commit: string | null;
  created_at: string | number;
}

interface PersonaRow {
  id: string;
  user_id: string;
  workspace: string;
  name: string;
  traits: string;
  checklist: string;
  pace_multiplier: number;
  created_at: string | number;
  updated_at: string | number;
}

interface ParticipantRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  state: string;
  invited_by: string;
  created_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));
const numOrNull = (value: string | number | null): number | null =>
  value === null ? null : typeof value === 'number' ? value : Number(value);

const sessionFromRow = (r: SessionRow): LiveSessionRecord => ({
  id: r.id,
  userId: r.user_id,
  workspace: r.workspace,
  title: r.title,
  goal: r.goal,
  platform: r.platform,
  status: r.status,
  environment: r.environment,
  safeMode: r.safe_mode === true || r.safe_mode === 1,
  persona: r.persona,
  deviceProfile: JSON.parse(r.device_profile) as unknown,
  goalTasks: JSON.parse(r.goal_tasks) as unknown,
  startedAt: numOrNull(r.started_at),
  endedAt: numOrNull(r.ended_at),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const stepFromRow = (r: StepRow): LiveStepRecord => ({
  id: r.id,
  sessionId: r.session_id,
  seq: r.seq,
  actor: r.actor,
  action: r.action,
  target: r.target,
  narration: r.narration,
  payload: JSON.parse(r.payload) as unknown,
  occurredAt: num(r.occurred_at),
});

const messageFromRow = (r: MessageRow): LiveMessageRecord => ({
  id: r.id,
  sessionId: r.session_id,
  role: r.role,
  body: r.body,
  createdAt: num(r.created_at),
});

const findingFromRow = (r: FindingRow): LiveFindingRecord => ({
  id: r.id,
  sessionId: r.session_id,
  severity: r.severity,
  title: r.title,
  reproSteps: JSON.parse(r.repro_steps) as string[],
  evidence: JSON.parse(r.evidence) as unknown,
  suspectedCommit: r.suspected_commit,
  createdAt: num(r.created_at),
});

const personaFromRow = (r: PersonaRow): CustomPersonaRecord => ({
  id: r.id,
  userId: r.user_id,
  workspace: r.workspace,
  name: r.name,
  traits: JSON.parse(r.traits) as string[],
  checklist: JSON.parse(r.checklist) as string[],
  paceMultiplier: r.pace_multiplier,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const participantFromRow = (r: ParticipantRow): ParticipantRecord => ({
  id: r.id,
  sessionId: r.session_id,
  userId: r.user_id,
  role: r.role,
  state: r.state,
  invitedBy: r.invited_by,
  createdAt: num(r.created_at),
});

export class PostgresLiveTestingStore implements LiveTestingStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async createSession(session: NewLiveSession): Promise<LiveSessionRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO live_sessions (id, user_id, workspace, title, goal, platform, status, environment, safe_mode, persona, device_profile, goal_tasks, started_at, ended_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16)',
      [id, session.userId, session.workspace, session.title, session.goal, session.platform, 'planned', session.environment, session.safeMode, session.persona, JSON.stringify(session.deviceProfile), JSON.stringify(session.goalTasks), null, null, session.now, session.now],
    );
    return {
      id,
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
  }

  async findSession(id: string): Promise<LiveSessionRecord | null> {
    const result = await this.pool.query<SessionRow>('SELECT * FROM live_sessions WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? sessionFromRow(row) : null;
  }

  async saveSession(session: LiveSessionRecord): Promise<LiveSessionRecord> {
    await this.pool.query(
      'UPDATE live_sessions SET status = $1, started_at = $2, ended_at = $3, persona = $4, device_profile = $5::jsonb, updated_at = $6 WHERE id = $7',
      [session.status, session.startedAt, session.endedAt, session.persona, JSON.stringify(session.deviceProfile), session.updatedAt, session.id],
    );
    return session;
  }

  async listSessionsByUser(userId: string, take: number): Promise<LiveSessionRecord[]> {
    const result = await this.pool.query<SessionRow>(
      'SELECT * FROM live_sessions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [userId, take],
    );
    return result.rows.map(sessionFromRow);
  }

  async appendStep(step: NewLiveStep): Promise<LiveStepRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO live_steps (id, session_id, seq, actor, action, target, narration, payload, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)',
      [id, step.sessionId, step.seq, step.actor, step.action, step.target, step.narration, JSON.stringify(step.payload), step.occurredAt],
    );
    return { id, ...step };
  }

  async listStepsBySession(sessionId: string): Promise<LiveStepRecord[]> {
    const result = await this.pool.query<StepRow>('SELECT * FROM live_steps WHERE session_id = $1 ORDER BY seq ASC', [sessionId]);
    return result.rows.map(stepFromRow);
  }

  async appendMessage(message: NewLiveMessage): Promise<LiveMessageRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO live_messages (id, session_id, role, body, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, message.sessionId, message.role, message.body, message.now],
    );
    return { id, sessionId: message.sessionId, role: message.role, body: message.body, createdAt: message.now };
  }

  async listMessagesBySession(sessionId: string): Promise<LiveMessageRecord[]> {
    const result = await this.pool.query<MessageRow>(
      'SELECT * FROM live_messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC',
      [sessionId],
    );
    return result.rows.map(messageFromRow);
  }

  async appendFinding(finding: NewLiveFinding): Promise<LiveFindingRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO live_findings (id, session_id, severity, title, repro_steps, evidence, suspected_commit, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)',
      [id, finding.sessionId, finding.severity, finding.title, JSON.stringify(finding.reproSteps), JSON.stringify(finding.evidence), finding.suspectedCommit, finding.now],
    );
    return {
      id,
      sessionId: finding.sessionId,
      severity: finding.severity,
      title: finding.title,
      reproSteps: finding.reproSteps,
      evidence: finding.evidence,
      suspectedCommit: finding.suspectedCommit,
      createdAt: finding.now,
    };
  }

  async listFindingsBySession(sessionId: string): Promise<LiveFindingRecord[]> {
    const result = await this.pool.query<FindingRow>(
      'SELECT * FROM live_findings WHERE session_id = $1 ORDER BY created_at ASC, id ASC',
      [sessionId],
    );
    return result.rows.map(findingFromRow);
  }

  async createPersona(persona: NewCustomPersona): Promise<CustomPersonaRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO live_personas (id, user_id, workspace, name, traits, checklist, pace_multiplier, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)',
      [id, persona.userId, persona.workspace, persona.name, JSON.stringify(persona.traits), JSON.stringify(persona.checklist), persona.paceMultiplier, persona.now, persona.now],
    );
    return {
      id,
      userId: persona.userId,
      workspace: persona.workspace,
      name: persona.name,
      traits: persona.traits,
      checklist: persona.checklist,
      paceMultiplier: persona.paceMultiplier,
      createdAt: persona.now,
      updatedAt: persona.now,
    };
  }

  async findPersona(userId: string, workspace: string, name: string): Promise<CustomPersonaRecord | null> {
    const result = await this.pool.query<PersonaRow>(
      'SELECT * FROM live_personas WHERE user_id = $1 AND workspace = $2 AND name = $3',
      [userId, workspace, name],
    );
    const row = result.rows[0];
    return row ? personaFromRow(row) : null;
  }

  async findPersonaById(id: string): Promise<CustomPersonaRecord | null> {
    const result = await this.pool.query<PersonaRow>('SELECT * FROM live_personas WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? personaFromRow(row) : null;
  }

  async listPersonas(userId: string, workspace: string | null): Promise<CustomPersonaRecord[]> {
    const result =
      workspace === null
        ? await this.pool.query<PersonaRow>('SELECT * FROM live_personas WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [userId])
        : await this.pool.query<PersonaRow>(
            'SELECT * FROM live_personas WHERE user_id = $1 AND workspace = $2 ORDER BY created_at DESC, id DESC',
            [userId, workspace],
          );
    return result.rows.map(personaFromRow);
  }

  async deletePersona(id: string): Promise<void> {
    await this.pool.query('DELETE FROM live_personas WHERE id = $1', [id]);
  }

  async createParticipant(participant: NewParticipant): Promise<ParticipantRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO live_participants (id, session_id, user_id, role, state, invited_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, participant.sessionId, participant.userId, participant.role, 'invited', participant.invitedBy, participant.now],
    );
    return {
      id,
      sessionId: participant.sessionId,
      userId: participant.userId,
      role: participant.role,
      state: 'invited',
      invitedBy: participant.invitedBy,
      createdAt: participant.now,
    };
  }

  async findParticipantById(id: string): Promise<ParticipantRecord | null> {
    const result = await this.pool.query<ParticipantRow>('SELECT * FROM live_participants WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? participantFromRow(row) : null;
  }

  async findParticipantBySessionAndUser(sessionId: string, userId: string): Promise<ParticipantRecord | null> {
    const result = await this.pool.query<ParticipantRow>(
      'SELECT * FROM live_participants WHERE session_id = $1 AND user_id = $2',
      [sessionId, userId],
    );
    const row = result.rows[0];
    return row ? participantFromRow(row) : null;
  }

  async listParticipantsBySession(sessionId: string): Promise<ParticipantRecord[]> {
    const result = await this.pool.query<ParticipantRow>(
      'SELECT * FROM live_participants WHERE session_id = $1 ORDER BY created_at ASC, id ASC',
      [sessionId],
    );
    return result.rows.map(participantFromRow);
  }

  async saveParticipant(participant: ParticipantRecord): Promise<ParticipantRecord> {
    await this.pool.query('UPDATE live_participants SET state = $1 WHERE id = $2', [participant.state, participant.id]);
    return participant;
  }

  async deleteParticipant(id: string): Promise<void> {
    await this.pool.query('DELETE FROM live_participants WHERE id = $1', [id]);
  }
}
