/** What holds a client key's mutation lock. */
export type ClientKeyMutation = 'save' | 'reset' | 'remove';

/** A mutation was refused, without running, because another one holds the key's lock. */
export class ClientKeyBusyError extends Error {
  readonly keyId: string;
  readonly holder: ClientKeyMutation;

  constructor(keyId: string, holder: ClientKeyMutation) {
    super(`Client key ${keyId} is busy: ${holder} in progress`);
    this.name = 'ClientKeyBusyError';
    this.keyId = keyId;
    this.holder = holder;
  }
}

export const isClientKeyBusy = (error: unknown): error is ClientKeyBusyError =>
  error instanceof ClientKeyBusyError;

export interface ClientKeyMutationLock {
  /**
   * Runs `task` holding the key's lock until it settles; rejects with `ClientKeyBusyError`
   * without running it while another mutation of the key holds the lock.
   */
  run<T>(keyId: string, mutation: ClientKeyMutation, task: () => Promise<T>): Promise<T>;
  /** The mutation holding the key's lock; null when it is free. */
  holder(keyId: string): ClientKeyMutation | null;
  subscribe(listener: () => void): () => void;
}

/**
 * One lock per key shared by the allowance save, the window reset and the removal, each
 * held from the request through the reload that follows it. Without it, a save made while
 * a removal deletes the key's history writes an allowance after the removal cleared it,
 * and the key, listed for its allowance, comes back.
 */
export function createClientKeyMutationLock(): ClientKeyMutationLock {
  const held = new Map<string, ClientKeyMutation>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    async run(keyId, mutation, task) {
      // Taken before anything is awaited, so two requests can never both get it.
      const current = held.get(keyId);
      if (current) throw new ClientKeyBusyError(keyId, current);
      held.set(keyId, mutation);
      notify();
      try {
        return await task();
      } finally {
        held.delete(keyId);
        notify();
      }
    },
    holder: (keyId) => held.get(keyId) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The dashboard's lock. Module-wide rather than per panel, so a removal still in flight
 * keeps the key locked when the panel is left and opened again.
 */
export const clientKeyMutations = createClientKeyMutationLock();
