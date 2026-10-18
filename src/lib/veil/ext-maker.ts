/**
 * Veil — AI Extension Maker: shared package builder.
 *
 * Veil AI (Extension Maker mode) returns a single self-contained HTML app.
 * This module wraps that app into a full VEIL-EXT package — the exact
 * format the offline file (veil-offline.html) installs via drag-drop /
 * Extensions upload: a landing page whose first body child is the
 * manifest script, followed by base64 `<script type="text/veil-asset">`
 * blocks (key `app:ai-*`, category "ai" → the offline Arcade's AI Lab tab).
 */

export interface AiExt {
  name: string;
  desc: string;
  icon: string;
  html: string;
}

/* Safe base64 for any unicode string (TextEncoder → binary string → btoa). */
export function b64encodeText(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c
  );
}

function extId(): string {
  return "ai-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Build the installable VEIL-EXT package text for an AI-made app.
 * `kb` is returned alongside so callers can show the true package size.
 */
export function buildExtPackage(ext: AiExt): { text: string; id: string; kb: number } {
  const id = extId();
  const key = `app:${id}`;
  const b64 = b64encodeText(ext.html);
  const kb = Math.round(ext.html.length / 1024);
  const manifest = {
    sig: "VEIL-EXT",
    v: 1,
    id,
    name: ext.name || "AI Extension",
    desc: ext.desc || "Made by Veil AI",
    assets: [key],
    appList: [
      {
        key,
        name: ext.name || "AI Extension",
        desc: ext.desc || "Made by Veil AI",
        icon: ext.icon || "spark",
        cat: "ai",
        kb,
      },
    ],
    bytes: ext.html.length,
    games: 0,
    apps: 1,
    built: new Date().toISOString().slice(0, 10),
  };
  const title = esc(ext.name || "AI Extension");
  const text = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veil Extension — ${title}</title>
<meta name="description" content="An AI-made Veil extension — ${esc(ext.desc || "built by Veil AI")}.">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background-color: #0a0907; color: #e4e4e7; padding: 24px;
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; }
main { width: 100%; max-width: 480px; padding: 28px; background: #131316;
  border: 1px solid rgba(139,92,246,.35); border-radius: 18px; box-shadow: 0 30px 80px rgba(0,0,0,.55); }
header { display: flex; align-items: center; gap: 9px; margin-bottom: 18px; }
header .k { font-size: 10.5px; font-weight: 700; letter-spacing: .22em; color: #a78bfa; }
h1 { font-size: 22px; font-weight: 700; color: #fafafa; letter-spacing: -.01em; }
h1 span { color: #a78bfa; }
.stats { margin: 6px 0 18px; font-size: 12.5px; color: #a1a1aa; }
.how { border: 1px dashed rgba(139,92,246,.45); border-radius: 12px; padding: 14px 16px;
  background: rgba(139,92,246,.06); }
.how b { display: block; font-size: 12px; color: #c4b5fd; margin-bottom: 6px; }
.how p { font-size: 12.5px; line-height: 1.55; color: #a1a1aa; }
.sig { margin-top: 14px; font-size: 10.5px; color: #52525b; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<script type="text/veil-ext-manifest" id="veilExtManifest">${JSON.stringify(manifest)}</script>
<main>
  <header><svg viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M12 22s8-3.6 8-10V5.5L12 2 4 5.5V12c0 6.4 8 10 8 10Z"/></svg><span class="k">VEIL EXTENSION · AI MADE</span></header>
  <h1>${title}<span>.</span></h1>
  <p class="stats">${esc(ext.desc || "Made by Veil AI")} · ${kb} KB · made by Veil AI</p>
  <div class="how">
    <b>HOW TO INSTALL</b>
    <p>Open <b>veil-offline.html</b> and hit <b>Extensions</b> on the dock (next to Settings) — pick this file. Or just drag it onto the page. The app lands under <b>Arcade → AI Lab</b> and runs with zero connection.</p>
  </div>
  <p class="sig">VEIL-EXT v1 · pack ${id} · built ${manifest.built} · by Veil AI</p>
</main>
<script type="text/veil-asset" id="veilA:${key}" data-mime="text/html">${b64}</script>
</body>
</html>
`;
  return { text, id, kb };
}

/** Trigger a browser download of the package as a .html file. */
export function downloadExtPackage(ext: AiExt): string {
  const { text, id } = buildExtPackage(ext);
  const blob = new Blob([text], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `veil-ext-${id}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return id;
}

/**
 * Client-side fallback parser (used when the server did not pre-extract
 * the extension — e.g. the origin-less pollinations path in the offline
 * file). Mirrors the server's parseExtReply.
 *
 * Handles BOTH shapes: the documented fenced code block, AND the
 * fence-less reply some model turns produce — the raw page straight
 * after an intro line (anchored on the veil-ext metadata comment or
 * the doctype) so a missing ``` never costs the install card.
 */
export function parseExtReply(reply: string): AiExt | null {
  const src = String(reply || "");
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/.exec(src);
  /* Only a block that actually looks like an HTML page counts as an app —
   * the AI Coder also answers plain code questions (```python, ```js, ...)
   * whose blocks must stay chat code, never become a broken "app" card. */
  const looksHtml = (s: string) =>
    /<!doctype html|<html[\s>]|<body[\s>]|<!--\s*veil-ext/i.test(s);
  let html = fence && looksHtml(fence[1]) ? fence[1].trim() : "";

  if (html.length < 400) {
    /* fence-less: anchor on the metadata comment, else the LAST doctype
       (an intro sentence may precede either) and cut to </html> */
    let start = -1;
    const metaAll = /<!--\s*veil-ext\s*\{[\s\S]*?\}\s*-->/.exec(src);
    if (metaAll) start = metaAll.index;
    if (start === -1) start = src.toLowerCase().lastIndexOf("<!doctype html");
    if (start !== -1) {
      const end = src.toLowerCase().lastIndexOf("</html>");
      if (end !== -1 && end > start) {
        let cut = src.slice(start, end + 7).trim();
        const docIn = cut.toLowerCase().indexOf("<!doctype html");
        if (docIn > 0) cut = cut.slice(docIn).trim();
        if (cut.length >= 400) html = cut;
      }
    }
  }
  if (html.length < 400) return null;

  let name = "";
  let desc = "";
  let icon = "spark";
  const meta = /<!--\s*veil-ext\s*(\{[\s\S]*?\})\s*-->/.exec(html) || /<!--\s*veil-ext\s*(\{[\s\S]*?\})\s*-->/.exec(src);
  if (meta) {
    try {
      const j = JSON.parse(meta[1]) as { name?: string; desc?: string; icon?: string };
      if (typeof j.name === "string") name = j.name.trim().slice(0, 40);
      if (typeof j.desc === "string") desc = j.desc.trim().slice(0, 140);
      if (typeof j.icon === "string" && /^[a-z0-9]+$/i.test(j.icon)) icon = j.icon.toLowerCase();
    } catch {
      /* fall through */
    }
  }
  const title = /<title>([^<]{1,80})<\/title>/i.exec(html);
  if (!name && title) name = title[1].trim().slice(0, 40);
  if (!name) name = "AI Extension";
  if (!desc) {
    const md = /<meta\s+name=["']description["']\s+content=["']([^"']{1,200})["']/i.exec(html);
    desc = md ? md[1].trim().slice(0, 140) : "Made by Veil AI";
  }
  html = html.replace(/<!--\s*veil-ext\s*\{[\s\S]*?\}\s*-->/, "").trim();
  return { name, desc, icon, html };
}

/** Remove the built app's code from the chat prose (fenced or raw) so the
 *  ExtCard is the single place it's shown.
 *
 *  Page-shaped replies (veil-ext comment or doctype present) are cut at
 *  the FIRST page anchor — the model sometimes writes stray triple-
 *  backticks INSIDE the app's own code (markdown editors literally
 *  process them), which defeats pair-fenced stripping and dumps raw JS
 *  into the chat. A fence opener dangling at the end of the intro line
 *  (the model often glues "```html" straight after the sentence, no
 *  newline) is swept too. */
export function stripExtHtml(content: string): string {
  let out = String(content || "");
  const anchor = /<!--\s*veil-ext\s*\{[\s\S]*?\}\s*-->|<!doctype html/i.exec(out);
  if (anchor) {
    out = anchor.index > 0 ? out.slice(0, anchor.index) : "";
    return out.replace(/```(?:html)?\s*$/i, "").trim();
  }
  out = out.replace(/```(?:html)?\s*\n[\s\S]*?```/g, "").trim();
  if (/<\/html>/i.test(out)) {
    const fb = /<!--\s*veil-ext\s*\{[\s\S]*?\}\s*-->|<!doctype html/i.exec(out);
    if (fb) {
      out = fb.index > 0 ? out.slice(0, fb.index).trim() : "";
    }
  }
  return out;
}

/**
 * Live variant for Maker replies that are STILL STREAMING: cut the
 * visible text at the first sign of the app's code — an opening fence,
 * a doctype, or the veil-ext metadata comment — so the raw HTML is
 * never painted into the chat while it's being written. The code's
 * only home is the ExtCard's "View HTML" viewer. Returns the prose
 * so far, how many bytes of code have landed, plus a TAIL of the code
 * (last ~700 chars) and the line count — the AI Coder's build panel
 * streams that tail live in a mini console, so a build never feels
 * like a silent KB counter.
 */
export function liveCutExt(content: string): {
  prose: string;
  building: boolean;
  bytes: number;
  codeTail: string;
  lines: number;
} {
  const src = String(content || "");
  let cut = -1;
  const fence = src.indexOf("```");
  if (fence !== -1) cut = fence;
  const doc = src.toLowerCase().indexOf("<!doctype html");
  if (doc !== -1 && (cut === -1 || doc < cut)) cut = doc;
  const meta = src.indexOf("<!-- veil-ext");
  if (meta !== -1 && (cut === -1 || meta < cut)) cut = meta;
  if (cut === -1) return { prose: src, building: false, bytes: 0, codeTail: "", lines: 0 };
  const code = src.slice(cut);
  return {
    prose: src.slice(0, cut).trim(),
    building: true,
    bytes: Math.max(0, code.length),
    codeTail: code.slice(-700),
    lines: (code.match(/\n/g) ?? []).length,
  };
}
