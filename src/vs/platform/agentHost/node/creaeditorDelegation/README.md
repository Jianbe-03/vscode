# Delegate to Server (CreaEditor)

Moves a chat from this machine to a CreaEditor Server: its code, its conversation and the accounts it needs. The chat then runs there in its own worktree, and its results come back as a local branch or a pull request.

## Files

| File | Side | What it does |
|---|---|---|
| `../../common/creaeditorDelegation.ts` | both | Types, constants, the HTTP API shapes, `ICreaEditorDelegationService` |
| `delegationPack.ts` | laptop | `packWorkspace`: one git bundle with `head` and a `snapshot` commit (uncommitted + untracked, not ignored; secret-looking files only on request), incremental with `^<known>` |
| `delegationWorktrees.ts` | server | Bare repo per repository, worktree per chat, result bundles, `importResultBundle` (laptop), `openPullRequestFromServer` |
| `delegationSessionFiles.ts` | both | Session export (rewritten to the worktree path) and install: Claude SDK transcript, Codex rollout, Copilot CLI session folder |
| `delegationCrypto.ts` | both | X25519 + HKDF-SHA256 + AES-256-GCM envelope for the accounts, bound to the delegation id |
| `delegationAccounts.ts` | server agent host | Opens the envelope (`authenticate` resource `creaeditor-delegation-accounts:<id>`) with the key pair of the code receiver; the Claude agent adds its setup-tokens, the Copilot agent keeps its gateway key and work context, and every agent lists the arrived session files |
| `../shared/serverGatewayKeys.ts` | server agent host | Delegated OpenRouter/LiteLLM keys (by `<vendor>/<group>`) and work contexts (by worktree), encrypted |
| `../shared/gatewayDirectConnection.ts` | server agent host | The BYOK bridge connection of a server: calls `/chat/completions` with the delegated key, checks hard-stop budgets, records costs |
| `../shared/gatewayCostLedger.ts` | server agent host | Appends to `<costs>/creaeditor-gateway-costs.jsonl` |
| `delegationClient.ts` | laptop | HTTP client (retries, chunked resumable upload), `delegateChat`, `bringBackChanges` |
| `delegationProcess.ts` | both | The `git`/`gh` runner (replaced in tests) |
| `../../electron-main/creaeditorDelegationMainService.ts` | laptop | The main-process service windows call over IPC |
| `src/vs/server/node/creaeditorServer/creaeditorServerDelegation.ts` | server | The `/api/delegation/` routes |
| `src/vs/sessions/contrib/providers/remoteAgentHost/electron-browser/delegateToServer.contribution.ts` | laptop | The Agents window actions |

## Transport

The server's Remote Access HTTP API with this device's key (`Authorization: Bearer <deviceKey>`), under `/api/delegation/`. Not AHP: bundles can be hundreds of MB, and AHP's JSON text frames would base64 them through the chat connection. HTTP gives chunked, resumable uploads with progress, and the code receiver runs in the server's front process next to its data folder. The accounts go over AHP (`authenticate`) because the agent host keeps them; they are sealed so only the server's agent host opens them. The envelope is always sent: it also carries the chat's work context (worktree, repository, branch, title) and tells the agents that session files arrived.

| Route | Answer |
|---|---|
| `GET key` | `{ publicKey, hasGitHubToken, hasGh, worktreesDir, agentHome }` |
| `GET repos/<repoId>/known` | `{ commits }`: tips of the server's branches and bases, newest first |
| `PUT uploads/<id>?offset=<n>` (raw body, 4 MB chunks) | `{ received }`; 409 when `offset` is not what the server has |
| `GET uploads/<id>` | `{ received }` (resume) |
| `POST delegations` | Unpacks the upload, creates the worktree, answers the record |
| `GET delegations/<id>` | The record |
| `POST delegations/<id>/session` | Installs session files (Claude `projects/...` in the Claude config folder, Codex `sessions/...` in `CODEX_HOME`, Copilot CLI `session-state/<id>/...` in the Copilot home); the record gets `resumeSessionId`. A chat delegated again after Take Back Here still has its first copy there (archived, maybe running): that copy stays untouched and the new one is installed under a fresh session id (paths and ids in its text rewritten), answered as `resumeSessionId` with the laptop's id as `sourceSessionId` |
| `DELETE delegations/<id>` | Abandons a delegation whose later step failed on the laptop: removes its worktree, branch and record. Only the device that created it, within 30 minutes, before session files arrived |
| `POST delegations/<id>/results` `{ knownCommits }` | `{ commit, downloadId?, bytes, includesUncommitted }` |
| `GET downloads/<id>` | The result bundle (removed after download) |
| `POST delegations/<id>/pull-request` | `{ url }` |
| `PUT github-token` `{ token }` | Empty removes it |

Errors are `{ error: <DelegationErrorCode>, message }`.

## Server data

`<data>/repos/<repoId>.git` (bare; `repoId` comes from the root commit, so the same project shares history), `<data>/worktrees/<repository name>-<shortId>` (the Agents window shows the folder name; `<delegationId>` without a name) on `creaeditor/delegated/<shortId>`, `<data>/delegations/<id>.json` (records, uploads, downloads), `<data>/secrets/delegation/` (key pair and GitHub token; its own master key, separate from the agent host's store).
