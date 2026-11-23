// Huddle voice's settings, kept in this computer's Buzz storage only and never
// synced: which voice to use, and the Gemini API key, which is sent nowhere but
// Google. The OpenCode and Claude (subscription) plugins share both under the
// same names, so they're set once.
import type { Host } from "./buzz";
import { LIVE_ORIGIN } from "./live";
import { React } from "./react";
import { Button, ChoiceRow, Field, SettingsGroup, TextInput } from "./ui";

export const GEMINI_KEY = "buzz-voice.gemini-api-key";

export const ENGINE_KEY = "buzz-voice.engine";
export type VoiceEngine = "auto" | "local" | "gemini" | "openrouter";
const ENGINES: readonly { value: VoiceEngine; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "local", label: "Local (oMLX)" },
  { value: "gemini", label: "Gemini Live" },
  { value: "openrouter", label: "OpenRouter" },
];

const listeners = new Set<() => void>();
const store = () => globalThis.localStorage as Storage | undefined;
const changed = () => {
  for (const listener of listeners) listener();
};

export function readGeminiKey(): string | undefined {
  return store()?.getItem(GEMINI_KEY)?.trim() || undefined;
}
export function saveGeminiKey(key: string | undefined) {
  const trimmed = key?.trim();
  if (trimmed) store()?.setItem(GEMINI_KEY, trimmed);
  else store()?.removeItem(GEMINI_KEY);
  changed();
}
/** The voice chosen in Settings; Automatic tries local, then Gemini, then
 * OpenRouter. */
export function readVoiceEngine(): VoiceEngine {
  const saved = store()?.getItem(ENGINE_KEY);
  return ENGINES.some((engine) => engine.value === saved)
    ? (saved as VoiceEngine)
    : "auto";
}
export function saveVoiceEngine(engine: VoiceEngine) {
  if (engine === "auto") store()?.removeItem(ENGINE_KEY);
  else store()?.setItem(ENGINE_KEY, engine);
  changed();
}
function useStored<T>(read: () => T, key: string) {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const storage = (event: StorageEvent) => {
        if (event.key === key) listener();
      };
      globalThis.addEventListener?.("storage", storage);
      return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.("storage", storage);
      };
    },
    read,
    read,
  );
}

/** Whether Google accepts `key`: undefined if so, otherwise why not. */
export async function checkGeminiKey(
  request: Host["request"],
  key: string,
): Promise<string | undefined> {
  try {
    const response = await request({
      url: `${LIVE_ORIGIN}/v1beta/models?pageSize=1`,
      method: "GET",
      headers: { "x-goog-api-key": key },
      timeoutMs: 15_000,
    });
    if (response.status >= 200 && response.status < 300) return undefined;
    try {
      return JSON.parse(response.body)?.error?.message ?? `Google answered ${response.status}`;
    } catch {
      return `Google answered ${response.status}`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The plugin's Settings card: the voice to use, and the Gemini key. `local`
 * says whether oMLX can listen and speak, or why not. */
export function GeminiKeySettings({
  host,
  local,
}: {
  host: Pick<Host, "request">;
  local?: () => Promise<{ listen: string; speak: string } | { error: string }>;
}) {
  const saved = useStored(readGeminiKey, GEMINI_KEY);
  const engine = useStored(readVoiceEngine, ENGINE_KEY);
  const [found, setFound] = React.useState<string>();
  React.useEffect(() => {
    let live = true;
    void local?.().then((models) => {
      if (!live) return;
      setFound(
        "error" in models
          ? `Local: ${models.error}.`
          : `Local: ${models.listen} listens and ${models.speak} speaks.`,
      );
    });
    return () => {
      live = false;
    };
  }, [local]);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const id = React.useId();
  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    setError(undefined);
    const problem = await checkGeminiKey(host.request.bind(host), key);
    setBusy(false);
    if (problem) {
      setError(`That key didn't work: ${problem}`);
      return;
    }
    saveGeminiKey(key);
    setDraft("");
  };
  return (
    <SettingsGroup layout="form">
      <ChoiceRow
        title="Voice"
        value={engine}
        choices={ENGINES}
        description={[
          "Automatic uses local oMLX models when oMLX is running, then Gemini Live with a key, then OpenRouter.",
          found,
        ]
          .filter(Boolean)
          .join(" ")}
        onChange={(value) => saveVoiceEngine(value as VoiceEngine)}
      />
      <Field
        id={id}
        label="Gemini API key"
        error={error}
        description={
          saved
            ? `Saved on this computer, ending in ${saved.slice(-4)}.`
            : "For Gemini Live. Get one at aistudio.google.com/apikey. It stays on this computer."
        }
      >
        <TextInput
          id={id}
          type="password"
          value={draft}
          disabled={busy}
          invalid={!!error}
          placeholder={saved ? "Replace the saved key" : "Paste your key"}
          onChange={setDraft}
        />
      </Field>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          variant="prominent"
          disabled={busy || !draft.trim()}
          onClick={() => void save()}
        >
          {busy ? "Checking…" : "Save key"}
        </Button>
        {saved && (
          <Button disabled={busy} onClick={() => saveGeminiKey(undefined)}>
            Remove key
          </Button>
        )}
      </div>
    </SettingsGroup>
  );
}
