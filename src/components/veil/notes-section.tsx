"use client";

/**
 * Veil — Notes: a viewer-scoped scratchpad (the Updates app's successor).
 *
 * Two panes: the note list (pinned first, then recently-edited) and the
 * editor. Everything autosaves with a debounce; the "Saved" pill in the
 * header mirrors the save state so a closed overlay never eats a thought.
 * Notes live server-side (Prisma Note model) scoped to the pseudonymous
 * viewer id — same privacy model as history and FreeTube data.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Loader2,
  NotebookPen,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionShell } from "@/components/veil/start-sections";
import { viewerHeaders } from "@/lib/veil/shared";

interface Note {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 900;

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

function notePreview(n: Note): string {
  const firstLine = n.body.split("\n").find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? "";
}

export function NotesSection({ onBack }: { onBack: () => void }) {
  const [notes, setNotes] = React.useState<Note[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [save, setSave] = React.useState<SaveState>("idle");
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = React.useRef({ id: "", title: "", body: "" });

  const selected = React.useMemo(
    () => notes?.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId]
  );

  /* ---- load ---- */
  React.useEffect(() => {
    let alive = true;
    fetch("/api/notes", { cache: "no-store", headers: viewerHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { ok?: boolean; notes?: Note[] } | null) => {
        if (!alive) return;
        if (data?.ok && Array.isArray(data.notes)) {
          setNotes(data.notes);
          if (data.notes.length > 0) setSelectedId(data.notes[0].id);
        } else {
          setNotes([]);
        }
      })
      .catch(() => alive && setNotes([]));
    return () => {
      alive = false;
    };
  }, []);

  /* ---- stop any pending timer on unmount ---- */
  React.useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  /* ---- load editor when switching notes ---- */
  React.useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSave("idle");
    setConfirmDelete(false);
    if (selected) {
      setTitle(selected.title);
      setBody(selected.body);
    } else {
      setTitle("");
      setBody("");
    }
  }, [selectedId]);

  const patchNote = React.useCallback(
    (payload: { title?: string; body?: string; pinned?: boolean }) => {
      const id = latest.current.id;
      if (!id) return;
      setSave("saving");
      fetch("/api/notes", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...viewerHeaders() },
        body: JSON.stringify({ id, ...payload }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { ok?: boolean } | null) => {
          if (data?.ok) {
            setSave("saved");
            setNotes((ns) => {
              if (!ns) return ns;
              return ns
                .map((n) =>
                  n.id === id
                    ? {
                        ...n,
                        title: payload.title ?? n.title,
                        body: payload.body ?? n.body,
                        pinned: payload.pinned ?? n.pinned,
                        updatedAt: new Date().toISOString(),
                      }
                    : n
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

  /* ---- debounced autosave ---- */
  const scheduleSave = React.useCallback(
    (nextTitle: string, nextBody: string) => {
      setSave("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        patchNote({ title: nextTitle, body: nextBody });
      }, AUTOSAVE_MS);
    },
    [patchNote]
  );

  const onTitleChange = (v: string) => {
    setTitle(v);
    if (!selected) return;
    latest.current = { id: selected.id, title: v, body };
    scheduleSave(v, body);
  };

  const onBodyChange = (v: string) => {
    setBody(v);
    if (!selected) return;
    latest.current = { id: selected.id, title, body: v };
    scheduleSave(title, v);
  };

  const createNote = React.useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json", ...viewerHeaders() },
        body: JSON.stringify({ title: "", body: "" }),
      });
      const data = (await res.json()) as { ok?: boolean; note?: Note; error?: string };
      if (data?.ok && data.note) {
        setNotes((ns) => [data.note as Note, ...(ns ?? [])]);
        setSelectedId(data.note.id);
        setTitle("");
        setBody("");
      } else {
        setError(data?.error ?? "Could not create the note.");
      }
    } catch {
      setError("Could not create the note.");
    } finally {
      setCreating(false);
    }
  }, []);

  const deleteNote = React.useCallback(async () => {
    if (!selected) return;
    const id = selected.id;
    try {
      const res = await fetch(
        `/api/notes?id=${encodeURIComponent(id)}`,
        { method: "DELETE", headers: viewerHeaders() }
      );
      const data = (await res.json()) as { ok?: boolean };
      if (data?.ok) {
        setNotes((ns) => {
          const rest = (ns ?? []).filter((n) => n.id !== id);
          setSelectedId(rest.length > 0 ? rest[0].id : null);
          return rest;
        });
        setConfirmDelete(false);
      } else {
        setError("Could not delete that note.");
      }
    } catch {
      setError("Could not delete that note.");
    }
  }, [selected]);

  const togglePin = () => {
    if (!selected) return;
    const next = !selected.pinned;
    setNotes((ns) =>
      (ns ?? [])
        .map((n) => (n.id === selected.id ? { ...n, pinned: next } : n))
        .sort((a, b) =>
          a.pinned === b.pinned
            ? b.updatedAt.localeCompare(a.updatedAt)
            : a.pinned
              ? -1
              : 1
        )
    );
    latest.current = { id: selected.id, title, body };
    patchNote({ pinned: next });
  };

  const filtered = React.useMemo(() => {
    const list = notes ?? [];
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter(
      (n) =>
        n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
    );
  }, [notes, query]);

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;

  return (
    <SectionShell
      title="Notes"
      subtitle="quick thoughts, kept"
      icon={<NotebookPen className="size-4.5" aria-hidden />}
      onBack={onBack}
    >
      <div className="relative z-10 flex h-full min-h-0 w-full flex-col p-3 sm:p-4 lg:p-6">
        <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row lg:gap-4">
          {/* ---------------- list pane ---------------- */}
          <aside className="flex h-44 shrink-0 flex-col gap-2.5 lg:h-full lg:w-80 lg:shrink">
            <div className="flex items-center gap-2">
              <div className="group relative min-w-0 flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500 transition group-focus-within:text-emerald-400"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a note…"
                  aria-label="Find a note"
                  className="h-9 rounded-xl border-zinc-800 bg-zinc-900/60 pl-9 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-emerald-500/50 focus-visible:ring-emerald-500/20"
                />
              </div>
              <Button
                onClick={() => void createNote()}
                disabled={creating}
                aria-label="New note"
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
              {notes === null ? (
                <div className="flex h-full items-center justify-center py-8">
                  <Loader2 aria-hidden className="size-5 animate-spin text-zinc-600" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-zinc-800 px-4 py-8 text-center">
                  <p className="text-[13px] font-medium text-zinc-400">
                    {query.trim() ? "Nothing matches that." : "No notes yet."}
                  </p>
                  {!query.trim() && (
                    <p className="mt-1 text-[11.5px] text-zinc-600">
                      Tap New — jot it down, it autosaves.
                    </p>
                  )}
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {filtered.map((n) => {
                    const active = n.id === selectedId;
                    return (
                      <motion.button
                        key={n.id}
                        layout
                        type="button"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97 }}
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        onClick={() => setSelectedId(n.id)}
                        aria-current={active ? "true" : undefined}
                        className={`min-h-11 w-full rounded-xl border px-3 py-2.5 text-left transition ${
                          active
                            ? "border-emerald-500/40 bg-emerald-500/10 ring-1 ring-emerald-500/20"
                            : "border-zinc-800/80 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70"
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          {n.pinned && (
                            <Pin aria-hidden className="size-3 shrink-0 text-emerald-400" />
                          )}
                          <span
                            className={`truncate text-[13px] font-semibold ${
                              active ? "text-emerald-100" : "text-zinc-200"
                            }`}
                          >
                            {n.title.trim() || "Untitled"}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[11.5px] text-zinc-500">
                          {notePreview(n) || "—"}
                        </span>
                        <span className="mt-1 block text-[10.5px] uppercase tracking-wide text-zinc-600">
                          {timeAgo(n.updatedAt)}
                        </span>
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              )}
            </div>
          </aside>

          {/* ---------------- editor pane ---------------- */}
          <section
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-sm"
            aria-label="Note editor"
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
                  <span className="hidden text-[11px] text-zinc-600 sm:inline">
                    {wordCount} {wordCount === 1 ? "word" : "words"}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={togglePin}
                      aria-label={selected.pinned ? "Unpin note" : "Pin note"}
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
                        confirmDelete ? void deleteNote() : setConfirmDelete(true)
                      }
                      onBlur={() => setConfirmDelete(false)}
                      aria-label={
                        confirmDelete ? "Confirm delete" : "Delete note"
                      }
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
                <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 sm:p-4">
                  <input
                    value={title}
                    onChange={(e) => onTitleChange(e.target.value)}
                    placeholder="Title"
                    aria-label="Note title"
                    maxLength={140}
                    className="w-full bg-transparent text-[17px] font-semibold tracking-tight text-zinc-50 outline-none placeholder:text-zinc-700"
                  />
                  <Textarea
                    value={body}
                    onChange={(e) => onBodyChange(e.target.value)}
                    placeholder="Start writing — everything autosaves."
                    aria-label="Note body"
                    className="veil-scroll-slim min-h-0 flex-1 resize-none rounded-xl border-zinc-800/60 bg-zinc-900/40 p-3 text-[14px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus-visible:border-emerald-500/40 focus-visible:ring-emerald-500/15"
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20">
                  <NotebookPen aria-hidden className="size-6" />
                </div>
                <div>
                  <p className="text-[15px] font-semibold text-zinc-200">
                    {notes === null
                      ? "Loading your notes…"
                      : notes.length === 0
                        ? "Your scratchpad is empty"
                        : "Pick a note"}
                  </p>
                  <p className="mt-1 max-w-xs text-[12.5px] leading-relaxed text-zinc-500">
                    {notes !== null &&
                      notes.length === 0 &&
                      "Quick thoughts, lists, links to remember — they stay on this browser and autosave as you type."}
                  </p>
                </div>
                {notes !== null && notes.length === 0 && (
                  <Button
                    onClick={() => void createNote()}
                    disabled={creating}
                    className="mt-1 h-10 rounded-xl bg-emerald-500 px-4 text-[13.5px] font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-400"
                  >
                    <Plus aria-hidden className="size-4" />
                    Write the first one
                  </Button>
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
