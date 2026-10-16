# CreaEditor Guide

CreaEditor is Creacoon's build of Visual Studio Code. Everything you know from VS Code works the same. On top of that, CreaEditor adds a set of features for working with AI agents: your own models and keys, cost tracking, several Claude and Codex subscriptions, a dedicated Agents window, and ways to keep agents running when you walk away from your desk.

This guide explains each of those features: what it does, how it works, and how to use it step by step.

> **Tip:** open this guide at any time with **Help > CreaEditor Guide**. For a short visual tour, use **Help > CreaEditor Features**. Every command mentioned here can also be found in the Command Palette (**Cmd+Shift+P**): start typing its name.

## The pages

| Page | What you learn |
| --- | --- |
| [Models and Keys](models-and-keys.md) | Use your own models (no Copilot account), connect OpenRouter and LiteLLM, use several keys, and how a chat stays on its key. |
| [Costs and Budgets](costs-and-budgets.md) | See what every chat and issue cost on the **AI Costs** page, and set budgets with alerts and a hard stop. |
| [Subscription Accounts](subscription-accounts.md) | Pool several Claude and Codex subscriptions behind one model, switch accounts when one is used up, and save money by compacting idle Claude chats. |
| [The Agents Window](agents-window.md) | The window made for agents: sessions, the Agents tree, chat groups that make several pull requests at once, Jira, and more. |
| [Director, Issue to PR and Code Reviewer](issue-agents.md) | Turn issues into reviewed pull requests: which of the three agents to use when, and how, step by step. |
| [Remote Access](remote-access.md) | Follow and steer the agents on your Mac from your phone. |
| [CreaEditor Server](creaeditor-server.md) | Run agents on a computer that is always on, and use it from your laptop and phone. |
| [Delegate to Server](delegate-to-server.md) | Hand a running chat, with its code, to your server, then bring the results back. |
| [Notifications](notifications.md) | Get a push notification on your phone when a chat finishes, fails or needs you. |
| [Dictation](dictation.md) | Talk instead of type, on this computer with Whisper: the one-time install, Dutch and English mixed, and the listening bar. |

## Your first 10 minutes

1. **Pick a theme.** Click the gear icon at the bottom left, choose **Themes > Color Theme** and try **Creacoon Dark**, **Creacoon Night** or **Creacoon Light**.
2. **Add a model.** Run **Add OpenRouter or LiteLLM Models...** from the Command Palette and paste your key, or run **Chat: Manage Language Models** for another provider. See [Models and Keys](models-and-keys.md).
3. **Add your Claude or Codex subscription** (if you have one). Run **Add Claude Account** or **Add Codex Account**. See [Subscription Accounts](subscription-accounts.md).
4. **Open the Agents window.** Press **Cmd+Shift+A**. Pick your project folder in the folder button above the input box, type what you want done and press Enter. See [The Agents Window](agents-window.md).
5. **Check what it cost.** Click the credit card button at the top of the Sessions list to open **AI Costs**. See [Costs and Budgets](costs-and-budgets.md).
6. **Optional: take it with you.** Turn on [Remote Access](remote-access.md) to follow your chats from your phone, and [Notifications](notifications.md) to hear when they are done.

When your team has a CreaEditor Server, add it next (**Add CreaEditor Server**) and read [Delegate to Server](delegate-to-server.md): it lets you close the laptop while a long task keeps running.

## A few words used throughout

- **Chat** or **session**: one conversation with an agent, working on one task.
- **Agent**: the AI that does the work, such as Claude, Codex or Copilot CLI. It can read and change files and run commands in your project.
- **Subagent**: a helper agent that a chat starts for part of its work.
- **Git worktree**: an extra working copy of the same repository, on its own branch, in its own folder. Agents use worktrees so several of them can change code at the same time without getting in each other's way.
- **Gateway**: a service that sits between CreaEditor and the model providers, such as OpenRouter or your company's LiteLLM proxy. It holds the key and reports the cost of each request.
