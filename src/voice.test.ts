import { describe, expect, it, vi } from "vitest";
import {
  fromPcm16,
  openRouterKey,
  openVoice,
  readSpoken,
  toWav,
  Utterances,
} from "./voice";

const tone = (seconds: number, level: number) =>
  Array.from({ length: Math.round(48_000 * seconds) }, (_, i) =>
    level * Math.sin(i / 10),
  );
const feed = (target: { push(f: number[]): void } | { input(f: number[]): void }, samples: number[]) => {
  for (let i = 0; i < samples.length; i += 960) {
    const frame = samples.slice(i, i + 960);
    if ("push" in target) target.push(frame);
    else target.input(frame);
  }
};

describe("openRouterKey", () => {
  it("reads OpenCode's OpenRouter login", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.includes(".local/share"))
        return new TextEncoder().encode(
          JSON.stringify({ openrouter: { type: "api", key: " sk-or-1 " } }),
        );
      throw new Error("No such file");
    });
    expect(await openRouterKey(readFile)).toBe("sk-or-1");
  });
  it("is undefined without one", async () => {
    const readFile = vi.fn(async () => new TextEncoder().encode("{}"));
    expect(await openRouterKey(readFile)).toBeUndefined();
  });
});

describe("audio", () => {
  it("writes 16 kHz mono WAV from 48 kHz samples", () => {
    const wav = toWav(new Float32Array(48_000));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(32_000);
    expect(wav.length).toBe(44 + 32_000);
  });
  it("doubles 24 kHz PCM16 to 48 kHz floats", () => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt16(0, 0x4000, true);
    new DataView(bytes.buffer).setInt16(2, -0x4000, true);
    expect(Array.from(fromPcm16(bytes))).toEqual([0.5, 0, -0.5, -0.5]);
  });
  it("reads streamed audio, its transcript and errors", () => {
    const pcm = btoa(String.fromCharCode(1, 2, 3, 4));
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm, transcript: "Hi " } } }] })}`,
      ": keep-alive",
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { transcript: "there." } } }] })}`,
      "data: [DONE]",
    ].join("\n");
    const spoken = readSpoken(body);
    expect(Array.from(spoken.pcm)).toEqual([1, 2, 3, 4]);
    expect(spoken.transcript).toBe("Hi there.");
    expect(readSpoken(`data: {"error":{"message":"no credit"}}`).error).toBe("no credit");
  });
});

describe("Utterances", () => {
  it("cuts speech at a pause, with pre-roll, and ignores clicks", () => {
    const heard: Float32Array[] = [];
    const cut = new Utterances((samples) => heard.push(samples));
    feed(cut, tone(0.5, 0));
    feed(cut, tone(0.1, 0.3)); // too short to be speech
    feed(cut, tone(1, 0));
    expect(heard).toHaveLength(0);
    feed(cut, tone(1, 0.3));
    feed(cut, tone(1, 0));
    expect(heard).toHaveLength(1);
    const seconds = (heard[0]?.length ?? 0) / 48_000;
    expect(seconds).toBeGreaterThan(1.6);
    expect(seconds).toBeLessThan(2.1);
  });
});

describe("openVoice", () => {
  const seatFor = () => {
    const abort = new AbortController();
    return {
      abort,
      seat: {
        agent: { name: "Ada" },
        conversation: { channelId: "room" },
        signal: abort.signal,
        config: { instructions: "Be brief." },
        transcript: vi.fn(async () => {}),
        output: vi.fn(async () => {}),
        ended: vi.fn(),
        thinking: vi.fn(),
      },
    };
  };
  const auth = async () =>
    new TextEncoder().encode(JSON.stringify({ openrouter: { key: "sk-or-1" } }));

  it("refuses without an OpenRouter login", async () => {
    const { seat } = seatFor();
    const host = { readFile: async () => new TextEncoder().encode("{}"), request: vi.fn() };
    await expect(openVoice(seat as never, host as never, vi.fn())).rejects.toThrow(/opencode auth login/);
  });

  it("transcribes speech, runs it as a turn, says the answer and posts both lines", async () => {
    const { seat, abort } = seatFor();
    const pcm = new Uint8Array(24_000 * 2 * 0.1); // 100 ms of silence
    const request = vi.fn(async ({ body }: { body: string; headers?: Record<string, string> }) => {
      const sent = JSON.parse(body);
      if (sent.stream) {
        expect(sent.messages[1]).toEqual({ role: "user", content: "Hello Brendon." });
        return {
          status: 200,
          headers: {},
          body: `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: btoa(String.fromCharCode(...pcm)), transcript: "Hello Brendon." } } }] })}\ndata: [DONE]\n`,
        };
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ choices: [{ message: { content: "Hi Ada" } }] }),
      };
    });
    const think = vi.fn(async () => "Hello Brendon.");
    const connection = await openVoice(seat as never, { readFile: auth, request } as never, think);
    feed(connection, tone(0.2, 0));
    feed(connection, tone(1, 0.3));
    feed(connection, tone(1, 0));
    await vi.waitFor(() => expect(seat.transcript).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(seat.transcript).toHaveBeenNthCalledWith(1, "owner", "Hi Ada");
    expect(seat.transcript).toHaveBeenNthCalledWith(2, "agent", "Hello Brendon.");
    await vi.waitFor(() => expect(seat.output).toHaveBeenCalledTimes(5));
    expect((seat.output.mock.calls[0] as unknown[])[0]).toHaveLength(960);
    expect(think).toHaveBeenCalledWith("Hi Ada", expect.any(Function));
    expect((think.mock.calls[0] as unknown as [string, () => boolean])[1]()).toBe(true);
    const speak = JSON.parse(request.mock.calls[1]![0].body);
    expect(speak.model).toBe("openai/gpt-audio-mini");
    expect(request.mock.calls[0]![0].headers?.Authorization).toBe("Bearer sk-or-1");
    abort.abort();
    connection.close();
  });
});
