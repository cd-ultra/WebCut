/**
 * WebCut — shared audio routing rules.
 *
 * Preview and export must never disagree about which tracks are audible, so
 * the mute/solo decision lives here and is imported by both
 * (`PreviewService` for the live WebAudio graph, `ExportService` for the
 * offline mixdown).
 *
 * Solo is deliberately an AUDIO-only concept, matching every other NLE: video
 * visibility is controlled separately by `Track.hidden`. Soloing an audio
 * track therefore silences other tracks without blanking the picture.
 */

import type { Project, Track, TrackId } from "../types/timeline";

/**
 * Ids of every track that should be heard.
 *
 * When at least one track is soloed, only soloed tracks are candidates;
 * otherwise every track is. An explicitly muted track is never audible, even
 * when it is also soloed — mute wins, which is what a mixer's mute button
 * means everywhere else.
 */
export const audibleTrackIds = (project: Project): ReadonlySet<TrackId> => {
  const soloed = project.tracks.filter((track) => track.soloed);
  const pool = soloed.length > 0 ? soloed : project.tracks;
  return new Set(pool.filter((track) => !track.muted).map((track) => track.id));
};

/** Convenience for call sites that already hold the track and the solo state. */
export const isTrackAudible = (track: Track, anySoloed: boolean): boolean =>
  !track.muted && (!anySoloed || track.soloed);

/** True when any track in the project is soloed. */
export const hasSoloedTrack = (project: Project): boolean => project.tracks.some((track) => track.soloed);
