/**
 * WebCut — stable cross-machine media identity.
 *
 * `MediaAsset.handleKey` is a random UUID scoped to one browser profile, so it
 * says nothing about *which file* an asset is. That makes a saved project
 * unopenable anywhere else: every asset dead-ends in `resolveMediaFile`. A
 * content hash gives each asset an identity that survives moving the project
 * to another machine, so media can be relinked instead of lost.
 *
 * The digest samples rather than reading the whole file: hashing a 4 GB source
 * would stall an import for tens of seconds, while size + head + tail is O(1)
 * and more than enough to tell a user's own media files apart. It is an
 * identity check, not a security boundary — a deliberately altered file could
 * of course collide.
 */

/** Bytes read from each end of the file. */
const SAMPLE_BYTES = 1024 * 1024;

/** Algorithm tag, so a future full-file scheme can coexist with these. */
const PREFIX = "sha256s";

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Content hash for a media file, or `undefined` when WebCrypto is unavailable.
 *
 * The undefined case is real, not defensive padding: `npm run dev` binds
 * `--host 0.0.0.0`, and loading the app over a LAN IP is an insecure context
 * where `crypto.subtle` does not exist. Import must still succeed there, so
 * callers treat the hash as optional and relinking falls back to matching on
 * file name and size.
 */
export const computeContentHash = async (file: File): Promise<string | undefined> => {
  if (!crypto?.subtle) return undefined;
  try {
    const head = await file.slice(0, SAMPLE_BYTES).arrayBuffer();
    // Non-overlapping tail; for files under 2 MiB the head already covers all
    // of it and the tail slice is empty, which is fine — size disambiguates.
    const tailStart = Math.max(SAMPLE_BYTES, file.size - SAMPLE_BYTES);
    const tail = await file.slice(tailStart, file.size).arrayBuffer();

    // Length-prefix with the file size so two files that share their first and
    // last megabyte but differ in the middle can't collide on length alone.
    const sizeTag = new TextEncoder().encode(`${file.size}:`);
    const payload = new Uint8Array(sizeTag.length + head.byteLength + tail.byteLength);
    payload.set(sizeTag, 0);
    payload.set(new Uint8Array(head), sizeTag.length);
    payload.set(new Uint8Array(tail), sizeTag.length + head.byteLength);

    return `${PREFIX}:${toHex(await crypto.subtle.digest("SHA-256", payload))}`;
  } catch (error) {
    // A revoked file handle or read error must not block the import.
    console.error("[WebCut] content hash failed:", error);
    return undefined;
  }
};
