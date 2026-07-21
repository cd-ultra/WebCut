/**
 * WebCut — built-in sounds library.
 *
 * Self-contained: sounds are synthesized to 16-bit PCM WAV at runtime (no
 * bundled audio binaries), then handed to the media pipeline as File objects.
 */

const SAMPLE_RATE = 44100;

const encodeWav = (samples: Float32Array, sampleRate = SAMPLE_RATE): Blob => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
};

/** Render `durationS` seconds via a per-sample generator into a WAV Blob. */
const render = (durationS: number, gen: (t: number, i: number) => number): Blob => {
  const n = Math.floor(durationS * SAMPLE_RATE);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = gen(i / SAMPLE_RATE, i);
  return encodeWav(samples);
};

const decay = (t: number, tau: number) => Math.exp(-t / tau);

export interface SoundDef {
  readonly name: string;
  readonly durationS: number;
  readonly make: () => Blob;
}

export const SOUND_LIBRARY: readonly SoundDef[] = [
  {
    name: "Beep",
    durationS: 0.3,
    make: () => render(0.3, (t) => Math.sin(2 * Math.PI * 880 * t) * decay(t, 0.12) * 0.6),
  },
  {
    name: "Click",
    durationS: 0.08,
    make: () => render(0.08, (t) => (Math.random() * 2 - 1) * decay(t, 0.01) * 0.7),
  },
  {
    name: "Chime",
    durationS: 0.9,
    make: () =>
      render(0.9, (t) => {
        const a = Math.sin(2 * Math.PI * 660 * t);
        const b = Math.sin(2 * Math.PI * 990 * t);
        return (a * 0.5 + b * 0.5) * decay(t, 0.35) * 0.5;
      }),
  },
  {
    name: "Whoosh",
    durationS: 0.6,
    make: () =>
      render(0.6, (t) => {
        const env = Math.sin((Math.PI * t) / 0.6);
        return (Math.random() * 2 - 1) * env * 0.4;
      }),
  },
  {
    name: "Thump",
    durationS: 0.4,
    make: () => render(0.4, (t) => Math.sin(2 * Math.PI * (120 - 60 * t) * t) * decay(t, 0.14) * 0.8),
  },
  {
    name: "Pop",
    durationS: 0.15,
    make: () => render(0.15, (t) => Math.sin(2 * Math.PI * (440 + 600 * t) * t) * decay(t, 0.04) * 0.6),
  },
];

/** Materialize a sound as a File ready for the import pipeline. */
export const soundToFile = (def: SoundDef): File =>
  new File([def.make()], `${def.name}.wav`, { type: "audio/wav" });
