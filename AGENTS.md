# AGENTS.md — Instructions for any AI working on this repo

This repo (patched CodeSage VS Code extension, extracted from compiled .vsix —
no original TypeScript source, so all changes are made as targeted edits
against the minified `extension.original.js` / webview `index.js` bundles)
is worked on across many separate AI sessions (Claude, GLM, Fable, Lovable,
etc.), often by different tools with no shared memory of each other.

`history.txt` in the repo root is the ONLY continuity mechanism between
sessions. Treat it as the source of truth for "what has already happened."
Follow this protocol exactly, every session, no exceptions.

## 1. BEFORE doing anything

- Read `history.txt` in full, top to bottom, before touching any code.
- Read the most recent entries especially carefully — they reflect the
  current state of the codebase and any open/unresolved issues.
- If the user's request contradicts or seems to redo something history.txt
  says is already fixed, say so explicitly before proceeding — don't
  silently redo or undo prior work.
- If `history.txt` doesn't exist yet, create it using the same format as
  below, and note that this is the first entry.

## 2. BEFORE making any change

- Append a new entry to the END of `history.txt` describing the PLAN before
  writing or editing any code. This must happen before the first edit, not
  after. Use this format:

  ```
  --------------------------------------------------------------------
  [YYYY-MM-DD HH:MM UTC] PLAN — <agent name/model>
  --------------------------------------------------------------------
  User request: <one line, verbatim or close to it>
  Planned changes:
    - <file>: <what will change and why>
    - <file>: <what will change and why>
  Assumptions / open questions: <anything uncertain>
  ```

- If the plan changes mid-session (new root cause found, approach pivots),
  append a short "PLAN UPDATE" block rather than silently deviating —
  future agents need to see the reasoning trail, not just the final diff.

## 3. AFTER making changes

- Append a COMPRESSED RESULT entry immediately after the PLAN entry (same
  session, right below it) — don't wait until the very end of a long
  session if it's likely to be interrupted. Format:

  ```
  --------------------------------------------------------------------
  [YYYY-MM-DD HH:MM UTC] RESULT — <agent name/model>
  --------------------------------------------------------------------
  Status: DONE | PARTIAL | BLOCKED
  What changed:
    - <file>: <concrete summary of the actual edit, not just intent>
  Root cause (if a bug fix): <1-3 sentences, specific — function/variable
    names, not vague language>
  Verified how: <e.g. "node --check passed", "manually traced call path",
    "not yet tested live — needs user confirmation">
  Follow-ups / known gaps: <anything left undone, deferred, or suspected
    but unconfirmed>
  ```

- Keep entries dense and factual. No filler, no restating the whole
  conversation — assume the next reader is a competent AI/dev who just
  needs the delta, not a narrative. Prior entries in this file already
  demonstrate the right density (see the entries from 2026-07-23).

- Never delete or rewrite prior history.txt entries. If something earlier
  turns out to be wrong, add a new entry that says so and why — history.txt
  is an append-only log, not a living doc.

## 4. Editing conventions for this specific repo

- `extension/dist/extension.original.js` and
  `extension/webview-ui/build/assets/index.js` are minified/compiled — there
  is no build step to regenerate them from source. All edits are direct,
  uniquely-matched string replacements (find exact substring, replace with
  patched substring). Before editing:
    - Always view/grep the exact current substring first — line numbers and
      surrounding code shift between sessions as other agents edit the file.
    - Confirm the target string is unique in the file before replacing it
      (a non-unique match risks patching the wrong call site).
- After every edit to either bundle, run a syntax check (`node --check
  <file>`) before considering the change complete. A syntax error in either
  bundle breaks the whole extension.
- If repackaging a `.vsix` is needed, zip the `extension/` tree with `zip -r
  -X -q`, then verify with `unzip -t` before handing it back.
- Don't assume prior fixes described in history.txt are still intact — a
  different agent may have reverted or altered them since. If a fix you're
  relying on isn't present in the current file, say so and re-apply or flag
  it rather than assuming it silently still works.

## 5. Tone / behavior

- Be explicit about root causes, not just symptoms. This codebase has a
  history of layered bugs where fixing one symptom revealed the real one
  underneath (see history.txt entries — several "fixes" only became correct
  after 2-3 iterations). Don't declare something fixed on a plausible theory
  alone; trace the actual code path.
- If you can't verify a fix will work (e.g. no way to run the extension
  live in this environment), say so plainly in the RESULT entry rather than
  implying it's confirmed working.
