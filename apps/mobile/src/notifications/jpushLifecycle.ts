import type { JPushRegistration } from '@cindy/device-link';

interface SavedRegistration { owner: string; registration: JPushRegistration; pendingRemoval?: boolean }
export interface JPushLifecycleDependencies {
  config: Pick<JPushRegistration, 'appKey' | 'production'>;
  read(): Promise<SavedRegistration | null>;
  write(value: SavedRegistration): Promise<void>;
  remove(): Promise<void>;
  randomAlias(): string;
  bind(alias: string): Promise<void>;
  disable(): Promise<void>;
  gate(alias: string, preview: boolean): boolean;
  changed(): void;
}

/** Serialize SDK mutations; lifecycle changes invalidate work before/after every await. */
export class JPushLifecycle {
  private owner: string | null = null;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private active: JPushRegistration | null = null;
  constructor(private readonly deps: JPushLifecycleDependencies) {}

  setOwner(owner: string | null) {
    if (this.owner === owner) {
      if (owner === null) this.deps.gate('', false);
      return;
    }
    this.owner = owner;
    this.generation++;
    this.active = null;
    this.deps.gate('', false);
    this.deps.changed();
  }
  registration(): JPushRegistration | null { return this.active; }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
  disable(): Promise<void> {
    this.generation++;
    this.active = null;
    this.deps.gate('', false); // Local redaction is synchronous, even without connectivity.
    this.deps.changed();
    return this.enqueue(async () => {
      const previous = await this.deps.read();
      if (!previous) return;
      await this.deps.write({ ...previous, pendingRemoval: true });
      await this.deps.disable();
      await this.deps.remove();
    });
  }
  sync(preview: boolean): Promise<boolean> {
    const owner = this.owner;
    const generation = this.generation;
    const current = () => owner !== null && owner === this.owner && generation === this.generation;
    return this.enqueue(async () => {
      if (!current()) return false;
      if (this.active?.preview === preview) return true;
      let previous = await this.deps.read();
      if (!current()) return false;
      this.active = null;
      this.deps.gate('', false);
      this.deps.changed();
      if (previous && (previous.pendingRemoval || previous.owner !== owner
        || previous.registration.preview !== preview || previous.registration.appKey !== this.deps.config.appKey
        || previous.registration.production !== this.deps.config.production)) {
        await this.deps.write({ ...previous, pendingRemoval: true });
        if (!current()) return false;
        await this.deps.disable();
        await this.deps.remove();
        previous = null;
      }
      if (!current()) return false;
      const registration: JPushRegistration = previous?.registration ?? {
        ...this.deps.config, alias: this.deps.randomAlias(), preview,
      };
      // Persist before SDK mutation: a lost callback must still be revocable after restart.
      await this.deps.write({ owner: owner!, registration });
      if (!current()) return false;
      await this.deps.bind(registration.alias);
      if (!current()) return false;
      if (!this.deps.gate(registration.alias, preview)) throw new Error('JPUSH_APP_GROUP_UNAVAILABLE');
      this.active = registration;
      this.deps.changed();
      return true;
    });
  }
}
