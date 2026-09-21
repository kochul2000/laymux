/** Shared draft lifecycle for Desktop and Remote. The backend owns compare-and-save. */
export class MemoDocument {
  private snapshot = {
    text: "",
    dirty: false,
    loaded: false,
    busy: false,
    error: null as string | null,
  };
  private baseline = "";
  private revision = 0;
  private listeners = new Set<() => void>();
  private saving: Promise<void> | null = null;
  private saveAgain = false;
  private reading = false;

  constructor(
    private load: () => Promise<string>,
    private write: (text: string, expectedContent: string) => Promise<void>,
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  edit = (text: string) => {
    this.revision += 1;
    this.publish({ text, dirty: text !== this.baseline });
  };

  async refresh(discard = false) {
    if (this.reading || this.saving || (this.snapshot.dirty && !discard)) return;
    this.reading = true;
    const revision = this.revision;
    try {
      const text = await this.load();
      if (revision !== this.revision) return;
      this.baseline = text;
      this.publish({ text, dirty: false, loaded: true, error: null });
    } catch (error) {
      this.publish({ error: String(error instanceof Error ? error.message : error) });
    } finally {
      this.reading = false;
    }
  }

  save = (): Promise<void> => {
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    if (!this.snapshot.loaded || !this.snapshot.dirty) return Promise.resolve();
    this.publish({ busy: true });
    this.saving = this.flush().finally(() => {
      this.saving = null;
      this.publish({ busy: false });
    });
    return this.saving;
  };

  private async flush() {
    do {
      this.saveAgain = false;
      const text = this.snapshot.text;
      try {
        await this.write(text, this.baseline);
        this.baseline = text;
        this.publish({ dirty: this.snapshot.text !== text, error: null });
      } catch (error) {
        this.publish({ error: String(error instanceof Error ? error.message : error) });
        return;
      }
    } while (this.saveAgain && this.snapshot.dirty);
  }
}
