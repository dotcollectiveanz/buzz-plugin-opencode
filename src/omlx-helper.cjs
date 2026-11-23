// Huddle voice's bridge to a local oMLX server. Buzz lets plugins reach only
// HTTPS origins, and oMLX serves plain HTTP on this computer, so the plugin
// runs this with `node -e` (plugin/manifest.json) and talks to it in JSON
// lines on stdin and stdout. It reaches only 127.0.0.1 on oMLX's own port,
// and only oMLX's model list and speech routes, with oMLX's own API key, read
// from its settings. Each request is {id, op, ...}; each answer {id, ok, ...}.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

function base() {
  try {
    const set = fs
      .readFileSync(
        path.join(os.homedir(), "Library/Application Support/oMLX/base-path"),
        "utf8",
      )
      .trim();
    if (set) return set;
  } catch {}
  return path.join(os.homedir(), ".omlx");
}
function server() {
  let settings = {};
  try {
    settings = JSON.parse(
      fs.readFileSync(path.join(base(), "settings.json"), "utf8"),
    );
  } catch {}
  const port = Number(settings.server?.port) || 8000;
  const key = settings.auth?.api_key;
  return {
    url: `http://127.0.0.1:${port}`,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  };
}
async function call(route, init) {
  const { url, headers } = server();
  const response = await fetch(url + route, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let reason = text.slice(0, 300);
    try {
      const error = JSON.parse(text);
      reason = error.detail || error.error?.message || reason;
    } catch {}
    throw new Error(`oMLX answered ${response.status}: ${reason}`);
  }
  return response;
}
const ops = {
  async models() {
    const body = await (await call("/v1/models", { method: "GET" })).json();
    return { models: (body.data || []).map((model) => model.id) };
  },
  async listen({ model, wav }) {
    const form = new FormData();
    form.set("model", String(model));
    form.set(
      "file",
      new Blob([Buffer.from(String(wav), "base64")], { type: "audio/wav" }),
      "speech.wav",
    );
    const body = await (
      await call("/v1/audio/transcriptions", { method: "POST", body: form })
    ).json();
    return { text: String(body.text || "").trim() };
  },
  async speak({ model, voice, text }) {
    const response = await call("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: String(model),
        voice: String(voice),
        input: String(text),
        response_format: "pcm",
      }),
    });
    return { pcm: Buffer.from(await response.arrayBuffer()).toString("base64") };
  },
};
const out = (answer) => process.stdout.write(`${JSON.stringify(answer)}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const op = Object.hasOwn(ops, request.op) ? ops[request.op] : undefined;
  if (!op) return out({ id: request.id, ok: false, error: "Unknown request" });
  op(request).then(
    (result) => out({ id: request.id, ok: true, ...result }),
    (error) =>
      out({
        id: request.id,
        ok: false,
        // fetch fails this way only when it can't reach the server at all.
        error:
          error?.message === "fetch failed"
            ? "oMLX isn't running"
            : String(error?.message || error),
      }),
  );
});
