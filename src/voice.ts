// Huddle voice for OpenCode agents, through OpenRouter. OpenCode has no live
// audio, so a seat is a loop: the owner's speech is cut into utterances,
// transcribed by an audio-input model, run as a turn in the agent's OpenCode
// session for the room (with its tools), and its final message read aloud by
// an audio-output model. The key is OpenCode's own OpenRouter login, read
// where `opencode auth login` keeps it.
import type { AgentType, Host } from "./buzz";
import type { Config } from "./settings";

type Seat = Parameters<NonNullable<AgentType<Config>["voice"]>>[0];
type Connection = Awaited<ReturnType<NonNullable<AgentType<Config>["voice"]>>>;

export const OPENROUTER = "https://openrouter.ai";
const COMPLETIONS = `${OPENROUTER}/api/v1/chat/completions`;
const AUTH_PATHS = [
  "~/.local/share/opencode/auth.json",
  "~/Library/Application Support/opencode/auth.json",
];
export const LISTEN_MODEL = "google/gemini-2.5-flash";
export const SPEAK_MODEL = "openai/gpt-audio-mini";
const SPEAK_VOICE = "alloy";
const NO_SPEECH = "NONE";

const RATE = 48_000;
const FRAME = 960; // 20 ms, what the seat's output takes.
const SPEAK_RATE = 24_000; // gpt-audio's pcm16.
const LISTEN_RATE = 16_000;
const PRE_ROLL = RATE * 0.3;
const END_SILENCE_MS = 700;
const MIN_SPEECH_MS = 300;
const MAX_SPEECH_MS = 30_000;
const LEAD_FRAMES = 3;

/** The OpenRouter key OpenCode signed in with, or undefined without one. */
export async function openRouterKey(
  readFile: NonNullable<Host["readFile"]>,
): Promise<string | undefined> {
  for (const path of AUTH_PATHS) {
    try {
      const auth = JSON.parse(new TextDecoder().decode(await readFile(path)));
      const entry = auth?.openrouter;
      const key = entry?.key ?? entry?.access;
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      /* Missing or unreadable: try the next place. */
    }
  }
  return undefined;
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function unbase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 48 kHz float samples as a 16 kHz 16-bit mono WAV. */
export function toWav(samples: Float32Array): Uint8Array {
  const step = RATE / LISTEN_RATE;
  const count = Math.floor(samples.length / step);
  const out = new Uint8Array(44 + count * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, LISTEN_RATE, true);
  view.setUint32(28, LISTEN_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += samples[i * step + j] ?? 0;
    const s = Math.max(-1, Math.min(1, sum / step));
    view.setInt16(44 + i * 2, Math.round(s * 0x7fff), true);
  }
  return out;
}

/** 24 kHz 16-bit little-endian PCM as 48 kHz float samples. */
export function fromPcm16(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count * (RATE / SPEAK_RATE));
  for (let i = 0; i < count; i++) {
    const a = view.getInt16(i * 2, true) / 0x8000;
    const b = i + 1 < count ? view.getInt16((i + 1) * 2, true) / 0x8000 : a;
    out[i * 2] = a;
    out[i * 2 + 1] = (a + b) / 2;
  }
  return out;
}

/** The audio and its transcript from a streamed audio completion. */
export function readSpoken(body: string) {
  const audio: string[] = [];
  const words: string[] = [];
  let failure: string | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") break;
    try {
      const chunk = JSON.parse(data);
      if (chunk.error) failure = chunk.error.message ?? String(chunk.error);
      const delta = chunk.choices?.[0]?.delta?.audio;
      if (typeof delta?.data === "string") audio.push(delta.data);
      if (typeof delta?.transcript === "string") words.push(delta.transcript);
    } catch {
      /* A keep-alive or partial line. */
    }
  }
  return {
    pcm: unbase64(audio.join("")),
    transcript: words.join("").trim(),
    ...(failure ? { error: failure } : {}),
  };
}

/** Cuts the owner's audio into utterances by loudness against a tracked floor. */
export class Utterances {
  private pre: Float32Array[] = [];
  private preLength = 0;
  private speech: Float32Array[] = [];
  private speechLength = 0;
  private quiet = 0;
  private voiced = 0;
  private floor = 0.005;
  constructor(private readonly done: (samples: Float32Array) => void) {}
  push(input: readonly number[]) {
    const frame = Float32Array.from(input);
    if (!frame.length) return;
    let sum = 0;
    for (const s of frame) sum += s * s;
    const rms = Math.sqrt(sum / frame.length);
    const loud = rms > Math.max(0.015, this.floor * 3);
    if (!this.speechLength) {
      if (!loud) {
        this.floor = this.floor * 0.95 + rms * 0.05;
        this.pre.push(frame);
        this.preLength += frame.length;
        while (this.preLength - (this.pre[0]?.length ?? 0) > PRE_ROLL)
          this.preLength -= this.pre.shift()?.length ?? 0;
        return;
      }
      this.speech = this.pre;
      this.speechLength = this.preLength;
      this.pre = [];
      this.preLength = 0;
    }
    this.speech.push(frame);
    this.speechLength += frame.length;
    this.quiet = loud ? 0 : this.quiet + frame.length;
    if (loud) this.voiced += frame.length;
    if (
      this.quiet >= (RATE * END_SILENCE_MS) / 1000 ||
      this.speechLength >= (RATE * MAX_SPEECH_MS) / 1000
    )
      this.flush();
  }
  /** Drops what was heard so far, such as the agent's own voice. */
  reset() {
    this.pre = [];
    this.preLength = 0;
    this.speech = [];
    this.speechLength = 0;
    this.quiet = 0;
    this.voiced = 0;
  }
  private flush() {
    const spoken = this.voiced;
    const all = new Float32Array(this.speechLength);
    let at = 0;
    for (const part of this.speech) {
      all.set(part, at);
      at += part.length;
    }
    this.reset();
    if (spoken >= (RATE * MIN_SPEECH_MS) / 1000) this.done(all);
  }
}

/** Runs what the owner said as a turn, and gives back what to say. Leaving
 * the Huddle doesn't stop the work; `listening` says whether anyone will hear
 * the answer. */
export type Think = (heard: string, listening: () => boolean) => Promise<string>;

/** Opens a Huddle seat for an OpenCode agent. */
export async function openVoice(
  seat: Seat,
  host: Host,
  think: Think,
): Promise<Connection> {
  seat.signal.throwIfAborted();
  if (seat.agent.protection)
    throw new Error("Voice is unavailable for protected agents");
  if (!host.readFile) throw new Error("Voice needs the desktop app");
  const key = await openRouterKey(host.readFile.bind(host));
  if (!key)
    throw new Error(
      "Sign OpenCode in to OpenRouter (opencode auth login) to use voice",
    );
  seat.signal.throwIfAborted();

  let busy = false;
  let closed = false;
  const queue: Float32Array[] = [];

  const post = async (body: unknown) => {
    const response = await host.request({
      url: COMPLETIONS,
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Title": "Buzz OpenCode voice",
      },
      body: JSON.stringify(body),
      timeoutMs: 90_000,
    });
    if (response.status < 200 || response.status >= 300) {
      let reason = `OpenRouter answered ${response.status}`;
      try {
        reason = JSON.parse(response.body)?.error?.message ?? reason;
      } catch {
        /* Not JSON. */
      }
      throw new Error(reason);
    }
    return response.body;
  };

  const listen = async (samples: Float32Array) => {
    const body = await post({
      model: LISTEN_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Transcribe this speech verbatim. Reply with only the words spoken. If there is no intelligible speech, reply with exactly ${NO_SPEECH}.`,
            },
            {
              type: "input_audio",
              input_audio: { data: base64(toWav(samples)), format: "wav" },
            },
          ],
        },
      ],
    });
    const text = String(
      JSON.parse(body)?.choices?.[0]?.message?.content ?? "",
    ).trim();
    return text && text !== NO_SPEECH ? text : undefined;
  };

  const speak = async (text: string) => {
    const body = await post({
      model: SPEAK_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a text-to-speech voice. Read the user's message aloud exactly as written, in a natural, friendly tone. Add nothing, answer nothing, and leave nothing out.",
        },
        { role: "user", content: text },
      ],
      modalities: ["text", "audio"],
      audio: { voice: SPEAK_VOICE, format: "pcm16" },
      stream: true,
    });
    const spoken = readSpoken(body);
    if (spoken.error) throw new Error(spoken.error);
    return spoken;
  };

  const play = async (samples: Float32Array) => {
    const start = performance.now();
    for (let i = 0, n = 0; i < samples.length; i += FRAME, n++) {
      if (closed) return;
      const frame = new Array<number>(FRAME).fill(0);
      for (let j = 0; j < FRAME && i + j < samples.length; j++)
        frame[j] = Math.max(-1, Math.min(1, samples[i + j] || 0));
      await seat.output(frame);
      // Stay a few frames ahead of real time; the seat drops frames past 5.
      const wait = start + (n - LEAD_FRAMES) * 20 - performance.now();
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    }
  };

  const say = (speaker: "owner" | "agent", text: string) =>
    seat.transcript(speaker, text).catch((error) => {
      if (!closed) console.warn("opencode voice transcript failed", error);
    });

  const answer = async (samples: Float32Array) => {
    seat.thinking?.(true);
    try {
      const heard = await listen(samples);
      if (closed || !heard) return;
      void say("owner", heard);
      const reply = await think(heard, () => !closed);
      if (closed) return;
      void say("agent", reply);
      const spoken = await speak(reply);
      if (closed) return;
      seat.thinking?.(false);
      await play(fromPcm16(spoken.pcm));
    } catch (error) {
      if (closed) return;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn("opencode voice turn failed", error);
      void say("agent", `(I couldn't answer that by voice: ${reason.slice(0, 200)})`);
    } finally {
      seat.thinking?.(false);
    }
  };

  const drain = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let next = queue.shift(); next && !closed; next = queue.shift())
        await answer(next);
    } finally {
      busy = false;
      // What the mic heard while the agent spoke is mostly the agent.
      utterances.reset();
    }
  };

  const utterances = new Utterances((samples) => {
    queue.push(samples);
    void drain();
  });

  const close = () => {
    closed = true;
    queue.length = 0;
    seat.signal.removeEventListener("abort", close);
  };
  seat.signal.addEventListener("abort", close, { once: true });

  return {
    input(samples) {
      if (closed || busy) return;
      utterances.push(samples);
    },
    close,
  };
}
