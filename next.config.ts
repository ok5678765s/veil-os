import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Quasar v2.1.0: the proxy engine imports undici/acorn directly from
  // route handlers. They must stay external (never bundled) — the raw
  // undici fetch bypasses Next's dev fetch instrumentation (which corrupts
  // large streamed bodies), and bundling it would reintroduce that wrapper.
  // bgutils-js + jsdom power the server-side YouTube poToken module;
  // playwright-core/playwright are OPTIONAL peers for the real-browser
  // poToken farm (QUASAR_POTOKEN_BROWSER=1) — externalizing keeps the
  // dynamic import a runtime require that fails gracefully when absent.
  serverExternalPackages: [
    "undici",
    "acorn",
    "acorn-walk",
    "bgutils-js",
    "jsdom",
    "playwright-core",
    "playwright",
  ],
  // Hide the floating Next.js dev-tools badge (the little circular "N"
  // pinned bottom-left in dev mode) — it reads as part of the site and
  // there is nothing to debug from the preview panel.
  devIndicators: false,
  // Critical for Veil: the route path scheme embeds the target site path
  // inside our own URL path (`/api/p/https/example.com/dir/`), so Next must
  // never "normalise" trailing slashes on those requests.
  skipTrailingSlashRedirect: true,
  // Serverless deploys (Vercel import of the GitHub repo) boot the DB from
  // files that are only read at RUNTIME, so file tracing can't see them —
  // list them explicitly or /api/* cold-boots without them and 500s:
  //   db/seed.db               — sanitized schema-only SQLite (0 rows)
  //   backups/chat/latest.json — committed backup the boot restore imports
  outputFileTracingIncludes: {
    "/api/**": ["./db/seed.db", "./backups/chat/latest.json"],
  },
  // 4GB-box survival kit (2026-09-10 OOM forensics): the dev cold-compile
  // peaks at next-server ~2.7GB + postcss ~0.6GB + base ~0.4GB = right at
  // the memory ceiling — the kernel OOM-killed every dev boot in a loop
  // (55+ kills). Two levers:
  //  - turbopackMemoryLimit: turbopack self-limits its native (Rust)
  //    structures at 2GB and fails/retries GRACEFULLY instead of letting
  //    the kernel kill the whole server mid-compile.
  //  - turbopackFileSystemCacheForDev: the compile state PERSISTS across
  //    dev restarts, so a restart resumes warm instead of paying the full
  //    cold-compile roulette every single boot.
  experimental: {
    turbopackMemoryLimit: 2 * 1024 * 1024 * 1024,
    turbopackFileSystemCacheForDev: true,
    // 2026-10-07 "can't log into chat" round: the webpack dev plateau sat at
    // ~1.95GB RSS — 100MB under the watchdog's 2.05GB line — so any compile
    // spike (QA sweep, multiple cold routes) tripped a forced restart, and
    // every restart window (15-60s of cold compiles) is exactly when logins
    // time out from the user's perspective. This flag switches webpack to
    // its memory-efficient cache/snapshot mode and shaves a few hundred MB
    // off the plateau, widening the headroom to survive compile bursts.
    webpackMemoryOptimizations: true,
  },
  // Dev-only: the sandbox preview panel serves this app on a per-session
  // subdomain (preview-chat-*.space-z.ai). Without this list Next 16 flags
  // every /_next/* request from that origin as cross-origin, which breaks
  // HMR delivery (edits take a long time to show up) and logs the
  // "Cross origin request detected" warning on every hit. The wildcard
  // covers future session subdomains.
  allowedDevOrigins: [
    "preview-chat-21def763-0ff2-4765-af1a-037e9d7be4ba.space-z.ai",
    "*.space-z.ai",
    "localhost",
    // 127.0.0.1 must be listed too: hitting the dev server through the
    // gateway as http://127.0.0.1:81 otherwise counts as a cross-origin
    // /_next/* request — Next blocks the HMR socket from that origin and
    // the page falls into a ~10s full-reload loop (observed 2026-09-22;
    // every "arcade closes by itself" during QA was this, not the site).
    "127.0.0.1",
  ],
  // Dev watcher discipline (2026-09-11 "stuck at 6.8 KB" forensics): the
  // backup daemon writes 4MB tarballs into backups/ + upload/ every 5
  // minutes, prisma churns db/*.db on every site visit, dev.log streams on
  // every request, and mini-services recompile on their own hot loop —
  // all inside this watched tree. Every one of those writes fired a Fast
  // Refresh / full page reload that killed in-flight AI builds and wiped
  // section state (the user saw the extension generator "die" mid-build).
  // Next 16 removed top-level watchOptions.ignored, so the exclusion is
  // applied to webpack's own watch config in the webpack hook below.
  webpack: (config, { dev }) => {
    if (dev) {
      // webpack's watchOptions.ignored schema accepts a bare RegExp or an
      // array of glob STRINGS — mixing them (or an array with RegExps)
      // fails validation and aborts the dev boot. One merged regex covers
      // Next's defaults (node_modules/.git/.next) plus every daemon-writer
      // directory (backups, upload, download, db, mini-services, scripts,
      // dev.log) AND the QA/screenshot dirs (tmp/, tool-results/) —
      // browser-tooling PNG drops there were firing Fast Refresh reloads
      // that closed the user's open sections mid-session (2026-10-02).
      //
      // 2026-10-17 "restarts to home screen every minute" postmortem: the
      // quasar engine's AST cache flushed to <root>/.quasar-cache/ every
      // 90s while anyone browsed — NOT in this list, so every flush
      // recompiled every route and Fast-Refresh-reloaded ALL viewers.
      // Fixes: (a) the cache now lives OUTSIDE the tree (fetcher.ts),
      // (b) the ignore list below now also covers .quasar-cache/,
      // .quasar-key, and EVERY *.log (dev-watchdog.log never matched the
      // old dev\.log$ pattern — its 5-minute writes were a quieter
      // reload trigger of the same class).
      config.watchOptions = {
        ...config.watchOptions,
        ignored:
          /(^|[\\/])(node_modules|backups|upload|download|db|mini-services|scripts|tmp|tool-results|tests|site|site-fixes\.d)([\\/]|$)|(^|[\\/])\.[^\\/]+([\\/]|$)|\.log$/,
      };
      // NOTE: do NOT set config.devtool here — Next 16 detects it, reverts
      // to 'false' and warns on every boot ("improper-devtool"). Its own
      // revert already skips source-map generation (the memory win).
    }
    return config;
  },
  async redirects() {
    return [];
  },
};

export default nextConfig;
