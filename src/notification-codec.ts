import { MPEGDecoder } from "mpg123-decoder"
import { setImmediate as yieldTurn } from "node:timers/promises"

export const MAX_SOUND_BYTES = 4 * 1024 * 1024
const MAX_SOUND_SECONDS = 10
const MAX_RATE = 96000
const MAX_SAMPLES = MAX_RATE * MAX_SOUND_SECONDS * 2
export const SOUND_RMS = 0.1 // -20 dBFS, consistent defaults/custom files.
export const SOUND_PEAK = 10 ** (-3 / 20)

interface Audio { channels: Float32Array[]; rate: number }
function valid(audio: Audio) {
  if (!Number.isInteger(audio.rate) || audio.rate < 8000 || audio.rate > MAX_RATE || ![1, 2].includes(audio.channels.length)
    || !audio.channels[0]?.length || audio.channels[0].length > audio.rate * MAX_SOUND_SECONDS
    || audio.channels.some(c => c.length !== audio.channels[0]!.length)) throw new Error("Unsupported notification audio")
  return audio
}

async function wav(bytes: Buffer, signal: AbortSignal): Promise<Audio> {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE"
    || bytes.readUInt32LE(4) + 8 > bytes.length) throw new Error("Invalid notification WAV")
  let format: Buffer | undefined, data: Buffer | undefined
  const end = bytes.readUInt32LE(4) + 8
  for (let offset = 12, chunks = 0; offset < end && chunks < 4096; chunks++) {
    signal.throwIfAborted()
    if (offset + 8 > end) throw new Error("Invalid notification WAV chunk")
    const size = bytes.readUInt32LE(offset + 4), next = offset + 8 + size
    if (next > end) throw new Error("Invalid notification WAV chunk")
    const name = bytes.toString("ascii", offset, offset + 4)
    if (name === "fmt ") { if (format) throw new Error("Duplicate WAV format"); format = bytes.subarray(offset + 8, next) }
    if (name === "data") { if (data) throw new Error("Duplicate WAV data"); data = bytes.subarray(offset + 8, next) }
    offset = next + (size % 2)
  }
  if (!format || format.length < 16 || !data) throw new Error("Missing notification WAV data")
  let kind = format.readUInt16LE(0)
  const count = format.readUInt16LE(2), rate = format.readUInt32LE(4), align = format.readUInt16LE(12), bits = format.readUInt16LE(14)
  if (kind === 0xfffe) {
    if (format.length < 40 || format.readUInt16LE(16) < 22 || format.readUInt16LE(18) !== bits
      || format.subarray(28, 40).toString("hex") !== "00001000800000aa00389b71") throw new Error("Unsupported WAV extension")
    kind = format.readUInt32LE(24)
  }
  if (!([1, 2].includes(count) && ((kind === 1 && [8, 16, 24, 32].includes(bits)) || (kind === 3 && bits === 32)))
    || align !== count * bits / 8 || format.readUInt32LE(8) !== rate * align || data.length % align) throw new Error("Unsupported notification WAV encoding")
  const frames = data.length / align
  const audio = valid({ rate, channels: Array.from({ length: count }, () => new Float32Array(frames)) })
  for (let i = 0; i < frames; i++) {
    if (i % 8192 === 0) { await yieldTurn(); signal.throwIfAborted() }
    for (let channel = 0; channel < count; channel++) {
      const offset = i * align + channel * bits / 8
      audio.channels[channel]![i] = kind === 3 ? data.readFloatLE(offset)
        : bits === 8 ? (data[offset]! - 128) / 128 : data.readIntLE(offset, bits / 8) / 2 ** (bits - 1)
    }
  }
  return audio
}

async function mp3(bytes: Uint8Array, signal: AbortSignal): Promise<Audio> {
  const decoder = new MPEGDecoder()
  let ready = false
  try {
    await decoder.ready; ready = true; signal.throwIfAborted()
    const pieces: Float32Array[][] = []
    let frames = 0, rate = 0
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      await yieldTurn(); signal.throwIfAborted()
      const part = decoder.decode(bytes.subarray(offset, offset + 4096))
      if (part.errors.length) throw new Error("Invalid notification MP3")
      if (!part.samplesDecoded) continue
      if (rate && rate !== part.sampleRate) throw new Error("Changing notification MP3 rate")
      rate = part.sampleRate; frames += part.samplesDecoded
      if (frames * 2 > MAX_SAMPLES || frames > rate * MAX_SOUND_SECONDS) throw new Error("Notification sound is too long")
      pieces.push(part.channelData)
    }
    const audio = valid({ rate, channels: [new Float32Array(frames), new Float32Array(frames)] })
    let offset = 0
    for (const part of pieces) {
      audio.channels[0]!.set(part[0]!, offset); audio.channels[1]!.set(part[1]!, offset)
      offset += part[0]!.length
    }
    return audio
  } finally { if (ready) decoder.free() }
}

/** One normalization path for bundled/custom MP3 and PCM/float WAV, no external decoder. */
export async function normalizedSound(bytes: Uint8Array, format: "mp3" | "wav", signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  if (!bytes.length || bytes.length > MAX_SOUND_BYTES) throw new Error("Notification sound size limit")
  const audio = format === "wav" ? await wav(Buffer.from(bytes), signal) : await mp3(bytes, signal)
  const length = audio.channels[0]!.length, count = audio.channels.length
  let square = 0, peak = 0
  for (let i = 0; i < length; i++) {
    if (i % 8192 === 0) { await yieldTurn(); signal.throwIfAborted() }
    for (const channel of audio.channels) {
      const value = channel[i]!
      if (!Number.isFinite(value)) throw new Error("Non-finite notification audio")
      square += value * value; peak = Math.max(peak, Math.abs(value))
    }
  }
  const rms = Math.sqrt(square / (length * count))
  const gain = rms > 1e-8 && peak > 0 ? Math.min(SOUND_RMS / rms, SOUND_PEAK / peak) : 1
  const dataBytes = length * count * 2
  const result = Buffer.alloc(44 + dataBytes)
  result.write("RIFF", 0); result.writeUInt32LE(36 + dataBytes, 4); result.write("WAVEfmt ", 8)
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(count, 22)
  result.writeUInt32LE(audio.rate, 24); result.writeUInt32LE(audio.rate * count * 2, 28)
  result.writeUInt16LE(count * 2, 32); result.writeUInt16LE(16, 34); result.write("data", 36); result.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < length; i++) {
    if (i % 8192 === 0) { await yieldTurn(); signal.throwIfAborted() }
    for (let channel = 0; channel < count; channel++) result.writeInt16LE(Math.round(audio.channels[channel]![i]! * gain * 32767), 44 + (i * count + channel) * 2)
  }
  return result
}
