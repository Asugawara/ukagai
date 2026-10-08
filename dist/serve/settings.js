import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { configPath, readConfig } from "../settings/config.js";
/**
 * The live settings (`<data-dir>/config.json`): read once at start, replaced by `PUT /api/settings`.
 * Consumers (recap watcher, Codex bridge, terminal delivery, the SSE hub) call `get()` at the moment they act, so a change
 * applies without a restart. Writes run one after another (same pattern as plan-read.ts).
 */
export class SettingsStore {
    dataDir;
    current;
    writing = Promise.resolve();
    listeners = [];
    constructor(dataDir, initial) {
        this.dataDir = dataDir;
        this.current = initial;
    }
    static async load(dataDir) {
        return new SettingsStore(dataDir, await readConfig(dataDir));
    }
    get() {
        return this.current;
    }
    onChange(fn) {
        this.listeners.push(fn);
    }
    /** `lang` as it is in config.json now (`install --lang` may have changed it behind the server's back); the live value when unreadable */
    async fileLang() {
        return (await readConfig(this.dataDir)).lang;
    }
    /**
     * Persist the settings, then make them current and tell the listeners (in that order, one update after another): when the write
     * fails nothing changed (`current` and the listeners are untouched) and the error is thrown. Resolves with `next` once it is saved
     */
    async update(next) {
        const json = JSON.stringify(next, null, 2) + "\n";
        const job = this.writing.then(async () => {
            await mkdir(this.dataDir, { recursive: true });
            const tmp = `${configPath(this.dataDir)}.${process.pid}.tmp`;
            try {
                await writeFile(tmp, json, "utf8");
                await rename(tmp, configPath(this.dataDir));
            }
            catch (err) {
                await rm(tmp, { force: true }).catch(() => { });
                throw err;
            }
            const prev = this.current;
            this.current = next;
            for (const fn of this.listeners) {
                try {
                    fn(next, prev);
                }
                catch {
                    // A listener must not break the save
                }
            }
        });
        this.writing = job.catch(() => { });
        await job;
        return next;
    }
    flush() {
        return this.writing;
    }
}
//# sourceMappingURL=settings.js.map