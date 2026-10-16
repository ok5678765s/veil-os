"use client";

/**
 * Veil — HTML Coder: a viewer-scoped, single-file HTML playground
 * (replaced the Notes app at the owner's request).
 *
 * Two panes: the document list (pinned first, then recently-edited) and
 * the workshop — a code editor + a live, sandboxed preview of the page.
 * Everything autosaves with a debounce; the "Saved" pill in the header
 * mirrors the save state so a closed overlay never eats a build.
 * Documents live server-side (Prisma CoderDoc model) scoped to the
 * pseudonymous viewer id — same privacy model as history.
 *
 * The preview runs the document in a sandboxed iframe (srcDoc):
 * scripts run, but the frame gets NO same-origin access — it can never
 * touch Veil's cookies, storage or DOM.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Code2,
  Download,
  Eye,
  Loader2,
  Monitor,
  Pin,
  PinOff,
  Play,
  Plus,
  RotateCw,
  Search,
  Smartphone,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionShell } from "@/components/veil/start-sections";
import { viewerHeaders } from "@/lib/veil/shared";
import { cn } from "@/lib/utils";

interface Doc {
  id: string;
  title: string;
  html: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 900;
const PREVIEW_MS = 700;

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function docPreview(d: Doc): string {
  const firstLine = d.html.split("\n").find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? "";
}

/* New documents start from a tiny, good-looking shell so the preview
 * never shows a blank void on the very first Run. */
const TEMPLATES: { key: string; label: string; html: string }[] = [
  {
    key: "blank",
    label: "Blank page",
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New page</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #09090b; color: #fafafa;
         font-family: system-ui, -apple-system, sans-serif; }
</style>
</head>
<body>
  <h1>Hello, veil 👋</h1>
</body>
</html>`,
  },
  {
    key: "landing",
    label: "Landing demo",
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Landing demo</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #09090b; color: #e4e4e7;
         font-family: system-ui, -apple-system, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 4rem 1.25rem; }
  h1 { font-size: clamp(2rem, 6vw, 3.25rem); line-height: 1.05; margin: 0 0 1rem; }
  .accent { color: #34d399; }
  p.lead { font-size: 1.1rem; color: #a1a1aa; margin: 0 0 2rem; }
  .cta { display: inline-block; background: #34d399; color: #052e16; font-weight: 700;
         padding: .8rem 1.5rem; border-radius: .9rem; border: 0; cursor: pointer; }
  .cta:hover { background: #6ee7b7; }
  #out { margin-top: 1.5rem; color: #34d399; min-height: 1.4em; }
</style>
</head>
<body>
<main>
  <h1>Build something <span class="accent">beautiful</span></h1>
  <p class="lead">This page is a live sandbox — edit the code on the left and watch it change.</p>
  <button class="cta" id="go">Tap me</button>
  <p id="out"></p>
</main>
<script>
  let n = 0;
  document.getElementById('go').addEventListener('click', () => {
    n++;
    document.getElementById('out').textContent = 'clicked ' + n + (n === 1 ? ' time' : ' times');
  });
</script>
</body>
</html>`,
  },
];

export function CoderSection({ onBack }: { onBack: () => void }) {
  const [docs, setDocs] = React.useState<Doc[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState("");
  const [code, setCode] = React.useState("");
  const [save, setSave] = React.useState<SaveState>("idle");
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* workshop view state */
  const [pane, setPane] = React.useState<"code" | "preview">("code");
  const [previewHtml, setPreviewHtml] = React.useState("");
  const [previewKey, setPreviewKey] = React.useState(0);
  const [autoRun, setAutoRun] = React.useState(true);
  const [mobileTab, setMobileTab] = React.useState<"code" | "preview">("code");

  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = React.useRef({ id: "", title: "", code: "" });

  const selected = React.useMemo(
    () => docs?.find((d) => d.id === selectedId) ?? null,
    [docs, selectedId]
  );

  /* ---- load ---- */
  React.useEffect(() => {
    let alive = true;
    fetch("/api/coder", { cache: "no-store", headers: viewerHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { ok?: boolean; docs?: Doc[] } | null) => {
        if (!alive) return;
        if (data?.ok && Array.isArray(data.docs)) {
          setDocs(data.docs);
          if (data.docs.length > 0) setSelectedId(data.docs[0].id);
        } else {
          setDocs([]);
        }
      })
      .catch(() => alive && setDocs([]));
    return () => {
      alive = false;
    };
  }, []);

  /* ---- stop pending timers on unmount ---- */
  React.useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (previewTimer.current) clearTimeout(previewTimer.current);
    },
    []
  );

  /* ---- load editor when switching documents ---- */
  React.useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSave("idle");
    setConfirmDelete(false);
    if (selected) {
      setTitle(selected.title);
      setCode(selected.html);
      setPreviewHtml(selected.html);
      setPreviewKey((k) => k + 1);
    } else {
      setTitle("");
      setCode("");
      setPreviewHtml("");
    }
  }, [selectedId]);

  const patchDoc = React.useCallback(
    (payload: { title?: string; html?: string; pinned?: boolean }) => {
      const id = latest.current.id;
      if (!id) return;
      setSave("saving");
      fetch("/api/coder", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...viewerHeaders() },
        body: JSON.stringify({ id, ...payload }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { ok?: boolean } | null) => {
          if (data?.ok) {
            setSave("saved");
            setDocs((ds) => {
              if (!ds) return ds;
              return ds
                .map((d) =>
                  d.id === id
                    ? {
                        ...d,
                        title: payload.title ?? d.title,
                        html: payload.html ?? d.html,
                        pinned: payload.pinned ?? d.pinned,
                        updatedAt: new Date().toISOString(),
                      }
                    : d
                )
                .sort((a, b) =>
                  a.pinned === b.pinned
                    ? b.updatedAt.localeCompare(a.updatedAt)
                    : a.pinned
                      ? -1
                      : 1
                );
            });
          } else {
            setSave("error");
          }
        })
        .catch(() => setSave("error"));
    },
    []
  );

  /* ---- debounced autosave + live preview ---- */
  const scheduleSave = React.useCallback(
    (nextTitle: string, nextCode: string) => {
      setSave("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        patchDoc({ title: nextTitle, html: nextCode });
      }, AUTOSAVE_MS);
      if (autoRun) {
        if (previewTimer.current) clearTimeout(previewTimer.current);
        previewTimer.current = setTimeout(() => {
          setPreviewHtml(nextCode);
          setPreviewKey((k) => k + 1);
        }, PREVIEW_MS);
      }
    },
    [autoRun, patchDoc]
  );

  const onTitleChange = (v: string) => {
    setTitle(v);
    if (!selected) return;
    latest.current = { id: selected.id, title: v, code };
    scheduleSave(v, code);
  };

  const onCodeChange = (v: string) => {
    setCode(v);
    if (!selected) return;
    latest.current = { id: selected.id, title, code: v };
    scheduleSave(title, v);
  };

  const runPreview = () => {
    setPreviewHtml(code);
    setPreviewKey((k) => k + 1);
    setMobileTab("preview");
  };

  const createDoc = React.useCallback(async (templateKey?: string) => {
    setCreating(true);
    setError(null);
    const tpl = TEMPLATES.find((t) => t.key === templateKey) ?? TEMPLATES[0];
    try {
      const res = await fetch("/api/coder", {
        method: "POST",
        headers: { "content-type": "application/json", ...viewerHeaders() },
        body: JSON.stringify({
          title: templateKey === "landing" ? "Landing demo" : "New page",
          html: tpl.html,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; doc?: Doc; error?: string };
      if (data?.ok && data.doc) {
        setDocs((ds) => [data.doc as Doc, ...(ds ?? [])]);
        setSelectedId(data.doc.id);
        setTitle(data.doc.title);
        setCode(data.doc.html);
        setPreviewHtml(data.doc.html);
        setPreviewKey((k) => k + 1);
        setMobileTab("code");
      } else {
        setError(data?.error ?? "Could not create the document.");
      }
    } catch {
      setError("Could not create the document.");
    } finally {
      setCreating(false);
    }
  }, []);

  const deleteDoc = React.useCallback(async () => {
    if (!selected) return;
    const id = selected.id;
    try {
      const res = await fetch(`/api/coder?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: viewerHeaders(),
      });
      const data = (await res.json()) as { ok?: boolean };
      if (data?.ok) {
        setDocs((ds) => {
          const rest = (ds ?? []).filter((d) => d.id !== id);
          setSelectedId(rest.length > 0 ? rest[0].id : null);
          return rest;
        });
        setConfirmDelete(false);
      } else {
        setError("Could not delete that document.");
      }
    } catch {
      setError("Could not delete that document.");
    }
  }, [selected]);

  const togglePin = () => {
    if (!selected) return;
    const next = !selected.pinned;
    setDocs((ds) =>
      (ds ?? [])
        .map((d) => (d.id === selected.id ? { ...d, pinned: next } : d))
        .sort((a, b) =>
          a.pinned === b.pinned
            ? b.updatedAt.localeCompare(a.updatedAt)
            : a.pinned
              ? -1
              : 1
        )
    );
    latest.current = { id: selected.id, title, code };
    patchDoc({ pinned: next });
  };

  const download = () => {
    if (!selected) return;
    const name = (title.trim() || "veil-page").replace(/[^\w.-]+/g, "-").slice(0, 60) + ".html";
    const blob = new Blob([code], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filtered = React.useMemo(() => {
    const list = docs ?? [];
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter(
      (d) => d.title.toLowerCase().includes(q) || d.html.toLowerCase().includes(q)
    );
  }, [docs, query]);

  const lineCount = code ? code.split("\n").length : 0;

  return (
    <SectionShell
      title="HTML Coder"
      subtitle="build pages, see them live"
      icon={<Code2 className="size-4.5" aria-hidden />}
      onBack={onBack}
      wide
    >
      <div className="relative z-10 flex h-full min-h-0 w-full flex-col p-3 sm:p-4 lg:p-6">
        <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row lg:gap-4">
          {/* ---------------- list pane ---------------- */}
          <aside className="flex h-44 shrink-0 flex-col gap-2.5 lg:h-full lg:w-72 lg:shrink">
            <div className="flex items-center gap-2">
              <div className="group relative min-w-0 flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500 transition group-focus-within:text-emerald-400"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a page…"
                  aria-label="Find a page"
                  className="h-9 rounded-xl border-zinc-800 bg-zinc-900/60 pl-9 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-emerald-500/50 focus-visible:ring-emerald-500/20"
                />
              </div>
              <Button
                onClick={() => void createDoc("blank")}
                disabled={creating}
                aria-label="New page"
                className="h-9 shrink-0 rounded-xl bg-emerald-500 px-3 text-[13px] font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-400"
              >
                {creating ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : (
                  <Plus aria-hidden className="size-4" />
                )}
                <span className="hidden sm:inline">New</span>
              </Button>
            </div>

            <div className="veil-scroll-slim min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
              {docs === null ? (
                <div className="flex h-full items-center justify-center py-8">
                  <Loader2 aria-hidden className="size-5 animate-spin text-zinc-600" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-zinc-800 px-4 py-8 text-center">
                  <p className="text-[13px] font-medium text-zinc-400">
                    {query.trim() ? "Nothing matches that." : "No pages yet."}
                  </p>
                  {!query.trim() && (
                    <p className="mt-1 text-[11.5px] text-zinc-600">
                      Tap New — write HTML, preview it live, it autosaves.
                    </p>
                  )}
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {filtered.map((d) => {
                    const active = d.id === selectedId;
                    return (
                      <motion.button
                        key={d.id}
                        layout
                        type="button"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97 }}
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        onClick={() => setSelectedId(d.id)}
                        aria-current={active ? "true" : undefined}
                        className={`min-h-11 w-full rounded-xl border px-3 py-2.5 text-left transition ${
                          active
                            ? "border-emerald-500/40 bg-emerald-500/10 ring-1 ring-emerald-500/20"
                            : "border-zinc-800/80 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70"
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          {d.pinned && (
                            <Pin aria-hidden className="size-3 shrink-0 text-emerald-400" />
                          )}
                          <span
                            className={`truncate text-[13px] font-semibold ${
                              active ? "text-emerald-100" : "text-zinc-200"
                            }`}
                          >
                            {d.title.trim() || "Untitled"}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500">
                          {docPreview(d) || "—"}
                        </span>
                        <span className="mt-1 block text-[10.5px] uppercase tracking-wide text-zinc-600">
                          {timeAgo(d.updatedAt)}
                        </span>
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              )}
            </div>
          </aside>

          {/* ---------------- workshop pane ---------------- */}
          <section
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-sm"
            aria-label="Page workshop"
          >
            {selected ? (
              <>
                <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800/70 px-3 py-2 sm:px-4">
                  {/* save pill */}
                  <span
                    aria-live="polite"
                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${
                      save === "saved"
                        ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25"
                        : save === "saving" || save === "dirty"
                          ? "bg-zinc-800/60 text-zinc-400 ring-zinc-700/60"
                          : save === "error"
                            ? "bg-rose-500/10 text-rose-300 ring-rose-500/25"
                            : "bg-zinc-900/60 text-zinc-500 ring-zinc-800"
                    }`}
                  >
                    {save === "saving" ? (
                      <Loader2 aria-hidden className="size-3 animate-spin" />
                    ) : save === "saved" ? (
                      <Check aria-hidden className="size-3" />
                    ) : save === "error" ? (
                      <span aria-hidden>!</span>
                    ) : null}
                    {save === "saved"
                      ? "Saved"
                      : save === "saving"
                        ? "Saving…"
                        : save === "dirty"
                          ? "Editing…"
                          : save === "error"
                            ? "Save failed — retry by typing"
                            : "Autosaves"}
                  </span>
                  <span className="hidden font-mono text-[11px] text-zinc-600 sm:inline">
                    {lineCount} {lineCount === 1 ? "line" : "lines"}
                  </span>

                  {/* mobile pane switch */}
                  <div className="ml-auto flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/70 p-0.5 lg:hidden">
                    {(["code", "preview"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          if (p === "preview" && mobileTab === "code") runPreview();
                          else setMobileTab(p);
                        }}
                        aria-pressed={mobileTab === p}
                        className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                          mobileTab === p
                            ? "bg-emerald-500/20 text-emerald-200"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {p === "code" ? (
                          <Code2 aria-hidden className="size-3" />
                        ) : (
                          <Eye aria-hidden className="size-3" />
                        )}
                        {p === "code" ? "Code" : "Preview"}
                      </button>
                    ))}
                  </div>

                  <div className="ml-auto hidden items-center gap-1.5 lg:flex">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setAutoRun((a) => !a)}
                      aria-pressed={autoRun}
                      title={autoRun ? "Auto-run on — the preview refreshes as you type" : "Auto-run off — refresh manually"}
                      aria-label={autoRun ? "Turn off auto-run" : "Turn on auto-run"}
                      className={`size-9 rounded-xl ${
                        autoRun
                          ? "text-emerald-300 hover:bg-emerald-500/10"
                          : "text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
                      }`}
                    >
                      {autoRun ? (
                        <RotateCw aria-hidden className="size-4 animate-[spin_3s_linear_infinite]" />
                      ) : (
                        <Square aria-hidden className="size-4 fill-current" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={runPreview}
                      className="h-9 gap-1.5 rounded-xl border-emerald-500/30 bg-emerald-500/10 px-3 text-[12px] font-semibold text-emerald-200 hover:border-emerald-400/60 hover:bg-emerald-500/20"
                    >
                      <Play aria-hidden className="size-3.5" />
                      Run
                    </Button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={download}
                      aria-label="Download this page as an .html file"
                      title="Download this page as an .html file"
                      className="size-9 rounded-xl text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
                    >
                      <Download aria-hidden className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={togglePin}
                      aria-label={selected.pinned ? "Unpin page" : "Pin page"}
                      className={`size-9 rounded-xl ${
                        selected.pinned
                          ? "text-emerald-300 hover:bg-emerald-500/10"
                          : "text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
                      }`}
                    >
                      {selected.pinned ? (
                        <PinOff aria-hidden className="size-4" />
                      ) : (
                        <Pin aria-hidden className="size-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        confirmDelete ? void deleteDoc() : setConfirmDelete(true)
                      }
                      onBlur={() => setConfirmDelete(false)}
                      aria-label={confirmDelete ? "Confirm delete" : "Delete page"}
                      className={`size-9 rounded-xl ${
                        confirmDelete
                          ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30 hover:bg-rose-500/25"
                          : "text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
                      }`}
                    >
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                    {confirmDelete && (
                      <span className="text-[11px] font-medium text-rose-300">
                        tap again to delete
                      </span>
                    )}
                  </div>
                </header>

                {/* editor + preview — side-by-side on desktop, tabbed on mobile */}
                <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                  <div
                    className={cn(
                      "flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-3 sm:p-4",
                      mobileTab === "code" ? "flex" : "hidden lg:flex"
                    )}
                  >
                    <input
                      value={title}
                      onChange={(e) => onTitleChange(e.target.value)}
                      placeholder="Title"
                      aria-label="Page title"
                      maxLength={140}
                      className="w-full bg-transparent text-[17px] font-semibold tracking-tight text-zinc-50 outline-none placeholder:text-zinc-700"
                    />
                    <Textarea
                      value={code}
                      onChange={(e) => onCodeChange(e.target.value)}
                      placeholder="<!doctype html> — write the whole page here…"
                      aria-label="HTML source"
                      spellCheck={false}
                      wrap="off"
                      className="veil-scroll-slim min-h-0 min-w-0 flex-1 resize-none rounded-xl border-zinc-800/60 bg-zinc-900/40 p-3 font-mono text-[12.5px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus-visible:border-emerald-500/40 focus-visible:ring-emerald-500/15"
                    />
                  </div>

                  {/* preview column */}
                  <div
                    className={cn(
                      "min-h-0 min-w-0 flex-1 flex-col border-t border-zinc-800/60 bg-zinc-900/20 p-3 sm:p-4 lg:border-l lg:border-t-0",
                      mobileTab === "preview" ? "flex" : "hidden lg:flex"
                    )}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                        <Monitor aria-hidden className="size-3.5" />
                        Live preview
                      </span>
                      <span
                        aria-hidden
                        className="ml-auto rounded-full bg-zinc-800/60 px-2 py-0.5 text-[10px] font-mono text-zinc-500"
                      >
                        sandboxed
                      </span>
                    </div>
                    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800/70 bg-white">
                      {previewHtml.trim() ? (
                        <iframe
                          key={previewKey}
                          title="Live preview of your page"
                          srcDoc={previewHtml}
                          sandbox="allow-scripts allow-forms allow-modals allow-popups"
                          className="absolute inset-0 h-full w-full border-0"
                        />
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                          <Smartphone aria-hidden className="size-6 text-zinc-300" />
                          <p className="text-[12.5px] font-medium text-zinc-500">
                            Hit Run to render the page
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20">
                  <Code2 aria-hidden className="size-6" />
                </div>
                <div>
                  <p className="text-[15px] font-semibold text-zinc-200">
                    {docs === null
                      ? "Loading your pages…"
                      : docs.length === 0
                        ? "The workshop is empty"
                        : "Pick a page"}
                  </p>
                  <p className="mt-1 max-w-xs text-[12.5px] leading-relaxed text-zinc-500">
                    {docs !== null &&
                      docs.length === 0 &&
                      "Write HTML with a live sandboxed preview — pages autosave on this browser."}
                  </p>
                </div>
                {docs !== null && docs.length === 0 && (
                  <div className="mt-1 flex flex-wrap justify-center gap-2">
                    {TEMPLATES.map((t) => (
                      <Button
                        key={t.key}
                        onClick={() => void createDoc(t.key)}
                        disabled={creating}
                        className="h-10 rounded-xl bg-emerald-500 px-4 text-[13.5px] font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-400"
                      >
                        <Plus aria-hidden className="size-4" />
                        {t.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {error && (
          <p
            role="alert"
            className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-rose-500/15 px-4 py-1.5 text-[12px] font-medium text-rose-200 ring-1 ring-rose-500/30 backdrop-blur"
          >
            {error}
          </p>
        )}
      </div>
    </SectionShell>
  );
}
