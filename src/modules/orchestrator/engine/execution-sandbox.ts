// Policy preflight for the orchestrator (FORGE AI-078).
// This pure engine validates a proposed tool action and describes restrictions. It does not
// launch a process/container/VM or enforce filesystem, network or time limits. A trusted runtime
// must enforce those restrictions at the OS/VM boundary before any untrusted code executes.
// A successful verdict is not evidence that code was isolated.

import { TOOLS } from './tool-registry.ts';

export const SANDBOX_TIMEOUT_MIN = 1;
export const SANDBOX_TIMEOUT_MAX = 600;
export const SANDBOX_TIMEOUT_DEFAULT = 30;

export const COMMAND_DENYLIST = [
  'rm -rf /',
  'sudo ',
  'mkfs',
  ':(){ :|:& };:',
  'chmod 777 /',
];

export const WORKSPACE_ROOT = '/workspace/';

export interface SandboxVerdict {
  readonly enforcement: 'preflight-only';
  ok: boolean;
  reason?: string;
  tool?: string;
  timeout?: number;
  restrictions?: string[];
}

/** Evaluates policy only; never executes the proposed tool or command. */
export function runSandboxed(input: {
  tool?: unknown;
  command?: unknown;
  timeout?: unknown;
  egress?: unknown;
  egressAllowlist?: unknown;
  fileWrites?: unknown;
}): SandboxVerdict {
  const tool = typeof input?.tool === 'string' ? input.tool.trim().toLowerCase() : '';
  if (tool.length === 0) return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-tool-missing' };
  if (!TOOLS.some((t) => t.name === tool)) {
    return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-tool-unknown:' + tool };
  }
  const timeout = input?.timeout === undefined ? SANDBOX_TIMEOUT_DEFAULT : input.timeout;
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < SANDBOX_TIMEOUT_MIN ||
    timeout > SANDBOX_TIMEOUT_MAX
  ) {
    return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-timeout-invalid:' + String(timeout) };
  }
  if (input?.command !== undefined) {
    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-command-missing' };
    }
    const lower = ' ' + input.command.toLowerCase() + ' ';
    for (const frag of COMMAND_DENYLIST) {
      if (lower.includes(frag.toLowerCase())) {
        return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-command-forbidden:' + frag.trim() };
      }
    }
  }
  const egress = input?.egress;
  if (egress !== undefined) {
    const host = (egress as { host?: unknown })?.host;
    if (typeof host !== 'string' || host.trim().length === 0) {
      return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-egress-host-missing' };
    }
    const allow = Array.isArray(input?.egressAllowlist)
      ? (input.egressAllowlist as unknown[])
      : [];
    for (const h of allow) {
      if (typeof h !== 'string') {
        return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-egress-allowlist-invalid' };
      }
    }
    const normalized = host.trim().toLowerCase();
    if (!allow.includes(normalized)) {
      return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-egress-denied:' + normalized };
    }
  }
  const writes = Array.isArray(input?.fileWrites) ? (input.fileWrites as unknown[]) : [];
  for (const w of writes) {
    if (typeof w !== 'string' || w.trim().length === 0) {
      return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-path-missing' };
    }
    if (!w.startsWith(WORKSPACE_ROOT)) {
      return { ok: false, enforcement: 'preflight-only', reason: 'sandbox-path-outside-workspace:' + w };
    }
  }
  const restrictions = ['workspace-only-fs', 'no-network', 'timeout-' + timeout + 's'];
  if (egress !== undefined) {
    restrictions.push('egress:' + ((egress as { host: string }).host as string).trim().toLowerCase());
  }
  return { ok: true, enforcement: 'preflight-only', tool, timeout, restrictions };
}
