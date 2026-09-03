import type { AppSettings } from '../shared/contracts';

/** Coalesce UI changes while retaining an explicit, awaitable save before closing. */
export class PreferencesSaveQueue {
  private pending: AppSettings | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly write: (settings: AppSettings) => Promise<void>,
    private readonly reportError: (error: unknown) => void,
  ) {}

  public schedule(settings: AppSettings): void {
    this.pending = settings;
    this.cancelTimer();
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 450);
  }

  public flush(): Promise<void> {
    this.cancelTimer();
    const settings = this.pending;
    if (settings !== undefined) {
      this.pending = undefined;
      // The main process serializes disk writes. Send this final value immediately,
      // so even a slow earlier save cannot keep it behind the renderer timeout.
      const save = this.write(settings);
      this.queue = Promise.all([this.queue.catch(() => undefined), save]).then(() => undefined);
      void save.catch(this.reportError);
    }
    return this.queue;
  }

  public cancelTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
