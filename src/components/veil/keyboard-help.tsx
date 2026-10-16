"use client";

/**
 * Veil — keyboard shortcuts help dialog.
 * Opens with the `?` key anywhere (which dispatches a `veil:open-shortcuts`
 * custom event) or via a trigger button. Lists every shortcut grouped by
 * context.
 */

import * as React from "react";
import { Command, Globe, Hand, Maximize, MousePointerClick, VenetianMask } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface Shortcut {
  keys: string[];
  label: string;
}

const LANDING: Shortcut[] = [
  { keys: ["/"], label: "Focus the search bar" },
  { keys: ["Esc"], label: "Close the open app overlay" },
  { keys: ["?"], label: "Open this shortcuts dialog" },
];

const BROWSING: Shortcut[] = [
  { keys: ["Alt", "←"], label: "Go back" },
  { keys: ["Alt", "→"], label: "Go forward" },
  { keys: ["Ctrl", "L"], label: "Focus the URL bar" },
  { keys: ["F"], label: "Toggle OS-level fullscreen" },
  { keys: ["Ctrl", "T"], label: "Open a new tab" },
  { keys: ["Ctrl", "W"], label: "Close the active tab" },
  { keys: ["Ctrl", "Tab"], label: "Next tab" },
  { keys: ["Ctrl", "Shift", "Tab"], label: "Previous tab" },
  { keys: ["Esc"], label: "Reveal the control bar (stays on the page)" },
  { keys: ["?"], label: "Open this shortcuts dialog" },
];

const MOUSE: Shortcut[] = [
  { keys: ["Hover top"], label: "Reveal the control bar" },
  { keys: ["Click ✕"], label: "Close a tab" },
  { keys: ["Middle-click"], label: "Close a tab (in the tab strip)" },
];

/** Split "ctrl+shift+y" into pretty key chips. */
function comboKeys(combo: string): string[] {
  return combo
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)));
}

/** The quick-exit kit — combos live in localStorage and are set in
 *  Settings → Security, so read them fresh every time the dialog opens. */
function panicShortcuts(): Shortcut[] {
  let panicKey = "ctrl+y";
  let cloakKey = "alt+b";
  let panicOn = true;
  try {
    panicKey = (window.localStorage.getItem("veil:panic-key") || "ctrl+y").toLowerCase();
    cloakKey = (window.localStorage.getItem("veil:cloak-key") || "alt+b").toLowerCase();
    panicOn = window.localStorage.getItem("veil:panic-enabled") !== "0";
  } catch {
    /* private mode — defaults */
  }
  const items: Shortcut[] = [
    { keys: comboKeys(cloakKey), label: "Open the veil in an about:blank window" },
  ];
  if (panicOn) {
    items.push({ keys: comboKeys(panicKey), label: "Panic — replace the page with the safe site" });
  }
  return items;
}

function Group({ icon, title, items }: { icon: React.ReactNode; title: string; items: Shortcut[] }) {
  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
        {icon}
        {title}
      </div>
      <ul className="space-y-1.5">
        {items.map((s) => (
          <li
            key={s.label}
            className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition hover:bg-zinc-800/60"
          >
            <span className="text-[13px] text-zinc-300">{s.label}</span>
            <span className="flex items-center gap-1">
              {s.keys.map((k, i) => (
                <kbd
                  key={k + i}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200 shadow-[0_1px_0_0_rgba(0,0,0,0.6)]"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function KeyboardHelp({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [panicItems, setPanicItems] = React.useState<Shortcut[]>([]);

  React.useEffect(() => {
    const onOpen = () => {
      setPanicItems(panicShortcuts());
      setOpen(true);
    };
    window.addEventListener("veil:open-shortcuts", onOpen);
    return () => window.removeEventListener("veil:open-shortcuts", onOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-w-[640px] border-zinc-800 bg-zinc-950 p-0 text-zinc-100">
        <DialogHeader className="border-b border-zinc-800/80 px-6 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-zinc-100">
            <Hand aria-hidden className="h-4 w-4 text-emerald-400" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="text-[13px] text-zinc-400">
            Move through Veil without ever reaching for the mouse.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-x-8 gap-y-6 px-6 py-5 sm:grid-cols-2">
          <Group icon={<Globe aria-hidden className="h-3.5 w-3.5" />} title="Start page" items={LANDING} />
          <Group icon={<Command aria-hidden className="h-3.5 w-3.5" />} title="While browsing" items={BROWSING} />
          <Group icon={<VenetianMask aria-hidden className="h-3.5 w-3.5" />} title="Quick exit (Settings → Security)" items={panicItems} />
          <Group icon={<MousePointerClick aria-hidden className="h-3.5 w-3.5" />} title="Mouse" items={MOUSE} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
