# CreaEditor

CreaEditor is Creacoon's build of Visual Studio Code (based on VS Code 1.140.0). On top of VS Code it adds:

- the Creacoon look: Creacoon Dark and Creacoon Light themes, logo and app icon;
- chat that runs only on your own language models (BYOK, LiteLLM, Claude Code, Codex, ...), with all of Copilot Chat's built-in agents, prompts and tools;
- OpenRouter presets in the model picker, without listing every OpenRouter model;
- request metadata (extra headers and body fields) per API key and per model;
- subagents that can start their own subagents;
- chat groups: agents can start several sessions at once, each in its own git worktree and branch.

## Installing (macOS)

1. Open `CreaEditor-darwin-arm64.dmg` and drag **CreaEditor** to **Applications**.
2. Start CreaEditor from Applications or Spotlight.

The app is ad-hoc signed, not notarized by Apple. On the Mac that built it, it opens normally. On another Mac, the first time, right-click the app in Applications, choose **Open**, then confirm. You can also run:

```sh
xattr -dr com.apple.quarantine /Applications/CreaEditor.app
```

To open folders from the terminal, run **Shell Command: Install 'creaeditor' command in PATH** from the Command Palette, then use `creaeditor .`.

CreaEditor keeps its settings and extensions apart from VS Code (`~/Library/Application Support/CreaEditor`, `~/.creaeditor`). Extensions come from [Open VSX](https://open-vsx.org). Telemetry is off.

## Language models

GitHub Copilot models are not used, and no GitHub sign-in is needed for chat. Add models in one of these ways:

- **Chat: Manage Language Models** (or **Manage Models...** in the model picker): add an API key for OpenRouter, Anthropic, OpenAI, Azure, Gemini, Ollama, a custom OpenAI-compatible endpoint, and others.
- Extensions that contribute language models, such as LiteLLM, show up in the model picker automatically.
- **Claude Code** (`anthropic.claude-code`) and **Codex** (`openai.chatgpt`) install from the Extensions view and work as in VS Code.

Copilot Chat's agents (Agent, Ask, Plan, ...), prompts, tools, custom agents (`.github/agents/*.agent.md`), prompt files and instructions all work with these models. Internal helper tasks, such as titles and summaries, use the selected chat model, or the model set in `chat.utilityModel` / `chat.utilitySmallModel`.

## OpenRouter presets

By default an OpenRouter API key shows **only the models you add**, not the whole catalog.

Add one:

1. Click **+** in the **Other Models** section of the model picker, or run **Chat: Add OpenRouter Preset or Model...**.
2. Type the preset slug (`programmer-agent`), `@preset/programmer-agent`, or paste the preset URL from openrouter.ai. You can also pick a regular model from the list.
3. Accept or change the name, for example `Programmer Agent (preset)`.

The first time, you are asked for the OpenRouter API key.

Agents and prompt files can use the model by name:

```yaml
---
model: Programmer Agent (preset)
---
```

The entries live in `chatLanguageModels.json` (**Chat: Open Language Models (JSON)**). There you can also set capabilities:

```jsonc
{
  "name": "OpenRouter",
  "vendor": "openrouter",
  "apiKey": "${input:chat.lm.secret.openrouter}",
  "models": [
    { "id": "@preset/programmer-agent", "name": "Programmer Agent (preset)" },
    { "id": "@preset/reviewer", "name": "Reviewer (preset)", "contextWindow": 400000, "maxOutputTokens": 64000, "vision": true },
    { "id": "anthropic/claude-sonnet-4.5" }
  ],
  // true: also list the full OpenRouter catalog after your own entries
  "showAllModels": false
}
```

Preset defaults are tool calling on, vision off, a 200K context window and 32K output tokens. A preset can borrow the capabilities of a catalog model with `"baseModel": "anthropic/claude-sonnet-4.5"`.

## Request metadata

Every BYOK provider group (that is, every API key) can add HTTP headers and JSON body fields to its requests. You can set them for the whole key, for single models via `requestMetadata.models`, or on a model entry itself.

```jsonc
{
  "name": "OpenRouter",
  "vendor": "openrouter",
  "apiKey": "${input:chat.lm.secret.openrouter}",
  "requestMetadata": {
    "headers": { "X-Title": "CreaEditor", "HTTP-Referer": "https://creacoon.nl" },
    "body": {
      "user": "${user}",
      "session_id": "${sessionId}",
      "metadata": { "project": "${workspaceFolderName}", "machine": "${hostname}" }
    },
    "models": {
      "@preset/reviewer": { "body": { "provider": { "order": ["anthropic"], "allow_fallbacks": false } } }
    }
  },
  "models": [
    {
      "id": "@preset/programmer-agent",
      "name": "Programmer Agent (preset)",
      "requestMetadata": { "body": { "metadata": { "role": "programmer" } } }
    }
  ]
}
```

- **Precedence:** key-level values, then `requestMetadata.models[id]`, then the model entry's own `requestMetadata`. Objects merge deeply, and `null` removes a key that was set at a lower level.
- **Variables:** `${model}`, `${modelName}`, `${provider}`, `${sessionId}`, `${requestId}`, `${workspaceFolder}`, `${workspaceFolderName}`, `${user}`, `${hostname}`, `${appName}`, `${date}` and `${env:NAME}`.
- **Protected fields:** the prompt fields (`messages`, `input`, `tools`, `model`, `stream`, `system`, `contents`) can't be overridden.
- **Coverage:** OpenAI-compatible providers (OpenRouter, OpenAI, Azure, custom endpoints, Ollama, ...) and Anthropic get headers and body fields. Gemini gets headers.

## Subagents that start subagents

Subagents (the `agent` / `runSubagent` tool) can start their own subagents. Nested subagents appear as cards inside their parent's card.

| Setting | Default | |
| --- | --- | --- |
| `chat.subagents.allowInvocationsFromSubagents` | `true` | Turn nesting on or off |
| `chat.subagents.maxNestingDepth` | `5` | A subagent started by the main agent has depth 1. Maximum 10. |

Depth is counted per chain, so parallel subagents do not use up each other's budget.

## Chat groups: parallel PRs in separate worktrees

In the **Agents window**, an agent can start other sessions, each in its own git worktree on its own branch, and follow them up. A typical use is your *Issue to PR (Agents View)* agent working on several issues at once. Any custom agent whose `tools` include `agent` gets these tools automatically:

| Tool | What it does |
| --- | --- |
| `create_session_group` | Starts up to 10 sessions at once under one group name, after one confirmation that lists all of them. Each session gets a fresh worktree from `baseBranch` (default: the repository's upstream or default branch), an optional `branch` name, a `prompt`, and an optional `agent` (for example `Issue to PR (Agents View)`) and model. |
| `create_session` | Starts a single session. With `relationship: "independent"` it accepts `agent`, `branch` and `worktree`. |
| `list_session_group` | Shows status, branch, worktree, changes and pull request of every member. |
| `list_sessions`, `get_session_context`, `send_message` | Inspect a session or send it a follow-up. |

Example prompt in the Agents window:

> Create a session group "Sprint 12" that runs the *Issue to PR (Agents View)* agent for issues #101, #102 and #107, one worktree each, based on `develop`. Report the PR links when they are done.

Members appear under the group name in the Agents window. A failing member does not stop the others.

| Setting | Default | |
| --- | --- | --- |
| `chat.agentHost.maxSessionSpawnDepth` | `3` | How deep agent-created sessions may nest |
| `chat.agentHost.agentOrchestrationLimits` | `on` | `off` removes the depth and breadth limits |

## Building from source

```sh
scripts/creaeditor-build-macos.sh                # full build (downloads Node, installs dependencies)
scripts/creaeditor-build-macos.sh --skip-install # reuse node_modules
```

The script writes `dist/CreaEditor-darwin-<arch>.dmg`, and the app to `../VSCode-darwin-<arch>/CreaEditor.app`. It needs the Xcode command line tools. `uv` is optional; it is used for the styled DMG window.
