import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import { assembleBugReport } from './engine/bug-report.ts';
import {
  checkCapability,
  checkInvitation,
  normalizeRole,
  roleCatalog,
} from './engine/session-collaboration.ts';
import { canHandBack, canTakeControl, isActing, transition } from './engine/session-lifecycle.ts';
import { getPersona, listPersonas } from './engine/persona-profile.ts';
import { checkAction, isPlatform } from './engine/platform-capability.ts';
import { narrate, parseGoal, type ParsedTask } from './engine/step-narration.ts';
import { buildTimeline } from './engine/session-recording.ts';
import { convertSession } from './engine/test-conversion.ts';
import { evaluateStep, isEnvironment, resolveSafeMode } from './engine/safe-mode.ts';
import { LiveTestingEvents, LIVE_TESTING_EVENT_VERSION } from './events.ts';
import type {
  CustomPersonaRecord,
  LiveFindingRecord,
  LiveSessionRecord,
  LiveStepRecord,
  LiveTestingStore,
  ParticipantRecord,
} from './live-testing-store.ts';

export interface LiveTestingDeps {
  readonly store: LiveTestingStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);

const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/**
 * FORGE TQ-001..018 (live agent testing, session core). The service is a
 * thin, auditable shell over pure engines: every state change is a legal
 * lifecycle transition, every recorded step is evaluated by safe mode
 * FIRST and the platform vocabulary second (security before mechanics),
 * and every refusal is named. Sessions belong to one owner; an active
 * participant can act within their role, and anyone else meets the same
 * session-not-found wall as a stranger.
 */
export class LiveTestingService {
  private readonly store: LiveTestingStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: LiveTestingDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  private workspaceOf(dto: { workspace?: unknown }): string {
    const w = typeof dto?.workspace === 'string' ? dto.workspace.trim() : '';
    return w.length > 0 ? w.slice(0, 64) : 'default';
  }

  private sessionIdOf(dto: { sessionId?: unknown }): string {
    const id = typeof dto?.sessionId === 'string' ? dto.sessionId.trim() : '';
    if (id.length === 0) throw refusal('session-id-missing');
    return id;
  }

  private async requireSession(userId: string, sessionId: string): Promise<LiveSessionRecord> {
    const row = await this.store.findSession(sessionId);
    if (!row || row.userId !== userId) throw refusal('session-not-found:' + sessionId);
    return row;
  }

  private async requireSessionCapability(
    userId: string,
    sessionId: string,
    capability: string,
  ): Promise<LiveSessionRecord> {
    const row = await this.store.findSession(sessionId);
    if (!row) throw refusal('session-not-found:' + sessionId);
    if (row.userId === userId) return row;
    const participant = await this.store.findParticipantBySessionAndUser(sessionId, userId);
    if (!participant || participant.state !== 'active') throw refusal('session-not-found:' + sessionId);
    const verdict = checkCapability({ role: participant.role, capability });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'collaboration-refused');
    return row;
  }

  private async emit(type: string, subjectId: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.append({
      type,
      version: LIVE_TESTING_EVENT_VERSION,
      actor: { kind: 'system', id: 'forge' },
      subject: { type: 'live_testing_session', id: subjectId },
      payload,
    });
  }

  async createSession(userId: string, body: unknown): Promise<LiveSessionRecord & { forcedSafeMode: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const workspace = this.workspaceOf(dto);
    const platform = dto.platform;
    if (!isPlatform(platform)) throw refusal('platform-unknown:' + String(platform));
    const environment = isEnvironment(dto.environment) ? dto.environment : 'staging';
    const decision = resolveSafeMode(dto.safeMode, environment);
    const goal = parseGoal(dto.goal);
    if (!goal.ok || !goal.tasks) throw refusal(goal.reason ?? 'goal-invalid');
    const tasks = goal.tasks as ParsedTask[];
    let persona: string | null = null;
    if (dto.persona !== undefined && dto.persona !== null && dto.persona !== '') {
      const verdict = getPersona(dto.persona);
      if (verdict.ok) {
        persona = verdict.profile?.name ?? null;
      } else {
        const personaName = String(dto.persona).trim().toLowerCase();
        const custom = await this.store.findPersona(userId, workspace, personaName);
        if (!custom) throw refusal(verdict.reason ?? 'persona-invalid');
        persona = custom.name;
      }
    }
    const title =
      typeof dto.title === 'string' && dto.title.trim().length > 0
        ? dto.title.trim().slice(0, 200)
        : tasks[0]!.text.slice(0, 200);
    const saved = await this.store.createSession({
      userId,
      workspace,
      title,
      goal: typeof dto.goal === 'string' ? dto.goal.slice(0, 1000) : '',
      platform,
      environment,
      safeMode: decision.safeMode,
      persona,
      deviceProfile: { platform },
      goalTasks: tasks,
      now: this.clock(),
    });
    await this.emit(LiveTestingEvents.SessionCreated, saved.id, {
      platform,
      environment,
      safeMode: decision.safeMode,
    });
    return { ...saved, forcedSafeMode: decision.forced };
  }

  private async applyTransition(userId: string, body: unknown, to: string): Promise<LiveSessionRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const sessionId = this.sessionIdOf(dto);
    const row = await this.requireSession(userId, sessionId);
    const verdict = transition(row.status, to);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'session-transition-refused');
    const from = row.status;
    let updated: LiveSessionRecord = { ...row, status: to, updatedAt: this.clock() };
    if (to === 'running' && updated.startedAt === null) updated = { ...updated, startedAt: this.clock() };
    if (to === 'completed' || to === 'failed' || to === 'cancelled') {
      updated = { ...updated, endedAt: this.clock() };
    }
    updated = await this.store.saveSession(updated);
    await this.emit(LiveTestingEvents.SessionStatusChanged, sessionId, { from, to });
    return updated;
  }

  async startSession(userId: string, body: unknown): Promise<LiveSessionRecord> {
    return this.applyTransition(userId, body, 'running');
  }

  async pauseSession(userId: string, body: unknown): Promise<LiveSessionRecord> {
    return this.applyTransition(userId, body, 'paused');
  }

  async resumeSession(userId: string, body: unknown): Promise<LiveSessionRecord> {
    return this.applyTransition(userId, body, 'running');
  }

  async completeSession(userId: string, body: unknown): Promise<LiveSessionRecord> {
    return this.applyTransition(userId, body, 'completed');
  }

  async failSession(userId: string, body: unknown): Promise<LiveSessionRecord> {
    return this.applyTransition(userId, body, 'failed');
  }

  async cancelSession(userId: string, body: unknown): Promise<LiveSessionRecord> {
    return this.applyTransition(userId, body, 'cancelled');
  }

  async takeControl(userId: string, body: unknown): Promise<LiveSessionRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const sessionId = this.sessionIdOf(dto);
    const row = await this.requireSession(userId, sessionId);
    if (!canTakeControl(row.status)) throw refusal('session-control-refused:' + row.status);
    const updated = await this.store.saveSession({ ...row, status: 'manual', updatedAt: this.clock() });
    await this.emit(LiveTestingEvents.SessionStatusChanged, sessionId, { from: row.status, to: 'manual' });
    return updated;
  }

  async handBack(userId: string, body: unknown): Promise<LiveSessionRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const sessionId = this.sessionIdOf(dto);
    const row = await this.requireSession(userId, sessionId);
    if (!canHandBack(row.status)) throw refusal('session-handback-refused:' + row.status);
    const updated = await this.store.saveSession({ ...row, status: 'running', updatedAt: this.clock() });
    await this.emit(LiveTestingEvents.SessionStatusChanged, sessionId, { from: row.status, to: 'running' });
    return updated;
  }

  async recordStep(userId: string, body: unknown): Promise<LiveStepRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const sessionId = this.sessionIdOf(dto);
    const row = await this.requireSessionCapability(userId, sessionId, 'steps');
    if (!isActing(row.status)) throw refusal('session-not-acting:' + row.status);
    const action = typeof dto.action === 'string' ? dto.action : '';
    const intent = {
      action,
      target: dto.target,
      payload: {
        value: dto.value,
        direction: dto.direction,
        key: dto.key,
        count: dto.count,
        extra: dto.payload ?? {},
      },
    };
    const safeVerdict = evaluateStep(intent, row.safeMode);
    if (!safeVerdict.ok) throw refusal(safeVerdict.reason ?? 'safe-mode-refused');
    const platformCheck = checkAction(row.platform, action);
    if (!platformCheck.ok) throw refusal(platformCheck.reason ?? 'platform-refused');
    const narration = narrate({
      action,
      target: dto.target,
      value: dto.value,
      direction: dto.direction,
      key: dto.key,
      count: dto.count,
    });
    if (!narration.ok) throw refusal(narration.reason ?? 'narration-refused');
    const existing = await this.store.listStepsBySession(sessionId);
    const step = await this.store.appendStep({
      sessionId,
      seq: existing.length + 1,
      actor: 'ai',
      action,
      target: typeof dto.target === 'string' && dto.target.length > 0 ? dto.target : null,
      narration: narration.text ?? '',
      payload: intent.payload,
      occurredAt: this.clock(),
    });
    await this.emit(LiveTestingEvents.StepRecorded, sessionId, { seq: step.seq, action });
    return step;
  }

  async postMessage(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const sessionId = this.sessionIdOf(dto);
    await this.requireSessionCapability(userId, sessionId, 'messages');
    const text = typeof dto.body === 'string' ? dto.body.trim() : '';
    if (text.length === 0) throw refusal('message-empty');
    return this.store.appendMessage({ sessionId, role: 'human', body: text.slice(0, 2000), now: this.clock() });
  }

  async reportFinding(userId: string, body: unknown): Promise<LiveFindingRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const sessionId = this.sessionIdOf(dto);
    await this.requireSessionCapability(userId, sessionId, 'findings');
    const severity = Number(dto.severity);
    if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
      throw refusal('finding-severity-invalid');
    }
    const title = typeof dto.title === 'string' ? dto.title.trim() : '';
    if (title.length === 0) throw refusal('finding-title-missing');
    let commit: string | null = null;
    if (dto.suspectedCommit !== undefined && dto.suspectedCommit !== null && dto.suspectedCommit !== '') {
      const candidate = String(dto.suspectedCommit).trim();
      if (!COMMIT_RE.test(candidate)) throw refusal('finding-commit-invalid');
      commit = candidate;
    }
    const finding = await this.store.appendFinding({
      sessionId,
      severity,
      title,
      reproSteps: Array.isArray(dto.reproSteps)
        ? dto.reproSteps.filter((p): p is string => typeof p === 'string')
        : [],
      evidence: dto.evidence !== null && typeof dto.evidence === 'object' ? dto.evidence : {},
      suspectedCommit: commit,
      now: this.clock(),
    });
    await this.emit(LiveTestingEvents.FindingReported, sessionId, { severity });
    return finding;
  }

  async getSession(userId: string, sessionId: string): Promise<unknown> {
    const row = await this.requireSession(userId, sessionId);
    const steps = await this.store.listStepsBySession(sessionId);
    const messages = await this.store.listMessagesBySession(sessionId);
    const findings = await this.store.listFindingsBySession(sessionId);
    return {
      session: row,
      stepCount: steps.length,
      messageCount: messages.length,
      findings,
    };
  }

  async listSessions(userId: string): Promise<LiveSessionRecord[]> {
    return this.store.listSessionsByUser(userId, 50);
  }

  async buildRecording(userId: string, sessionId: string): Promise<unknown> {
    const row = await this.requireSession(userId, sessionId);
    if (row.startedAt === null) throw refusal('recording-not-started');
    const steps = await this.store.listStepsBySession(sessionId);
    const verdict = buildTimeline(
      new Date(row.startedAt),
      steps.map((s) => ({
        seq: s.seq,
        narration: s.narration,
        status: 'recorded',
        occurredAt: new Date(s.occurredAt),
      })),
      [],
    );
    if (!verdict.ok) throw refusal(verdict.reason ?? 'recording-refused');
    return { sessionId, events: verdict.events, durationMs: verdict.durationMs };
  }

  async assembleBugReport(userId: string, sessionId: string): Promise<unknown> {
    const row = await this.requireSession(userId, sessionId);
    const findings = await this.store.listFindingsBySession(sessionId);
    const latest = findings.length === 0 ? null : findings[findings.length - 1]!;
    if (!latest) throw refusal('bugreport-none');
    const steps = await this.store.listStepsBySession(sessionId);
    const evidenceText =
      latest.evidence !== null &&
      typeof latest.evidence === 'object' &&
      Object.keys(latest.evidence).length > 0
        ? JSON.stringify(latest.evidence)
        : null;
    const verdict = assembleBugReport(
      sessionId,
      {
        platform: row.platform,
        environment: row.environment,
        safeMode: row.safeMode,
      },
      {
        severity: latest.severity,
        title: latest.title,
        reproSteps: latest.reproSteps.join(' '),
        evidence: evidenceText,
        suspectedCommit: latest.suspectedCommit,
      },
      steps.map((s) => ({ narration: s.narration, status: 'recorded' })),
    );
    if (!verdict.ok) throw refusal(verdict.reason ?? 'bugreport-refused');
    return { sessionId, report: verdict.report };
  }

  async convertSessionForUser(userId: string, sessionId: string): Promise<unknown> {
    const row = await this.requireSession(userId, sessionId);
    const steps = await this.store.listStepsBySession(sessionId);
    const tasks = Array.isArray(row.goalTasks) ? (row.goalTasks as { id: string; text: string }[]) : [];
    const verdict = convertSession(
      { title: row.title, tasks },
      steps.map((s) => ({ seq: s.seq, action: s.action, target: s.target })),
    );
    if (!verdict.ok) throw refusal(verdict.reason ?? 'conversion-refused');
    return { sessionId, testCase: verdict.testCase };
  }

  personaCatalog(): readonly string[] {
    return listPersonas();
  }

  async createCustomPersona(userId: string, body: unknown): Promise<CustomPersonaRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const workspace = this.workspaceOf(dto);
    const name = typeof dto.name === 'string' ? dto.name.trim().toLowerCase() : '';
    if (name.length === 0) throw refusal('persona-name-missing');
    if (getPersona(name).ok) throw refusal('persona-duplicate:' + name);
    const existing = await this.store.findPersona(userId, workspace, name);
    if (existing) throw refusal('persona-duplicate:' + name);
    const pace = dto.paceMultiplier === undefined ? 1 : Number(dto.paceMultiplier);
    if (!Number.isFinite(pace) || pace < 0.25 || pace > 4) throw refusal('persona-pace-invalid');
    const traits = Array.isArray(dto.traits)
      ? dto.traits.filter((t): t is string => typeof t === 'string')
      : [];
    const checklist = Array.isArray(dto.checklist)
      ? dto.checklist.filter((c): c is string => typeof c === 'string')
      : [];
    return this.store.createPersona({
      userId,
      workspace,
      name,
      traits,
      checklist,
      paceMultiplier: pace,
      now: this.clock(),
    });
  }

  async listCustomPersonas(userId: string, workspace: string | null): Promise<CustomPersonaRecord[]> {
    return this.store.listPersonas(userId, workspace);
  }

  async deleteCustomPersona(userId: string, personaId: string): Promise<{ deleted: boolean; id: string }> {
    const row = await this.store.findPersonaById(personaId);
    if (!row || row.userId !== userId) throw refusal('persona-not-found:' + personaId);
    await this.store.deletePersona(row.id);
    return { deleted: true, id: row.id };
  }

  roleCatalog(): { role: string; capabilities: string[] }[] {
    return roleCatalog();
  }

  async inviteParticipant(userId: string, body: unknown): Promise<ParticipantRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const sessionId = this.sessionIdOf(dto);
    const row = await this.requireSession(userId, sessionId);
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      throw refusal('collaboration-session-terminal:' + row.status);
    }
    const role = normalizeRole(dto.role ?? 'tester');
    if (!role) throw refusal('collaboration-role-unknown:' + String(dto.role));
    const invitee = typeof dto.userId === 'string' ? dto.userId.trim() : '';
    if (invitee.length === 0) throw refusal('collaboration-user-missing');
    if (invitee === userId) throw refusal('collaboration-self-invite');
    const existing = await this.store.findParticipantBySessionAndUser(sessionId, invitee);
    if (existing) throw refusal('collaboration-participant-duplicate:' + invitee);
    return this.store.createParticipant({
      sessionId,
      userId: invitee,
      role,
      invitedBy: userId,
      now: this.clock(),
    });
  }

  async acceptInvitation(userId: string, participantId: string): Promise<ParticipantRecord> {
    const row = await this.store.findParticipantById(participantId);
    if (!row || row.userId !== userId) throw refusal('participant-not-found:' + participantId);
    const verdict = checkInvitation({ state: row.state, action: 'accept' });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'collaboration-refused');
    const updated = await this.store.saveParticipant({ ...row, state: 'active' });
    return updated;
  }

  async revokeParticipant(userId: string, participantId: string): Promise<{ deleted: boolean; id: string }> {
    const row = await this.store.findParticipantById(participantId);
    if (!row) throw refusal('participant-not-found:' + participantId);
    await this.requireSession(userId, row.sessionId);
    const verdict = checkInvitation({ state: row.state, action: 'revoke' });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'collaboration-refused');
    await this.store.deleteParticipant(row.id);
    return { deleted: true, id: row.id };
  }

  async listParticipants(userId: string, body: unknown): Promise<{ sessionId: string; participants: ParticipantRecord[] }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const sessionId = this.sessionIdOf(dto);
    await this.requireSession(userId, sessionId);
    return { sessionId, participants: await this.store.listParticipantsBySession(sessionId) };
  }
}
