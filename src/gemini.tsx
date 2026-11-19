// The Gemini API key Huddle voice runs on, kept in this computer's Buzz
// storage only: never synced, never sent anywhere but Google. The OpenCode and
// Claude (subscription) plugins share it under one name, so it's set once.
import type { Host } from "./buzz";
import { LIVE_ORIGIN } from "./live";
import { React } from "./react";
import { Button, Field, SettingsGroup, TextInput } from "./ui";

export const GEMINI_KEY = "buzz-voice.gemini-api-key";

const listeners = new Set<() => void>();
const store = () => globalThis.localStorage as Storage | undefined;

export function readGeminiKey(): string | undefined {
  return store()?.getItem(GEMINI_KEY)?.trim() || undefined;
}
export function saveGeminiKey(key: string | undefined) {
  const trimmed = key?.trim();
  if (trimmed) store()?.setItem(GEMINI_KEY, trimmed);
  else store()?.removeItem(GEMINI_KEY);
  for (const listener of listeners) listener();
}
function useGeminiKey() {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const storage = (event: StorageEvent) => {
        if (event.key === GEMINI_KEY) listener();
      };
      globalThis.addEventListener?.("storage", storage);
      return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.("storage", storage);
      };
    },
    readGeminiKey,
    readGeminiKey,
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

/** The plugin's Settings card: set, check and remove the Gemini key. */
export function GeminiKeySettings({ host }: { host: Pick<Host, "request"> }) {
  const saved = useGeminiKey();
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
      <Field
        id={id}
        label="Gemini API key"
        error={error}
        description={
          saved
            ? `Saved on this computer, ending in ${saved.slice(-4)}. Huddles use Gemini Live for listening and speaking.`
            : "Get one at aistudio.google.com/apikey. It stays on this computer, and Huddles then use Gemini Live for listening and speaking."
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
