// Pure execution sandbox engine for the orchestrator (FORGE AI-078).
// Market law (E2B Firecracker microVM sandboxes): every agent action runs
// workspace-only, network is denied by default with a per-host egress
// allowlist, timeouts are bounded between 1 and 600 seconds, and destructive
// shell commands are refused from a denylist. Every refusal is named.

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
  ok: boolean;
  reason?: string;
  tool?: string;
  timeout?: number;
  restrictions?: string[];
}

export function runSandboxed(input: {
  tool?: unknown;
  command?: unknown;
  timeout?: unknown;
  egress?: unknown;
  egressAllowlist?: unknown;
  fileWrites?: unknown;
}): SandboxVerdict {
  const tool = typeof input?.tool === 'string' ? input.tool.trim().toLowerCase() : '';
  if (tool.length === 0) return { ok: false, reason: 'sandbox-tool-missing' };
  if (!TOOLS.some((t) => t.name === tool)) {
    return { ok: false, reason: 'sandbox-tool-unknown:' + tool };
  }
  const timeout = input?.timeout === undefined ? SANDBOX_TIMEOUT_DEFAULT : input.timeout;
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < SANDBOX_TIMEOUT_MIN ||
    timeout > SANDBOX_TIMEOUT_MAX
  ) {
    return { ok: false, reason: 'sandbox-timeout-invalid:' + String(timeout) };
  }
  if (input?.command !== undefined) {
    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      return { ok: false, reason: 'sandbox-command-missing' };
    }
    const lower = ' ' + input.command.toLowerCase() + ' ';
    for (const frag of COMMAND_DENYLIST) {
      if (lower.includes(frag.toLowerCase())) {
        return { ok: false, reason: 'sandbox-command-forbidden:' + frag.trim() };
      }
    }
  }
  const egress = input?.egress;
  if (egress !== undefined) {
    const host = (egress as { host?: unknown })?.host;
    if (typeof host !== 'string' || host.trim().length === 0) {
      return { ok: false, reason: 'sandbox-egress-host-missing' };
    }
    const allow = Array.isArray(input?.egressAllowlist)
      ? (input.egressAllowlist as unknown[])
      : [];
    for (const h of allow) {
      if (typeof h !== 'string') {
        return { ok: false, reason: 'sandbox-egress-allowlist-invalid' };
      }
    }
    const normalized = host.trim().toLowerCase();
    if (!allow.includes(normalized)) {
      return { ok: false, reason: 'sandbox-egress-denied:' + normalized };
    }
  }
  const writes = Array.isArray(input?.fileWrites) ? (input.fileWrites as unknown[]) : [];
  for (const w of writes) {
    if (typeof w !== 'string' || w.trim().length === 0) {
      return { ok: false, reason: 'sandbox-path-missing' };
    }
    if (!w.startsWith(WORKSPACE_ROOT)) {
      return { ok: false, reason: 'sandbox-path-outside-workspace:' + w };
    }
  }
  const restrictions = ['workspace-only-fs', 'no-network', 'timeout-' + timeout + 's'];
  if (egress !== undefined) {
    restrictions.push('egress:' + ((egress as { host: string }).host as string).trim().toLowerCase());
  }
  return { ok: true, tool, timeout, restrictions };
}
