"use client";

/**
 * Veil — Scramjet engine manager for the MAIN page (cherrion.top architecture).
 *
 * cherrion.top runs ONE Scramjet controller inside its app document and hands
 * each tab an iframe via `controller.createFrame(el, { plugins })`. Veil now
 * does the same: instead of a boot page per tab (whose controller died on
 * every tab switch, leaving stale registrations in the service worker), the
 * Veil app itself lazily boots a single long-lived controller the first time
 * a Scramjet tab opens, and every tab's content frame belongs to it:
 *
 *   - tab switching never orphans controllers (the app owns the only one),
 *   - frames are dispatched by their per-frame URL prefix, so any number of
 *     tabs coexist safely,
 *   - the controller's guardServiceWorkerRevive machinery re-attaches to the
 *     service worker whenever the worker idles out and restarts,
 *   - the wisp tunnel + wasm are loaded once per app session, not per tab.
 *
 * The standalone boot page (/eng/sj/boot, prefix /eng/sj/~b/) remains as the
 * popup/fallback lane and can never collide with this controller.
 */

/* Shape of the controller/frame objects from @mercuryworkshop/scramjet
 * (2.0.67-alpha.2 — the exact build cherrion.top ships). */
export interface SjFrame {
  id: string;
  prefix: string;
  element: HTMLIFrameElement;
  go(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
}

export interface SjEngine {
  controller: {
    createFrame(element: HTMLIFrameElement, options?: { plugins?: unknown[] }): SjFrame;
    frames: SjFrame[];
    ready: Promise<void>;
  };
  createFrame(element: HTMLIFrameElement, plugins: unknown[], target: string): Promise<SjFrame>;
  destroyFrame(frame: SjFrame): void;
}

interface SjGlobals {
  $scramjetController?: {
    Controller: new (opts: {
      serviceworker: ServiceWorker | null;
      transport: unknown;
      config: {
        prefix: string;
        scramjetPath: string;
        injectPath: string;
        wasmPath: string;
      };
    }) => SjEngine["controller"];
  };
  LibcurlTransport?: {
    LibcurlClient: new (opts: { wisp: string }) => unknown;
  };
  VeilSjPlugins?: {
    EventHandlerPlugin: new (opts?: unknown) => unknown;
    HttpCachePlugin: new (opts?: { cacheName?: string }) => unknown;
    UrlWatcherPlugin: new (cb: (url: string) => void, opts?: unknown) => unknown;
    LinkHandlerPlugin: new (cb: (href: string) => void, opts?: unknown) => unknown;
    VeilShellPlugin: new (handlers: {
      onMouseNearTop?: (y: number) => void;
      onEscape?: () => void;
      onTitle?: (title: string) => void;
    }) => unknown;
  };
}

const SCRIPTS = [
  "/eng/sj/scramjet/scramjet.js",
  "/eng/sj/controller/controller.api.js",
  "/eng/sj/libcurl/index.js",
  "/eng/sj/veil-plugins.js",
] as const;

const loadedScripts = new Set<string>();

function loadScript(src: string): Promise<void> {
  if (loadedScripts.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => {
      loadedScripts.add(src);
      resolve();
    };
    s.onerror = () => reject(new Error(`engine asset failed to load: ${src}`));
    document.head.appendChild(s);
  });
}

/* ---- wisp transport probe ------------------------------------------
   Candidate 1 (gateway): ws(s)://<this host>/?XTransformPort=3312 — works
   whenever the app is served through the sandbox gateway. When the app is
   opened directly (localhost:3000) that URL hits the Next server, which
   answers HTML — the probe body is the discriminator.
   Candidate 2 (direct): ws://localhost:3312/ — same-machine access. */
function probeWisp(): Promise<string> {
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const cands: string[] = [`${wsProto}//${location.host}/?XTransformPort=3312`];
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    cands.push(`ws://${host}:3312/`);
  }
  let i = 0;
  function tryNext(): Promise<string> {
    if (i >= cands.length) return Promise.resolve(cands[0]);
    const c = cands[i++];
    const probeUrl = c.replace(/^ws/, "http");
    return fetch(probeUrl, { cache: "no-store" })
      .then((r) => r.text().then((t) => ({ ok: r.ok, body: t })))
      .then((res) => (res.ok && res.body.includes("wisp-server-alive") ? c : tryNext()))
      .catch(() => tryNext());
  }
  return tryNext();
}

/* Resolve an active service worker for the engine scope — waiting out the
 * installing one (mirrors the boot page's statechange dance). */
function activeWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  const controlled = navigator.serviceWorker.controller;
  if (controlled) return Promise.resolve(controlled);
  if (reg.active) return Promise.resolve(reg.active);
  const installing = reg.installing || reg.waiting;
  if (!installing) return Promise.reject(new Error("no engine worker became available"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("engine worker activation timed out")), 20000);
    installing.addEventListener("statechange", function onState() {
      if (installing.state === "activated") {
        installing.removeEventListener("statechange", onState);
        clearTimeout(timer);
        resolve(navigator.serviceWorker.controller || installing);
      }
    });
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      function once() {
        navigator.serviceWorker.removeEventListener("controllerchange", once);
        const c = navigator.serviceWorker.controller;
        if (c) {
          clearTimeout(timer);
          resolve(c);
        }
      },
      { once: true },
    );
  });
}

let enginePromise: Promise<SjEngine> | null = null;

/** Boot (once) and return the app's single Scramjet engine. */
export function ensureSjEngine(): Promise<SjEngine> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    for (const src of SCRIPTS) await loadScript(src);
    const g = window as unknown as SjGlobals;
    if (!g.$scramjetController || !g.LibcurlTransport) {
      throw new Error("the Scramjet engine assets did not initialize");
    }

    const reg = await navigator.serviceWorker.register("/api/eng/sj/sw", { scope: "/eng/sj/" });
    const sw = await activeWorker(reg);

    const wispUrl = await probeWisp();
    const transport = new g.LibcurlTransport.LibcurlClient({ wisp: wispUrl });

    const controller = new g.$scramjetController.Controller({
      serviceworker: sw,
      transport,
      config: {
        prefix: "/eng/sj/~/",
        scramjetPath: "/eng/sj/scramjet/scramjet.js",
        injectPath: "/eng/sj/controller/controller.inject.js",
        wasmPath: "/eng/sj/scramjet/scramjet.wasm",
      },
    });
    await controller.ready;

    return {
      controller,
      createFrame: async (element, plugins, target) => {
        const frame = controller.createFrame(element, { plugins });
        frame.go(target);
        return frame;
      },
      destroyFrame: (frame) => {
        /* detach the element immediately (the tab is switching away), but
         * keep the frame registered for a short grace so in-flight requests
         * routed to its prefix still resolve instead of erroring out of the
         * worker ("No frame found for request"). */
        try {
          frame.element.src = "about:blank";
        } catch {
          /* element already unmounted */
        }
        setTimeout(() => {
          const i = controller.frames.indexOf(frame);
          if (i !== -1) controller.frames.splice(i, 1);
        }, 5000);
      },
    };
  })();
  /* a failed boot may be transient (wisp hiccup) — allow a retry */
  enginePromise.catch(() => {
    enginePromise = null;
  });
  return enginePromise;
}

/** Fallback lane: the standalone boot page (popups, engine-boot failures). */
export function sjBootUrl(target: string): string {
  return `/eng/sj/boot?target=${encodeURIComponent(target)}`;
}
