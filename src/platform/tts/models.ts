/** SpeechT5 TTS (MIT) with its HiFi-GAN vocoder (MIT); weights are loaded from Hugging Face at the pinned revisions. */
export const SPEECHT5_MODEL = "Xenova/speecht5_tts";
export const SPEECHT5_VOCODER = "Xenova/speecht5_hifigan";
/**
 * 4-bit weights with fp16 activations. The 8-bit export of this model truncates and garbles speech (a Whisper round trip
 * returned "Welcome to the video." for a 12-word sentence); q4f16 round-trips word for word (docs/AUDIO_VOICE.md).
 */
export const SPEECHT5_DTYPE = "q4f16";
export const SPEAKER_EMBEDDING_SIZE = 512;
export const SPEECHT5_APPROX_MEGABYTES = 105;
