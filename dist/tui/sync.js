import { ApiError } from "./api.js";
export const RECONNECT_MIN_MS = 2000;
export const RECONNECT_MAX_MS = 5000;
/** Wait before the next reconnect after the nth failure (1-based): doubles from 2 seconds, capped at 5 seconds */
export const reconnectDelay = (failures) => Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, failures - 1));
/**
 * Re-fetch the pending list (and the plans unless `plans` is false: the safety poll skips them while SSE is up, since its reconnect refetch and `plan.*` events cover them).
 * A decision still pending locally but missing from the list is fetched individually and dropped if the server no longer has it
 */
export async function refetch(api, app, now = Date.now, plans = true) {
    // Plans are best effort: a failure leaves what is known
    const [pending, files] = await Promise.all([api.listPending(), plans && api.plans ? api.plans().catch(() => null) : null]);
    const stale = app.replacePending(pending, now());
    const states = api.sessions ? await api.sessions().catch(() => null) : null;
    if (states)
        app.setSessions(states);
    const settings = api.settings ? await api.settings().catch(() => null) : null;
    if (settings)
        app.settingsUpdated(settings);
    if (files)
        app.replacePlans(files, now());
    await Promise.all(stale.map(async (id) => {
        try {
            app.upsert(await api.get(id), now());
        }
        catch (e) {
            if (e instanceof ApiError && e.status === 404)
                app.drop(id, now());
            // Anything else is retried on the next fetch
        }
    }));
}
/** Keep subscribing to SSE. On a drop, wait and reconnect, syncing the list each time it connects */
export async function streamLoop(api, app, signal, o) {
    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = o.now ?? Date.now;
    let failures = 0;
    while (!signal.aborted) {
        try {
            await api.stream((ev) => {
                if (ev.event === "session.updated")
                    app.sessionUpdated(ev.session);
                else if (ev.event === "plan.updated")
                    app.planUpdated(ev.plan, now());
                else if (ev.event === "settings.updated")
                    app.settingsUpdated(ev.settings);
                else if (ev.event === "plan.removed")
                    app.planRemoved(ev.name, now());
                else
                    app.upsert(ev.decision, now());
                o.onChange();
            }, signal, () => {
                failures = 0;
                app.setConnected(true, now());
                o.onChange();
                void refetch(api, app, now).then(o.onChange, () => { });
            });
        }
        catch {
            // Reconnect
        }
        if (signal.aborted)
            return;
        failures++;
        app.setConnected(false, now());
        o.onChange();
        await sleep(reconnectDelay(failures));
    }
}
//# sourceMappingURL=sync.js.map