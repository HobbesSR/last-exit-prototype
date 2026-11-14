export const LOCK_PORTS: Readonly<{ bench: 47913; intent: 47913 }>;
export const SHARED_PORTS: readonly number[];
export const DEFAULT_CONTENTION_THRESHOLD: number;
export const LOCK_ENV: 'MACHINE_LOCK_HELD';

export interface ContentionSample {
  wallMs: number;
  selfCpuMs: number;
  otherBusyShare: number;
  contended: boolean;
  threshold: number;
}

export interface MachineLockOptions {
  mode?: 'exclusive' | 'shared';
  port?: number;
  sharedPorts?: readonly number[];
  timeoutMs?: number;
  pollMs?: number;
  noWait?: boolean;
  force?: boolean;
  threshold?: number;
  log?: (message: string) => void;
}

export interface MachineLock {
  port: number | null;
  ports: number[];
  mode: 'exclusive' | 'shared';
  inherited?: boolean;
  skippedCi?: boolean;
  release: () => void;
  contention: () => ContentionSample;
}

export function startContentionSample(options?: { threshold?: number }): () => ContentionSample;
export function acquireMachineLock(name: string, options?: MachineLockOptions): Promise<MachineLock>;
