/**
 * WebCut — reusable motion-graphics templates (#62).
 *
 * A template is a serialized bundle of overlays (Text / Shape / Sticker) plus
 * *parameter bindings* — named slots the caller fills in when applying. The
 * template stores the overlay tree verbatim; applying substitutes parameter
 * values into the targeted fields and returns fresh, id-less overlay
 * objects ready for `addItemToTrack`.
 *
 * Templates persist to localStorage as a compact index; the overlay blobs
 * are inlined (they're small — no media assets are ever inside a template).
 */

import {
  identityTransform,
  type OverlayItem,
  type ShapeItem,
  type StickerItem,
  type TextItem,
} from "../types/timeline";

export type TemplateParamKind = "text" | "color" | "number";

export interface TemplateParam {
  readonly name: string;
  readonly kind: TemplateParamKind;
  /** Sensible default; the UI pre-fills this. */
  readonly defaultValue: string | number;
  /** One or more targets substituted with the caller's value at apply-time. */
  readonly targets: readonly TemplateParamTarget[];
}

/**
 * A parameter target names an overlay by its (template-local) id and a
 * dotted path into the overlay object. Supported paths are limited to the
 * substitutable string/number leaves — the shape is validated at apply-time.
 */
export interface TemplateParamTarget {
  readonly overlayId: string;
  /** e.g. "text", "fillColor", "fontSizePx", "cornerRadiusPx", "content". */
  readonly path: string;
}

export interface MotionGraphicsTemplate {
  readonly id: string;
  readonly name: string;
  /** Duration in frames the template's overlays occupy (relative to their internal starts). */
  readonly durationFrames: number;
  /** Overlays with template-local ids (regenerated on apply). */
  readonly overlays: readonly TemplateOverlay[];
  readonly params: readonly TemplateParam[];
  /** ISO timestamp for the gallery's sort order. */
  readonly createdAt: string;
}

/** Overlay stored in a template — same shape as OverlayItem minus the branded `id`. */
export type TemplateOverlay = { readonly templateOverlayId: string } & (
  | Omit<TextItem, "id">
  | Omit<ShapeItem, "id">
  | Omit<StickerItem, "id">
);

// ---------------------------------------------------------------------------
// Persistence (localStorage index + blobs together — templates are small)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "webcut.templates.v1";

export const loadTemplates = (): MotionGraphicsTemplate[] => {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as MotionGraphicsTemplate[];
  } catch {
    return [];
  }
};

export const saveTemplates = (templates: readonly MotionGraphicsTemplate[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    /* private mode / quota — fine */
  }
};

// ---------------------------------------------------------------------------
// Build a template from a selection of overlays currently on the timeline
// ---------------------------------------------------------------------------

/**
 * Snapshot a selection of overlays into a template. Points are captured
 * verbatim; parameters can be added later by the UI (or programmatically).
 * The template's timebase is normalized: the earliest overlay start becomes
 * frame 0 of the template.
 */
export const templateFromOverlays = (
  name: string,
  overlays: readonly OverlayItem[],
  params: readonly TemplateParam[] = [],
): MotionGraphicsTemplate => {
  if (overlays.length === 0) {
    throw new Error("Templates need at least one overlay.");
  }
  const minStart = Math.min(...overlays.map((o) => o.startFrame));
  const maxEnd = Math.max(...overlays.map((o) => o.startFrame + o.durationFrames));
  const normalized = overlays.map((o, idx) => {
    const rebased = { ...o, startFrame: o.startFrame - minStart };
    // Strip the branded `id` — templates use their own local ids.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ...rest } = rebased;
    void id;
    return { ...(rest as Omit<TextItem, "id"> | Omit<ShapeItem, "id"> | Omit<StickerItem, "id">), templateOverlayId: `t${idx}` } as TemplateOverlay;
  });
  return {
    id: `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    durationFrames: Math.max(1, maxEnd - minStart),
    overlays: normalized,
    params,
    createdAt: new Date().toISOString(),
  };
};

// ---------------------------------------------------------------------------
// Apply a template at a given start frame with concrete parameter values
// ---------------------------------------------------------------------------

/** A concrete set of parameter values, keyed by parameter name. */
export type TemplateValues = Record<string, string | number>;

const setPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const segs = path.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur[seg] == null || typeof cur[seg] !== "object") {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
};

/**
 * Materialize a template as a set of `Omit<*Item, "id">` objects, ready for
 * `addItemToTrack`. `startAtFrame` is applied to every overlay in the template.
 */
export const applyTemplate = (
  template: MotionGraphicsTemplate,
  values: TemplateValues,
  startAtFrame: number,
): Array<Omit<TextItem, "id"> | Omit<ShapeItem, "id"> | Omit<StickerItem, "id">> => {
  return template.overlays.map((overlay) => {
    // Fresh mutable copy (deep enough for our substitutable fields — nested
    // params targeting a compound object are the caller's responsibility).
    const copy = JSON.parse(JSON.stringify(overlay)) as unknown as Record<string, unknown>;
    delete copy.templateOverlayId;
    // Overlays lose `transform` after JSON round-trip if it uses functions;
    // reinstate a base transform so the item is always valid on paste.
    if (!copy.transform || typeof copy.transform !== "object") {
      copy.transform = identityTransform();
    }
    // Substitute each param whose target names this overlay.
    for (const param of template.params) {
      const v = values[param.name] ?? param.defaultValue;
      for (const target of param.targets) {
        if (target.overlayId !== overlay.templateOverlayId) continue;
        setPath(copy, target.path, v);
      }
    }
    copy.startFrame = (copy.startFrame as number) + startAtFrame;
    return copy as unknown as Omit<TextItem, "id"> | Omit<ShapeItem, "id"> | Omit<StickerItem, "id">;
  });
};

// ---------------------------------------------------------------------------
// A small built-in preset library — proves the pipeline end-to-end
// ---------------------------------------------------------------------------

/** Two-line lower-third title card with a bar background. */
export const builtInLowerThird = (): MotionGraphicsTemplate => {
  const now = new Date().toISOString();
  const durationFrames = 90;
  return {
    id: "tpl_builtin_lower_third",
    name: "Lower Third",
    durationFrames,
    createdAt: now,
    overlays: [
      {
        templateOverlayId: "bar",
        type: "shape",
        name: "Bar",
        startFrame: 0,
        durationFrames,
        transform: identityTransform(),
        effects: [],
        locked: false,
        shape: "rectangle",
        fillColor: "#000000cc",
        strokeColor: "#ffffff00",
        strokeWidthPx: 0,
        cornerRadiusPx: 8,
      },
      {
        templateOverlayId: "title",
        type: "text",
        name: "Title",
        startFrame: 0,
        durationFrames,
        transform: identityTransform(),
        effects: [],
        locked: false,
        text: "Your name here",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSizePx: 72,
        fontWeight: 700,
        fillColor: "#ffffff",
        alignment: "left",
        lineHeight: 1.15,
      },
      {
        templateOverlayId: "subtitle",
        type: "text",
        name: "Subtitle",
        startFrame: 0,
        durationFrames,
        transform: identityTransform(),
        effects: [],
        locked: false,
        text: "Role · Location",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSizePx: 36,
        fontWeight: 500,
        fillColor: "#dddddd",
        alignment: "left",
        lineHeight: 1.15,
      },
    ],
    params: [
      { name: "Name", kind: "text", defaultValue: "Your name here", targets: [{ overlayId: "title", path: "text" }] },
      { name: "Role", kind: "text", defaultValue: "Role · Location", targets: [{ overlayId: "subtitle", path: "text" }] },
      { name: "Accent color", kind: "color", defaultValue: "#000000cc", targets: [{ overlayId: "bar", path: "fillColor" }] },
    ],
  };
};

/** Big centered title used for opening cards. */
export const builtInTitleCard = (): MotionGraphicsTemplate => {
  const now = new Date().toISOString();
  const durationFrames = 90;
  return {
    id: "tpl_builtin_title_card",
    name: "Title Card",
    durationFrames,
    createdAt: now,
    overlays: [
      {
        templateOverlayId: "title",
        type: "text",
        name: "Title",
        startFrame: 0,
        durationFrames,
        transform: identityTransform(),
        effects: [],
        locked: false,
        text: "TITLE",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSizePx: 160,
        fontWeight: 800,
        fillColor: "#ffffff",
        alignment: "center",
        lineHeight: 1.1,
      },
    ],
    params: [
      { name: "Text", kind: "text", defaultValue: "TITLE", targets: [{ overlayId: "title", path: "text" }] },
      { name: "Size", kind: "number", defaultValue: 160, targets: [{ overlayId: "title", path: "fontSizePx" }] },
      { name: "Color", kind: "color", defaultValue: "#ffffff", targets: [{ overlayId: "title", path: "fillColor" }] },
    ],
  };
};

export const BUILT_IN_TEMPLATES: readonly MotionGraphicsTemplate[] = [
  builtInLowerThird(),
  builtInTitleCard(),
];
