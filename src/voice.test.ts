import { describe, expect, it, vi } from "vitest";
import {
  fromPcm16,
  likeness,
  openRouterKey,
  openVoice,
  parts,
  readSpoken,
  speakRequest,
  spoken,
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
    await expect(openVoice(seat as never, host as never, vi.fn(), vi.fn())).rejects.toThrow(/opencode auth login/);
  });

  const voiced = (said: string) => {
    const pcm = new Uint8Array(24_000 * 2 * 0.1); // 100 ms of silence
    return `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: btoa(String.fromCharCode(...pcm)), transcript: said } } }] })}\ndata: [DONE]\n`;
  };
  const speakAs = (...said: string[]) =>
    vi.fn(async ({ body }: { body: string; headers?: Record<string, string> }) => {
      const sent = JSON.parse(body);
      if (sent.stream) return { status: 200, headers: {}, body: voiced(said.shift() ?? "") };
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ choices: [{ message: { content: "Hi Ada" } }] }),
      };
    });
  const speakTo = (connection: { input(f: number[]): void }) => {
    feed(connection, tone(0.2, 0));
    feed(connection, tone(1, 0.3));
    feed(connection, tone(1, 0));
  };

  it("transcribes speech, runs it as a turn, posts what was heard and says the answer", async () => {
    const { seat, abort } = seatFor();
    const request = speakAs("Hello Brendon.");
    const think = vi.fn(async () => "Hello Brendon.");
    const post = vi.fn(async () => {});
    const connection = await openVoice(seat as never, { readFile: auth, request } as never, think, post);
    speakTo(connection);
    await vi.waitFor(() => expect(seat.output).toHaveBeenCalledTimes(5), { timeout: 3000 });
    expect((seat.output.mock.calls[0] as unknown[])[0]).toHaveLength(960);
    // The owner's words are posted by the plugin, and the answer by the turn:
    // never Buzz's "(transcribed by …)" lines.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("owner", "Hi Ada");
    expect(seat.transcript).not.toHaveBeenCalled();
    expect(think).toHaveBeenCalledWith("Hi Ada");
    const speak = JSON.parse(request.mock.calls[1]![0].body);
    expect(speak).toEqual(speakRequest("Hello Brendon."));
    expect(request.mock.calls[0]![0].headers?.Authorization).toBe("Bearer sk-or-1");
    abort.abort();
    connection.close();
  });

  it("tries again when the voice answers the line instead of saying it, then stays quiet", async () => {
    const { seat, abort } = seatFor();
    const line = "My core memory has three main parts.";
    const request = speakAs(
      "I hear you're describing your core memory. That's thoughtful.",
      "It sounds like your memory is well organised.",
    );
    const post = vi.fn(async () => {});
    const connection = await openVoice(
      seat as never,
      { readFile: auth, request } as never,
      vi.fn(async () => line),
      post,
    );
    speakTo(connection);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3), { timeout: 3000 });
    await vi.waitFor(() => expect(seat.thinking).toHaveBeenLastCalledWith(false));
    expect(seat.output).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    abort.abort();
    connection.close();
  });

  it("starts speaking after the first sentence, voicing the rest while it plays", async () => {
    const { seat, abort } = seatFor();
    const answer = "Merged and released.\nTake the update when Buzz offers it. Then start a Huddle.";
    const [first, rest] = parts(answer);
    const request = speakAs(first!, rest!);
    const connection = await openVoice(
      seat as never,
      { readFile: auth, request } as never,
      vi.fn(async () => answer),
      vi.fn(async () => {}),
    );
    speakTo(connection);
    await vi.waitFor(() => expect(seat.output).toHaveBeenCalledTimes(10), { timeout: 3000 });
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.parse(request.mock.calls[1]![0].body)).toEqual(speakRequest(first!));
    expect(JSON.parse(request.mock.calls[2]![0].body)).toEqual(speakRequest(rest!));
    abort.abort();
    connection.close();
  });

  it("plays the second try when it says the line", async () => {
    const { seat, abort } = seatFor();
    const line = "My core memory has three main parts.";
    const request = speakAs("I hear you're describing your core memory.", line);
    const connection = await openVoice(
      seat as never,
      { readFile: auth, request } as never,
      vi.fn(async () => line),
      vi.fn(async () => {}),
    );
    speakTo(connection);
    await vi.waitFor(() => expect(seat.output).toHaveBeenCalledTimes(5), { timeout: 3000 });
    expect(request).toHaveBeenCalledTimes(3);
    abort.abort();
    connection.close();
  });
});

describe("speaking the agent's line", () => {
  it("voices the first sentence on its own and groups the rest", () => {
    expect(parts("Done.")).toEqual(["Done."]);
    expect(parts("Hi Brendon\n\nMerged and released as v1.2.3. Take the update. Then start a Huddle.")).toEqual([
      "Hi Brendon Merged and released as v1.2.3.",
      "Take the update. Then start a Huddle.",
    ]);
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is about this long.`).join(" ");
    const pieces = parts(long);
    expect(pieces[0]).toBe("Sentence number 0 is about this long.");
    expect(pieces.slice(1).every((p) => p.length <= 240)).toBe(true);
    expect(pieces.join(" ")).toBe(long);
  });

  it("gives the line in the system prompt, as the agent's own, with nothing to answer", () => {
    const request = speakRequest("Should I merge it?");
    expect(request.model).toBe("openai/gpt-audio-mini");
    expect(request.messages[0]!.role).toBe("system");
    expect(request.messages[0]!.content).toContain("Should I merge it?");
    expect(request.messages[0]!.content).toContain("first-person");
    expect(request.messages[1]).toEqual({ role: "user", content: "Action" });
  });

  it("measures how closely the voice kept to the line", () => {
    expect(likeness("I'll do it.", "I\u2019ll do it")).toBe(1);
    expect(likeness("Done. I've posted it in the chat.", "Done, I've posted it in the chat!")).toBe(1);
    expect(
      likeness(
        "My core memory has three main parts.",
        "I hear you're describing how your core memory is structured.",
      ),
    ).toBeLessThan(0.8);
  });
});

describe("a conversation", () => {
  const abortable = () => {
    const abort = new AbortController();
    return {
      abort,
      seat: {
        agent: { name: "Ada" },
        conversation: { channelId: "room" },
        signal: abort.signal,
        output: vi.fn(async () => {}),
        ended: vi.fn(),
        thinking: vi.fn(),
      },
    };
  };
  const auth = async () =>
    new TextEncoder().encode(JSON.stringify({ openrouter: { key: "sk-or-1" } }));
  /** Speaks every line back faithfully, as `seconds` of silence. */
  const faithful = (seconds = 0.1) =>
    vi.fn(async ({ body }: { body: string }) => {
      const sent = JSON.parse(body);
      if (!sent.stream)
        return { status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: "Hi Ada" } }] }) };
      const line = /<line>\n([\s\S]*)\n<\/line>/.exec(sent.messages[0].content)?.[1] ?? "";
      const pcm = new Uint8Array(Math.round(24_000 * 2 * seconds));
      let binary = "";
      for (let i = 0; i < pcm.length; i += 0x8000) binary += String.fromCharCode(...pcm.subarray(i, i + 0x8000));
      return {
        status: 200,
        headers: {},
        body: `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: btoa(binary), transcript: line } } }] })}\ndata: [DONE]\n`,
      };
    });
  const lines = (request: ReturnType<typeof faithful>) =>
    request.mock.calls
      .map((call) => JSON.parse(call[0].body))
      .filter((body) => body.stream)
      .map((body) => /<line>\n([\s\S]*)\n<\/line>/.exec(body.messages[0].content)?.[1]);
  const speakTo = (connection: { input(f: number[]): void }) => {
    feed(connection, tone(0.2, 0));
    feed(connection, tone(1, 0.3));
    feed(connection, tone(1, 0));
  };

  it("stops talking when the owner talks over it, and answers them", async () => {
    const { seat, abort } = abortable();
    const request = faithful(3);
    const think = vi.fn(async () => "This answer takes three seconds to say.");
    const connection = await openVoice(seat as never, { readFile: auth, request } as never, think, vi.fn(async () => {}));
    speakTo(connection);
    await vi.waitFor(() => expect(seat.output.mock.calls.length).toBeGreaterThan(10), { timeout: 3000 });
    speakTo(connection);
    await vi.waitFor(() => expect(think).toHaveBeenCalledTimes(2), { timeout: 3000 });
    // 3 s is 150 frames: cut off, the first answer stopped well short of it.
    expect(seat.output.mock.calls.length).toBeLessThan(100);
    abort.abort();
    connection.close();
  });

  it("hears the owner while it works, and answers that next", async () => {
    const { seat, abort } = abortable();
    const request = faithful();
    let release!: () => void;
    const think = vi
      .fn<(heard: string) => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((done) => (release = () => done("First."))))
      .mockImplementation(async () => "Second.");
    const connection = await openVoice(seat as never, { readFile: auth, request } as never, think, vi.fn(async () => {}));
    speakTo(connection);
    await vi.waitFor(() => expect(think).toHaveBeenCalledTimes(1));
    speakTo(connection);
    release();
    await vi.waitFor(() => expect(think).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await vi.waitFor(() => expect(lines(request)).toEqual(["First.", "Second."]), { timeout: 3000 });
    abort.abort();
    connection.close();
  });

  it("says it's on it when a turn runs long", async () => {
    const { seat, abort } = abortable();
    const request = faithful();
    const think = vi.fn(() => new Promise<string>((done) => setTimeout(() => done("Done."), 2200)));
    const connection = await openVoice(seat as never, { readFile: auth, request } as never, think, vi.fn(async () => {}));
    speakTo(connection);
    await vi.waitFor(() => expect(lines(request)).toEqual(["On it.", "Done."]), { timeout: 5000 });
    abort.abort();
    connection.close();
  });

  it("says aloud what the agent posts for its owner, without markdown", async () => {
    const { seat, abort } = abortable();
    const request = faithful();
    const connection = await openVoice(seat as never, { readFile: auth, request } as never, vi.fn(), vi.fn(async () => {}));
    connection.announce("In builds: @Brendon can you check [the PR](https://github.com/x/y/pull/1)?");
    await vi.waitFor(() => expect(lines(request)).toEqual(["In builds: Brendon can you check the PR?"]));
    await vi.waitFor(() => expect(seat.output).toHaveBeenCalled());
    abort.abort();
    connection.close();
  });
});

describe("spoken", () => {
  it("drops markdown, links and code, and reads mentions as names", () => {
    expect(spoken("**Hi @Brendon**\n\n- See https://x.y/z\n- Run `npm test`\n```sh\nrm -rf /\n```")).toBe(
      "Hi Brendon\nSee a link\nRun npm test",
    );
  });
});

describe("a given engine", () => {
  it("listens and speaks with it, with no OpenRouter login", async () => {
    const abort = new AbortController();
    const seat = {
      agent: { name: "Ada" },
      conversation: { channelId: "room" },
      signal: abort.signal,
      output: vi.fn(async () => {}),
      ended: vi.fn(),
      thinking: vi.fn(),
    };
    const engine = {
      listen: vi.fn(async () => "What's the build status?"),
      speak: vi.fn(async () => ({ pcm: new Uint8Array(24_000 * 2 * 0.1) })),
    };
    const host = { readFile: async () => new TextEncoder().encode("{}"), request: vi.fn() };
    const think = vi.fn(async () => "It passed.");
    const post = vi.fn(async () => {});
    const connection = await openVoice(seat as never, host as never, think, post, engine);
    feed(connection, tone(0.2, 0));
    feed(connection, tone(1, 0.3));
    feed(connection, tone(1, 0));
    await vi.waitFor(() => expect(seat.output).toHaveBeenCalledTimes(5), { timeout: 3000 });
    expect(think).toHaveBeenCalledWith("What's the build status?");
    expect(engine.speak).toHaveBeenCalledWith("It passed.");
    expect(post).toHaveBeenCalledWith("owner", "What's the build status?");
    expect(host.request).not.toHaveBeenCalled();
    abort.abort();
    connection.close();
  });
});
