import { attachmentsReadImage } from "./api/attachments";
import { useVaultStore } from "../state/vaultStore";

/**
 * In-memory cache of vault images for the Markdown viewer, so re-renders
 * (every pin/tag/task change re-renders the note) don't re-read and
 * re-encode each image. Keyed by vault + candidate paths; failures are
 * not cached because the file may appear later (sync, paste).
 */
const IMAGE_CACHE_LIMIT = 200;
const imageCache = new Map<string, Promise<string>>();

/** Load a vault image as a `data:` URL (see `attachments_read_image`). */
export function loadVaultImage(candidates: string[]): Promise<string> {
  const vault = useVaultStore.getState().active?.root ?? "";
  const key = `${vault}\n${candidates.join("\n")}`;
  const hit = imageCache.get(key);
  if (hit !== undefined) return hit;
  const pending = attachmentsReadImage(candidates);
  imageCache.set(key, pending);
  pending.catch(() => imageCache.delete(key));
  if (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  return pending;
}

/** Forget every cached image (tests). */
export function clearViewerImageCache(): void {
  imageCache.clear();
}
