# WebCut

Local-first, browser-based NLE. Vite + React 18 + TypeScript (strict) + Tailwind v4, WebGPU compositing, WebCodecs decode, onnxruntime-web neural matting. Verified: `tsc -b` clean, `vite build` clean, dev server serves HTTP 200 on `0.0.0.0:5173`.

## Boot via Docker

```sh
docker compose up --build
# → http://localhost:5173
```

The compose service now runs `npm install && npm run dev` automatically (node_modules lives in an anonymous container volume — your host folder stays clean). Vite binds `0.0.0.0:5173` with polling file-watch (required for Windows bind mounts) and COOP/COEP headers (cross-origin isolation → multithreaded WASM for onnxruntime-web).

Browser requirements: Chrome/Edge 113+ with hardware acceleration. Verify WebGPU at `chrome://gpu` → "WebGPU: Hardware accelerated".

## Directory structure

```
src/
├── types/timeline.ts            # Domain model: Project / Track / TrackItem (clip|shape|text),
│                                #   Keyframe (linear|bezier|hold) + sampler, Transform, Effect,
│                                #   CorridorKeyParams. Integer-frame time base, branded IDs.
├── services/
│   ├── FileSystemService.ts     # File System Access API: media import via showOpenFilePicker,
│   │                            #   .webcut save/load via showSaveFilePicker, handle persistence
│   │                            #   in IndexedDB, chunked media streaming generator.
│   └── OnnxMatteService.ts      # onnxruntime-web session: "webgpu" EP first, "wasm" fallback.
│                                #   NCHW preprocessing, drop-frame backpressure.
├── store/timelineStore.ts       # Zustand structural state + `transport` side-channel:
│                                #   playhead mutates outside React; subscribers paint
│                                #   imperatively → 60 FPS scrubs with zero tree re-renders.
├── effects/CorridorKeyShader.ts # WGSL: BT.709 chroma-distance matte, erosion, 9-tap feather,
│                                #   boundary-aware spill unmixing, ONNX alpha-matte fusion at
│                                #   @group(1) @binding(3). Uniform packer + pass factory +
│                                #   NeuralMatteStreamer (r8unorm streaming texture).
└── components/
    ├── VideoPlayer.tsx          # WebGPU init (adapter→device→context.configure), persistent
    │                            #   render pipeline, command encoder per frame, WebCodecs
    │                            #   DecodeBridge (VideoDecoder), VideoFrame→texture ingest.
    ├── Timeline.tsx             # Frame-accurate ruler scrub, px/frame zoom, razor split,
    │                            #   move/trim drags, snapping, J/K/L-style keys (Space, ←/→, V, C).
    └── MainLayout.tsx           # Media Pool | WebGPU viewer | Inspector (CorridorKey controls)
                                 #   over the multi-track timeline.
```

## WebGPU initialization checks (`VideoPlayer.tsx → initWebGPU`)

1. `"gpu" in navigator` — API surface exists (else "unsupported" UI state).
2. `requestAdapter({ powerPreference: "high-performance" })` — null ⇒ GPU blocklisted.
3. `requestDevice()` + `device.lost` handler — logs non-`destroyed` device loss.
4. `canvas.getContext("webgpu")` + `configure({ device, format: getPreferredCanvasFormat() })`.
5. Adapter vendor/architecture surfaced in the viewer's corner badge.

## Notes

- Keying without a model works immediately (procedural chroma matte). To enable neural matting, load a MODNet/RVM-style `.onnx` through `onnxMatteService.loadModel()` and check "Drive matte with ONNX neural session" in the Inspector.
- Demuxing (mp4box.js or similar) is the intended feeder for `DecodeBridge.decode()`; the bridge, GPU upload path, and matte slot are fully wired.
