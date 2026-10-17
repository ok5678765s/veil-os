/**
 * Quasar Rewriter
 * ---------------
 * Rewrites HTML and CSS so every embedded URL points back through the proxy.
 *
 * HTML pipeline:
 *   1. Shield <script> bodies and <style> bodies with placeholders so the tag
 *      scanner never mangles JS (this mirrors how Ultraviolet/Scramjet scan).
 *   2. Scan opening tags and rewrite URL-bearing attributes (href, src, srcset,
 *      action, poster, ...) + inline style="" attributes.
 *   3. Strip <base>, CSP metas, integrity attributes; rewrite meta refresh and
 *      force charset metas to UTF-8 (body is re-encoded server-side).
 *   4. Restore scripts untouched; re-serialize <style> bodies through the CSS
 *      rewriter.
 *   5. Inject the Quasar client-hook bundle as the very first thing in <head>.
 */

import { proxyPath } from "./codec-server";
import { HOOK_BUNDLE, quasarHeadParts } from "./hooks";
import { isDirectMediaHost } from "./site-fixes";
import type { SiteFix } from "./site-fixes";

const SKIP_SCHEME_RE = /^(data|blob|javascript|mailto|tel|about|sms|magnet|irc|file|ws|wss|view-source):/i;

const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "data",
  "background",
  "cite",
  "longdesc",
  "manifest",
  "ping",
  "icon",
  "xlink:href",
]);

const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);

/** Common lazy-loading attributes that site JS later copies onto src/srcset/href. */
const LAZY_URL_ATTRS = new Set([
  "data-src",
  "data-original",
  "data-poster",
  "data-href",
  "data-url",
  "data-background-image",
  "data-bg",
  "data-lazy",
  "data-lazy-src",
  "data-echo",
  "data-echo-src",
]);

const LAZY_SRCSET_ATTRS = new Set(["data-srcset", "data-lazy-srcset"]);

/** Minimal entity decoder for attribute values we re-process (srcdoc). */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Resolve a single URL attribute value against the real page URL, then proxy it. */
function rewriteUrlValue(value: string, baseUrl: string): string {
  const v = value.trim();
  if (!v) return value;
  if (v.startsWith("#")) return value;
  if (SKIP_SCHEME_RE.test(v)) return value;
  try {
    const abs = new URL(v, baseUrl);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return value;
    // v2.0.4 direct-media hosts stay untouched — the browser fetches them
    // itself (real TLS fingerprint / real IP, see site-fixes.ts).
    if (isDirectMediaHost(abs)) return value;
    return proxyPath(abs.href);
  } catch {
    return value;
  }
}

/** Rewrite a srcset-style attribute ("url descriptor, url descriptor"). */
function rewriteSrcsetValue(value: string, baseUrl: string): string {
  return String(value)
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";
      if (SKIP_SCHEME_RE.test(trimmed)) return trimmed;
      const segs = trimmed.split(/\s+/);
      segs[0] = rewriteUrlValue(segs[0], baseUrl);
      return segs.join(" ");
    })
    .filter((s) => s !== "")
    .join(", ");
}

/**
 * Rewrite an HLS playlist: every non-comment line is a URI (segments or nested
 * playlists) and `#EXT-X-...:URI="…"` tags carry URLs as attributes. Rewriting
 * the manifest itself keeps HLS players (hls.js, video.js, native) inside the
 * tunnel even when they bypass the service worker.
 */
export function rewriteM3u8(text: string, baseUrl: string): string {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(
          /URI\s*=\s*(.)([^'"]*)\1/gi,
          (m, quote: string, raw: string) => {
            if (quote !== '"' && quote !== "'") return m;
            const rewritten = rewriteUrlValue(raw, baseUrl);
            return rewritten === raw ? m : "URI=" + quote + rewritten + quote;
          }
        );
      }
      return rewriteUrlValue(t, baseUrl);
    })
    .join("\n");
}

/** Media file extensions that are safe to proxy when discovered in JSON payloads. */
const JSON_MEDIA_EXT_RE =
  /\.(png|jpe?g|gif|webp|avif|bmp|svgz?|ico|tiff?|mp4|m4v|webm|mov|mkv|ogg|ogv|mp3|m4a|aac|wav|flac|opus|m3u8|mpd|ts)(\?[^"\\]*)?$/i;

/**
 * Rewrite absolute http(s) media URLs embedded as JSON string values
 * (API thumbnails, cover art, video sources). Deliberately conservative —
 * only media extensions are touched, so signatures, issuer/@id fields and
 * redirect_uri-style values are never mutated.
 */
export function rewriteJsonMedia(json: string, baseUrl: string): string {
  return String(json).replace(/"(https:\/\/[^"\\\s]+)"/g, (m, u: string) => {
    if (!JSON_MEDIA_EXT_RE.test(u)) return m;
    const rewritten = rewriteUrlValue(u, baseUrl);
    return rewritten === u ? m : '"' + rewritten + '"';
  });
}

/** Quasar CSS rewriter: url(...) + @import. */
export function rewriteCss(css: string, baseUrl: string): string {
  let out = css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote: string, rawUrl: string) => {
      const u = rawUrl.trim();
      if (!u || SKIP_SCHEME_RE.test(u) || u.startsWith("#")) return match;
      const rewritten = rewriteUrlValue(u, baseUrl);
      if (rewritten === u) return match;
      return `url(${quote}${rewritten}${quote})`;
    }
  );
  out = out.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (match, quote: string, rawUrl: string) => {
      const u = rawUrl.trim();
      if (!u || SKIP_SCHEME_RE.test(u)) return match;
      const rewritten = rewriteUrlValue(u, baseUrl);
      if (rewritten === u) return match;
      return `@import ${quote}${rewritten}${quote}`;
    }
  );
  return out;
}

/** Rewrite inline style attribute bodies. */
function rewriteInlineStyle(value: string, baseUrl: string): string {
  try {
    return rewriteCss(value, baseUrl);
  } catch {
    return value;
  }
}

interface TagContext {
  isMetaRefresh: boolean;
}

/**
 * Rewrite the attribute blob of one opening tag.
 * Returns the new attributes string. Exported for the streaming rewriter.
 */
export function rewriteAttrs(tagLower: string, attrs: string, baseUrl: string): string {
  const ctx: TagContext = {
    isMetaRefresh:
      tagLower === "meta" && /http-equiv\s*=\s*("refresh"|'refresh'|refresh)/i.test(attrs),
  };

  return attrs.replace(
    /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)\s*(=\s*("[^"]*"|'[^']*'|[^\s"'=>]+))?/g,
    (full, name: string, _eqAndVal?: string) => {
      const lower = name.toLowerCase();
      const m = full.match(/=\s*("[^"]*"|'[^']*'|[^\s"'=>]+)/);
      if (!m) return full; // boolean attribute, leave as-is
      const raw = m[1];
      const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : "";
      const value = quote ? raw.slice(1, -1) : raw;

      // Strip subresource integrity — resources are re-served by the proxy.
      if (lower === "integrity") return "";

      // Charset metas: everything is re-encoded as UTF-8 server-side.
      if (tagLower === "meta" && (lower === "charset" || (lower === "content" && /;\s*charset=/i.test(value)))) {
        if (lower === "charset") return `charset="UTF-8"`;
        return `content=${quote}${value.replace(/charset\s*=\s*[^;"'\s]+/i, "charset=UTF-8")}${quote}`;
      }

      // Meta refresh: content="5; url=https://target/..."
      if (ctx.isMetaRefresh && lower === "content") {
        const rewritten = value.replace(
          /(url\s*=\s*)(.+)$/i,
          (_mm, p1: string, p2: string) => p1 + rewriteUrlValue(p2.trim().replace(/^['"]|['"]$/g, ""), baseUrl)
        );
        return `${name}=${quote}${rewritten}${quote}`;
      }

      if (lower === "style") {
        return `${name}=${quote}${rewriteInlineStyle(value, baseUrl)}${quote}`;
      }

      if (URL_ATTRS.has(lower)) {
        return `${name}=${quote}${rewriteUrlValue(value, baseUrl)}${quote}`;
      }
      if (SRCSET_ATTRS.has(lower)) {
        return `${name}=${quote}${rewriteSrcsetValue(value, baseUrl)}${quote}`;
      }
      if (LAZY_URL_ATTRS.has(lower)) {
        return `${name}=${quote}${rewriteUrlValue(value, baseUrl)}${quote}`;
      }
      if (LAZY_SRCSET_ATTRS.has(lower)) {
        return `${name}=${quote}${rewriteSrcsetValue(value, baseUrl)}${quote}`;
      }
      if (lower === "srcdoc") {
        try {
          const rewritten = rewriteHtml(decodeEntities(value), baseUrl);
          // Re-serialize as a double-quoted attribute; & and " are the only
          // characters that must stay escaped inside it.
          return `${name}="${rewritten.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
        } catch {
          return full;
        }
      }
      return full;
    }
  );
}

const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const SCRIPT_RE = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;
const STYLE_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;

/* ------------------------------------------------------------------ */
/* v2.4.1 — inline framebuster neutralization                          */
/* ------------------------------------------------------------------ */

const TOP_LOCATION_RE = /\b(?:window\.)?top\.location\b/g;
const PARENT_LOCATION_RE = /\b(?:window\.)?parent\.location\b/g;
const FRAME_CMP_RE =
  /\b(?:window\.)?(?:top|parent|self)\s*(?:!==?|===?)\s*(?:window\.)?(?:top|parent|self)\b/g;

/**
 * v2.4.1 — defuse classic framebusting inline scripts.
 *
 * Sites like Roblox ship `if (top.location != self.location) { top.location =
 * self.location.href; }`. Inside the app's managed iframe that hijacks the
 * whole UI (and cascades into escapes to the real target). Both pipeline
 * rewriters pipe every inline <script> body through this before serving it:
 *
 *   top.location     → self.location   (reads AND assignments become no-ops)
 *   parent.location  → self.location
 *   X <cmp> Y (top/parent/self) → literal true/false so buster branches die
 *
 * Sites legitimately addressing their own frames lose that ability under the
 * proxy — the accepted trade-off (same one Ultraviolet/Scramjet make).
 */
export function neutralizeInlineScript(js: string): string {
  if (!js || js.length > 2 * 1024 * 1024) return js;
  let out = js.replace(TOP_LOCATION_RE, "self.location");
  out = out.replace(PARENT_LOCATION_RE, "self.location");
  out = out.replace(FRAME_CMP_RE, (m) => {
    const ids: string[] = m.match(/top|parent|self/g) ?? [];
    if (ids.length === 2 && ids[0] === ids[1]) return "true";
    return ids.indexOf("top") !== -1 || ids.indexOf("parent") !== -1 ? "false" : m;
  });
  return out;
}

export interface RewriteHtmlOptions {
  /** Site fix whose client hooks should be announced to the bundle. */
  site?: SiteFix | null;
  /** Prebuilt injection block (data + hooks scripts). Defaults to the standard bundle. */
  injection?: string;
}

/** Rewrite a full HTML document for proxying (buffered pipeline). */
export function rewriteHtml(html: string, baseUrl: string, opts: RewriteHtmlOptions = {}): string {
  // 1. Shield script + style bodies.
  const scripts: string[] = [];
  const styles: string[] = [];
  let out = html.replace(SCRIPT_RE, (_m, open: string, body: string, close: string) => {
    scripts.push(body);
    return open + `\u0000QSR${scripts.length - 1}\u0000` + close;
  });
  out = out.replace(STYLE_RE, (_m, open: string, body: string, close: string) => {
    styles.push(body);
    return open + `\u0000QSC${styles.length - 1}\u0000` + close;
  });

  // 2. Scan opening tags.
  out = out.replace(OPEN_TAG_RE, (match, tag: string, attrs: string, selfClose: string) => {
    const t = tag.toLowerCase();
    if (t === "!doctype") return match;
    // <base> would misdirect relative resolution — the rewriter handles everything.
    if (t === "base") return "";
    // Drop CSP / X-XSS-Protection / sandbox metas: the proxy re-serves every
    // subresource from the app origin, so injected policies can only break pages.
    if (
      t === "meta" &&
      /http-equiv\s*=\s*("[^"]*"|'[^']*'|[\w-]+)/i.test(attrs) &&
      /http-equiv\s*=\s*["']?\s*(content-security-policy|x-xss-protection)/i.test(attrs)
    ) {
      return "";
    }
    const newAttrs = rewriteAttrs(t, attrs, baseUrl);
    return `<${tag}${newAttrs}${selfClose}>`;
  });

  // 3. Restore styles through the CSS rewriter.
  out = out.replace(/\u0000QSC(\d+)\u0000/g, (_m, idx: string) => {
    const body = styles[Number(idx)] ?? "";
    try {
      return rewriteCss(body, baseUrl);
    } catch {
      return body;
    }
  });

  // 4. Restore scripts — inline framebusters neutralized (v2.4.1), otherwise untouched.
  out = out.replace(/\u0000QSR(\d+)\u0000/g, (_m, idx: string) => {
    const body = scripts[Number(idx)] ?? "";
    try {
      return neutralizeInlineScript(body);
    } catch {
      return body;
    }
  });

  // 5. Inject the data blob + hook bundle as the first element inside <head>.
  const hookTag = opts.injection ?? buildStandardInjection(baseUrl, opts.site ?? null);
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${hookTag}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html[^>]*>/i, (m) => `${m}<head>${hookTag}</head>`);
  } else {
    out = hookTag + out;
  }
  return out;
}

/** Standard injection block: page data + site config + hook bundle. */
function buildStandardInjection(baseUrl: string, site: SiteFix | null): string {
  const { pageDataTag, siteConfigTag } = quasarHeadParts(baseUrl, site);
  return pageDataTag + siteConfigTag + `<script data-quasar="engine">${HOOK_BUNDLE}</script>`;
}
