# Smart pick — hit rate baseline

2026-09-22. `bun scripts/probe-pick.ts`, heuristic only (the dev proxy was
down, and it currently pins requests to the seven card questions, so it would
have rejected pick bodies anyway). Re-run with the proxy up to fill the decider
columns.

**The scenarios are synthetic.** They were written by hand to look like real
pastes (a Slack message box with a PR link just copied, a terminal with a
shell command among prose, a spreadsheet cell with a figure, a Mail "To" field
with an address, an editor with a stack trace…), not recorded from use. They
measure what the heuristic gets right *by construction* and mark where a
decider would have to earn its keep; they say nothing yet about real hit
rates. The v1 acceptance ("thirty real scenarios") still needs recorded ones —
`scripts/probe-pick.ts` reads its own generated set today, and
`.work/pick-scenarios.json` is gitignored.

## Method

- A scenario is a `Context` at some level (L0 app only, L1 + AX role and
  label, L2 + up to 200 chars before/after the caret), 5–8 `ClipItem`
  candidates with ages from 10 s to 30 min, and the index of the item the user
  meant. Candidates are handed newest first, as the shell will.
- `pick(ctx, candidates, null)` ranks by the heuristic
  (`core/src/pick/heuristic.ts`): recency with a 10-minute half-life, +0.15
  when the item was copied in another app, +0.2 for text into a text input,
  −0.5 for an image into a single-line field or cell, −0.2/−0.3 for a file
  into a web area / single-line field, +0.1 pinned, −0.3 for text over 200
  chars into a single-line field.
- With a decider, `pick` asks the two questions in
  `core/src/pick/question.ts` (a Choice over `c0..cN` + `none`, a Noul on
  whether to paste here) and blends 0.7 × the pick probability (scaled so the
  favourite is 1) with 0.3 × the heuristic (scaled to 0..1).
- top-1: the meant item ranked first. top-3: within the first three (what the
  confirm bar can show without scrolling).

## Results (heuristic)

| # | scenario | L | top-1 | top-3 |
|--:|---|:-:|:-:|:-:|
| 1 | Slack: PR link into the message box | 2 | hit | hit |
| 2 | Terminal: install command among prose | 2 | miss | hit |
| 3 | Numbers: a figure into a cell | 1 | hit | hit |
| 4 | Mail: address into the To field | 2 | hit | hit |
| 5 | VS Code: snippet from the docs | 2 | hit | hit |
| 6 | GitHub issue comment: the stack trace | 1 | hit | hit |
| 7 | Finder: renaming a file | 2 | hit | hit |
| 8 | Safari: a URL into the address bar | 1 | miss | hit |
| 9 | Chrome with no accessibility: newest wins | 0 | hit | hit |
| 10 | Messages: a short reply | 2 | hit | hit |
| 11 | Terminal: host after ssh | 2 | miss | hit |
| 12 | Xcode: URL inside a string literal | 2 | miss | hit |
| 13 | Excel: a formula into a cell | 1 | hit | hit |
| 14 | Notes: an address after a label | 2 | hit | hit |
| 15 | Figma: a headline into a text layer | 1 | hit | hit |
| 16 | Figma: a colour into the fill field | 2 | miss | hit |
| 17 | Zoom chat: the meeting link | 1 | hit | hit |
| 18 | Finder: a file onto the Desktop | 1 | miss | hit |
| 19 | Discord: a link into the message box | 1 | hit | hit |
| 20 | Photoshop with no accessibility: the image | 0 | miss | hit |
| 21 | Keynote: a figure after a label | 2 | miss | hit |
| 22 | Spotlight: an app name | 1 | hit | hit |
| 23 | Obsidian: a paragraph into meeting notes | 2 | hit | hit |
| 24 | Gmail compose: a screenshot into the body | 1 | miss | hit |
| 25 | Terminal: the commit message | 2 | hit | hit |
| 26 | Twitter compose with no accessibility | 0 | hit | hit |
| 27 | Numbers: a figure while a paragraph is newer | 2 | hit | hit |
| 28 | Mail: the attachment after "attached" | 2 | miss | hit |
| 29 | iTerm2: the endpoint after curl | 2 | miss | hit |
| 30 | Reminders: a short title while a paragraph is newer | 1 | hit | hit |

**heuristic: top-1 19/30 (63 %), top-3 30/30 (100 %).** Decider: not run.
Each pick takes well under a millisecond.

## Reading it

- Every top-1 hit is either "newest wins" or a kind/length rule firing (long
  prose losing to an address in a To field, an image losing to text in a cell).
  The heuristic has no way to read intent from the caret text, so a command
  after `ssh `, a URL inside `URL(string: "`, a figure after `Q3 revenue: `
  (2, 8, 11, 12, 16, 21, 29) all lose to whatever was copied last. Those are
  the L2 cases the decider exists for.
- The "cross-app +0.15" assumption costs two same-app pastes: a file copied in
  Finder and pasted in Finder (18), and it does not help an image copied in
  Preview for Gmail (24) or a file for Mail (28), where the text-fit bonus on an
  older paragraph wins. Once the shell records where items were pasted, this
  should become same-app affinity as PLAN.md describes.
- At L0 (9, 20, 26) only recency and kind exist; the Photoshop case needs the
  decider to read the app name.
- top-3 is 100 % because the meant item is never older than the fourth
  candidate in these scenarios — that is a property of how they were written,
  not of the heuristic.

## How to re-run

```
cd proxy && npx wrangler dev --port 8787     # optional, for the decider columns
bun scripts/probe-pick.ts
```

The script writes `.work/pick-scenarios.json`, prints the table, and one
warning line if the proxy is down or rejects the pick questions.
