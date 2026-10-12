# Papiro

When your agent has several questions for you, Papiro turns them into a decision sheet: one page with every question, the agent's suggested answer already picked, and a short reason for each. You change only what you disagree with and paste back a reply that lists just the changes.

It replaces the long numbered list in the chat that you have to answer line by line, and the rounds of one-question-at-a-time prompts.

## Install

```
/plugin marketplace add svallory/tutor
/plugin install papiro@tutor
```

Or as a standalone skill via the [skills CLI](https://skills.sh):

```
npx skills add svallory/tutor --skill decision-sheet
```

## Requirements

| Dependency | Required for |
|---|---|
| `bun` or `node` | the build script, which has no dependencies |
| a browser | answering the sheet |

In Claude Code the sheet is published as a private artifact, so it opens on claude.ai. On other agents it is a local HTML file that needs no server.

## When it triggers

- You run `/papiro`, or `/papiro:decision-sheet`. Anything after the command tells the agent what the questions are about.
- You ask for the questions "as a list with defaults" or "as a form".
- The agent has about four or more decisions for you at once: a triage list, keep-or-drop reviews, migration choices, config options. For one to three quick questions it still asks in the chat.

## On the page

- Every question starts on the agent's suggestion, marked with a dot. Questions it had no suggestion for are marked "needs you".
- Short options sit in a row of buttons. When options have descriptions, they become a list of short names with a box beside it that explains the picked option; hovering another option previews its explanation.
- **Something else** is the last option of every choice question. Picking it opens a note that you must fill in: **Copy reply** refuses until you say what you want instead.
- Any question can take a note, and some questions take a free-text answer.
- A sticky bar counts what changed, what is still open and which notes are missing.

Your answers are kept as a draft in your browser. When the agent rebuilds the sheet with changed questions, answers to the questions that are still there carry over.

## The reply

**Copy reply** puts something like this on your clipboard:

```
zsh triage: 2 changed, 1 answered, 2 notes, 31 as suggested, 1 open.
- 13 watch, the fswatch folder watcher: Keep (suggested: Drop).
- 16 The 28 wt.* WezTerm CLI aliases: Keep (suggested: Drop). Note: I still use wt.split
- 5 EDITOR=nano, VISUAL='zed --wait' where Zed is installed: Keep, as suggested. Note: try micro
- 20 go-go, the Go project scaffold: Something else (suggested: Drop). Note: keep it, but as a just recipe
- 36 API keys still in use: "OPENAI_API_KEY, GITHUB_TOKEN".
Still open: 34
```

Questions you left on the suggestion are not listed, so the reply stays short however long the sheet was. When nothing changed it is one line. A checkbox on the page lists every answer instead.

Paste it into the chat. The agent applies it, asks again only about anything unclear, and updates the plan or report the questions came from.

## What the agent writes

The agent writes the questions as JSON, and a build script checks it and writes the page. The script reports every problem with its path, such as a suggestion that is not one of the options, and warns about option labels too long to read well in the selector. The format is in the skill's `SKILL.md`.

## See also

- [Decompose](/docs/decompose) — breaks a hard problem into testable hypotheses.
- [Plugin overview](/docs/) — the rest of the marketplace.
