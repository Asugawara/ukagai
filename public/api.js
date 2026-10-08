// A tiny fetch wrapper for the pages that do not carry app.js's own: the cookie is renewed once on a 401 (GET / sets it).
let refreshing = null;
function refreshAuth() {
  refreshing ??= fetch("/", { credentials: "same-origin", cache: "no-store" })
    .then((r) => r.ok, () => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** JSON in, JSON out. Throws Error(message) with `.issues` (zod issues of a 400) and `.status` on failure */
export async function api(path, init) {
  const go = () => fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  let res = await go();
  if (res.status === 401 && (await refreshAuth())) res = await go();
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(j.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.issues = j.issues;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}
