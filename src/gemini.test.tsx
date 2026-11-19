import { beforeEach, expect, it, vi } from "vitest";
import { checkGeminiKey, GEMINI_KEY, readGeminiKey, saveGeminiKey } from "./gemini";

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  });
});

it("keeps the key in this computer's storage, trimmed, and removes it", () => {
  expect(readGeminiKey()).toBeUndefined();
  saveGeminiKey("  AIza-1 ");
  expect(readGeminiKey()).toBe("AIza-1");
  expect(localStorage.getItem(GEMINI_KEY)).toBe("AIza-1");
  saveGeminiKey(undefined);
  expect(readGeminiKey()).toBeUndefined();
});

it("checks a key with Google, in a header, and says why one fails", async () => {
  const request = vi.fn(async () => ({ status: 200, headers: {}, body: "{}" }));
  expect(await checkGeminiKey(request as never, "AIza-1")).toBeUndefined();
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: expect.stringMatching(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models/),
      headers: { "x-goog-api-key": "AIza-1" },
    }),
  );
  const bad = vi.fn(async () => ({ status: 400, headers: {}, body: JSON.stringify({ error: { message: "API key not valid." } }) }));
  expect(await checkGeminiKey(bad as never, "nope")).toBe("API key not valid.");
});
