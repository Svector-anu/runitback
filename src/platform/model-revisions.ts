/**
 * Hugging Face commit hashes the default models are loaded at. Loading `main` would let an upstream push silently
 * change embeddings and transcripts while the stored model id stays the same. Bump a hash only together with
 * DEFAULT_WHISPER_MODEL / DEFAULT_CLIP_MODEL review and the real-model specs, and record it in docs/SUPPLY_CHAIN.md.
 */
export const PINNED_MODEL_REVISIONS: Readonly<Record<string, string>> = {
  "onnx-community/whisper-tiny.en_timestamped": "aeaa13760958b03fac5062f457d317d3319c3168",
  "Xenova/clip-vit-base-patch32": "d15189d7028b43f1d3e65039190477f6af591c2a",
  "Xenova/opus-mt-en-es": "4b002a4c7edd54a7ced58877258b87f7efd3f892",
  "Xenova/opus-mt-en-fr": "28726206f80896b90035bd99cccd5cc1e151f916",
  "Xenova/opus-mt-es-en": "eadfd7c658a9d8929ac3b8e996b68a68e2c7d480",
  "Xenova/speecht5_tts": "1723781b8ce2d02f0400c8337be04ae8ee3d6d56",
  "Xenova/speecht5_hifigan": "cf980c3610d7b7f20919960031066ef7905737bd",
};

/** The pinned commit for a known model repo; custom model ids (test seams, future models) track `main`. */
export function revisionFor(model: string): string {
  return PINNED_MODEL_REVISIONS[model] ?? "main";
}
