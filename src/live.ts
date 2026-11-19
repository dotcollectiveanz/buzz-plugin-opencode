// Huddle voice through Gemini Live, when the owner has a Gemini API key. One
// live speech-to-speech session per seat holds the conversation: it hears the
// owner, answers small talk itself, lets them talk over it, and hands anything
// that needs the agent to `ask_agent`, which runs a turn in the room's OpenCode
// session without blocking the conversation. The turn's answer comes back to
// say, and what the agent posts for its owner elsewhere is said too. The key is
// the one set in the plugin's Settings card (src/gemini.tsx).
import type { AgentType } from "./buzz";
import type { Config } from "./settings";
import {
  base64,
  fromPcm16,
  type Post,
  spoken,
  type Think,
  toPcm16,
  unbase64,
} from "./voice";

type Seat = Parameters<NonNullable<AgentType<Config>["voice"]>>[0];
type Connection = Awaited<ReturnType<NonNullable<AgentType<Config>["voice"]>>>;

export const LIVE_MODEL = "models/gemini-3.8-live";
const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const FRAME = 960;
const LEAD_FRAMES = 3;
/** Owner audio is sent in pieces of about this many 48 kHz samples (100 ms). */
const CHUNK = 4_800;
const TOOL = "ask_agent";

/** The session's setup: the agent's voice, with `ask_agent` for real work. */
export function liveSetup(name: string, handle?: string) {
  return {
    setup: {
      model: LIVE_MODEL,
      generationConfig: { responseModalities: ["AUDIO"] },
      systemInstruction: {
        parts: [
          {
            text: [
              `You are the voice of ${name}, an AI agent, talking with its owner in a voice call. Speak as ${name}, in the first person.`,
              `${name} does the actual work, with its tools, files and memory; you are how it talks. For anything beyond greetings and small talk, such as a question, a task, or anything about their work, call ${TOOL} with what they asked, in their words, and say briefly that you're on it. Never make up an answer yourself.`,
              `${TOOL} runs in the background, so keep talking with them while it works. When its answer comes back, tell them it: keep to its words and meaning, as your own, and leave out links and code.`,
              `A message that starts with "[Posted]" is something ${name} just posted for them elsewhere: tell them it briefly, as your own words.`,
              `Keep replies short and conversational. If they talk over you, stop and listen. Don't call ${TOOL} more than twice in a row for the same thing.`,
            ].join("\n"),
          },
        ],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: TOOL,
              description: `Has ${name} work on what the owner asked, with its tools, and returns its answer.`,
              behavior: "NON_BLOCKING",
              parameters: {
                type: "OBJECT",
                properties: {
                  request: {
                    type: "STRING",
                    description: "What the owner asked, in their words.",
                  },
                },
                required: ["request"],
              },
            },
          ],
        },
      ],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: handle ? { handle } : {},
    },
  };
}

type LiveMessage = {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
  };
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: { request?: unknown } }[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: unknown;
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
};

type Socket = Pick<WebSocket, "send" | "close"> & {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
export type OpenSocket = (url: string) => Socket;

const openSocket: OpenSocket = (url) => new WebSocket(url) as unknown as Socket;

async function text(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof (data as Blob).text === "function")
    return (data as Blob).text();
  return String(data);
}

/** Opens a Huddle seat that talks through Gemini Live. */
export async function openLiveVoice(
  seat: Seat,
  key: string,
  think: Think,
  post: Post,
  open: OpenSocket = openSocket,
): Promise<Connection & { announce(text: string): void }> {
  seat.signal.throwIfAborted();
  const name = seat.agent.name?.trim() || "the agent";

  let closed = false;
  let socket: Socket | undefined;
  let ready = false;
  let handle: string | undefined;
  let reconnects = 0;
  const outbox: string[] = [];
  let heard = "";
  let pendingTurns = 0;

  // Playout: the model sends audio faster than real time; play it paced, and
  // drop what's left when the owner talks over it.
  let playout: Float32Array[] = [];
  let offset = 0;
  const takeFrame = () => {
    if (!playout.length) return undefined;
    const frame = new Array<number>(FRAME).fill(0);
    let j = 0;
    while (j < FRAME && playout.length) {
      const head = playout[0]!;
      while (j < FRAME && offset < head.length)
        frame[j++] = Math.max(-1, Math.min(1, head[offset++] || 0));
      if (offset >= head.length) {
        playout.shift();
        offset = 0;
      }
    }
    return frame;
  };
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      const start = performance.now();
      for (let n = 0, frame = takeFrame(); frame && !closed; n++, frame = takeFrame()) {
        await seat.output(frame);
        // Stay a few frames ahead of real time; the seat drops frames past 5.
        const wait = start + (n - LEAD_FRAMES) * 20 - performance.now();
        if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      }
    } finally {
      pumping = false;
    }
  };
  const clear = () => {
    playout = [];
    offset = 0;
  };

  const send = (message: unknown) => {
    const data = JSON.stringify(message);
    if (ready && socket) socket.send(data);
    else outbox.push(data);
  };

  const postHeard = () => {
    const line = heard.trim();
    heard = "";
    if (line)
      void post("owner", line).catch((error) => {
        if (!closed) console.warn("opencode voice could not post", error);
      });
  };

  const runTool = async (id: string | undefined, request: string) => {
    pendingTurns++;
    seat.thinking?.(true);
    let response: Record<string, unknown>;
    try {
      const answer = await think(request);
      response = { status: "success", retryable: false, message: spoken(answer) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response = {
        status: "error",
        retryable: false,
        message: `${name} couldn't finish that: ${reason.slice(0, 200)}`,
      };
    } finally {
      pendingTurns--;
      if (!pendingTurns) seat.thinking?.(false);
    }
    if (closed) return;
    send({
      toolResponse: {
        functionResponses: [
          { id, name: TOOL, response: { ...response, scheduling: "WHEN_IDLE" } },
        ],
      },
    });
  };

  const receive = async (data: unknown) => {
    let message: LiveMessage;
    try {
      message = JSON.parse(await text(data));
    } catch {
      return;
    }
    if (message.setupComplete !== undefined) {
      ready = true;
      reconnects = 0;
      for (let next = outbox.shift(); next; next = outbox.shift())
        socket?.send(next);
      return;
    }
    if (message.sessionResumptionUpdate?.resumable)
      handle = message.sessionResumptionUpdate.newHandle || handle;
    const content = message.serverContent;
    if (content) {
      if (content.inputTranscription?.text)
        heard += content.inputTranscription.text;
      if (content.interrupted) clear();
      for (const part of content.modelTurn?.parts ?? []) {
        const audio = part.inlineData;
        if (audio?.data && audio.mimeType?.startsWith("audio/pcm")) {
          playout.push(fromPcm16(unbase64(audio.data)));
          void pump();
        }
      }
      if (content.turnComplete) postHeard();
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (call.name !== TOOL) continue;
      postHeard();
      const request = String(call.args?.request ?? "").trim();
      if (request) void runTool(call.id, request);
    }
  };

  const connect = () =>
    new Promise<void>((resolve, reject) => {
      ready = false;
      const ws = open(`${LIVE_URL}?key=${encodeURIComponent(key)}`);
      socket = ws;
      let settled = false;
      ws.onopen = () => ws.send(JSON.stringify(liveSetup(name, handle)));
      ws.onmessage = (event) => {
        void receive(event.data).then(() => {
          if (ready && !settled) {
            settled = true;
            resolve();
          }
        });
      };
      ws.onerror = () => {};
      ws.onclose = (event) => {
        if (socket !== ws) return;
        ready = false;
        const reason = event.reason || `closed (${event.code ?? "no code"})`;
        if (!settled) {
          settled = true;
          reject(new Error(`Gemini Live ${reason}`));
          return;
        }
        if (closed) return;
        // The server closes sessions now and then (goAway); carry on in a
        // new connection from the last handle.
        if (reconnects++ < 3) {
          void connect().catch((error) => {
            if (!closed) seat.ended(error);
          });
        } else seat.ended(new Error(`Gemini Live ${reason}`));
      };
    });

  await connect();
  if (seat.signal.aborted) {
    closed = true;
    socket?.close();
    seat.signal.throwIfAborted();
  }

  let buffer: Float32Array[] = [];
  let buffered = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    clear();
    socket?.close();
    seat.signal.removeEventListener("abort", close);
  };
  seat.signal.addEventListener("abort", close, { once: true });

  return {
    input(samples) {
      if (closed) return;
      buffer.push(Float32Array.from(samples));
      buffered += samples.length;
      if (buffered < CHUNK) return;
      const all = new Float32Array(buffered);
      let at = 0;
      for (const part of buffer) {
        all.set(part, at);
        at += part.length;
      }
      buffer = [];
      buffered = 0;
      if (!ready) return;
      send({
        realtimeInput: {
          audio: { data: base64(toPcm16(all)), mimeType: "audio/pcm;rate=16000" },
        },
      });
    },
    close,
    announce(message) {
      const line = spoken(message);
      if (closed || !line) return;
      send({ realtimeInput: { text: `[Posted] ${line}` } });
    },
  };
}

export const LIVE_ORIGIN = "https://generativelanguage.googleapis.com";
