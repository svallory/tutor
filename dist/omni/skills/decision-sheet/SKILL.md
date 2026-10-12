---
name: decision-sheet
description: Use when the user has several decisions to make at once (about 4 or more questions, each with your suggested answer), such as triage lists, keep-or-drop reviews, migration choices or config options, or when they ask for questions "as a list with defaults" or as a form. Builds a private artifact page where they flip only the answers they disagree with, add optional notes, and copy a short reply back into the chat.
---

# Decision sheet

Turns questions with your suggested answers into a page. The user changes only what they disagree with, adds notes where they want, and presses **Copy reply**. The copied text lists only the changes, the notes and the unanswered questions, so the reply stays short.

Use it instead of a long list in the chat or several rounds of AskUserQuestion. For 1 to 3 quick questions, AskUserQuestion is still better.

## Steps

1. Write the questions to a JSON file in the scratchpad (format below). Give every question your suggestion, and a short reason in `detail`. Leave `suggested` out only when you have no sensible default: the page marks those "needs you".
2. Build the page. It runs with `bun` or `node` and has no dependencies:
   ```bash
   bun $SKILL_DIR/scripts/build.mjs questions.json   # writes questions.html
   ```
   It checks the file and lists every problem with its path, such as `groups[1].questions[3].suggested: "maybe" is not an option ("Keep", "Drop")`. Fix them and run it again. It also warns about labels that are too long (see [Options](#options)); fix those too, since a long label reads badly in the selector.
3. Give the user the HTML file's path to open in a browser. The page has no server and works offline.
4. Stop there. Tell the user to paste the copied reply into the chat.
5. Apply the reply (format below). Then update the record of the decisions, for example the report or plan the questions came from.

To change the questions later, edit the JSON and build to the same HTML path.
Drafts are saved in the user's browser and keyed by question id, so answers to questions that are still there carry over to the new version.

## JSON format

```json
{
  "title": "zsh triage",
  "id": "zsh-triage",
  "intro": "35 leftovers from the Mac's zsh config. The numbers match the chat.",
  "options": ["Keep", "Drop"],
  "groups": [
    {
      "title": "Keep",
      "description": "I'd keep these.",
      "questions": [
        { "id": 1, "title": "`man` opens pages through batman", "detail": "Colored man pages.", "suggested": "Keep" },
        {
          "id": 9,
          "title": "`open-pr` base branch",
          "options": [
            { "value": "env", "label": "`$GIT_PR_BASE`, else the default branch" },
            { "value": "staging", "label": "Always `staging`", "description": "What the Mac did." }
          ],
          "suggested": "env"
        }
      ]
    },
    {
      "title": "Needs you",
      "questions": [
        { "id": 36, "type": "text", "title": "API keys still in use", "placeholder": "Key names only" }
      ]
    }
  ]
}
```

Top level:

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | Page name, also the first word of the reply. |
| `id` | no | Names the saved draft. Defaults to the title as a slug. |
| `intro` | no | Shown above the questions. Blank lines split paragraphs. |
| `options` | no | Default options for choice questions that list none. |
| `other` | no | `false` turns off the **Something else** option on every choice question. On by default. |
| `groups` | one of | `[{title, description, questions}]`, in display order. |
| `questions` | one of | A flat list. A question's `group` field groups them, in order of first appearance. |

Question:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | String or number, unique. The reply refers to questions by it. |
| `title` | yes | The decision, in a few words. |
| `detail` | no | Why you suggest what you do. One or two sentences. |
| `type` | no | `"choice"` (default) or `"text"` for a free answer. |
| `options` | choice | At least 2. A string, or `{value, label, description}`. See [Options](#options). |
| `suggested` | no | For choice, the `value` of one option. For text, prefilled text. |
| `placeholder` | no | Text questions only. |
| `other` | no | Choice questions only. Overrides the top-level `other` for this question. |

Every choice question gets a last option, **Something else**, unless `other` is `false`. Picking it makes the note required: the row is flagged and **Copy reply** refuses until the note is written. Don't add an option of your own for it; the value `__other__` is reserved.

`title`, `detail`, `intro`, labels and descriptions accept `` `code` `` and `**bold**`. Everything else is shown as plain text.

### Options

A `label` is the option's name in the selector: 1 to 4 words, such as "Per machine" or "Unsigned until 1.0". Put the explanation in `description`. The build warns about labels over 32 characters.

- When no option of a question has a description, the options sit in a row of buttons beside the question, or in a column when the labels are long.
- When any option has a description, the options become a list of their labels, with a box beside it. The box shows the picked option's description, and previews another option's while the pointer or keyboard focus is on it. On a phone the box sits under the list.

Write descriptions as the facts the user needs to choose: what the option does, what it costs, what it rules out. Keep `value` stable across rebuilds: drafts store answers by value.

## The reply

The user pastes something like:

```
zsh triage: 2 changed, 1 answered, 2 notes, 31 as suggested, 1 open.
- 13 watch, the fswatch folder watcher: Keep (suggested: Drop).
- 16 The 28 wt.* WezTerm CLI aliases: Keep (suggested: Drop). Note: I still use wt.split
- 5 EDITOR=nano, VISUAL='zed --wait' where Zed is installed: Keep, as suggested. Note: try micro
- 20 go-go, the Go project scaffold: Something else (suggested: Drop). Note: keep it, but as a just recipe
- 36 API keys still in use: "OPENAI_API_KEY, GITHUB_TOKEN".
Still open: 34
```

- Each line starts with the question `id`. Titles are shortened, so go by the id.
- A question that isn't listed was left on your suggestion.
- `Something else` always comes with a note saying what the user wants instead. Do what the note says; if it's unclear, ask about that question only.
- `answered` means a question with no suggestion now has an answer. Text answers are in quotes, with line breaks shown as ` / `.
- `Still open` lists questions with no suggestion and no answer. Leave them pending, or ask again.
- When nothing changed, the reply is one line: `zsh triage: all 35 as suggested.`
- If the user ticked "Also list the answers that match my suggestion", unchanged answers are listed too, each ending in `as suggested`.

## Files

- `scripts/build.mjs`: checks the JSON, warns about long labels, and writes the page.
- `assets/template.html`: the page. Drafts are saved in the browser by question id, so republishing a changed sheet to the same URL keeps the user's answers. It has the placeholders `__TITLE__` and `__FORM_DATA__`. Change the design here, not in built pages.
- `scripts/build.test.mjs`: run with `bun test` from the skill folder.
- `examples/sample.json`: a small sheet to try the build with.
