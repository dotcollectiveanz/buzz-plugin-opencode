// Share and harness changes, as Buzz runs them: `exportShared` and `carry`
// make a share (`src/features/agents/agent-share.ts` in buzz-app), Import
// offers the first type whose `importShared` takes the listing, and a type
// change takes the old type's `carry` into the new one's `adopt`.
import { describe, expect, it } from "vitest";
import {
  adopt,
  carry,
  config,
  DEFAULT_CONFIG,
  exportShared,
  importShared,
} from "./settings";

describe("share", () => {
  it("lists the opencode runtime with the model and instructions", () => {
    const saved = config({
      mode: "plan",
      model: "anthropic/claude-sonnet-4-5",
      effort: "high",
      instructions: "Be brief.",
      workspace: "~/Sites/secret",
      scope: "channel",
    });
    expect(exportShared(saved)).toEqual({
      runtime: "opencode",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(carry(saved).instructions).toBe("Be brief.");
    // Nothing of this computer's: the workspace stays out of what is listed.
    expect(JSON.stringify(exportShared(saved))).not.toContain("secret");
  });

  it("lists OpenCode's own default model as none", () => {
    expect(exportShared(DEFAULT_CONFIG)).toEqual({ runtime: "opencode", model: "" });
    expect(exportShared({ model: "  " })).toEqual({ runtime: "opencode", model: "" });
  });
});

describe("import", () => {
  it("takes an opencode listing as a new agent on its model", () => {
    expect(importShared({ runtime: "opencode", model: " openrouter/x " })).toEqual({
      ...DEFAULT_CONFIG,
      model: "openrouter/x",
    });
    expect(importShared({ runtime: "opencode", model: "" })).toEqual(DEFAULT_CONFIG);
  });

  it("round-trips a share", () => {
    const saved = config({ model: "openai/gpt-5", workspace: "~/Sites/app" });
    expect(importShared(exportShared(saved))?.model).toBe("openai/gpt-5");
  });

  it("leaves other runtimes to their own types", () => {
    for (const runtime of ["claude", "codex", "goose", "pi", "", undefined])
      expect(importShared({ runtime, model: "sonnet" })).toBeUndefined();
  });
});

describe("changing harness", () => {
  it("keeps the instructions and workspace both ways", () => {
    const brought = carry(config({ instructions: "Review PRs.", workspace: "~/Sites/app" }));
    expect(brought).toEqual({ instructions: "Review PRs.", workspace: "~/Sites/app" });
    expect(carry(adopt(brought, DEFAULT_CONFIG))).toEqual(brought);
  });
});
