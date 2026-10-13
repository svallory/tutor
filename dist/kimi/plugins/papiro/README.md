# Papiro plugin

Decision sheets: when your agent has several questions for you, it turns them into a page instead of a long list in the chat.

## What it does

The `decision-sheet` skill takes the agent's questions, each with its suggested answer and a short reason, and builds a single HTML page. On the page you:

1. change only the answers you disagree with;
2. add a note where you want to say more, or pick **Something else** and write what you want instead;
3. press **Copy reply** and paste it into the chat.

The reply lists only what changed, your notes and the questions still open, so it stays short however many questions there were. The agent then applies it and updates the plan or report the questions came from.

Questions can have their own options, a free-text answer, or no suggestion at all (shown as "needs you"). Each question shows a one-line reason and can fold out an in-depth look and related files and links; the sheet and each group can fold out a context block that defines the terms they use. When options have descriptions, the page shows the options as a list of short names with a box beside it that explains the picked one; hovering another option previews its explanation.

Answers are saved as a draft in your browser. When the agent rebuilds the sheet with changed questions, answers to the questions that are still there carry over.

In Claude Code the page is published as a private artifact. On other agents it is a local HTML file you open in a browser; it needs no server.

## Usage

Run `/papiro` to turn the open questions in the conversation into a sheet, or ask for "these questions as a list with defaults" or "as a form". The agent also reaches for it on its own when it has about four or more decisions for you.

`/papiro:decision-sheet` runs the skill directly.

## Requirements

`bun` or `node`, to run the build script. It has no dependencies.

## Install

```
/plugin install papiro@tutor
```

Or as a standalone skill via the [skills CLI](https://skills.sh):

```
npx skills add svallory/tutor --skill decision-sheet
```

## Files

| Path | What it is |
|---|---|
| `commands/papiro.md` | the `/papiro` command |
| `skills/decision-sheet/SKILL.md.jig` | the skill, rendered per platform |
| `skills/decision-sheet/scripts/build.mjs` | checks the questions JSON and writes the page |
| `skills/decision-sheet/scripts/build.test.mjs` | tests; run `bun test` in the skill folder |
| `skills/decision-sheet/assets/template.html` | the page |
| `skills/decision-sheet/examples/sample.json` | a small sheet to try the build with |
