// OpenCode agents for Buzz, as an installed plugin: an agent type whose agents
// are OpenCode on this computer, all in one `opencode acp` process. Each
// conversation an agent is in is one ACP session; OpenCode answers with the
// Buzz tools, served to it over loopback HTTP MCP.
import type { AgentType, Context } from "./buzz";
import { OpenCodeIcon } from "./icon";
import { OpenCodeModels } from "./models";
import { React, setReact } from "./react";
import { OpenCodeRuntime } from "./runtime";
import {
  adopt,
  type Config,
  carry,
  config,
  DEFAULT_CONFIG,
  exportShared,
  importShared,
  syncedSettingsSchema,
  withSyncedSettings,
} from "./settings";
import { createTabs } from "./tabs";
import { GeminiKeySettings, readGeminiKey, readVoiceEngine } from "./gemini";
import { openLiveVoice } from "./live";
import { localModels, OmlxHelper, omlxEngine } from "./omlx";
import { type Engine, openVoice } from "./voice";

export const TYPE_ID = "opencode";
/** A turn's run returns once opencode has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

export const inject = ["react", "agents", "host"];

export function apply(ctx: Context) {
  setReact(ctx.react);
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "opencode-harness"}/${TYPE_ID}`;
  const desktop = !!(host.spawn && host.resolveDirectory && host.serveMcp);
  const runtime = new OpenCodeRuntime(agents, host);
  const models = desktop
    ? new OpenCodeModels({
        // biome-ignore lint/style/noNonNullAssertion: checked by `desktop`.
        spawn: host.spawn!.bind(host),
        // biome-ignore lint/style/noNonNullAssertion: checked by `desktop`.
        resolveDirectory: host.resolveDirectory!.bind(host),
      })
    : undefined;
  // Local voice talks to oMLX through one helper process, started when first
  // needed.
  const omlx = desktop
    ? // biome-ignore lint/style/noNonNullAssertion: checked by `desktop`.
      new OmlxHelper(host.spawn!.bind(host))
    : undefined;
  const checkLocal = omlx
    ? () => localModels(omlx)
    : async () => ({ error: "needs the desktop app" });
  // Huddle voice's settings, in the plugin's own Settings card. Its service
  // is optional: without it the agents still run.
  if (desktop)
    ctx.inject(["settingsCards"], (scope) => {
      scope.settingsCards.register({
        id: "voice",
        title: "OpenCode voice",
        group: "App",
        component: () => <GeminiKeySettings host={host} local={checkLocal} />,
      });
    });
  if (desktop) {
    const sync = () => {
      const snapshot = agents.snapshot();
      if (snapshot.status === "loading") return;
      runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
    };
    const unsubscribe = agents.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
      void omlx?.stop();
    });
  }

  const listModels = async () => models?.read() ?? { current: "", models: [] };
  const { ActivityTab, Create, SettingsTab } = createTabs({
    models: listModels,
    modes: async () => models?.modes() ?? { current: "", modes: [] },
    runtime,
  });

  const type: AgentType<Config> = {
    id: TYPE_ID,
    title: "OpenCode",
    // Buzz types it as its own icon wrapper; a plain component renders the same.
    icon: OpenCodeIcon as unknown as AgentType<Config>["icon"],
    description:
      "OpenCode on this computer, with any provider it supports. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    adopt,
    carry,
    exportShared,
    importShared,
    summary: (agent) => {
      const { mode, model } = config(agent.config);
      return [mode, model].filter(Boolean).join(" · ") || "OpenCode";
    },
    Create,
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: ActivityTab,
      },
    ],
    sessions: {
      list: (key) =>
        runtime.conversations(key).map(({ key, at }) => {
          const [channelId = key, root] = key.split("/");
          return { channelId, ...(root && { root }), at };
        }),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    models: listModels,
    sessionControls: {
      scope: (agent) => config(agent.config).scope,
      state: (agent, place) => runtime.sessionState(agent, place),
      run: (agent, place, action) => runtime.session(agent, place, action),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    // Huddle voice: speech in and out through oMLX, Gemini Live or OpenRouter, the work in the
    // room's OpenCode session (src/voice.ts).
    ...(desktop
      ? {
          voice: async (seat) => {
            const think = (heard: string) => runtime.voiceTurn(seat, heard);
            const post = (speaker: "owner" | "agent", text: string) =>
              runtime.voicePost(seat, speaker, text);
            // The voice chosen in Settings. Automatic: local oMLX models when
            // oMLX serves them, then Gemini Live with a key, then OpenRouter.
            const choice = readVoiceEngine();
            const gemini = readGeminiKey();
            let engine: Engine | undefined;
            if (omlx && (choice === "local" || choice === "auto")) {
              const models = await localModels(omlx);
              if (!("error" in models)) engine = omlxEngine(omlx, models);
              else if (choice === "local")
                throw new Error(`Local voice is unavailable: ${models.error}`);
            }
            if (!engine && choice === "gemini" && !gemini)
              throw new Error("Add a Gemini API key in Settings → OpenCode voice");
            const connection =
              !engine && gemini && (choice === "gemini" || choice === "auto")
                ? await openLiveVoice(seat, gemini, think, post)
                : await openVoice(seat, host, think, post, engine);
            // While seated, what the agent posts for its owner elsewhere is
            // said aloud too.
            const off = runtime.onOwnerNeeded(seat.agent.key, (text) =>
              connection.announce(text),
            );
            seat.signal.addEventListener("abort", off, { once: true });
            return {
              input: (samples) => connection.input(samples),
              close: () => {
                off();
                return connection.close();
              },
            };
          },
        }
      : {}),
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    timeoutMs: HANDOVER_MS,
    syncedSettings: {
      schema: syncedSettingsSchema,
      withSynced: withSyncedSettings,
    },
    resumes: true,
  };
  agents.register<Config>(type);
}
