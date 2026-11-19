// Huddle voice for OpenCode agents, through OpenRouter. OpenCode has no live
// audio, so a seat is a loop: the owner's speech is cut into utterances,
// transcribed by an audio-input model, run as a turn in the agent's OpenCode
// session for the room (with its tools), and its final message read aloud by
// an audio-output model, word for word as the agent's own line: first
// sentence first, so it starts talking while the rest is voiced. The owner is
// heard throughout: talking over the agent cuts it off, and what they say
// while it works is answered next. A turn that runs long gets a quick "On it",
// and what the agent posts for its owner elsewhere is said aloud too. Both sides are
// posted in the room as plain messages from the agent. The key is OpenCode's
// own OpenRouter login, read where `opencode auth login` keeps it.
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
/** How much of the line the voice must have said for it to be played. */
const FAITHFUL = 0.8;
/** A piece shorter than this takes the next sentence with it. */
const MIN_PART = 20;
/** The most characters of sentences grouped into one piece after the first. */
const PART = 240;

const RATE = 48_000;
const FRAME = 960; // 20 ms, what the seat's output takes.
const SPEAK_RATE = 24_000; // gpt-audio's pcm16.
const LISTEN_RATE = 16_000;
const PRE_ROLL = RATE * 0.3;
const END_SILENCE_MS = 700;
const MIN_SPEECH_MS = 300;
const MAX_SPEECH_MS = 30_000;
const LEAD_FRAMES = 3;
/** How long the owner must talk over the agent to cut it off. */
const BARGE_MS = 250;
/** How long a turn may run before the agent says it's on it. */
const ACK_MS = 1500;
const ACK_LINE = "On it.";

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

export function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function unbase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 48 kHz float samples as 16 kHz 16-bit little-endian mono PCM. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const step = RATE / LISTEN_RATE;
  const count = Math.floor(samples.length / step);
  const out = new Uint8Array(count * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += samples[i * step + j] ?? 0;
    const s = Math.max(-1, Math.min(1, sum / step));
    view.setInt16(i * 2, Math.round(s * 0x7fff), true);
  }
  return out;
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

function words(text: string) {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** How closely `said` matches `line`, from 0 to 1: the share of words they
 * have in common, against the longer of the two. */
export function likeness(line: string, said: string) {
  const want = words(line);
  const got = words(said);
  if (!want.length || !got.length) return want.length === got.length ? 1 : 0;
  const left = new Map<string, number>();
  for (const w of got) left.set(w, (left.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of want) {
    const n = left.get(w) ?? 0;
    if (n) {
      shared++;
      left.set(w, n - 1);
    }
  }
  return shared / Math.max(want.length, got.length);
}

/** The request that has the audio model perform `line` as the agent's own
 * words. The line sits in the system prompt, not a user turn, so the model
 * has nothing to answer: given it as a message, it replied to it instead. */
export function speakRequest(line: string) {
  return {
    model: SPEAK_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a voice actor recording one line for an AI assistant, in the assistant's own first-person voice. Your line, word for word, is everything between the markers:\n\n<line>\n${line}\n</line>\n\nEvery word between the markers is spoken, even a lead-in such as "First, who I am:". When the director says "Action", perform exactly that line and nothing else: no reply, no comment, no changes.`,
      },
      { role: "user", content: "Action" },
    ],
    modalities: ["text", "audio"],
    audio: { voice: SPEAK_VOICE, format: "pcm16" },
    stream: true,
  };
}

/** The answer in the pieces it is voiced in, in order: its first sentence on
 * its own, so speech starts as soon as that is ready, then the rest in
 * sentences grouped up to `PART` characters, voiced while earlier ones play. */
export function parts(text: string): string[] {
  const sentences = text
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      (last.length < MIN_PART ||
        (out.length > 1 && last.length + sentence.length < PART))
    )
      out[out.length - 1] = `${last} ${sentence}`;
    else out.push(sentence);
  }
  return out;
}

/** Cuts the owner's audio into utterances by loudness against a tracked floor.
 * `strict` asks for louder speech, as while the agent talks; `started` is
 * called once an utterance has been voiced for `BARGE_MS`. */
export class Utterances {
  private pre: Float32Array[] = [];
  private preLength = 0;
  private speech: Float32Array[] = [];
  private speechLength = 0;
  private quiet = 0;
  private voiced = 0;
  private floor = 0.005;
  private announced = false;
  constructor(
    private readonly done: (samples: Float32Array) => void,
    private readonly started?: () => void,
  ) {}
  push(input: ArrayLike<number>, strict = false) {
    const frame = Float32Array.from(input);
    if (!frame.length) return;
    let sum = 0;
    for (const s of frame) sum += s * s;
    const rms = Math.sqrt(sum / frame.length);
    const loud = strict
      ? rms > Math.max(0.04, this.floor * 5)
      : rms > Math.max(0.015, this.floor * 3);
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
    if (!this.announced && this.voiced >= (RATE * BARGE_MS) / 1000) {
      this.announced = true;
      this.started?.();
    }
    if (
      this.quiet >= (RATE * END_SILENCE_MS) / 1000 ||
      this.speechLength >= (RATE * MAX_SPEECH_MS) / 1000
    )
      this.flush();
  }
  /** Drops what was heard so far. */
  reset() {
    this.pre = [];
    this.preLength = 0;
    this.speech = [];
    this.speechLength = 0;
    this.quiet = 0;
    this.voiced = 0;
    this.announced = false;
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

/** A message the agent posted, as something to say aloud: no markdown, links
 * or code, and mentions as plain names. */
export function spoken(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/nostr:\S+/g, "")
    .replace(/(^|\s)@(\S)/g, "$1$2")
    .replace(/^\s*(#+|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Runs what the owner said as a turn, posts the answer in the room, and
 * gives it back to say. Leaving the Huddle doesn't stop the work. */
export type Think = (heard: string) => Promise<string>;
/** Posts a line of the Huddle in the room. */
export type Post = (speaker: "owner" | "agent", text: string) => Promise<void>;

/** Opens a Huddle seat for an OpenCode agent. */
export async function openVoice(
  seat: Seat,
  host: Host,
  think: Think,
  post: Post,
): Promise<Connection & { announce(text: string): void }> {
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
  let playing = false;
  /** The owner talked over the agent: stop what it's saying. */
  let cut = false;
  const queue: ({ heard: Float32Array } | { say: string })[] = [];

  const send = async (body: unknown) => {
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
    const body = await send({
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
    // The voice is a chat model, so it can still answer the line instead of
    // saying it: check what it said, try once more, and stay quiet rather
    // than speak words that aren't the agent's. The text is posted either way.
    for (let attempt = 0; attempt < 2; attempt++) {
      const spoken = readSpoken(await send(speakRequest(text)));
      if (spoken.error) throw new Error(spoken.error);
      if (likeness(text, spoken.transcript) >= FAITHFUL) return spoken;
      console.warn("opencode voice changed the line", spoken.transcript);
    }
    return undefined;
  };

  const play = async (samples: Float32Array) => {
    playing = true;
    try {
      const start = performance.now();
      for (let i = 0, n = 0; i < samples.length; i += FRAME, n++) {
        if (closed || cut) return;
        const frame = new Array<number>(FRAME).fill(0);
        for (let j = 0; j < FRAME && i + j < samples.length; j++)
          frame[j] = Math.max(-1, Math.min(1, samples[i + j] || 0));
        await seat.output(frame);
        // Stay a few frames ahead of real time; the seat drops frames past 5.
        const wait = start + (n - LEAD_FRAMES) * 20 - performance.now();
        if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      }
    } finally {
      playing = false;
    }
  };

  /** Says `text`: each piece is voiced while the one before it plays, at
   * most two ahead. A piece the voice won't say faithfully is left out, and
   * the owner talking over it stops the rest. */
  const sayAloud = async (text: string) => {
    const pieces = parts(text);
    const voiced: (ReturnType<typeof speak> | undefined)[] = [];
    const ahead = (i: number) => {
      const line = pieces[i];
      if (line === undefined || voiced[i] || closed || cut) return;
      const piece = speak(line);
      piece.catch(() => {}); // Seen when awaited, or not at all once closed.
      voiced[i] = piece;
    };
    ahead(0);
    ahead(1);
    for (let i = 0; i < pieces.length; i++) {
      const spoken = await voiced[i];
      ahead(i + 2);
      if (closed || cut) return;
      if (!spoken) continue;
      seat.thinking?.(false);
      await play(fromPcm16(spoken.pcm));
    }
  };

  // "On it.", voiced the first time a turn runs long, then kept.
  let ack: ReturnType<typeof speak> | undefined;
  const acknowledge = async (done: () => boolean) => {
    ack ??= speak(ACK_LINE).catch(() => undefined);
    const spoken = await ack;
    if (!spoken || done() || closed || cut) return;
    seat.thinking?.(false);
    await play(fromPcm16(spoken.pcm));
    if (!done()) seat.thinking?.(true);
  };

  const say = (speaker: "owner" | "agent", text: string) =>
    post(speaker, text).catch((error) => {
      if (!closed) console.warn("opencode voice could not post", error);
    });

  const answer = async (samples: Float32Array) => {
    seat.thinking?.(true);
    try {
      const heard = await listen(samples);
      if (closed || !heard) return;
      await say("owner", heard);
      let finished = false;
      let acking: Promise<void> | undefined;
      const timer = setTimeout(() => {
        acking = acknowledge(() => finished);
      }, ACK_MS);
      let reply: string;
      try {
        reply = await think(heard);
      } finally {
        finished = true;
        clearTimeout(timer);
      }
      await acking;
      if (closed) return;
      cut = false;
      await sayAloud(reply);
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
      for (let next = queue.shift(); next && !closed; next = queue.shift()) {
        cut = false;
        if ("heard" in next) await answer(next.heard);
        else
          await sayAloud(next.say).catch((error) =>
            console.warn("opencode voice could not say", error),
          );
      }
    } finally {
      busy = false;
    }
  };

  // The owner is heard all the time: while the agent works, what they say is
  // answered next; while it speaks, talking over it cuts it off.
  const utterances = new Utterances(
    (samples) => {
      queue.push({ heard: samples });
      void drain();
    },
    () => {
      if (playing) cut = true;
    },
  );

  const close = () => {
    closed = true;
    queue.length = 0;
    seat.signal.removeEventListener("abort", close);
  };
  seat.signal.addEventListener("abort", close, { once: true });

  return {
    input(samples) {
      if (closed) return;
      utterances.push(samples, playing);
    },
    close,
    announce(text) {
      const line = spoken(text);
      if (closed || !line) return;
      queue.push({ say: line });
      void drain();
    },
  };
}
