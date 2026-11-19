/// <reference types="node" />
// A real Gemini Live session through openLiveVoice, on the key in
// GEMINI_API_KEY: a typed request stands in for speech, the model hands it to
// ask_agent, and the stand-in agent's answer comes back as audio. Nothing
// reaches Buzz. Run with GEMINI_LIVE=1.
import { describe, expect, it, vi } from "vitest";
import { openLiveVoice } from "./live";

const LIVE = process.env.GEMINI_LIVE === "1";

describe.skipIf(!LIVE)("Gemini Live", () => {
  it("hands a request to ask_agent and says the answer", { timeout: 60_000 }, async () => {
    const key = process.env.GEMINI_API_KEY;
    expect(key, "GEMINI_API_KEY").toBeTruthy();
    const abort = new AbortController();
    const seat = {
      agent: { name: "Ada" },
      conversation: { channelId: "room" },
      signal: abort.signal,
      output: vi.fn(async () => {}),
      ended: vi.fn(),
      thinking: vi.fn(),
    };
    const think = vi.fn(async () => "The build passed, all 57 tests are green.");
    // The real socket, kept so a typed request can stand in for speech.
    let socket: WebSocket | undefined;
    const open = (url: string) => {
      socket = new WebSocket(url);
      return socket as never;
    };
    const started = performance.now();
    const connection = await openLiveVoice(seat as never, key!, think, vi.fn(async () => {}), open);
    console.log(`connected in ${Math.round(performance.now() - started)} ms`);
    try {
      const asked = performance.now();
      socket!.send(
        JSON.stringify({ realtimeInput: { text: "What's the status of the build?" } }),
      );
      await vi.waitFor(() => expect(think).toHaveBeenCalled(), { timeout: 30_000, interval: 100 });
      console.log(`ask_agent after ${Math.round(performance.now() - asked)} ms:`, think.mock.calls[0]);
      const answered = performance.now();
      const before = seat.output.mock.calls.length;
      await vi.waitFor(
        () => expect(seat.output.mock.calls.length).toBeGreaterThan(before + 25),
        { timeout: 30_000, interval: 100 },
      );
      console.log(`answer audio ${Math.round(performance.now() - answered)} ms after the agent answered`);
      expect(seat.ended).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      connection.close();
    }
  });
});
