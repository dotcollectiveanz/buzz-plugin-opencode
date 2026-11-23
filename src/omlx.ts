// Huddle voice on a local oMLX server: a speech-to-text model (Parakeet,
// Whisper or another ASR model oMLX serves) listens, and a text-to-speech
// model (Kokoro or another) speaks. The plugin can't reach oMLX's plain HTTP
// itself, so it talks to it through the helper in src/omlx-helper.cjs, which
// the manifest runs with `node -e`.
import type { Host } from "./buzz";
import { base64, type Engine, toWav, unbase64 } from "./voice";

/** The manifest's process id for the helper. */
export const OMLX_PROCESS = "omlx";
/** Kokoro's highest-rated voice. */
export const OMLX_VOICE = "af_heart";
const LISTENERS = [/parakeet/i, /whisper/i, /asr/i];
const SPEAKERS = [/kokoro/i, /tts/i];

/** The first model each pattern finds, in pattern order. */
function pick(models: readonly string[], patterns: readonly RegExp[]) {
  for (const pattern of patterns) {
    const found = models.find((model) => pattern.test(model));
    if (found) return found;
  }
  return undefined;
}

/** oMLX's models for listening and speaking, if it serves both. */
export function voiceModels(models: readonly string[]) {
  const listen = pick(models, LISTENERS);
  const speak = pick(models, SPEAKERS);
  return listen && speak ? { listen, speak } : undefined;
}

type Answer = { id: number; ok: boolean; error?: string } & Record<
  string,
  unknown
>;

/** The helper process, answering one JSON line per request. */
export class OmlxHelper {
  private next = 0;
  private buffer = "";
  private readonly waiting = new Map<
    number,
    { resolve(answer: Answer): void; reject(error: Error): void }
  >();
  private process?: Promise<Awaited<ReturnType<NonNullable<Host["spawn"]>>>>;

  constructor(private readonly spawn: NonNullable<Host["spawn"]>) {}

  private start() {
    this.process ??= this.spawn(OMLX_PROCESS, {
      onStdout: (data) => this.read(data),
      onStderr: (data) => console.warn("oMLX helper", data.slice(0, 500)),
    }).then((child) => {
      void child.exited.then(() => this.fail("The oMLX helper stopped"));
      return child;
    });
    this.process.catch(() => {
      this.process = undefined;
    });
    return this.process;
  }

  private read(data: string) {
    this.buffer += data;
    for (
      let end = this.buffer.indexOf("\n");
      end >= 0;
      end = this.buffer.indexOf("\n")
    ) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let answer: Answer;
      try {
        answer = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = this.waiting.get(answer.id);
      if (!waiter) continue;
      this.waiting.delete(answer.id);
      if (answer.ok) waiter.resolve(answer);
      else waiter.reject(new Error(answer.error ?? "oMLX failed"));
    }
  }

  private fail(reason: string) {
    this.process = undefined;
    this.buffer = "";
    for (const waiter of this.waiting.values()) waiter.reject(new Error(reason));
    this.waiting.clear();
  }

  async ask(op: string, fields: Record<string, unknown> = {}): Promise<Answer> {
    const child = await this.start();
    const id = ++this.next;
    const answer = new Promise<Answer>((resolve, reject) =>
      this.waiting.set(id, { resolve, reject }),
    );
    await child.write(`${JSON.stringify({ id, op, ...fields })}\n`);
    return answer;
  }

  async stop() {
    const child = await this.process?.catch(() => undefined);
    this.fail("Stopped");
    await child?.kill();
  }
}

/** oMLX's voice models, or why local voice isn't available. */
export async function localModels(helper: OmlxHelper) {
  try {
    const { models } = await helper.ask("models");
    const found = voiceModels(Array.isArray(models) ? models.map(String) : []);
    return found ?? { error: "oMLX has no speech-to-text and text-to-speech models" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Listening and speaking on oMLX's models. Warms both up, since oMLX loads a
 * model on its first request, which can take half a minute. */
export function omlxEngine(
  helper: OmlxHelper,
  models: { listen: string; speak: string },
): Engine {
  const silence = new Float32Array(48_000 / 2);
  void helper
    .ask("speak", { model: models.speak, voice: OMLX_VOICE, text: "Hi." })
    .catch(() => {});
  void helper
    .ask("listen", { model: models.listen, wav: base64(toWav(silence)) })
    .catch(() => {});
  return {
    async listen(samples) {
      const { text } = await helper.ask("listen", {
        model: models.listen,
        wav: base64(toWav(samples)),
      });
      const heard = String(text ?? "").trim();
      return heard || undefined;
    },
    async speak(text) {
      const { pcm } = await helper.ask("speak", {
        model: models.speak,
        voice: OMLX_VOICE,
        text,
      });
      return typeof pcm === "string" && pcm ? { pcm: unbase64(pcm) } : undefined;
    },
  };
}
