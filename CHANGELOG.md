# Changelog

## 1.2.1 (2026-11-19)

- **Huddle voice answers again:** every spoken request failed with "This conversation was not admitted
  by agents.harness", because the voice turn made up its own conversation, which Buzz's tools and
  replies refuse. It now has Buzz admit the room's conversation first, as this plugin's own local wake
  at the room's top level.

## 1.2.0 (2026-11-19)

- **Huddle voice:** OpenCode agents can join a Huddle and talk. `google/gemini-2.5-flash` transcribes
  your speech, the agent works on it in its OpenCode session for that room, with its tools as for a
  typed message, and `openai/gpt-audio-mini` reads the answer aloud. Both run through OpenRouter on the
  key OpenCode is signed in with. Both sides' words are posted in the Huddle, and an answer that comes
  after you leave is posted in the chat. Updating asks you to approve access to `https://openrouter.ai`.

## 1.1.0 (2026-11-18)

- **Share to the Marketplace:** the agent's card menu now offers **Share**, as it does for Buzz's own
  agents. Buzz has no OpenCode harness of its own, so the listing names the `opencode` runtime with the
  agent's name, picture, model and instructions. Whoever adds it with this plugin installed gets an
  OpenCode agent on that model, on their own OpenCode and providers. The OpenCode agent, thinking
  level, workspace and conversations aren't shared.
- **Import:** a shared `opencode` agent imports as OpenCode with its model. Listings for other runtimes
  are left to their own harnesses.
- **Releases on merge:** a version merged to `main` is tagged and released automatically, with its
  changelog section as the notes and `opencode-harness-plugin.zip` attached.
- Links point to the repository's current address, `dotcollectiveanz/buzz-plugin-opencode`.
- `npm test` runs only this plugin's tests, not those of a Buzz checkout made by `npm run types`.

## 1.0.0 (2026-11-10)

First public release.

- **OpenCode harness:** create an agent with OpenCode as its Harness, or switch one to it. Each thread
  (or channel) is one continuing OpenCode session, with the Buzz tools to read and post.
- **Identity:** OpenCode agent, Model and Thinking from your OpenCode, and Instructions.
- **Settings:** Workspace and Conversations.
- **Activity:** the agent's conversations with their status, and each one's transcript.
- **Synced settings and harness changes:** agent, model, thinking level and scope sync across devices;
  instructions and workspace carry over when an agent changes harness.
- A failed turn says so in its thread and tags the owner.
- Requires OpenCode 2.2 or later.
