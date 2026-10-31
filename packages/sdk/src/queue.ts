import type { CollectedEvent } from './types';
import { storage } from './utils';

const KEY = 'hh:queue';
export const MAX_ITEMS = 200; // a fila offline nunca passa disso (o storage tem limite)
export const BATCH = 50;
const MAX_AGE_MS = 24 * 3600_000; // evento parado há mais de um dia não vale mais

// Fila de eventos. Fica no localStorage: sem rede, ou ao fechar a página no meio do envio, nada se perde.
export class EventQueue {
  private items: CollectedEvent[] = [];

  constructor() {
    try {
      const saved = JSON.parse(storage.read('localStorage', KEY) || '[]');
      if (Array.isArray(saved)) this.items = saved;
    } catch {
      this.items = [];
    }
    this.trim();
  }

  get size(): number {
    return this.items.length;
  }

  push(item: CollectedEvent): void {
    this.items.push(item);
    this.trim();
    this.persist();
  }

  /** Tira um lote da frente da fila (devolva com putBack se o envio falhar) */
  take(): CollectedEvent[] {
    const batch = this.items.splice(0, BATCH);
    this.persist();
    return batch;
  }

  putBack(batch: CollectedEvent[]): void {
    this.items.unshift(...batch);
    this.trim();
    this.persist();
  }

  private trim(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    this.items = this.items.filter((e) => e && typeof e.timestamp === 'number' && e.timestamp > cutoff).slice(-MAX_ITEMS);
  }

  private persist(): void {
    storage.write('localStorage', KEY, JSON.stringify(this.items));
  }
}
