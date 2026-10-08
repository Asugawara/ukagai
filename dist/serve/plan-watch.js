import { existsSync, watch } from "node:fs";
import { MAX_PLAN_BYTES, planFingerprint, planSummary, plansFingerprint } from "./plans.js";
/**
 * Watch the plans directory. fs.watch gives the fast path; a listing poll every `pollMs`
 * (name -> mtimeMs + size) is the safety net and also covers a directory that does not exist yet.
 * Files present at start are not reported.
 */
export function startPlanWatcher(opts) {
    const { plansDir, onChange, onRemove, isRead, pollMs = 10000, debounceMs = 400 } = opts;
    const known = new Map();
    const timers = new Map();
    let watcher;
    let stopped = false;
    const seeded = plansFingerprint(plansDir).then((m) => {
        for (const [n, sig] of m)
            if (!known.has(n))
                known.set(n, sig);
    });
    const check = async (name) => {
        await seeded;
        if (stopped)
            return;
        const sig = await planFingerprint(plansDir, name);
        if (stopped)
            return;
        if (sig === null) {
            if (known.delete(name))
                onRemove(name);
            return;
        }
        if (known.get(name) === sig)
            return;
        const summary = await planSummary(plansDir, name, isRead);
        if (stopped)
            return;
        if (!summary) {
            if (known.delete(name))
                onRemove(name);
            return;
        }
        known.set(name, sig);
        if (summary.bytes > MAX_PLAN_BYTES)
            return;
        onChange(summary);
    };
    const schedule = (name) => {
        clearTimeout(timers.get(name));
        const t = setTimeout(() => {
            timers.delete(name);
            void check(name).catch(() => { });
        }, debounceMs);
        t.unref();
        timers.set(name, t);
    };
    const poll = async () => {
        await seeded;
        if (stopped)
            return;
        attach();
        const now = await plansFingerprint(plansDir);
        if (stopped)
            return;
        const names = new Set([...now.keys(), ...known.keys()]);
        for (const n of names) {
            if (now.get(n) !== known.get(n) && !timers.has(n))
                await check(n).catch(() => { });
        }
    };
    function attach() {
        if (watcher || stopped || !existsSync(plansDir))
            return;
        try {
            const w = watch(plansDir, (_event, filename) => {
                if (filename === null || filename === undefined) {
                    void poll().catch(() => { });
                    return;
                }
                const name = String(filename);
                if (name.endsWith(".md"))
                    schedule(name);
            });
            w.on("error", () => {
                try {
                    w.close();
                }
                catch { }
                if (watcher === w)
                    watcher = undefined;
            });
            watcher = w;
        }
        catch {
            watcher = undefined;
        }
    }
    attach();
    const interval = setInterval(() => void poll().catch(() => { }), pollMs);
    interval.unref();
    return {
        stop() {
            stopped = true;
            clearInterval(interval);
            for (const t of timers.values())
                clearTimeout(t);
            timers.clear();
            try {
                watcher?.close();
            }
            catch { }
            watcher = undefined;
        },
    };
}
//# sourceMappingURL=plan-watch.js.map