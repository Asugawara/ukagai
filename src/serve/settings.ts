import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { type Settings } from "../contract.js";
import { configPath, readConfig } from "../settings/config.js";

/**
 * The live settings (`<data-dir>/config.json`): read once at start, replaced by `PUT /api/settings`.
 * Consumers (recap watcher, Codex bridge, terminal delivery, the SSE hub) call `get()` at the moment they act, so a change
 * applies without a restart. Writes run one after another (same pattern as plan-read.ts).
 */
export class SettingsStore {
  private current: Settings;
  private writing: Promise<void> = Promise.resolve();
  private listeners: ((s: Settings, prev: Settings) => void)[] = [];

  constructor(private dataDir: string, initial: Settings) {
    this.current = initial;
  }

  static async load(dataDir: string): Promise<SettingsStore> {
    return new SettingsStore(dataDir, await readConfig(dataDir));
  }

  get(): Settings {
    return this.current;
  }

  onChange(fn: (s: Settings, prev: Settings) => void): void {
    this.listeners.push(fn);
  }

  /** `lang` as it is in config.json now (`install` may have created the file behind the server's back); the live value when unreadable */
  async fileLang(): Promise<Settings["lang"]> {
    return (await readConfig(this.dataDir)).lang;
  }

  /**
   * Persist the settings, then make them current and tell the listeners (in that order, one update after another): when the write
   * fails nothing changed (`current` and the listeners are untouched) and the error is thrown. Resolves with `next` once it is saved
   */
  async update(next: Settings): Promise<Settings> {
    const json = JSON.stringify(next, null, 2) + "\n";
    const job = this.writing.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const tmp = `${configPath(this.dataDir)}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, json, "utf8");
        await rename(tmp, configPath(this.dataDir));
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      const prev = this.current;
      this.current = next;
      for (const fn of this.listeners) {
        try {
          fn(next, prev);
        } catch {
          // A listener must not break the save
        }
      }
    });
    this.writing = job.catch(() => {});
    await job;
    return next;
  }

  flush(): Promise<void> {
    return this.writing;
  }
}
