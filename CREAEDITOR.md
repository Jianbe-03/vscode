# CreaEditor

CreaEditor is Creacoon's build of Visual Studio Code (based on VS Code 1.140.0). On top of VS Code it adds:

- the Creacoon look: Creacoon Dark, Creacoon Night (near-black, for working at night) and Creacoon Light themes, listed first in the theme picker, plus logo and app icon;
- chat that runs only on your own language models (BYOK, LiteLLM, Claude Code, Codex, ...), with all of Copilot Chat's built-in agents, prompts and tools;
- OpenRouter and LiteLLM connections that are detected automatically, with OpenRouter presets and only the models your key's guardrails allow, so the model picker stays short;
- tracking of every OpenRouter / LiteLLM request by chat and issue, and an **AI Costs** page with the cost per issue and per chat;
- request metadata (extra headers and body fields) per API key and per model;
- subagents that can start their own subagents, and an **Agents** tree that shows them all live;
- chat groups: agents can start several sessions at once, each in its own git worktree and branch;
- several Claude and Codex subscription accounts per provider, pooled behind one model, with a **Subscription Usage** page.

**Help → CreaEditor Features** opens a tour of all of this, with pictures.

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

GitHub Copilot models are not used, and no GitHub sign-in is needed for chat. Signing in to GitHub (for example for pull requests) doesn't add any Copilot models either: the Copilot CLI and the Agents window's Copilot agent only list your own models. Add models in one of these ways:

- **Chat: Manage Language Models** (or **Manage Models...** in the model picker): add an API key for OpenRouter, Anthropic, OpenAI, Azure, Gemini, Ollama, a custom OpenAI-compatible endpoint, and others.
- **Chat: Add OpenRouter or LiteLLM Models...** (also in the model picker): connect OpenRouter or your LiteLLM proxy, see below.
- Extensions that contribute language models show up in the model picker automatically.
- **Claude Code** (`anthropic.claude-code`) and **Codex** (`openai.chatgpt`) install from the Extensions view and work as in VS Code.

Copilot Chat's agents (Agent, Ask, Plan, ...), prompts, tools, custom agents (`.github/agents/*.agent.md`), prompt files and instructions all work with these models. Internal helper tasks, such as titles and summaries, use the selected chat model, or the model set in `chat.utilityModel` / `chat.utilitySmallModel`.

## OpenRouter and LiteLLM

Run **Chat: Add OpenRouter or LiteLLM Models...**, or click **Add OpenRouter / LiteLLM...** (or **+** next to **Other Models**) in the model picker.

1. Enter the URL: OpenRouter (`https://openrouter.ai/api/v1`, the default) or your LiteLLM proxy. If the proxy is only reachable over Tailscale or a VPN, connect that first. CreaEditor detects which of the two it is.
2. Give the connection a name and enter the API key (OpenRouter key or LiteLLM virtual key). It is stored in the secret storage of your Mac.

**OpenRouter:**
- The presets of your account appear in the model picker automatically (`GET /api/v1/presets`).
- To add a model, run the same command again. The list only offers models your key's guardrails, provider preferences and privacy settings allow (`GET /api/v1/models/user`).
- You can still type a preset slug, `@preset/...` or a preset URL.
- The rest of the catalog stays out of the picker unless you set `"showAllModels": true`.

**LiteLLM:**
- Every model your virtual key may use appears automatically, with context size, tool calling and vision taken from the proxy's `/model/info`.
- Hide models with `"hiddenModels": ["..."]`, or rename them under `"models"`.

**Several keys:** run the command again and choose **Connect OpenRouter or a LiteLLM Proxy...** to add another key, for example one for work and one for a personal project. Each key has its own name, presets, guardrails and models.
- Every model shows the name of its key, in the model picker and on the model button: "Claude Opus (Work key)", "Claude Opus (Personal key)".
- A chat stays on the key it started on. Its subagents, their subagents, and sessions or chats it starts with `create_session`, `create_session_group` or `create_chat` all use that same key, in the editor chat and in the Agents window. A model that only another key offers is refused with an error; an agent whose `model:` is not offered by the key runs on the chat's own model. Switching an Agents window chat to a model of another key is refused too; start a new chat for that.
- When a key hits its limit, the request fails with the error of that key. CreaEditor never falls back to another key.
- The **AI Costs** page records which key each request used.

Agents and prompt files can use the model by name, without the key name; the model of the chat's own key is used:

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

## Cost per issue and chat

Every request to OpenRouter or LiteLLM carries the chat it belongs to and the issue it works on, so the gateways can attribute the cost:

| Gateway | Sent with each request |
| --- | --- |
| OpenRouter | `session_id` (the chat), `user`, `trace` (issue as trace name) and `metadata`: `creaeditor_chat`, `creaeditor_issue`, `creaeditor_repo`, `creaeditor_branch`, `creaeditor_title`, ... Header `x-session-id`. |
| LiteLLM | `litellm_session_id`, `user`, `metadata` (same fields plus `tags`) and header `x-litellm-tags: creaeditor,chat:<id>,issue:<owner/repo#n>,repo:<owner/repo>` |

**Subagents:** their requests carry their own `creaeditor_subchat` id and add up to the chat that started them.

**Issue:** taken from, in order of preference:
1. an agent calling the **Set Chat Issue** tool (`#chatIssue`; it is in the `execute` tool set, so agents like *Issue to PR* have it);
2. a GitHub or Jira issue URL, `owner/repo#123`, a Jira key such as `PROJ-123`, or `#123` in the first prompt;
3. the branch name (`PROJ-123-fix-login`, `123-fix-login`, `issue/123`, `feature/GH-123-x`).

Jira keys are stored in upper case and link to the issue on the AI Costs page when the site is known (from a `/browse/PROJ-123` URL). Prefixes that are not tickets, like `UTF-8`, `SHA-256` or `GPT-5`, never count as a key.

**Recording costs:** CreaEditor records the cost each gateway reports:
- OpenRouter: `usage.cost` in the response, or `GET /api/v1/generation` afterwards.
- LiteLLM: the `x-litellm-response-cost` header, or `GET /spend/logs` when the key may read it.

**AI Costs page** (**CreaEditor: Show AI Costs per Issue and Chat**):
- Shows the total per issue, and per chat within each issue.
- Filter by period, gateway or text, and export everything as CSV.
- The data stays on your Mac.
- Because the metadata is sent along, the same breakdown is also available in the OpenRouter activity logs and in LiteLLM's spend tracking (tags), for the whole team.

## Jira

Agents can read Jira issues directly, with their description and comments, through Atlassian's official remote MCP server (Atlassian Cloud sites, `yourcompany.atlassian.net`).

1. Run **CreaEditor: Connect Jira...** from the Command Palette (or the button on the features page).
2. Choose **Sign In with Atlassian**. CreaEditor adds the server as `atlassian` to your MCP servers (`https://mcp.atlassian.com/v2/mcp`) and starts it; confirm that it may start, and sign in once in the browser. Agents only see what your Atlassian account can see.
   - Alternatively choose **Use a Service Account API Key** when your Atlassian admin enabled API keys for the Rovo MCP server. The key is asked for once and kept in the secret storage, not in `mcp.json`.
3. Mention a key in a chat, for example *"Fix PROJ-123"*, or ask for *"all open bugs in sprint 12"*. The agent reads the issue with the Jira tools.

The **Director** reads Jira issues too: *"Make PRs for PROJ-12, PROJ-15 and PROJ-20 on develop"* starts one session per issue, with the key in each branch name and pull request. Jira keys also count as the issue on the [AI Costs page](#cost-per-issue-and-chat).

Jira Data Center (self-hosted) is not supported by Atlassian's remote MCP server; use a community Jira MCP server for it.

## Request metadata

Your own metadata comes on top of the tracking fields above.

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

**Chat: Show Agents Tree** opens the **Agents** view next to the chat, like Claude Code's agent tree:
- Every chat is a card. Lines connect it to the cards of the subagents it started, and those to their own nested subagents.
- Each card shows the agent's task, model and duration, and updates live. Its colored edge shows the status: running, waiting for confirmation, done or failed. The line to a running agent takes that color too.
- Click a card to jump to it. The chevron on a card collapses its subagents; the keyboard works with the arrow keys and Enter.
- In the Agents window the tree also shows the sessions and chat groups an agent created.
- Ended agents stay visible as turned off: finished, failed or cancelled agents, closed chats and archived sessions keep their card in a quieter grey, and their subagents fold away (click the chevron to unfold them; they stay open). Running agents come first, then idle chats, then ended ones, each newest first. Only the 20 most recent closed chats or archived sessions are kept.

In the Agents window, the header of the Sessions list has two extra buttons after New, Filter and Find: **Toggle Agents Tree** ($(type-hierarchy-sub)), which folds the **Agents** section below the Sessions list open or closed (clicking the section's header does the same; drag the line above an open section to make it taller or shorter, and the height is remembered), and **Open AI Costs** ($(credit-card)), which opens the [cost page](#cost-per-issue-and-chat) full screen over the chat. The section shows the subagents of running and recent sessions, also when you never opened them, each nested under the subagent that started it (the agent host records that parent as `spawningChat` on the chat's tool origin).

| Setting | Default | |
| --- | --- | --- |
| `chat.subagents.allowInvocationsFromSubagents` | `true` | Turn nesting on or off |
| `chat.subagents.maxNestingDepth` | `5` | A subagent started by the main agent has depth 1. Maximum 10. |

Depth is counted per chain, so parallel subagents do not use up each other's budget.

## Chat groups: parallel PRs in separate worktrees

In the **Agents window**, an agent can start other sessions, each in its own git worktree on its own branch, and follow them up. A typical use is your *Issue to PR (Agents View)* agent working on several issues at once.

### The Director agent

CreaEditor ships a built-in **Director** agent for this. To make several pull requests at once:

1. Open the Agents window, pick your repository, and pick **Director** in the agent picker.
2. Ask for the work, for example: *"Make PRs for issues #101, #102 and #107 on `develop` with the Issue to PR (Agents View) agent."*
3. The Director reads the issues (with `gh`), checks that they don't overlap, and starts one session per issue with `create_session_group`. You confirm the whole group once.
4. Each session works in its **own new worktree and branch** and opens its own pull request. The Director follows them up and ends with a table of branches and PR links.

The Director itself never changes code, so it never needs a worktree. While it is selected, the **New Worktree** checkbox is hidden and the session works in your folder. Your usual worktree choice for that workspace is left as it was. The checkbox otherwise only affects the session you are starting.

To make your own director, copy the built-in one into `.github/agents/` and name the file `<something>-director.agent.md` (for example `sprint-director.agent.md`). Any agent file whose name ends in `director.agent.md` gets the same folder-only treatment. It needs `agent` in its `tools`.

### The tools

Any custom agent whose `tools` include `agent` gets these tools automatically:

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

## Agents window background and pet

The Agents window has a chat background behind the new-session view and every open chat, so it stays while you work in a session. Pick it with **Set Background...**, from the Command Palette or a right-click on the background. Next to **No Background**, **Codicons**, **Image...** and recently used images, it offers:

- **Starry Night** (default): a night sky whose twinkling stars are Creacoon marks, with a Creacoon shooting star now and then.
- **Creacoon Pattern**: a calm, slowly drifting pattern of Creacoon marks.

The choice is stored per color theme kind in `chat.agentSessions.preferredDarkBackgroundImage` and `chat.agentSessions.preferredLightBackgroundImage` (`starryNight`, `pattern`, `codicons`, `none`, or an image path). An existing `sessions.background` value is migrated to these settings. High contrast themes show no background, and with reduced motion on the stars don't twinkle, the pattern doesn't drift and there are no shooting stars.

Type `/creacoon-pet` (or use **Pet** in the same right-click menu) for the Creacoon pet, the green chat companion that replaces the VS Code pet. Its context menu switches between Green and Mint colors.

## Subscription accounts

Claude and Codex can each run on **several subscription accounts** (for example a work and a personal Claude Max plan). The accounts of a provider form one pool: the model picker keeps a single Claude and a single Codex entry, new work goes to the first account that has room, and a chat whose account is used up can continue on the next one.

**Adding accounts** (Command Palette, category Chat):

| Command | What it does |
| --- | --- |
| **Add Claude Account** | Asks a name, then **Paste a Setup-Token** (run `claude setup-token` in a terminal and paste the token it prints; it is kept in the keychain) or **Sign In with the Browser** (the Claude CLI opens claude.ai; if that fails, CreaEditor offers to run the printed `claude auth login` command in a terminal, or to copy it in the Agents window). |
| **Add Codex Account** | Asks a name and opens the ChatGPT sign-in page. |
| **Manage Subscription Accounts** | Lists the accounts per provider: sign in, refresh usage, rename, move up or down (the order in which they are tried), remove. |
| **Show Subscription Usage** | Opens the usage page. |

The login you already had (`~/.claude`, `~/.codex`) is always listed first (for Claude as **This Computer**).

**When an account is used up**, the chat shows the limit with **Continue on** *next account* and **Always Switch Automatically**. With `chat.subscriptionAccounts.autoSwitch` on (default off; the "allow all" for limits), the chat moves to the next account without asking. When every account is used up, the chat says when the first one resets and offers **Add Claude Account** / **Add Codex Account**.

**Usage page** (**Show Subscription Usage**, or the pulse icon next to AI Costs at the top of the Sessions list in the Agents window, where it opens full screen): per provider a card with the pool's average share left, how many accounts are available and the first reset, and one row per account with its email, plan, status and a bar per usage window ("38% left · resets in 3h"). In the editor window the status bar shows the pools in short (`Claude 62% · Codex 80%`); its hover lists every account and a click opens the page.

Setup-tokens are stored in the keychain by the window and handed to the agent host on every (re)start; the agent host keeps them in memory only. Browser logins live in their own CLI config folder per account.

## Building from source

```sh
scripts/creaeditor-build-macos.sh                # full build (downloads Node, installs dependencies)
scripts/creaeditor-build-macos.sh --skip-install # reuse node_modules
```

The script writes `dist/CreaEditor-darwin-<arch>.dmg`, and the app to `../VSCode-darwin-<arch>/CreaEditor.app`. It needs the Xcode command line tools. `uv` is optional; it is used for the styled DMG window.
