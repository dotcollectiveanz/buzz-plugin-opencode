// An OpenCode agent's settings, which of them sync across devices (NIP-AP
// `buzz.agent.settings`), and what carries over when an agent changes harness.
// No credentials or env vars live in this config; the allowlist keeps it so.
import { validWorkspace } from "./acp/shims";

export type Scope = "thread" | "channel";
export type Config = Readonly<{
  /** An opencode agent (its ACP `mode`), such as `build`; empty uses
   * opencode's `default_agent`. */
  mode: string;
  /** A model opencode offers; empty uses opencode's own. */
  model: string;
  /** A thinking level opencode offers for the model; empty uses opencode's. */
  effort: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own session, or the whole channel is one. */
  scope: Scope;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  mode: "",
  model: "",
  effort: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
});
/** A saved config, filled from the defaults. New agent can't refuse a typed
 * path, so a blank or relative workspace runs in the default one rather than
 * wherever opencode was started. */
export const config = (value: unknown): Config => {
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
  };
  const workspace =
    typeof merged.workspace === "string" ? merged.workspace.trim() : "";
  return {
    ...merged,
    scope: merged.scope === "channel" ? "channel" : "thread",
    workspace: validWorkspace(workspace) ? workspace : DEFAULT_CONFIG.workspace,
  };
};

type SettingsSchema = Readonly<Record<string, "string" | readonly string[]>>;
export const syncedSettingsSchema = {
  mode: "string",
  model: "string",
  effort: "string",
  scope: ["thread", "channel"],
} as const satisfies SettingsSchema;

/** The allowlisted fields of a config, for publishing. */
const pick = (value: object) =>
  Object.fromEntries(
    Object.keys(syncedSettingsSchema)
      .filter((name) => name in value)
      .map((name) => [name, (value as Record<string, unknown>)[name]]),
  ) as Record<string, string>;

export const syncedSettings = (value: Config) => pick(value);

/** Synced fields come only from `settings`, a left-out one from the default;
 * everything else stays this device's. */
export const withSyncedSettings = (
  value: Config,
  settings: Readonly<Record<string, string>>,
): Config => ({ ...value, ...pick(DEFAULT_CONFIG), ...pick(settings) });

/** What one harness hands another when an agent changes type. */
export type Carry = Readonly<{ instructions?: string; workspace?: string }>;

/** What another harness may take over: the instructions, and a workspace
 * other than the default. */
export const carry = (saved: unknown): Carry => {
  const { instructions, workspace } = config(saved);
  return {
    ...(instructions.trim() && { instructions }),
    ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
  };
};

/** The catalog runtime an OpenCode agent is shared as. Buzz has no OpenCode
 * harness of its own, so only this plugin claims it. */
export const SHARED_RUNTIME = "opencode";

/** What a share or export lists (Buzz's agent menu offers Share only with
 * this): the `opencode` runtime and the model, with the instructions from
 * `carry`. The OpenCode agent, thinking level, workspace and anything else of
 * this computer's aren't shared. */
export const exportShared = (saved: unknown) => ({
  runtime: SHARED_RUNTIME,
  model: config(saved).model.trim(),
});

/** A shared `opencode` agent, imported as an OpenCode agent with its model;
 * any other runtime is left to the type it belongs to. */
export const importShared = (source: {
  runtime?: string;
  model: string;
}): Config | undefined =>
  source.runtime?.trim() === SHARED_RUNTIME
    ? { ...DEFAULT_CONFIG, model: source.model.trim() }
    : undefined;

/** A brought-over agent keeps the instructions and workspace it carries. */
export const adopt = (brought: Carry, saved: Config): Config => ({
  ...saved,
  instructions: brought.instructions ?? saved.instructions,
  workspace: brought.workspace ?? saved.workspace,
});
