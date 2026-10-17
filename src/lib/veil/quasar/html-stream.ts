/**
 * Quasar Streaming HTML Rewriter
 * ------------------------------
 * Rewrites HTML in-flight as a TransformStream: the first byte of the page
 * reaches the browser while the rest is still being fetched. This is what
 * Ultraviolet cannot do (it buffers whole documents) and it makes big pages
 * and slow origins feel instant.
 *
 * Design:
 *   - Byte chunks are decoded incrementally (TextDecoder stream mode) with
 *     the declared charset, then re-encoded as UTF-8 (the response header is
 *     adjusted to match).
 *   - A quote-aware scanner emits complete tags only; <script> and <style>
 *     raw-text sections are consumed verbatim (script bodies pass through —
 *     runtime hooks + the AST rewriter for external JS cover them) while
 *     <style> bodies are CSS-rewritten at their closing tag.
 *   - The injection block (__QUASAR_DATA__ + site config + hook bundle) is
 *     placed right after the first <head>/<body> tag — before any page
 *     script can run — with an end-of-stream fallback for headless documents.
 *   - Fail-open: any scanner error emits the pending text untouched, so a
 *     rewriting bug can never lose content.
 */

import { neutralizeInlineScript, rewriteAttrs, rewriteCss } from "./rewriter";

const TAG_CAP = 1024 * 1024; // a single tag larger than this (e.g. huge data URIs) passes raw
const STYLE_CAP = 512 * 1024; // style bodies above this pass raw
const SCRIPT_TAIL_KEEP = 32; // chars held back in script mode to catch split closing tags
const INLINE_SCRIPT_CAP = 64 * 1024; // inline bodies buffered up to here (framebuster pass)

/** Parse the tag name out of a complete opening tag string. */
function tagNameOf(tag: string): string {
  const m = tag.match(/^<\s*([a-zA-Z][a-zA-Z0-9:.-]*)/);
  return m ? m[1].toLowerCase() : "";
}

/** Split `<name attrs /?>` into its pieces for rewriteAttrs. */
function rewriteTag(tag: string, baseUrl: string): string {
  const m = tag.match(/^<([a-zA-Z][a-zA-Z0-9:.-]*)([\s\S]*?)(\/?)>$/);
  if (!m) return tag;
  const name = m[1];
  const lower = name.toLowerCase();
  const attrs = m[2];
  const selfClose = m[3];
  try {
    return `<${name}${rewriteAttrs(lower, attrs, baseUrl)}${selfClose}>`;
  } catch {
    return tag;
  }
}

/** Tags whose opening tag is dropped entirely (mirrors the buffered pipeline). */
function isDroppedTag(lower: string, attrs: string): boolean {
  if (lower === "base") return true;
  if (
    lower === "meta" &&
    /http-equiv\s*=\s*["']?\s*(content-security-policy|x-xss-protection)/i.test(attrs)
  )
    return true;
  return false;
}

/**
 * Case-insensitive search for a raw-text closing tag (`</script`, `</style`)
 * requiring the following char to be whitespace, `/` or `>` (HTML spec).
 */
function findClosingTag(buf: string, name: string): number {
  const needle = "</" + name;
  const n = needle.length;
  outer: for (let i = 0; i <= buf.length - n; i++) {
    if (buf.charCodeAt(i) !== 60 /* < */) continue;
    for (let j = 1; j < n; j++) {
      if ((buf.charCodeAt(i + j) | 32) !== (needle.charCodeAt(j) | 32)) continue outer;
    }
    const after = buf.charCodeAt(i + n);
    if (after === 62 /* > */ || after === 47 /* / */ || after === 32 || after === 9 || after === 10 || after === 13)
      return i;
  }
  return -1;
}

/** Find the first `>` outside quoted attribute values, starting at `from`. */
function findTagEnd(buf: string, from: number): number {
  let quote = 0; // 0 none, 34 double, 39 single
  for (let i = from; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62 /* > */) {
      return i;
    }
  }
  return -1;
}

export interface HtmlStreamOptions {
  /** Declared charset of the upstream document (header-based). */
  charset?: string;
  /** Prebuilt injection block (data + site config + hooks). */
  injection: string;
}

/**
 * Create the streaming rewriter. Throws synchronously only when the charset
 * is unknown (callers fall back to the buffered pipeline then).
 */
export function createHtmlStream(
  baseUrl: string,
  options: HtmlStreamOptions
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder(options.charset || "utf-8");

  let buf = "";
  let mode: "html" | "script" | "style" | "comment" = "html";
  let injected = false;
  let scriptInline = false; // current <script> has no src= (body executes in-document)
  let scriptHold = ""; // buffered body of the current inline script

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (text) controller.enqueue(encoder.encode(text));
  };

  function processBuf(controller: TransformStreamDefaultController<Uint8Array>): void {
    for (;;) {
      if (mode === "comment") {
        const end = buf.indexOf("-->");
        if (end === -1) {
          emit(controller, buf);
          buf = "";
          return;
        }
        emit(controller, buf.slice(0, end + 3));
        buf = buf.slice(end + 3);
        mode = "html";
        continue;
      }

      if (mode === "script") {
        const close = findClosingTag(buf, "script");
        if (close === -1) {
          if (scriptInline) {
            if (scriptHold.length + buf.length > INLINE_SCRIPT_CAP) {
              // Fail-open: oversized inline body — flush raw and stream the rest.
              emit(controller, scriptHold + buf);
              scriptHold = "";
              scriptInline = false;
              buf = "";
            } else {
              scriptHold += buf;
              buf = "";
            }
          } else if (buf.length > SCRIPT_TAIL_KEEP) {
            emit(controller, buf.slice(0, buf.length - SCRIPT_TAIL_KEEP));
            buf = buf.slice(-SCRIPT_TAIL_KEEP);
          }
          return;
        }
        if (scriptInline) {
          const body = scriptHold + buf.slice(0, close);
          try {
            emit(controller, neutralizeInlineScript(body));
          } catch {
            emit(controller, body);
          }
          scriptHold = "";
        } else {
          emit(controller, buf.slice(0, close));
        }
        buf = buf.slice(close);
        scriptInline = false;
        mode = "html";
        continue;
      }

      if (mode === "style") {
        const close = findClosingTag(buf, "style");
        if (close === -1) {
          if (buf.length > STYLE_CAP) {
            // Fail-open: too big to hold — emit raw.
            emit(controller, buf);
            buf = "";
            mode = "html";
          }
          return;
        }
        const body = buf.slice(0, close);
        try {
          emit(controller, rewriteCss(body, baseUrl));
        } catch {
          emit(controller, body);
        }
        buf = buf.slice(close);
        mode = "html";
        continue;
      }

      // ---- html mode ----
      const lt = buf.indexOf("<");
      if (lt === -1) {
        emit(controller, buf);
        buf = "";
        return;
      }
      if (lt > 0) {
        emit(controller, buf.slice(0, lt));
        buf = buf.slice(lt);
      }

      if (buf.startsWith("<!--")) {
        mode = "comment";
        continue;
      }
      if (buf.startsWith("<!") || buf.startsWith("<?")) {
        // doctype / CDATA / processing instruction — emit complete or wait
        const gt = findTagEnd(buf, 2);
        if (gt === -1) {
          if (buf.length > TAG_CAP) {
            emit(controller, buf);
            buf = "";
          }
          return;
        }
        emit(controller, buf.slice(0, gt + 1));
        buf = buf.slice(gt + 1);
        continue;
      }
      if (buf.startsWith("</")) {
        const gt = findTagEnd(buf, 2);
        if (gt === -1) {
          if (buf.length > TAG_CAP) {
            emit(controller, buf);
            buf = "";
          }
          return;
        }
        emit(controller, buf.slice(0, gt + 1));
        buf = buf.slice(gt + 1);
        continue;
      }

      // Opening tag — wait for a complete tag (respecting quotes).
      const gt = findTagEnd(buf, 1);
      if (gt === -1) {
        if (buf.length > TAG_CAP) {
          emit(controller, buf);
          buf = "";
        }
        return;
      }
      const tag = buf.slice(0, gt + 1);
      buf = buf.slice(gt + 1);

      const lower = tagNameOf(tag);
      const drop = isDroppedTag(lower, tag);
      if (!drop) {
        emit(controller, rewriteTag(tag, baseUrl));
      }

      if (!injected && (lower === "head" || lower === "body")) {
        emit(controller, options.injection);
        injected = true;
      }

      if (!drop && (lower === "script" || lower === "style")) {
        mode = lower;
        if (lower === "script") scriptInline = !/\bsrc\s*=/i.test(tag);
      }
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let text: string;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch {
        text = decoder.decode(chunk); // replace invalid sequences
      }
      buf += text;
      try {
        processBuf(controller);
      } catch (err) {
        // Fail-open: never lose the stream because of a rewriting bug.
        console.error("[quasar] html stream rewrite error", err);
        try {
          emit(controller, buf);
        } catch {
          /* ignore */
        }
        buf = "";
        mode = "html";
      }
    },
    flush(controller) {
      try {
        if (!injected) emit(controller, options.injection);
        if (scriptHold) emit(controller, scriptHold);
        emit(controller, buf);
      } catch {
        /* ignore */
      }
      buf = "";
      scriptHold = "";
      mode = "html";
    },
  });
}
