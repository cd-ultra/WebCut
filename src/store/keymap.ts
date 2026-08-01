/**
 * WebCut — customizable keyboard shortcuts (#75).
 *
 * A command registry maps stable command ids to editable key "chords". Bindings
 * persist to localStorage so they survive reloads. Timeline/global key handlers
 * resolve an event to a command id via `matchCommand`, decoupling the physical
 * keys from the actions they trigger.
 *
 * A chord is a normalized string: zero or more modifiers (`Mod` = ⌘ on macOS /
 * Ctrl elsewhere, plus `Shift`/`Alt`) joined to a `KeyboardEvent.code` with `+`,
 * e.g. "Mod+KeyZ", "Shift+KeyZ+Mod", normalized to a canonical order.
 */

import { useSyncExternalStore } from "react";

export type CommandId =
  | "playback.toggle"
  | "edit.split"
  | "edit.delete"
  | "edit.rippleDelete"
  | "edit.undo"
  | "edit.redo"
  | "edit.copy"
  | "edit.cut"
  | "edit.paste"
  | "edit.duplicate"
  | "view.zoomIn"
  | "view.zoomOut"
  | "playhead.nextFrame"
  | "playhead.prevFrame"
  | "playhead.start"
  | "playhead.end"
  | "marker.add"
  | "shuttle.forward"
  | "shuttle.back"
  | "shuttle.stop";

export interface CommandDef {
  readonly id: CommandId;
  readonly label: string;
  readonly group: string;
  readonly defaultChord: string;
}

export const COMMANDS: readonly CommandDef[] = [
  { id: "playback.toggle", label: "Play / Pause", group: "Playback", defaultChord: "Space" },
  { id: "shuttle.forward", label: "Shuttle forward (J/K/L)", group: "Playback", defaultChord: "KeyL" },
  { id: "shuttle.stop", label: "Shuttle stop", group: "Playback", defaultChord: "KeyK" },
  { id: "shuttle.back", label: "Shuttle reverse", group: "Playback", defaultChord: "KeyJ" },
  { id: "playhead.nextFrame", label: "Next frame", group: "Playback", defaultChord: "ArrowRight" },
  { id: "playhead.prevFrame", label: "Previous frame", group: "Playback", defaultChord: "ArrowLeft" },
  { id: "playhead.start", label: "Go to start", group: "Playback", defaultChord: "Home" },
  { id: "playhead.end", label: "Go to end", group: "Playback", defaultChord: "End" },
  { id: "edit.split", label: "Split at playhead", group: "Editing", defaultChord: "KeyS" },
  { id: "edit.delete", label: "Delete", group: "Editing", defaultChord: "Delete" },
  { id: "edit.rippleDelete", label: "Ripple delete", group: "Editing", defaultChord: "Shift+Delete" },
  { id: "edit.undo", label: "Undo", group: "Editing", defaultChord: "Mod+KeyZ" },
  { id: "edit.redo", label: "Redo", group: "Editing", defaultChord: "Mod+Shift+KeyZ" },
  { id: "edit.copy", label: "Copy", group: "Editing", defaultChord: "Mod+KeyC" },
  { id: "edit.cut", label: "Cut", group: "Editing", defaultChord: "Mod+KeyX" },
  { id: "edit.paste", label: "Paste", group: "Editing", defaultChord: "Mod+KeyV" },
  { id: "edit.duplicate", label: "Duplicate", group: "Editing", defaultChord: "Mod+KeyD" },
  { id: "marker.add", label: "Add marker", group: "Editing", defaultChord: "KeyM" },
  { id: "view.zoomIn", label: "Zoom in", group: "View", defaultChord: "Equal" },
  { id: "view.zoomOut", label: "Zoom out", group: "View", defaultChord: "Minus" },
];

const STORAGE_KEY = "webcut.keymap.v1";

/** Build the canonical chord string from a keyboard event. */
export const chordFromEvent = (e: KeyboardEvent | React.KeyboardEvent): string => {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const code = e.code || (e.key === " " ? "Space" : e.key);
  // Bare modifier presses are not a chord.
  if (code !== "ControlLeft" && code !== "ControlRight" && code !== "MetaLeft" &&
      code !== "MetaRight" && code !== "ShiftLeft" && code !== "ShiftRight" &&
      code !== "AltLeft" && code !== "AltRight") {
    parts.push(code);
  }
  return parts.join("+");
};

/** Normalize a chord string to canonical modifier order (Mod, Shift, Alt, key). */
export const normalizeChord = (chord: string): string => {
  const tokens = chord.split("+").map((t) => t.trim()).filter(Boolean);
  const mods = { Mod: false, Shift: false, Alt: false };
  let key = "";
  for (const t of tokens) {
    if (t === "Mod" || t === "Ctrl" || t === "Meta" || t === "Cmd") mods.Mod = true;
    else if (t === "Shift") mods.Shift = true;
    else if (t === "Alt" || t === "Option") mods.Alt = true;
    else key = t;
  }
  const out: string[] = [];
  if (mods.Mod) out.push("Mod");
  if (mods.Shift) out.push("Shift");
  if (mods.Alt) out.push("Alt");
  if (key) out.push(key);
  return out.join("+");
};

/** Human-friendly rendering of a chord for the UI. */
export const prettyChord = (chord: string): string => {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return normalizeChord(chord)
    .split("+")
    .map((t) => {
      if (t === "Mod") return isMac ? "⌘" : "Ctrl";
      if (t === "Shift") return isMac ? "⇧" : "Shift";
      if (t === "Alt") return isMac ? "⌥" : "Alt";
      if (t.startsWith("Key")) return t.slice(3);
      if (t.startsWith("Digit")) return t.slice(5);
      if (t === "Equal") return "=";
      if (t === "Minus") return "−";
      if (t === "ArrowLeft") return "←";
      if (t === "ArrowRight") return "→";
      return t;
    })
    .join(isMac ? "" : "+");
};

const loadBindings = (): Record<string, string> => {
  const defaults: Record<string, string> = {};
  for (const c of COMMANDS) defaults[c.id] = normalizeChord(c.defaultChord);
  if (typeof localStorage === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(saved)) {
        if (k in defaults && typeof v === "string") defaults[k] = normalizeChord(v);
      }
    }
  } catch {
    /* corrupt storage → defaults */
  }
  return defaults;
};

let bindings = loadBindings();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    /* storage may be unavailable (private mode) */
  }
};

export const getBindings = (): Record<string, string> => bindings;

export const setBinding = (id: CommandId, chord: string): void => {
  bindings = { ...bindings, [id]: normalizeChord(chord) };
  persist();
  emit();
};

export const resetBindings = (): void => {
  bindings = {};
  for (const c of COMMANDS) bindings[c.id] = normalizeChord(c.defaultChord);
  persist();
  emit();
};

/** Resolve a keyboard event to the command it is bound to, if any. */
export const matchCommand = (e: KeyboardEvent | React.KeyboardEvent): CommandId | null => {
  const chord = chordFromEvent(e);
  for (const [id, bound] of Object.entries(bindings)) {
    if (bound === chord) return id as CommandId;
  }
  return null;
};

/** React hook exposing the live bindings map (re-renders on change). */
export const useKeymap = (): Record<string, string> =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => bindings,
    () => bindings,
  );
