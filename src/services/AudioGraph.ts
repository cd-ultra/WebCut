/**
 * WebCut — live preview audio mixer (#100).
 *
 * Preview used to have no audio path at all for audio tracks: media elements
 * were created only for *visual* layers and played their own audio straight to
 * the output, so track gain/pan/solo were export-only concepts and a clip on an
 * audio track was structurally incapable of making sound.
 *
 * This module routes every preview media element through one mixer-shaped
 * WebAudio graph:
 *
 *   element -> MediaElementAudioSourceNode -> clipGain
 *                                              |
 *                        trackGain -> trackPanner -> trackAnalyser -> master -> destination
 *
 * Per-clip gain (clip dB + keyframed ramp + transition fade) lives on the clip
 * node; per-track trim/pan/mute/solo live on the track nodes, mirroring the
 * offline graph `ExportService.mixAndEncodeAudio` builds.
 *
 * Browser constraints this deliberately works around:
 *
 * 1. `createMediaElementSource` may be called AT MOST ONCE per element — a
 *    second call throws InvalidStateError — so sources are cached by element
 *    identity and never rebuilt.
 * 2. Once an element is routed through the graph its audio no longer reaches
 *    the destination directly, and `element.muted` feeds *silence* into the
 *    graph. Attached elements are therefore force-unmuted with `volume = 1`,
 *    and all attenuation (including mute) is expressed as gain. Callers must
 *    not set `.muted` / `.volume` on an attached element.
 * 3. An AudioContext starts suspended until a user gesture. `resume()` is
 *    called from the transport play path and from a one-shot gesture listener.
 * 4. If WebAudio is unavailable or never reaches "running", `enabled` goes
 *    false and callers fall back to plain element volume/mute control, so
 *    preview audio can never regress to silence because of this file.
 */

import type { TrackId } from "../types/timeline";

interface TrackNodes {
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  readonly analyser: AnalyserNode;
}

interface ElementNodes {
  readonly source: MediaElementAudioSourceNode;
  readonly gain: GainNode;
  trackId: TrackId | null;
}

/** Short ramp for gain changes; instant sets click audibly. */
const RAMP_S = 0.015;

class AudioGraph {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private tracks = new Map<TrackId, TrackNodes>();
  private elements = new Map<HTMLMediaElement, ElementNodes>();
  /** False once we know the graph can't be used; callers then self-manage. */
  private usable = true;
  private gestureHooked = false;

  /** True when elements should be routed through the graph. */
  get enabled(): boolean {
    return this.usable;
  }

  /**
   * Create (once) the AudioContext and master bus. Returns null when WebAudio
   * is unavailable, which flips the graph off permanently for this session.
   */
  private context(): AudioContext | null {
    if (!this.usable) return null;
    if (this.ctx) return this.ctx;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("AudioContext unavailable");
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.hookGesture();
      return ctx;
    } catch (error) {
      console.error("[WebCut] WebAudio unavailable, falling back to element audio:", error);
      this.usable = false;
      return null;
    }
  }

  /**
   * Autoplay policy keeps a fresh context suspended until the page has seen a
   * gesture. Transport play already is one, but a one-shot listener covers the
   * case where the context was created during an earlier, non-gesture sync.
   */
  private hookGesture(): void {
    if (this.gestureHooked) return;
    this.gestureHooked = true;
    const wake = () => void this.resume();
    window.addEventListener("pointerdown", wake, { once: true, passive: true });
    window.addEventListener("keydown", wake, { once: true, passive: true });
  }

  /** Resume the context; safe to call repeatedly and before any attach. */
  async resume(): Promise<void> {
    const ctx = this.context();
    if (!ctx || ctx.state === "running") return;
    try {
      await ctx.resume();
    } catch {
      /* Still suspended — a later gesture will retry. */
    }
  }

  /** Lazily build the per-track gain -> pan -> analyser chain. */
  private ensureTrack(trackId: TrackId): TrackNodes | null {
    const ctx = this.context();
    if (!ctx || !this.master) return null;
    const existing = this.tracks.get(trackId);
    if (existing) return existing;
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    gain.connect(panner).connect(analyser).connect(this.master);
    const nodes: TrackNodes = { gain, panner, analyser };
    this.tracks.set(trackId, nodes);
    return nodes;
  }

  /**
   * Route `element` into `trackId`'s channel strip. Idempotent per element; a
   * later call with a different track re-patches the existing clip gain node
   * rather than creating a second source (which would throw).
   *
   * Returns false when the graph is unusable, telling the caller to fall back
   * to `element.volume` / `element.muted`.
   */
  attach(element: HTMLMediaElement, trackId: TrackId): boolean {
    const ctx = this.context();
    if (!ctx) return false;
    // Only adopt an element once the context is actually running. Routing into
    // a suspended graph would silence it, and the adoption is irreversible
    // (constraint 1). Until then the caller keeps using plain element volume,
    // so audio plays either way; playback re-syncs every frame, so the handover
    // lands within a frame of resume() completing.
    if (ctx.state !== "running" && !this.elements.has(element)) {
      void this.resume();
      return false;
    }
    const track = this.ensureTrack(trackId);
    if (!track) return false;

    let entry = this.elements.get(element);
    if (!entry) {
      try {
        const source = ctx.createMediaElementSource(element);
        const gain = ctx.createGain();
        gain.gain.value = 0; // silent until the first setClipGain of this sync
        source.connect(gain);
        entry = { source, gain, trackId: null };
        this.elements.set(element, entry);
      } catch (error) {
        // A source already exists for this element but we lost the mapping, or
        // the element is cross-origin. Either way it can't join the graph.
        console.error("[WebCut] could not route element into audio graph:", error);
        return false;
      }
    }

    // The element's own output must be wide open: everything downstream of the
    // source node is what actually shapes the signal (see file header).
    element.muted = false;
    element.volume = 1;

    if (entry.trackId !== trackId) {
      if (entry.trackId !== null) entry.gain.disconnect();
      entry.gain.connect(track.gain);
      entry.trackId = trackId;
    }
    return true;
  }

  /** Set a clip's linear gain (0 = muted). No-op for unattached elements. */
  setClipGain(element: HTMLMediaElement, linearGain: number): void {
    const entry = this.elements.get(element);
    const ctx = this.ctx;
    if (!entry || !ctx) return;
    const value = Math.max(0, Math.min(1, linearGain));
    const param = entry.gain.gain;
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(value, ctx.currentTime, RAMP_S);
  }

  /** Apply a track's mixer trim and pan. `gainDb` is already mute/solo-aware. */
  setTrackMix(trackId: TrackId, linearGain: number, pan: number): void {
    const track = this.ensureTrack(trackId);
    const ctx = this.ctx;
    if (!track || !ctx) return;
    const g = track.gain.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setTargetAtTime(Math.max(0, Math.min(1, linearGain)), ctx.currentTime, RAMP_S);
    track.panner.pan.value = Math.max(-1, Math.min(1, pan));
  }

  /**
   * Current peak level [0,1] for a track, for mixer meters. Returns 0 when the
   * track has no channel strip yet.
   */
  peakLevel(trackId: TrackId): number {
    const track = this.tracks.get(trackId);
    if (!track) return 0;
    const buf = new Uint8Array(track.analyser.fftSize);
    track.analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const sample of buf) {
      const deviation = Math.abs(sample - 128) / 128;
      if (deviation > peak) peak = deviation;
    }
    return peak;
  }

  /** Drop an element's nodes when its cached media element is discarded. */
  release(element: HTMLMediaElement): void {
    const entry = this.elements.get(element);
    if (!entry) return;
    try {
      entry.gain.disconnect();
      entry.source.disconnect();
    } catch {
      /* already torn down */
    }
    this.elements.delete(element);
  }

  /** Tear the whole graph down (preview sink unmount). */
  dispose(): void {
    for (const element of [...this.elements.keys()]) this.release(element);
    for (const track of this.tracks.values()) {
      try {
        track.gain.disconnect();
        track.panner.disconnect();
        track.analyser.disconnect();
      } catch {
        /* already torn down */
      }
    }
    this.tracks.clear();
    this.master?.disconnect();
    this.master = null;
    void this.ctx?.close().catch(() => {
      /* closing an already-closed context is fine */
    });
    this.ctx = null;
  }
}

export const audioGraph = new AudioGraph();
