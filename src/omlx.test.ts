/// <reference types="node" />
import { spawn as spawnChild } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostProcessOptions } from "./acp/host";
import { localModels, OmlxHelper, omlxEngine, voiceModels } from "./omlx";

const HELPER = readFileSync(new URL("./omlx-helper.cjs", import.meta.url), "utf8");

/** The host's spawn, running the helper as the manifest does, with HOME set. */
const spawnWith = (home: string) => async (_id: string, options: HostProcessOptions = {}) => {
  const child = spawnChild("node", ["-e", HELPER], {
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (d) => options.onStdout?.(d));
  child.stderr.setEncoding("utf8").on("data", (d) => options.onStderr?.(d));
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  return {
    write: (data: string) =>
      new Promise<void>((done, fail) => child.stdin.write(data, (e) => (e ? fail(e) : done()))),
    end: async () => void child.stdin.end(),
    kill: async () => void child.kill(),
    exited,
  };
};

/** A stand-in oMLX on a free port, with its settings in a temp home. */
async function fakeOmlx(models: string[]) {
  const seen: { url: string; auth?: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("latin1").on("data", (d) => (body += d));
    request.on("end", () => {
      seen.push({ url: request.url ?? "", auth: request.headers.authorization, body });
      if (request.url === "/v1/models")
        return void response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      if (request.url === "/v1/audio/transcriptions")
        return void response.end(JSON.stringify({ text: " Hello there " }));
      if (request.url === "/v1/audio/speech") return void response.end(Buffer.from([1, 0, 2, 0]));
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), "omlx-home-"));
  mkdirSync(join(home, ".omlx"));
  writeFileSync(
    join(home, ".omlx/settings.json"),
    JSON.stringify({ server: { port }, auth: { api_key: "local-key" } }),
  );
  return { home, seen, close: () => server.close() };
}

describe("voiceModels", () => {
  it("picks Parakeet and Kokoro first, and needs both", () => {
    expect(voiceModels(["Qwen", "whisper-large-v3-turbo", "parakeet-tdt-0.6b-v3", "Kokoro-82M-bf16"])).toEqual({
      listen: "parakeet-tdt-0.6b-v3",
      speak: "Kokoro-82M-bf16",
    });
    expect(voiceModels(["Qwen", "Kokoro-82M-bf16"])).toBeUndefined();
  });
});

describe("the oMLX helper", () => {
  it("lists models, transcribes and speaks through oMLX with its own key", async () => {
    const omlx = await fakeOmlx(["parakeet-tdt-0.6b-v3", "Kokoro-82M-bf16", "Qwen"]);
    const helper = new OmlxHelper(spawnWith(omlx.home) as never);
    try {
      const models = await localModels(helper);
      expect(models).toEqual({ listen: "parakeet-tdt-0.6b-v3", speak: "Kokoro-82M-bf16" });
      const engine = omlxEngine(helper, models as { listen: string; speak: string });
      expect(await engine.listen(new Float32Array(4800))).toBe("Hello there");
      expect((await engine.speak("Hi."))?.pcm).toEqual(new Uint8Array([1, 0, 2, 0]));
      expect(omlx.seen.every((r) => r.auth === "Bearer local-key")).toBe(true);
      expect(JSON.parse(omlx.seen.filter((r) => r.url === "/v1/audio/speech").at(-1)!.body)).toMatchObject({
        model: "Kokoro-82M-bf16",
        voice: "af_heart",
        response_format: "pcm",
      });
    } finally {
      await helper.stop();
      omlx.close();
    }
  });

  it("says when oMLX isn't running", async () => {
    const home = mkdtempSync(join(tmpdir(), "omlx-home-"));
    mkdirSync(join(home, ".omlx"));
    writeFileSync(join(home, ".omlx/settings.json"), JSON.stringify({ server: { port: 1 } }));
    const helper = new OmlxHelper(spawnWith(home) as never);
    try {
      expect(await localModels(helper)).toEqual({ error: "oMLX isn't running" });
    } finally {
      await helper.stop();
    }
  });

  it("refuses anything but its own requests", async () => {
    const helper = new OmlxHelper(spawnWith(tmpdir()) as never);
    try {
      await expect(helper.ask("fetch", { url: "http://example.com" })).rejects.toThrow("Unknown request");
    } finally {
      await helper.stop();
    }
  });
});

describe.skipIf(process.env.OMLX_LIVE !== "1")("the real oMLX", () => {
  it("transcribes what Kokoro says", { timeout: 120_000 }, async () => {
    const { homedir } = await import("node:os");
    const helper = new OmlxHelper(spawnWith(homedir()) as never);
    try {
      const models = await localModels(helper);
      expect(models).not.toHaveProperty("error");
      const engine = omlxEngine(helper, models as { listen: string; speak: string });
      const line = "Merged and released. Start a Huddle when you're ready.";
      await engine.speak(line); // warm
      let at = performance.now();
      const spoken = await engine.speak(line);
      const speakMs = performance.now() - at;
      const { fromPcm16 } = await import("./voice");
      const samples = fromPcm16(spoken!.pcm);
      await engine.listen(samples); // warm
      at = performance.now();
      const heard = await engine.listen(samples);
      const listenMs = performance.now() - at;
      console.log(`speak ${Math.round(speakMs)} ms for ${(samples.length / 48_000).toFixed(1)} s, listen ${Math.round(listenMs)} ms: ${heard}`);
      expect(heard?.toLowerCase()).toContain("merged and released");
    } finally {
      await helper.stop();
    }
  });
});
