import { describe, expect, it, vi } from "vitest";
import { geminiKey, LIVE_MODEL, liveSetup, openLiveVoice, type OpenSocket } from "./live";

const file = (text: string) => async () => new TextEncoder().encode(text);

describe("geminiKey", () => {
  it("reads GEMINI_API_KEY from the Gemini CLI's .env", async () => {
    expect(await geminiKey(file("# keys\nexport GEMINI_API_KEY=\"AIza-1\"\n"))).toBe("AIza-1");
    expect(await geminiKey(file("GOOGLE_API_KEY=AIza-2"))).toBe("AIza-2");
  });
  it("is undefined without one", async () => {
    expect(await geminiKey(file("OTHER=1\nGEMINI_API_KEY=\n"))).toBeUndefined();
    expect(await geminiKey(async () => { throw new Error("ENOENT"); })).toBeUndefined();
  });
});

describe("liveSetup", () => {
  it("speaks as the agent and hands real work to ask_agent, without blocking", () => {
    const { setup } = liveSetup("Ada");
    expect(setup.model).toBe(LIVE_MODEL);
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.systemInstruction.parts[0]!.text).toContain("You are the voice of Ada");
    const [tool] = setup.tools[0]!.functionDeclarations;
    expect(tool).toMatchObject({ name: "ask_agent", behavior: "NON_BLOCKING" });
    expect(liveSetup("Ada", "h1").setup.sessionResumption).toEqual({ handle: "h1" });
  });
});

/** A stand-in Gemini Live: records what the seat sends, and lets the test
 * send server messages. */
function fakeLive() {
  const sent: any[] = [];
  const urls: string[] = [];
  let socket: any;
  const open: OpenSocket = (url) => {
    urls.push(url);
    socket = {
      send: (data: string) => sent.push(JSON.parse(data)),
      close: vi.fn(),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    queueMicrotask(() => {
      socket.onopen?.({});
      socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
    });
    return socket;
  };
  return {
    open,
    sent,
    urls,
    server: (message: unknown) => socket.onmessage?.({ data: new Blob([JSON.stringify(message)]) }),
    drop: () => socket.onclose?.({ code: 1000, reason: "goAway" }),
  };
}

const seatFor = () => {
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

describe("openLiveVoice", () => {
  it("connects with the key, streams the owner's audio and plays the model's", async () => {
    const live = fakeLive();
    const { seat, abort } = seatFor();
    const connection = await openLiveVoice(seat as never, "AIza-1", vi.fn(), vi.fn(async () => {}), live.open);
    expect(live.urls[0]).toContain("key=AIza-1");
    expect(live.sent[0].setup.model).toBe(LIVE_MODEL);
    connection.input(new Array(4800).fill(0.1));
    expect(live.sent[1].realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    // 100 ms of 24 kHz audio is 5 frames at 48 kHz.
    const pcm = btoa(String.fromCharCode(...new Uint8Array(4800)));
    live.server({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: "audio/pcm;rate=24000" } }] } } });
    await vi.waitFor(() => expect(seat.output).toHaveBeenCalledTimes(5));
    abort.abort();
    connection.close();
  });

  it("runs ask_agent as a turn, posts what the owner said, and returns the answer to say", async () => {
    const live = fakeLive();
    const { seat, abort } = seatFor();
    const think = vi.fn(async () => "**Done**, see https://x.y/z");
    const post = vi.fn(async () => {});
    const connection = await openLiveVoice(seat as never, "k", think, post, live.open);
    live.server({ serverContent: { inputTranscription: { text: "Can you check " } } });
    live.server({ serverContent: { inputTranscription: { text: "the build?" } } });
    live.server({ toolCall: { functionCalls: [{ id: "c1", name: "ask_agent", args: { request: "Check the build" } }] } });
    await vi.waitFor(() => expect(live.sent.some((m) => m.toolResponse)).toBe(true));
    expect(think).toHaveBeenCalledWith("Check the build");
    expect(post).toHaveBeenCalledWith("owner", "Can you check the build?");
    const response = live.sent.find((m) => m.toolResponse).toolResponse.functionResponses[0];
    expect(response).toMatchObject({ id: "c1", name: "ask_agent", response: { status: "success", message: "Done, see a link", scheduling: "WHEN_IDLE" } });
    abort.abort();
    connection.close();
  });

  it("stops playing when the owner talks over it", async () => {
    const live = fakeLive();
    const { seat, abort } = seatFor();
    const connection = await openLiveVoice(seat as never, "k", vi.fn(), vi.fn(async () => {}), live.open);
    const pcm = btoa(String.fromCharCode(...new Uint8Array(48_000 * 2))); // 2 s
    live.server({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: "audio/pcm;rate=24000" } }] } } });
    await vi.waitFor(() => expect(seat.output.mock.calls.length).toBeGreaterThan(5));
    live.server({ serverContent: { interrupted: true } });
    await new Promise((done) => setTimeout(done, 300));
    const after = seat.output.mock.calls.length;
    await new Promise((done) => setTimeout(done, 200));
    expect(seat.output.mock.calls.length).toBe(after);
    expect(after).toBeLessThan(60);
    abort.abort();
    connection.close();
  });

  it("passes on what the agent posts for its owner, as text to say", async () => {
    const live = fakeLive();
    const { seat, abort } = seatFor();
    const connection = await openLiveVoice(seat as never, "k", vi.fn(), vi.fn(async () => {}), live.open);
    connection.announce("In builds: @Brendon which branch?");
    expect(live.sent.at(-1)).toEqual({ realtimeInput: { text: "[Posted] In builds: Brendon which branch?" } });
    abort.abort();
    connection.close();
  });

  it("reconnects from the last handle when the server closes the session", async () => {
    const live = fakeLive();
    const { seat, abort } = seatFor();
    const connection = await openLiveVoice(seat as never, "k", vi.fn(), vi.fn(async () => {}), live.open);
    live.server({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
    await new Promise((done) => setTimeout(done, 10));
    live.drop();
    await vi.waitFor(() => expect(live.urls).toHaveLength(2));
    await vi.waitFor(() => expect(live.sent.filter((m) => m.setup).at(-1).setup.sessionResumption).toEqual({ handle: "h1" }));
    expect(seat.ended).not.toHaveBeenCalled();
    abort.abort();
    connection.close();
  });
});
