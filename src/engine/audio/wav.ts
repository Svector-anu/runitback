/** 16-bit PCM WAV bytes for equal-length channels in [-1, 1] (values beyond are clipped). */
export function encodeWav(input: { channels: ReadonlyArray<Float32Array>; sampleRate: number }): Uint8Array {
  const { channels, sampleRate } = input;
  const channelCount = channels.length;
  const length = channels[0]?.length ?? 0;
  if (channelCount === 0) throw new Error("A WAV file needs at least one channel");
  const dataBytes = length * channelCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (const channel of channels) {
      const v = Math.max(-1, Math.min(1, channel[i] ?? 0));
      view.setInt16(offset, Math.round(v < 0 ? v * 32768 : v * 32767), true);
      offset += 2;
    }
  }
  return bytes;
}
