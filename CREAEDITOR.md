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

**Help → CreaEditor Guide** opens the help pages: every feature explained step by step for people new to CreaEditor, with diagrams and screenshots. They are Markdown files in `extensions/creaeditor-features/help/` (images in `help/images/`), opened in the Markdown preview by the command `creaeditor.help.open` (with a page name such as `delegate-to-server`); the **Learn More** buttons of the features tour use it too. When a feature changes, update its page there as well as this file.

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
- **Limit per key:** with several keys, the model picker shows what each key has left next to its name ("Work key · $12.40 left of $50", or "$3.10 spent this month" without a limit); the model hover says it too. It is read every 5 minutes while the window has focus and shortly after requests: OpenRouter `GET /api/v1/key` (and `/api/v1/credits` when the key may read the balance), LiteLLM `GET /key/info`.
- The built-in search and execution subagents of the editor chat cannot pick a model per key, so on a key they always use the chat's own model.
- A subagent that asks for another key's model ends with "The model ... is not available to this chat: subagents stay on the key ... the chat uses." on its card; the parent chat keeps going.

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

**AI Costs page** (**Chat: Show AI Costs** in any window, the $(credit-card) button at the top of the Sessions list in the Agents window, or the $(credit-card) button next to **Other Models** in the model picker once a key shows its limit):
- Shows the total per issue, and per chat within each issue.
- Filter by period, gateway or text, and export everything as CSV.
- The **Advanced** tab analyses the requests in depth: filter on date range, key, model, gateway, repository, branch, issue, chat, cost source, machine (this computer or a CreaEditor Server, see AI Costs of Servers), main chats or subagents, missing costs, cost per request and free text; see totals, median and P95 request cost, tokens, cache hit share, cost per active day and a projection for this month; cost over time stacked by key, model or another dimension, a breakdown, tokens over time, a pivot table and every request in a sortable, paged table. Each click on a bar, legend entry or row adds a filter chip: values of the same kind match any of them, different kinds all apply. Export the filtered requests as CSV or JSON. The tab and its filters are remembered.
- **Compare** (Advanced tab) puts the period next to the one before it of the same length, or **This month vs last month**: cost, requests and tokens per key or model with the change, and every KPI card shows its change.
- **Subscriptions** at the top shows the Claude and Codex pools (share left, accounts available) and per account its email, plan, usage windows and status. It refreshes every 30 seconds; **Refresh Usage** asks for new readings and **Show Subscription Usage** opens the usage page. Without accounts it offers **Add Claude Account** and **Add Codex Account**.
- **Keys** shows per OpenRouter or LiteLLM key its limit, what is left (with a bar), when the limit resets and what the gateway says it spent today, this week and this month (OpenRouter) or since the last budget reset (LiteLLM), or why the key could not be read.
- **Budgets:** **Add Budget** (or **Chat: Add AI Budget**) sets an amount per day, week or month for a key, an issue (`acme/web#42`, `PROJ-7`) or a repository (`acme/web`). The spend is counted from the costs recorded on this Mac. A notification says when 80% and 100% are reached, once per period, with **Open AI Costs** and **Edit Budget**. With **Warn and Stop** (hard stop), requests of that key, issue or repository, subagents included, are refused before they are sent once the budget is used up: "Your CreaEditor budget for the Personal key ($50 per month) is used up. Raise it with Edit under Budgets on the AI Costs page." These budgets are CreaEditor's own limits, separate from a key's limit at LiteLLM or OpenRouter, which CreaEditor only reads. Budgets live in the `creaeditor.aiCosts.budgets` setting, so they sync with Settings Sync and can be edited as JSON (`warnAt` changes the percentages).
- **Cost per chat:** the chat header (chat view title, chat editor title, and the session title bar in the Agents window) shows the OpenRouter/LiteLLM cost of the chat, subagents included, as soon as it has one. Hover for requests and tokens; click to open AI Costs filtered to that chat.
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

In the Agents window, the header of the Sessions list has four extra buttons after New, Filter and Find: **Toggle Agents Tree** ($(type-hierarchy-sub)), which folds the **Agents** section below the Sessions list open or closed (clicking the section's header does the same; drag the line above an open section to make it taller or shorter, and the height is remembered), **Show AI Costs** ($(credit-card)), which opens the [cost page](#cost-per-issue-and-chat) full screen over the chat, **Show Subscription Usage** ($(pulse)) and **Stop All Chats** ($(debug-stop)). The section shows the subagents of running and recent sessions, also when you never opened them, each nested under the subagent that started it (the agent host records that parent as `spawningChat` on the chat's tool origin).

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
2. Ask for the work, for example: *"Make PRs for issues #101, #102 and #107 on `develop`."* When it cannot tell whether they are GitHub or Jira issues, it asks.
3. The Director reads the issues (with `gh`, or the Atlassian tools for Jira), checks that they don't overlap, and starts one session per issue with `create_session_group`. You confirm the whole group once.
4. Each session runs the built-in **Issue to PR** agent in its **own new worktree and branch**: it implements the issue, has the **Code Reviewer** agent review it as its own subagent, and opens its own pull request. The Director follows them up and ends with a table of branches and PR links.

### Issue to PR and Code Reviewer

Two more built-in agents, usable without the Director:

- **Issue to PR** takes one GitHub or Jira issue to a ready-to-review pull request: issue to In Progress, branch, plan, implement, tests and the project's own checks, review by the Code Reviewer (at most two fix rounds), push, pull request, issue to In Review. It asks whether the issue is on GitHub or Jira when the prompt does not say. It learns the project's commands and rules from AGENTS.md, CONTRIBUTING and the build files. Started by the Director, it stays on the branch it was given.
- **Code Reviewer** is read-only: it reviews a branch's changes against its base and the acceptance criteria and reports verified findings with file and line. Issue to PR calls it as a subagent; you can run it yourself on any branch.

The agents live in `extensions/creaeditor-agents/agents/`. Copy one into a project's `.github/agents/` to change it for that project.

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

Run **Chat: Toggle Creacoon Pet** (or type `/creacoon-pet`, or check **Pet** when you right-click the chat background, on the new-session screen or in a chat; **Hide Pet** in the pet's own menu turns it off) for the Creacoon pet, the green chat companion that replaces the VS Code pet. Its context menu switches between Green and Mint colors.

## Subscription accounts

Claude and Codex can each run on **several subscription accounts** (for example a work and a personal Claude Max plan, or five work accounts); there is no limit on how many. The accounts of a provider form one pool: the model picker keeps a single Claude and a single Codex entry, new work goes to the first account that has room, and a chat whose account is used up can continue on the next one.

**Adding accounts** (Command Palette, category Chat):

| Command | What it does |
| --- | --- |
| **Add Claude Account** | Asks a name, then **Paste a Setup-Token** (run `claude setup-token` in a terminal and paste the token it prints; it is kept in the keychain) or **Sign In with the Browser** (CreaEditor opens claude.ai and picks up the login when the page says you are set up; no terminal or separate Claude install needed; if it does not finish, **Sign In** again). |
| **Add Codex Account** | Asks a name and opens the ChatGPT sign-in page. |
| **Manage Subscription Accounts** | Lists the accounts per provider: sign in, refresh usage, rename, move up or down (the order in which they are tried), remove. |
| **Show Subscription Usage** | Opens the usage page. |

The login you already had (`~/.claude`, `~/.codex`) is always listed first (for Claude as **This Computer**).

**When an account is used up**, the chat shows the limit with **Continue on** *next account* and **Always Switch Automatically**. With `chat.subscriptionAccounts.autoSwitch` on (default off; the "allow all" for limits), the chat moves to the next account without asking. When every account is used up, the chat says when the first one resets and offers **Add Claude Account** / **Add Codex Account** and **Show Usage**.

**Before the limit**: when an account's tightest window passes 80% (and again at 95%) a notification says so once per window and reset ("The Claude account Work has used 82% of its 5-hour limit (resets in 1h 12m).") with **Show Usage** and **Don't Warn Again**; a chat running on that account gets a short note. From then on the account's usage is read every two minutes instead of ten. Set the share with `chat.subscriptionAccounts.usageWarningThreshold` (`0` turns warnings off).

**Continue When Usage Resets**, on the limit message (also when no other account is left), makes the chat wait ("Waiting for the Work account's 5-hour limit to reset at 14:05…"; **Stop** cancels) and continue the interrupted turn on that account a minute after the reset, once a new reading confirms it. With `chat.subscriptionAccounts.whenNoAccountLeft` set to `waitForReset` a chat whose last account is used up waits by itself. The wait runs in the window, so keep it open.

**Choosing an account**: with more than one account, a Claude or Codex model in the model picker opens a list with **Pool (Automatic)** and every account (what is left; used-up and signed-out accounts are disabled). Below the accounts, **Show Subscription Usage** and **Add Claude Account** / **Add Codex Account** lead to the accounts without changing the model. Choosing an account pins the current chat to it (the picker then shows e.g. "Claude Opus 5.5 · Work"); when it is used up, the chat runs on the pool or asks as usual and goes back to the pinned account once it has room. Pins last while CreaEditor runs.

**Stop All Chats** (command palette, and the stop button at the top of the Sessions list in the Agents window) cancels every running chat, asking first when more than one runs.

**Usage page** (**Show Subscription Usage**, or the pulse icon next to AI Costs at the top of the Sessions list in the Agents window, where it opens full screen): per provider a card with the pool's average share left, how many accounts are available and the first reset, and one row per account with its email, plan, status and a bar per usage window ("38% left · resets in 3h"). Below the pool and every account a chart shows the used share per window over the past four weeks (point at it for the values of an hour) with a summary such as "Hit its limit 6 times in 4 weeks" and whether all accounts were ever used up at once, to judge whether the pool has enough accounts. The agent host records a reading per account at most every ten minutes in `agent-subscription-usage-history.jsonl` (in `globalStorage`, eight weeks kept). In the editor window the status bar shows the pools in short (`Claude 62% · Codex 80%`); its hover lists every account and a click opens the page.

Setup-tokens are stored in the keychain by the window and handed to the agent host on every (re)start; the agent host keeps them in memory only. Browser logins live in their own CLI config folder per account.

**Good to know:**
- A setup-token is checked with one tiny real request (Haiku, one turn) only when it is added or replaced, and again when Anthropic refuses it during a chat (or on **Refresh** while its check failed). An accepted token is remembered by a fingerprint (never the token itself), so starting CreaEditor does not check it again. A refused token shows an error and is skipped; Anthropic refusing a token during a chat is handled like a used-up account. Each check uses a very small amount of that account's usage.
- Setup-tokens can only send prompts, so their usage comes from those check requests and from chats; until then the account shows "No usage reading yet". The Claude usage reading uses an API Anthropic marks as experimental.
- Codex runs one app-server per account that has chats, so chats on different Codex accounts run side by side and switching never ends another chat. An account's app-server starts with its first chat and stops five minutes after its last turn (the one where new chats start keeps running).
- A chat continued on another account keeps the whole conversation, tool results and images included: Claude resumes the same session and Codex the same thread on the other account. A turn that had not started yet is sent again as it was, with its attachments; otherwise the model is asked to continue ("Continue where you left off." for Claude, which shows as an extra turn when the chat is replayed). Only when a Codex thread cannot be resumed there does the chat continue on a new thread with the request resent as text, and the chat says so. A Claude session that cannot be resumed ends the turn with a note saying why.
- Each added account has its own folder (`~/.creaeditor/claude-accounts/<id>`, `~/.creaeditor/codex-accounts/<id>`) with its own login; chat history, settings, skills and agents are links to `~/.claude` and `~/.codex`, so a chat can move between accounts.
- Some ChatGPT plans do not include Codex usage; OpenAI answers `402 Payment Required` and the account shows that note.
- The Claude and Codex agent SDKs ship inside CreaEditor.app (about 490 MB), because CreaEditor has no SDK download server.
- After installing a new CreaEditor build, macOS asks once for access to **CreaEditor Safe Storage** (where the tokens are kept); choose **Always Allow**. Without an Apple Developer ID that answer does not carry over to the next build.

## Compacting Idle Claude Chats Before the Cache Expires

Anthropic keeps a Claude chat's context in its prompt cache after each request, for a time chosen per request: 5 minutes by default, 1 hour when the request uses 1-hour caching; reading it from the cache costs a tenth of the normal price. A message sent after the cache expired writes the whole context to the cache again at full price (more than the normal price), which adds up for a big chat you come back to later.

So CreaEditor compacts an idle Claude chat shortly before its cache expires: 4 minutes 15 seconds after its last turn ended (57 minutes when the last request used the 1-hour cache, seen from the turn's usage) it runs the Claude CLI's own `/compact`. The summary is made from the cached context (cheap), and your next message starts from the small summary. The chat shows it as "Compacted to save cost: the prompt cache was about to expire, so the conversation was summarized while reading it was still cheap.", with "Conversation compacted: older messages were summarized." (what a `/compact` you send yourself shows). The agent host remembers the automatic compactions in the chat's database (`creaeditor.autoCompactBoundaries`, the ids of their `compact_boundary` records), so a reloaded chat still says why it was compacted. It does not send a phone notification and does not mark the chat unread.

It only happens when all of this holds: the setting is on; the context of the last request (input, cache read and cache write tokens) is at least `creaeditor.claude.compactBeforeCacheExpiresMinTokens` (default 60000); the chat is idle (no running turn, no queued or steering message, nothing waiting for approval or an answer; a chat waiting for a usage reset ended with an error and is never compacted); it is not archived, read-only or delegated to a server (a delegated chat is archived on the laptop; on the server it is compacted there); and it was not compacted since your last message (a `/compact` you sent counts). A new message cancels it, and a chat is compacted at most once per idle period. On a CreaEditor Server at its running chats limit the compaction is skipped rather than queued.

The trade-off: a summary loses detail of the conversation (exact file contents, tool output, earlier wording). Turn it off with `creaeditor.claude.compactBeforeCacheExpires` (on by default), or raise the threshold so only big chats are compacted. Both settings apply to every agent host this computer connects to.

## Remote Access

Use the Agents window of your Mac from a phone or another computer: see the sessions and chats live, open a chat and follow its output, send messages, approve or skip tool calls, stop a chat or **Stop All Chats**, and pick the agent and model. The agents keep running on the Mac; the device shows the same sessions as every window.

**Set up Tailscale** (once): install [Tailscale](https://tailscale.com/download) on the Mac and on the phone, and sign in to the same account on both. Remote Access listens on the Mac's Tailscale address only (never on all networks), so only devices in your tailnet can reach it. Traffic inside a tailnet is encrypted by WireGuard, so plain `http://` is fine there.

**Turn it on**: in the Agents window click the phone button at the top right (or Cmd+Shift+P, **Show Remote Access**) and click **Allow Remote Access** (also a command: **Allow Remote Access** turns it on and off). The dialog shows the address (`http://100.x.y.z:8790`, also the MagicDNS name when your tailnet has it), a QR code with a one-time pairing code, the paired devices with **Sign Out**, the password and public access.

**Pair a device**: scan the QR code with the phone's camera. The page asks for a device name (it suggests one, such as "iPhone (Safari)") and opens the Agents window in the phone layout. The device keeps its key in the browser, so later it only needs the address; add it to the home screen for an app-like window. Codes work once and expire after 10 minutes (**New Code** makes another). **Sign Out** on the Mac ends the device's key and closes its connections at once.

**Keep-awake**: while Remote Access is on and a chat runs, the Mac does not sleep ("Keeping this Mac awake while chats run" in the dialog); it may sleep again once no chat runs. Closing the lid still sleeps most MacBooks unless they are on power with an external display.

**Try it on the Mac** (no Tailscale needed): set `creaeditor.remoteAccess.network` to `localhost` (or click **Use Localhost Only** in the dialog), turn Remote Access on, click **Copy Link** and open the link in a browser; the browser's device toolbar (phone size, e.g. 390×844) shows the phone layout.

**Public access** (optional, off by default): reach the Mac from anywhere over HTTPS with [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), for example from a phone without Tailscale. Set a password first (at least 8 characters), then click **Turn On Public Access**. CreaEditor runs `tailscale funnel --bg --yes 8790` (Funnel forwards `https://<mac>.<tailnet>.ts.net` to `127.0.0.1:8790`, so the server then also listens on `127.0.0.1`), shows the `https://` address from `tailscale funnel status --json`, and puts that address in the QR code. While public access is on, every new pairing needs the password as well as the pairing code. **Turn Off Public Access** (or turning Remote Access off) runs `tailscale funnel --https=443 off`. Funnel must be allowed for your tailnet once; if it is not, the dialog shows Tailscale's link to allow it. Quitting CreaEditor leaves the Funnel configured (it then answers with an error until CreaEditor runs again).

**Cloudflare Tunnel instead of Funnel**: keep public access off, set the network to `localhost`, and point a tunnel at the port, e.g. `cloudflared tunnel --url http://127.0.0.1:8790` (quick tunnel) or a named tunnel with your own hostname. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of it, because CreaEditor only asks for the password when its own public access is on.

**Security**:
- Device keys are long random secrets; the Mac only stores their SHA-256 hash (`<user data>/remote-access/remote-access-auth.json`, readable by you only). The password is stored as an scrypt hash.
- Five wrong pairing codes or passwords from one address within 15 minutes lock that address out for 15 minutes; 30 failures from all addresses together lock pairing for everyone for 15 minutes.
- The pages and scripts of the web Agents window are served without a key (they are the same for everyone and hold no data); everything with data (the agent host connection) needs a device key.
- Devices paired over Tailscale keep working when public access is turned on; sign them out to require the password from everyone.
- Anyone with a paired device can do what you can do in the Agents window, including running commands on the Mac through the agents. Sign out devices you lose.

**Settings**: `creaeditor.remoteAccess.enabled`, `creaeditor.remoteAccess.network` (`tailscale` or `localhost`), `creaeditor.remoteAccess.port` (default `8790`). They are per machine and not synced. `GET /health` answers `{ "status": "ok", "version": … }` without a key.

**How it works**: the main process runs the server, so it survives window reloads and stops when CreaEditor quits. It serves the web Agents window (built into `CreaEditor.app/Contents/Resources/app/out-sessions-web` by `scripts/creaeditor-build-macos.sh`), the pairing page and API, and relays each device's authenticated WebSocket to the agent host. The server core is shared with CreaEditor Server: see `src/vs/platform/agentHost/node/remoteAccess/README.md`.

## CreaEditor Server

A separate, headless CreaEditor that runs the agents (Claude, Codex) on a machine that is always on: a Linux server with Docker, a Mac mini, a Linux box. You use it from CreaEditor on your laptop (its chats show in the Agents window next to the laptop's) and from your phone (the same web Agents window as Remote Access). The server keeps its own chats, accounts and worktrees, so it keeps working while the laptop sleeps.

It is the agent host plus the Remote Access server: one port (default **31600**) serves the web Agents window, pairing (`/api/pair`), `/health` and the agent host WebSocket (`/ahp`, device key required). The agent host runs as a child process on a private unix socket and is restarted when it stops.

**Add it in CreaEditor**: in the Agents window, Cmd+Shift+P, **Add CreaEditor Server** (also in the workspace picker under Manage, and the **Add CreaEditor Server** button of the CreaEditor Features walkthrough):
- **Connect by Address or Pairing Link**: paste the link the server prints (`http://100.x.y.z:31600/#pair=ABCDE-12345`) or just its address (`https://agents.example.com`, `http://100.x.y.z:31600`; a bare `100.x.y.z` means port 31600). Without a code in the link CreaEditor asks for one; a public server also asks for its password. CreaEditor exchanges the code for a device key, keeps the key in its secret storage (never in settings) and connects.
- **Install on a Computer over SSH**: pick a host from your SSH config or type `user@host`, then choose **Install as a Service from a Server Tarball** (copies a `creaeditor-server-<os>-<arch>.tar.gz` from this computer and runs its installer), **from a Download URL** (that computer downloads the tarball for its system), or **Run with Docker** (runs the image you built, see below). Choose how this computer reaches it: **Tailscale** (recommended; the server listens on that computer's Tailscale address), **Every Network of That Computer** (plain HTTP on 0.0.0.0, trusted networks only) or **Only That Computer** (for a domain or Funnel you set up there; you then enter its address). CreaEditor reads the pairing code the installer prints and pairs.

**CreaEditor Servers** (Cmd+Shift+P, or Manage in the workspace picker) lists every server: Online or Offline (with "last seen"), version, CPU and memory of the server machine, running and queued chats ("3 of 4 chats running · 2 queued"), and whether it is public. Per server: **Open in Browser**, **Pair Phone** (a QR code with a fresh one-time pairing code the server makes for this computer, so the phone pairs as soon as it opens the page; an older server shows its page and you run `creaeditor-server pair` for a code), **Sign In to an Account on This Server** (below), **Check Now** and **Remove** (signs this computer out of the server and forgets its key; the server keeps running).

**Accounts on the server**: the server has its own Claude and Codex logins (in Docker they live in the data volume). From **CreaEditor Servers** > a server > **Sign In to an Account on This Server**:
- **Claude: Sign In with a Browser**: the server runs `claude auth login`; CreaEditor opens the sign-in page here, and you paste the code the page shows.
- **Claude: Paste a Setup-Token**: a token from `claude setup-token`; the server keeps it encrypted (see Data) so it survives restarts.
- **Codex: Sign In with a Device Code**: the server runs the ChatGPT device sign-in; CreaEditor copies the code and opens the page where you enter it.

**Run it with Docker** (Linux, amd64 or arm64), from the repository:

```sh
docker build -f build/creaeditor-server/Dockerfile --build-arg BUILD_SOURCEVERSION=$(git rev-parse HEAD) -t creaeditor-server .
cd build/creaeditor-server
docker compose up -d                                   # on 127.0.0.1:31600 of the Docker host
docker compose exec creaeditor-server creaeditor-server pair     # a pairing code and link
docker compose exec creaeditor-server creaeditor-server status
```

The image build uses `dist/creaeditor-server-linux-<arch>.tar.gz` when it is there, and otherwise builds the server from source inside Docker (needs about 8 GB of memory). The image runs as a non-root user with `git`, `gh` and `ssh`, keeps everything in the `/data` volume (`HOME` is `/data/home`, so Claude, Codex, `gh` and git settings persist), exposes 31600 and has a `HEALTHCHECK` on `/health`.

- **Tailscale** (recommended): `docker compose --profile tailscale up -d` with `TS_AUTHKEY=tskey-auth-…` in a `.env` file next to the compose file. The sidecar joins your tailnet as `creaeditor-server` and serves `https://creaeditor-server.<tailnet>.ts.net` (Tailscale Serve, `tailscale-serve.json`). Set `CREAEDITOR_SERVER_PUBLIC_URL` to that address so pairing links use it. For access from the internet set `AllowFunnel` to true in `tailscale-serve.json` (Tailscale Funnel) and also `CREAEDITOR_SERVER_PUBLIC=1`.
- **Your own domain with HTTPS**: `docker compose --profile public up -d` with `CREAEDITOR_PUBLIC_DOMAIN=agents.example.com` in `.env` (a DNS record pointing at the machine, ports 80 and 443 open). Caddy gets a Let's Encrypt certificate and proxies to the server; the domain also turns public mode on.
- **Public mode** (domain or Funnel): pairing needs the password as well as the code. Set it once: `docker compose exec creaeditor-server creaeditor-server password`.
- Behind Caddy or the Tailscale sidecar every client reaches the server from the proxy's address, so failed pairing attempts of all clients count together for the lockout.

**Run it as a macOS service** (Apple silicon): extract `creaeditor-server-darwin-arm64.tar.gz` and run `creaeditor-server/install.sh` (or `install/macos/install.sh`). It installs into `~/Applications/CreaEditor Server` (`--system`: `/usr/local/lib/creaeditor-server`), writes the launch agent `~/Library/LaunchAgents/nl.creacoon.creaeditor-server.plist` (starts at login, restarts when it stops) and starts it with `launchctl bootstrap gui/$UID`. It listens on the Mac's Tailscale address when Tailscale runs, else on 127.0.0.1 (`--host`, `--port` to change). Logs: `~/Library/Logs/CreaEditor Server/server.log`. Remove with `install/macos/uninstall.sh` (`--purge` also deletes the data). The tarball is not notarized; the installer removes the quarantine flag.

**Run it as a Linux service** (instead of Docker): extract the tarball and run `creaeditor-server/install.sh`. As root it installs into `/opt/creaeditor-server` and runs a systemd service as the user `creaeditor` (data in `/var/lib/creaeditor-server/data`); as a user it installs into `~/.local/lib/creaeditor-server` with a user service (run `loginctl enable-linger $USER` once so it keeps running after you log out). Install `git` (and `gh` for pull requests) on the machine. Logs: `journalctl -u creaeditor-server` (add `--user` for a user service). Remove with `install/linux/uninstall.sh`.

**One-line install**: publish the tarballs and `build/creaeditor-server/install.sh` on a web server, then on the machine: `curl -fsSL https://downloads.example.com/creaeditor-server/install.sh | CREAEDITOR_SERVER_DOWNLOAD_URL=https://downloads.example.com/creaeditor-server sh`. Options go after `sh -s --`, e.g. `--host 0.0.0.0`. The same `install.sh` also works from an extracted tarball.

**Commands** (`creaeditor-server help`): `serve` (default) starts the server; `pair` prints a new one-time pairing code, its link and (in a terminal) a QR code; `password` sets or removes the password for public mode; `status` shows the agent host state, paired and connected devices, CPU and memory; `version`. Options (with environment variables): `--host` (`CREAEDITOR_SERVER_HOST`; default 127.0.0.1, 0.0.0.0 in Docker), `--port` (`CREAEDITOR_SERVER_PORT`, 31600), `--data-dir` (`CREAEDITOR_SERVER_DATA_DIR`), `--public-url` (`CREAEDITOR_SERVER_PUBLIC_URL`, or `https://$CREAEDITOR_PUBLIC_DOMAIN`), `--public` (`CREAEDITOR_SERVER_PUBLIC=1`), `--log`, `--disable-codex` (`CREAEDITOR_SERVER_CODEX=0`), `--max-running-chats` (`CREAEDITOR_SERVER_MAX_RUNNING_CHATS`, default 4; see Several Chats at Once). On first start, with no device paired yet, the server prints a pairing code to its log and writes it to `<data>/pairing.txt` (readable by its user only). `pair`, `password` and `status` talk to the running server through an admin endpoint on 127.0.0.1 that needs the token in `<data>/remote-access/admin-token`, so only the server's user (or root) can use them.

**Data** (`--data-dir`; default `~/.creaeditor-server`, `/data` in Docker; folder mode 0700):
- `agent-host/`: chats (session database), agent settings, the account list, logs.
- `secrets/`: Claude setup-tokens (and later gateway keys), encrypted with AES-256-GCM under a key derived from `secrets/master.key` (generated on first start, 0600). There is no OS keychain in Docker, so this file store replaces it.
- `remote-access/`: paired devices (only hashes of their keys), the password (scrypt hash), the admin token.
- `repos/`: repositories of delegated chats (bare), `worktrees/`: one worktree per delegated chat, `delegations/`: their records (see Delegate to a Server).
- `costs/`: the AI cost ledger of OpenRouter/LiteLLM requests the server makes itself (`creaeditor-gateway-costs.jsonl`) and the budgets your laptop pushed (`budgets.json`).
- `server.json` (pid, port, version while it runs) and `pairing.txt`.
- In Docker, `/data/home` holds `~/.claude`, `~/.codex`, gh and git settings.

**Backups**: stop the server (`docker compose stop`, `launchctl bootout gui/$UID/nl.creacoon.creaeditor-server`, or `systemctl stop creaeditor-server`) and copy the whole data folder (in Docker: `docker run --rm -v creaeditor-data:/data -v $PWD:/backup alpine tar czf /backup/creaeditor-data.tgz -C /data .`). Keep `secrets/master.key` with `secrets/secrets.json`: one is useless without the other, so store the backup privately.

**Updating**: Docker: rebuild the image and `docker compose up -d` (the volume stays). macOS and Linux: run the new tarball's `install.sh` again; it stops the service, replaces the program and starts it, and keeps the data and paired devices. Paired laptops and phones reconnect by themselves.

**Try it on this Mac from the repository** (after `npm run transpile-client`):

```sh
node out/vs/server/node/creaeditorServer/creaeditorServerMain.js --host 127.0.0.1 --port 31600 --data-dir /tmp/ce.server
node out/vs/server/node/creaeditorServer/creaeditorServerMain.js pair --data-dir /tmp/ce.server
```

Then **Add CreaEditor Server** with `http://127.0.0.1:31600`. Use the Node from `.tools/node` (the server's native modules are built for Node 24); without a web build in `.build/out-sessions-web` the browser shows the pairing page only. Add `--enable-mock-agent` and `VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED=false` to try it without real agents.

**Build the tarballs**: `scripts/creaeditor-build-server.sh [darwin-arm64|linux-x64|linux-arm64] [--skip-install] [--skip-web] [--dry-run]` writes `dist/creaeditor-server-<os>-<arch>.tar.gz` with Node, the bundled server and agent host (the standard remote server packaging, `gulp vscode-reh-<os>-<arch>-min`), the web Agents window, the Claude and Codex SDKs for the target, the `bin/creaeditor-server` command and the installers. Native modules are compiled for the building OS, so build the Linux tarballs on Linux or let the Docker build do it.

## Delegate to a Server

Move a chat from your laptop to a CreaEditor Server: the chat continues there with its code, so you can close the laptop. It only runs in one place at a time.

**Delegate**: in the Agents window, right-click a chat (or its header) > **Delegate to Server...**, or pick **Delegate to Server...** under **Continue Chat in...** in the chat input (also Cmd+Shift+P). In the editor window the same **Delegate to Server...** (under **Continue Chat in...** or Cmd+Shift+P) opens the Agents window and delegates the chat from there; only agent chats (Copilot CLI, Claude, Codex) that run on this computer can move. Pick the server, then how the results come back. If the chat is running, CreaEditor stops it first. A notification shows the progress ("Sending code... 12 MB / 40 MB").

What goes to the server:
- **The code**, as one git bundle: the current branch with the history the server lacks, plus your uncommitted changes and untracked files that are not ignored (`.gitignore` is respected). Your files, index and branches are not touched. The first time the whole history of the branch goes up; after that only new commits (the server says which commits it has). Untracked files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, ...) stay on the laptop unless you choose **Send Them Too**; tracked files always go, they are in the repository anyway. The upload is limited to 500 MB (`creaeditor.delegation.maxUploadMB`); over the limit you get a clear message.
- **The conversation**: the agent's own session, rewritten from your folder to the server's worktree, so the chat resumes there as the same session with all its history: for Claude the Agent SDK transcript (with its subagents), for Codex the thread's rollout (`~/.codex/sessions/...`, installed in the server's `CODEX_HOME`), for Copilot CLI the session folder (`~/.copilot/session-state/<id>`: events, workspace and session database). When a session cannot move (missing, larger than 64 MB, or the server cannot import it), the chat continues with a transcript of the conversation as an attachment; the notification says so.
- **Claude setup-token accounts**, encrypted for that server (X25519 + AES-256-GCM, on top of Tailscale or HTTPS), so the server's agent host is the only one that can read them; it keeps them in its encrypted secret store. A browser-login Claude account or a Codex login cannot move: if the server has none, sign in once on the server (**CreaEditor Servers** > the server > **Sign In to an Account on This Server**). - **The OpenRouter or LiteLLM key** of a Copilot CLI chat on such a model (its provider group: name, gateway, URL, key and models), sealed the same way. The server's agent host keeps it in its encrypted secret store and calls the gateway itself, so the chat runs while the laptop is off. The chat and its subagents only use that key (another key's model is refused, as on the laptop); every request is checked against your hard-stop budgets and recorded in the server's cost ledger with the chat's repository, branch, issue and title (see **AI Costs of Servers**). A later delegation with the same key name replaces the key on the server.
- **Your personal agents, skills and instructions** (repository ones go with the code anyway): Claude `~/.claude/agents/`, `skills/`, `commands/` and `CLAUDE.md`; Copilot CLI `~/.copilot/agents/`, `skills/` and `copilot-instructions.md`; Codex `~/.codex/AGENTS.md` (Codex prompts and skills stay: Codex reads them only from its shared home). Never settings, credentials (`.credentials*`, `auth.json`, `config.toml`), MCP configurations, `.env*` or keys, caches, `projects/`, `sessions/`, `todos/`, files over 1 MB, or more than 10 MB in all. Sealed for the server like the accounts and sent to the code receiver, which keeps them per delegation in `<data>/user-customizations/<id>/` (removed with the worktree, sent fresh on every delegation). Only that chat's agent uses them, looked up by its working directory: Claude as a local plugin `personal` of the session (plus `CLAUDE.md` appended to its system prompt; the server's `~/.claude` is untouched), Copilot CLI with the agents as `customAgents` of the session (the SDK drops plugin-folder agents once a session has custom agents, and did not show them on a server at all) and the skills from a plugin folder (plus `copilot-instructions.md` appended to its system message), Codex with `AGENTS.md` in its developer instructions. Browser-login Claude accounts, Codex logins and MCP servers do not move.

On the server the chat works in its own worktree `<data>/worktrees/<id>` on the branch `creaeditor/delegated/<id>`, with your uncommitted changes as uncommitted changes (repositories are kept as `<data>/repos/<repo>.git`). The chat then shows under the server in the Agents window (and on your phone when it is connected to the server). The laptop's chat is archived and locked: instead of its input it says "This chat continues on <server>." with **Open on Server**, **Bring Back Changes** (or **Open PR from the Server**) and **Take Back Here**. **Take Back Here** (also in the chat header menu and **Show Delegated Chats**) stops the chat on the server, archives it there and unlocks the local chat, which continues from where it was delegated: the conversation on the server stays there, so bring its changes back first.

**Results**, chosen when delegating and changeable later (**Change How Results Come Back** in the chat header menu):
- **Bring Back Changes**: when the laptop is online, fetches the server's branch into the local branch `creaeditor/from-<server>/<id>`; the server's uncommitted work comes as one last commit. Your working tree is never touched; then pick **Compare** (a diff against your current branch), **Checkout** or **Merge** (both refuse while you have uncommitted changes; a merge with conflicts is undone).
- **Open PR from the Server**: the server commits its uncommitted work, pushes `creaeditor/delegated/<id>` to the repository's GitHub `origin` and opens a pull request with `gh`. It uses its own GitHub token: set it once with **Set GitHub Token on Server** (a fine-grained token with Contents and Pull requests read and write; the server keeps it encrypted and never puts it in command lines or logs). The server needs `gh` (the Docker image has it).

**Start on Server**: a new chat (no turn yet) can start on the server right away: type its first message in the new chat input and click **Start on Server...** (the server button below the input; it shows when a CreaEditor Server is added), or run **Delegate to Server...** from Cmd+Shift+P. The folder's code goes up as above, and the chat starts in its worktree on the server with that message, on the same agent (Copilot CLI, Claude, Codex) and model; no turn runs on this computer (attachments stay here). It has no local copy, so Take Back Here does not apply.

**Cleanup**: the server removes a delegated chat's worktree, its branch `creaeditor/delegated/<id>`, its base ref and its record by itself: at once when you delete the chat on the server; 7 days after the chat was archived (Take Back Here archives it; unarchiving it cancels this); 30 days after it was delegated when no chat on the server works in it any more (its chat data is gone). Except for a deleted chat, only while the work is safe: the worktree's state, uncommitted changes included, is what Bring Back Changes last fetched, what Open PR from the Server last pushed, or what it was when the chat arrived. The server checks on start and every 4 hours (it follows its agent host's chats over the agent host socket: `listSessions` and the `root/session*` notifications) and logs each removal. **Clean Up Server...** (Cmd+Shift+P, or the server in **CreaEditor Servers**) lists every worktree with its size, chat state (in use, archived, no chat on the server), whether its work was brought back and when the server removes it, and removes the ones you select, with a warning when their work was not brought back; any paired device may do this. Chats started on the server itself in a delegated repository work in `<repo>.worktrees/` and are cleaned up with their chat, as upstream does.

**Status**: **Show Delegated Chats** (Cmd+Shift+P) lists every delegated chat with its server, state (running, waiting for approval, done, server offline) and branch, with Open on Server and the results action. While CreaEditor runs, a notification says when a delegated chat finishes or waits for you. When the server is offline, delegating stops with **Try Again**; uploads continue where they stopped after a dropped connection.

**Limitations**: the lock and **Take Back Here** are in the Agents window (the editor window's chat panel does not lock a delegated chat). Taking a chat back does not bring the server's conversation along, only its code (with Bring Back Changes). OpenRouter and LiteLLM keys move with Copilot CLI chats only (Claude and Codex chats use their own accounts). On the server, BYOK requests go to the gateway's Chat Completions API (OpenRouter's Anthropic models too), without streaming.

**How it works**: the laptop's main process packs the code (`git bundle` with a snapshot commit built in a temporary index) and talks to the server's code receiver under `/api/delegation/` with this computer's device key (chunked, resumable uploads). The accounts go to the server's agent host over the agent host connection. See `src/vs/platform/agentHost/node/creaeditorDelegation/README.md`.

## Notifications on Your Phone

Get a push notification when a chat finishes, stops with an error, or waits for your approval or an answer, for chats on this computer (useful with Remote Access) and on your CreaEditor Servers. It uses [ntfy](https://ntfy.sh): a free app for iOS and Android, no account needed.

**Set it up**: Cmd+Shift+P > **Set Up Notifications** (also in the CreaEditor Features walkthrough) > **Use ntfy.sh (Recommended)**. CreaEditor makes a topic with a random 128-bit name (`https://ntfy.sh/creaeditor-…`; anyone who knows a topic can read it, so keep it private) and shows it as a QR code: in the ntfy app tap **+**, scan it or type the topic, then **Send Test Notification**. **Use My Own ntfy Server...** takes your server's address and an access token (for a server with access control). Run the command again to show the QR code, send a test, use a new topic or turn notifications off.

The topic and token are kept in CreaEditor's secret storage, never in settings. CreaEditor gives them to the agent host of this computer and of every CreaEditor Server it connects to; a server keeps them in its encrypted secret store, so it notifies after a restart while your laptop is off. When you turn notifications off, servers forget the topic the next time this computer connects to them.

A notification has the chat's title and a short message ("Finished on build-box.", "Waits for your approval or answer.") without code or other content; tapping it opens the web Agents window (the Remote Access address, or the server's address). A status must hold for a few seconds (an approval you answer at once does not notify), every change notifies once, and at most 10 notifications go out per minute.

Settings: `creaeditor.notifications.enabled`, `creaeditor.notifications.events` (`finished`, `failed`, `needsInput`), `creaeditor.notifications.onlyWhenAway` (on by default: only when no CreaEditor window on a computer had focus for `creaeditor.notifications.awayMinutes`, default 5) and `creaeditor.notifications.awayMinutes`. They apply to every agent host this computer connects to.

**Try it without ntfy**: run a listener on this Mac (`node -e "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d).on('end',()=>{console.log(q.url,b);s.end('{}')})}).listen(8999,'127.0.0.1')"`), choose **Use My Own ntfy Server...** with `http://127.0.0.1:8999` and send a test: the listener prints the JSON CreaEditor posts.

## Several Chats at Once on a Server

A CreaEditor Server runs several chats at the same time, each delegated chat in its own worktree. To keep the machine responsive it runs at most `--max-running-chats` (default 4) at once; a chat you send while that many run waits in a queue and shows "Queued on <server> (2 ahead)" until another one finishes, then starts by itself. Stopping a queued chat takes it out of the queue. The **CreaEditor Servers** list shows the running and queued chats, and `/health` tells a paired device (with its device key) the CPU, memory and chat counts; without a key `/health` stays minimal.

## AI Costs of Servers

OpenRouter and LiteLLM requests a CreaEditor Server makes itself are recorded in the server's own ledger (`<data>/costs/`). While the Agents window is open (it holds the paired servers, so open it once after starting CreaEditor; it may stay in the background), CreaEditor pulls new entries from every paired server every few minutes (and when a server connects) with its device key, keeps them in the default profile's `globalStorage/creaeditor-server-costs/`, and the **AI Costs** page of every window shows them with everything else: the **Advanced** tab has a **Machine** filter and breakdown (This computer, or the server's name), and every request shows its machine. On a server, OpenRouter and LiteLLM requests always run on the keys delegated chats brought along.

**Budgets** count the spend of all machines. Budgets with a hard stop also stop requests on a server: CreaEditor sends them to every server with what this computer and the other servers spent in the current period, and the server refuses a request once the budget is used up. When the period ends before CreaEditor sends again, the server counts only its own spend.

## Dictation with Whisper

Dictation (the microphone in the chat input, editor window and Agents window) runs **Whisper Large v3 Turbo** on this computer through Foundry Local (the native runtime is bundled in the macOS app; the model is not). Guide page: [Dictation](extensions/creaeditor-features/help/dictation.md).

**One-time install**: the first dictation asks at once (the install check reads the cache folder first; the online catalog is only read when files are there) **Download a Speech Model for Dictation?** with **Whisper Small (Faster)** (`whisper-small`, about 0.4 GB), **Whisper Large (More Accurate)** (`whisper-large-v3-turbo`, about 1.3 GB) or **Both** (Small first), downloaded once from Microsoft's Foundry Local catalog into `<cache>/chatDictationModels`. The download runs in the background with a cancellable progress notification and does not start listening; the first model that installs becomes `dictation.model` ("Whisper Small is installed. Start dictation again to talk."). **Cancel** downloads nothing. Stopping dictation while it is still starting cancels the start, so no prompt follows later. **Switch Speech Model...** in the microphone's right-click menu (command `workbench.action.chat.switchDictationModel`) switches between the two, asking before it downloads one that is not installed. A dictation start never downloads a model (`ILocalTranscriptionService.start` fails with `notInstalled`; only `downloadModel` downloads).

**Segments**: Foundry Local's live transcription session only runs Nemotron ("NemotronStreamingProcessor requires a nemotron_speech model type"), so for Whisper the utility process cuts the audio into utterances (`SpeechSegmenter`: energy-based with an adaptive noise floor, 600 ms of silence ends one, at most 24 s, cut at the quietest recent frame) and transcribes each with `AudioClient.transcribeStreaming` (a private temporary WAV file, removed right after); the words of the utterance stream into the input as they are decoded, and Stop transcribes what was said last. Whisper's output for silence ("you", dots, subtitle credits) is dropped. Each utterance takes about 3.5 s on an M-series Mac (on all cores; Whisper pads every utterance to 30 s, so the time hardly depends on its length).

**Language**: Foundry Local's Whisper does not detect the language; without a hint it writes English and translates Dutch into English. With the Dutch hint it keeps English words and sentences English. `dictation.language` (default Automatic: the Voice Mode language, else the first non-English language of the display language, the browser languages and the OS's preferred languages, else English). Pause between sentences in different languages: Whisper can drop a whole sentence in the other language inside one utterance.

**Listening bar**: while dictation listens, a slim bar docked above the chat input shows the microphone level (a scrolling graph; a still meter with reduced motion) and **Listening…** / **Transcribing…** (aria-live). For Whisper it also shows the spoken language as a chip (**NL** / **EN**): clicking it, or **Switch Dictation Language** (Cmd+Alt+J while dictating), switches `dictation.language` between English and the other language (the last non-English choice, remembered in `dictation.lastOtherLanguage`, else the first non-English system language) and hands it to the running session (`ILocalTranscriptionService.setLanguage`, from the next utterance on). **Spoken Language...** in the microphone's right-click menu (`workbench.action.chat.pickDictationLanguage`) picks any language of the setting. Foundry Local puts a fixed language token in Whisper's prompt (the hint, else English) and returns no detected language or scores, so there is no automatic detection; with mixed speech, words of the other language are kept only partly (tested: Dutch main language keeps English words in Dutch sentences but can drop a Dutch word in an English sentence).

`dictation.model` still offers Nemotron (streaming, on-device) and MAI (cloud).

**Microphone always shown**: the microphone's right-click menu has no **Microphone Button** or **Disable** any more (a hidden button had no way back from the input box), and configuration migrations clear a stored `false` of `dictation.showButton` and `dictation.enabled` (both default `true`; the `DictationEnabled` policy still turns dictation off). The menu ends with **How Dictation Works** (`creaeditor.help.open` `dictation`).

## Building from source

```sh
scripts/creaeditor-build-macos.sh                # full build (downloads Node, installs dependencies)
scripts/creaeditor-build-macos.sh --skip-install # reuse node_modules
```

The script writes `dist/CreaEditor-darwin-<arch>.dmg`, and the app to `../VSCode-darwin-<arch>/CreaEditor.app`. It needs the Xcode command line tools. `uv` is optional; it is used for the styled DMG window.
