import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
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
  NewTestAccount,
  ParticipantRecord,
  TestAccountRecord,
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
  safe_mode: number;
  persona: string | null;
  device_profile: string;
  goal_tasks: string;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
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
  occurred_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  body: string;
  created_at: number;
}

interface FindingRow {
  id: string;
  session_id: string;
  severity: number;
  title: string;
  repro_steps: string;
  evidence: string;
  suspected_commit: string | null;
  created_at: number;
}

interface PersonaRow {
  id: string;
  user_id: string;
  workspace: string;
  name: string;
  traits: string;
  checklist: string;
  pace_multiplier: number;
  created_at: number;
  updated_at: number;
}

interface ParticipantRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  state: string;
  invited_by: string;
  created_at: number;
}

interface AccountRow {
  id: string;
  session_id: string;
  username: string;
  email: string;
  password: string;
  role: string;
  state: string;
  created_at: number;
  cleaned_at: number | null;
}

const sessionFromRow = (r: SessionRow): LiveSessionRecord => ({
  id: r.id,
  userId: r.user_id,
  workspace: r.workspace,
  title: r.title,
  goal: r.goal,
  platform: r.platform,
  status: r.status,
  environment: r.environment,
  safeMode: r.safe_mode === 1,
  persona: r.persona,
  deviceProfile: JSON.parse(r.device_profile) as unknown,
  goalTasks: JSON.parse(r.goal_tasks) as unknown,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
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
  occurredAt: r.occurred_at,
});

const messageFromRow = (r: MessageRow): LiveMessageRecord => ({
  id: r.id,
  sessionId: r.session_id,
  role: r.role,
  body: r.body,
  createdAt: r.created_at,
});

const findingFromRow = (r: FindingRow): LiveFindingRecord => ({
  id: r.id,
  sessionId: r.session_id,
  severity: r.severity,
  title: r.title,
  reproSteps: JSON.parse(r.repro_steps) as string[],
  evidence: JSON.parse(r.evidence) as unknown,
  suspectedCommit: r.suspected_commit,
  createdAt: r.created_at,
});

const personaFromRow = (r: PersonaRow): CustomPersonaRecord => ({
  id: r.id,
  userId: r.user_id,
  workspace: r.workspace,
  name: r.name,
  traits: JSON.parse(r.traits) as string[],
  checklist: JSON.parse(r.checklist) as string[],
  paceMultiplier: r.pace_multiplier,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const participantFromRow = (r: ParticipantRow): ParticipantRecord => ({
  id: r.id,
  sessionId: r.session_id,
  userId: r.user_id,
  role: r.role,
  state: r.state,
  invitedBy: r.invited_by,
  createdAt: r.created_at,
});

const accountFromRow = (r: AccountRow): TestAccountRecord => ({
  id: r.id,
  sessionId: r.session_id,
  username: r.username,
  email: r.email,
  password: r.password,
  role: r.role,
  state: r.state,
  createdAt: r.created_at,
  cleanedAt: r.cleaned_at,
});

export class SqliteLiveTestingStore implements LiveTestingStore {
  private readonly db: Database;
  private readonly insertSession;
  private readonly sessionById;
  private readonly updateSession;
  private readonly sessionsByUser;
  private readonly insertStep;
  private readonly stepsBySession;
  private readonly insertMessage;
  private readonly messagesBySession;
  private readonly insertFinding;
  private readonly findingsBySession;
  private readonly insertPersona;
  private readonly personaByUserWorkspaceName;
  private readonly personaById;
  private readonly personasByUser;
  private readonly deletePersonaStmt;
  private readonly insertParticipant;
  private readonly participantById;
  private readonly participantBySessionAndUser;
  private readonly participantsBySession;
  private readonly updateParticipant;
  private readonly deleteParticipantStmt;
  private readonly insertAccount;
  private readonly accountsBySession;
  private readonly updateAccount;

  constructor(db: Database) {
    this.db = db;
    this.insertSession = db.prepare('INSERT INTO live_sessions (id, user_id, workspace, title, goal, platform, status, environment, safe_mode, persona, device_profile, goal_tasks, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.sessionById = db.prepare('SELECT * FROM live_sessions WHERE id = ?');
    this.updateSession = db.prepare('UPDATE live_sessions SET status = ?, started_at = ?, ended_at = ?, persona = ?, device_profile = ?, updated_at = ? WHERE id = ?');
    this.sessionsByUser = db.prepare('SELECT * FROM live_sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertStep = db.prepare('INSERT INTO live_steps (id, session_id, seq, actor, action, target, narration, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.stepsBySession = db.prepare('SELECT * FROM live_steps WHERE session_id = ? ORDER BY seq ASC');
    this.insertMessage = db.prepare('INSERT INTO live_messages (id, session_id, role, body, created_at) VALUES (?, ?, ?, ?, ?)');
    this.messagesBySession = db.prepare('SELECT * FROM live_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC');
    this.insertFinding = db.prepare('INSERT INTO live_findings (id, session_id, severity, title, repro_steps, evidence, suspected_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.findingsBySession = db.prepare('SELECT * FROM live_findings WHERE session_id = ? ORDER BY created_at ASC, id ASC');
    this.insertPersona = db.prepare('INSERT INTO live_personas (id, user_id, workspace, name, traits, checklist, pace_multiplier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.personaByUserWorkspaceName = db.prepare('SELECT * FROM live_personas WHERE user_id = ? AND workspace = ? AND name = ?');
    this.personaById = db.prepare('SELECT * FROM live_personas WHERE id = ?');
    this.personasByUser = db.prepare('SELECT * FROM live_personas WHERE user_id = ? AND (? IS NULL OR workspace = ?) ORDER BY created_at DESC, id DESC');
    this.deletePersonaStmt = db.prepare('DELETE FROM live_personas WHERE id = ?');
    this.insertParticipant = db.prepare('INSERT INTO live_participants (id, session_id, user_id, role, state, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.participantById = db.prepare('SELECT * FROM live_participants WHERE id = ?');
    this.participantBySessionAndUser = db.prepare('SELECT * FROM live_participants WHERE session_id = ? AND user_id = ?');
    this.participantsBySession = db.prepare('SELECT * FROM live_participants WHERE session_id = ? ORDER BY created_at ASC, id ASC');
    this.updateParticipant = db.prepare('UPDATE live_participants SET state = ? WHERE id = ?');
    this.deleteParticipantStmt = db.prepare('DELETE FROM live_participants WHERE id = ?');
    this.insertAccount = db.prepare('INSERT INTO live_test_accounts (id, session_id, username, email, password, role, state, created_at, cleaned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.accountsBySession = db.prepare('SELECT * FROM live_test_accounts WHERE session_id = ? ORDER BY created_at ASC, id ASC');
    this.updateAccount = db.prepare('UPDATE live_test_accounts SET state = ?, cleaned_at = ? WHERE id = ?');
  }

  async createSession(session: NewLiveSession): Promise<LiveSessionRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertSession.run(id, session.userId, session.workspace, session.title, session.goal, session.platform, 'planned', session.environment, session.safeMode ? 1 : 0, session.persona, JSON.stringify(session.deviceProfile), JSON.stringify(session.goalTasks), null, null, session.now, session.now);
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
    });
  }

  async findSession(id: string): Promise<LiveSessionRecord | null> {
    const row = this.sessionById.get(id) as unknown as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  async saveSession(session: LiveSessionRecord): Promise<LiveSessionRecord> {
    return transaction(this.db, () => {
      this.updateSession.run(session.status, session.startedAt, session.endedAt, session.persona, JSON.stringify(session.deviceProfile), session.updatedAt, session.id);
      return session;
    });
  }

  async listSessionsByUser(userId: string, take: number): Promise<LiveSessionRecord[]> {
    const rows = this.sessionsByUser.all(userId, take) as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  async appendStep(step: NewLiveStep): Promise<LiveStepRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertStep.run(id, step.sessionId, step.seq, step.actor, step.action, step.target, step.narration, JSON.stringify(step.payload), step.occurredAt);
      return { id, ...step };
    });
  }

  async listStepsBySession(sessionId: string): Promise<LiveStepRecord[]> {
    const rows = this.stepsBySession.all(sessionId) as unknown as StepRow[];
    return rows.map(stepFromRow);
  }

  async appendMessage(message: NewLiveMessage): Promise<LiveMessageRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertMessage.run(id, message.sessionId, message.role, message.body, message.now);
      return { id, sessionId: message.sessionId, role: message.role, body: message.body, createdAt: message.now };
    });
  }

  async listMessagesBySession(sessionId: string): Promise<LiveMessageRecord[]> {
    const rows = this.messagesBySession.all(sessionId) as unknown as MessageRow[];
    return rows.map(messageFromRow);
  }

  async appendFinding(finding: NewLiveFinding): Promise<LiveFindingRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertFinding.run(id, finding.sessionId, finding.severity, finding.title, JSON.stringify(finding.reproSteps), JSON.stringify(finding.evidence), finding.suspectedCommit, finding.now);
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
    });
  }

  async listFindingsBySession(sessionId: string): Promise<LiveFindingRecord[]> {
    const rows = this.findingsBySession.all(sessionId) as unknown as FindingRow[];
    return rows.map(findingFromRow);
  }

  async createPersona(persona: NewCustomPersona): Promise<CustomPersonaRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertPersona.run(id, persona.userId, persona.workspace, persona.name, JSON.stringify(persona.traits), JSON.stringify(persona.checklist), persona.paceMultiplier, persona.now, persona.now);
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
    });
  }

  async findPersona(userId: string, workspace: string, name: string): Promise<CustomPersonaRecord | null> {
    const row = this.personaByUserWorkspaceName.get(userId, workspace, name) as unknown as PersonaRow | undefined;
    return row ? personaFromRow(row) : null;
  }

  async findPersonaById(id: string): Promise<CustomPersonaRecord | null> {
    const row = this.personaById.get(id) as unknown as PersonaRow | undefined;
    return row ? personaFromRow(row) : null;
  }

  async listPersonas(userId: string, workspace: string | null): Promise<CustomPersonaRecord[]> {
    const rows = this.personasByUser.all(userId, workspace, workspace) as unknown as PersonaRow[];
    return rows.map(personaFromRow);
  }

  async deletePersona(id: string): Promise<void> {
    transaction(this.db, () => {
      this.deletePersonaStmt.run(id);
    });
  }

  async createParticipant(participant: NewParticipant): Promise<ParticipantRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertParticipant.run(id, participant.sessionId, participant.userId, participant.role, 'invited', participant.invitedBy, participant.now);
      return {
        id,
        sessionId: participant.sessionId,
        userId: participant.userId,
        role: participant.role,
        state: 'invited',
        invitedBy: participant.invitedBy,
        createdAt: participant.now,
      };
    });
  }

  async findParticipantById(id: string): Promise<ParticipantRecord | null> {
    const row = this.participantById.get(id) as unknown as ParticipantRow | undefined;
    return row ? participantFromRow(row) : null;
  }

  async findParticipantBySessionAndUser(sessionId: string, userId: string): Promise<ParticipantRecord | null> {
    const row = this.participantBySessionAndUser.get(sessionId, userId) as unknown as ParticipantRow | undefined;
    return row ? participantFromRow(row) : null;
  }

  async listParticipantsBySession(sessionId: string): Promise<ParticipantRecord[]> {
    const rows = this.participantsBySession.all(sessionId) as unknown as ParticipantRow[];
    return rows.map(participantFromRow);
  }

  async saveParticipant(participant: ParticipantRecord): Promise<ParticipantRecord> {
    return transaction(this.db, () => {
      this.updateParticipant.run(participant.state, participant.id);
      return participant;
    });
  }

  async deleteParticipant(id: string): Promise<void> {
    transaction(this.db, () => {
      this.deleteParticipantStmt.run(id);
    });
  }

  async createTestAccount(account: NewTestAccount): Promise<TestAccountRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertAccount.run(id, account.sessionId, account.username, account.email, account.password, account.role, 'created', account.now, null);
      return {
        id,
        sessionId: account.sessionId,
        username: account.username,
        email: account.email,
        password: account.password,
        role: account.role,
        state: 'created',
        createdAt: account.now,
        cleanedAt: null,
      };
    });
  }

  async listTestAccountsBySession(sessionId: string): Promise<TestAccountRecord[]> {
    const rows = this.accountsBySession.all(sessionId) as unknown as AccountRow[];
    return rows.map(accountFromRow);
  }

  async saveTestAccount(account: TestAccountRecord): Promise<TestAccountRecord> {
    return transaction(this.db, () => {
      this.updateAccount.run(account.state, account.cleanedAt, account.id);
      return account;
    });
  }
}
