/**
 * Quasar Cookie Jar
 * -----------------
 * Server-side in-memory cookie store keyed by (container, target origin).
 * Set-Cookie from targets is absorbed here and re-issued on later requests,
 * so login sessions survive. The client shim also syncs document.cookie
 * writes into this jar via /api/cookie.
 *
 * v2.1.0 — the jar is partitioned per CONTAINER as well as per origin: two
 * tabs using different containers can be logged into the same site as two
 * different accounts (Firefox-container style), and incognito containers get
 * a jar that is dropped wholesale when the last incognito tab closes.
 * The built-in container ("default") preserves pre-2.1 behavior exactly.
 */

export const DEFAULT_CONTAINER = "default";

/** jar key = container + "\n" + origin (container sanitized by callers).
 *  State lives on globalThis: Next.js (Turbopack) compiles each route as its
 *  own bundle — without this, /api/cookie and /p/ would hold two different
 *  jars and cookie sync would silently break. */
const jars: Map<string, Map<string, string>> = ((globalThis as Record<string, unknown>).__quasarCookieJars ??= new Map()) as Map<string, Map<string, string>>;

const MAX_ORIGINS = 250;
const MAX_COOKIES_PER_ORIGIN = 120;

const EXPIRED_RE = /max-age\s*=\s*0(?![0-9])/i;

/** Normalize an externally supplied container id (falls back to default). */
export function normContainer(container: string | null | undefined): string {
  if (!container) return DEFAULT_CONTAINER;
  const c = String(container);
  return /^[A-Za-z0-9_-]{1,40}$/.test(c) ? c : DEFAULT_CONTAINER;
}

function jarKey(origin: string, container: string): string {
  return container + "\n" + origin;
}

/** Key for the v2.4.1 domain-scoped jar (Domain=.roblox.com style cookies). */
function domainJarKey(domain: string, container: string): string {
  return container + "\nd:" + domain;
}

function jarFor(key: string): Map<string, string> {
  let jar = jars.get(key);
  if (!jar) {
    if (jars.size >= MAX_ORIGINS) {
      const oldest = jars.keys().next().value;
      if (oldest) jars.delete(oldest);
    }
    jar = new Map();
    jars.set(key, jar);
  }
  return jar;
}

function originJarFor(origin: string, container: string): Map<string, string> {
  return jarFor(jarKey(origin, container));
}

function isExpired(setCookie: string): boolean {
  if (EXPIRED_RE.test(setCookie)) return true;
  const m = setCookie.match(/expires=([^;]+)/i);
  if (m) {
    const d = new Date(m[1]);
    if (!isNaN(d.getTime()) && d.getTime() < Date.now()) return true;
  }
  return false;
}

/** Parse the Domain= attribute of a Set-Cookie (no leading dot, lowercase). */
function cookieDomain(setCookie: string): string | null {
  const m = setCookie.match(/;\s*domain\s*=\s*([^;]+)/i);
  if (!m) return null;
  return m[1].trim().toLowerCase().replace(/^\./, "") || null;
}

/** True when `host` equals or is a subdomain of `domain`. */
function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/**
 * Absorb Set-Cookie headers from a target response.
 *
 * v2.4.1 — cookies carrying a Domain attribute (e.g. Roblox's
 * `.ROBLOSECURITY; Domain=.roblox.com`, set by auth.roblox.com but needed by
 * www/apis/games subdomains) are stored in a DOMAIN jar shared by every
 * subdomain of that domain, instead of being trapped on the origin that set
 * them. Domainless cookies keep the exact pre-2.4.1 behavior.
 */
export function storeSetCookies(
  origin: string,
  setCookies: string[],
  container: string = DEFAULT_CONTAINER
): void {
  if (!setCookies.length) return;
  let host = "";
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return;
  }
  for (const sc of setCookies) {
    const pair = sc.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!name) continue;
    const domain = cookieDomain(sc);
    let jar: Map<string, string>;
    if (domain && hostMatchesDomain(host, domain)) {
      jar = jarFor(domainJarKey(domain, container));
    } else {
      jar = originJarFor(origin, container);
    }
    if (isExpired(sc) || value === "") {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
    while (jar.size > MAX_COOKIES_PER_ORIGIN) {
      const first = jar.keys().next().value;
      if (!first) break;
      jar.delete(first);
    }
  }
}

/** Merge cookies pushed by the client document.cookie shim. */
export function mergeClientCookies(
  origin: string,
  cookies: Record<string, string>,
  container: string = DEFAULT_CONTAINER
): void {
  if (!cookies || typeof cookies !== "object") return;
  const jar = originJarFor(origin, container);
  for (const [name, value] of Object.entries(cookies)) {
    if (!name) continue;
    if (value === "") jar.delete(name);
    else jar.set(name, String(value).slice(0, 4096));
  }
}

/**
 * Build a Cookie header for a target origin (null when empty).
 *
 * v2.4.1 — merges the origin jar with every DOMAIN jar of the host's parent
 * domains (www.roblox.com picks up the roblox.com domain jar), domain cookies
 * listed first so origin-scoped values win on name collisions.
 */
export function cookieHeader(
  origin: string,
  container: string = DEFAULT_CONTAINER
): string | null {
  const parts: string[] = [];
  try {
    const host = new URL(origin).hostname.toLowerCase();
    // Walk parent domains: a.b.c.com -> b.c.com -> c.com (TLD-only keys skipped).
    const labels = host.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      const domain = labels.slice(i).join(".");
      const djar = jars.get(domainJarKey(domain, container));
      if (djar) for (const [k, v] of djar.entries()) parts.push(k + "=" + v);
    }
  } catch {
    /* not a parseable origin — origin jar only */
  }
  const jar = jars.get(jarKey(origin, container));
  if (jar) for (const [k, v] of jar.entries()) parts.push(k + "=" + v);
  return parts.length ? parts.join("; ") : null;
}

/** Snapshot of a jar (for the client shim bootstrap). */
export function snapshotCookies(
  origin: string,
  container: string = DEFAULT_CONTAINER
): Record<string, string> {
  const jar = jars.get(jarKey(origin, container));
  if (!jar) return {};
  return Object.fromEntries(jar.entries());
}

/**
 * Drop every jar of a container (incognito hygiene: called when the last
 * tab of an ephemeral container closes). Returns the number of jars removed.
 */
export function clearContainer(container: string): number {
  const c = normContainer(container);
  if (c === DEFAULT_CONTAINER) return 0; // never nuke the default jar
  let removed = 0;
  for (const key of Array.from(jars.keys())) {
    if (key.split("\n")[0] === c) {
      jars.delete(key);
      removed++;
    }
  }
  return removed;
}

/** Introspection for the debug panel: jars grouped by container. */
export function jarStats(): { container: string; origin: string; cookies: number }[] {
  const out: { container: string; origin: string; cookies: number }[] = [];
  for (const [key, jar] of jars.entries()) {
    const i = key.indexOf("\n");
    const scope = key.slice(i + 1);
    out.push({
      container: key.slice(0, i),
      origin: scope.startsWith("d:") ? "*." + scope.slice(2) : scope,
      cookies: jar.size,
    });
  }
  return out;
}
