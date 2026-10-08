import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** A reconnecting pinned tab retries every 5 s at most: give it this long before opening a new tab */
export const GRACE_MS = 8000;
export function localDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Owns the once-a-day GUI open: a connected GUI tab (or one that reconnects within the grace) means no new tab */
export class GuiOpener {
    deps;
    timer = false;
    constructor(deps) {
        this.deps = deps;
    }
    get marker() {
        return join(this.deps.dataDir, "gui-opened");
    }
    today() {
        return localDate(this.deps.now());
    }
    writeMarker() {
        mkdirSync(this.deps.dataDir, { recursive: true, mode: 0o700 });
        writeFileSync(this.marker, this.today() + "\n");
    }
    request() {
        try {
            let last = "";
            try {
                last = readFileSync(this.marker, "utf8").trim();
            }
            catch {
                // no marker: first time
            }
            if (last === this.today())
                return "opened_today";
            if (this.deps.hub.browsers > 0) {
                this.writeMarker();
                this.deps.log?.("gui_open", { result: "connected", opened: "no" });
                return "connected";
            }
            if (!this.timer) {
                this.timer = true;
                this.deps.setTimeout(() => this.fire(), GRACE_MS);
            }
            return "pending";
        }
        catch {
            return "pending";
        }
    }
    fire() {
        this.timer = false;
        try {
            this.writeMarker();
            let opened = false;
            if (this.deps.hub.browsers === 0) {
                const opener = this.deps.platform === "darwin" ? "open" : this.deps.platform === "linux" ? "xdg-open" : undefined;
                if (opener) {
                    this.deps.spawn(opener, [`http://127.0.0.1:${this.deps.port()}/?autostart=1`], { detached: true, stdio: "ignore" }).unref();
                    opened = true;
                }
            }
            this.deps.log?.("gui_open", { result: "pending", opened: opened ? "yes" : "no" });
        }
        catch {
            // never throws
        }
    }
}
//# sourceMappingURL=gui-open.js.map