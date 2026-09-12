# Report — Local mode

Triage one finding at a time — each distinct problem gets its own AskUserQuestion item.

Everything you need is in `reported.json`: explanation, evidence, fix, and diff. No file
re-reads.

**Print the cards in a normal chat message FIRST, then ask.** AskUserQuestion renders its
text as plain text, so ```diff fences get no red/green colouring inside the widget. The
polished version belongs in your message; the widget stays a thin control.

1. One card per finding, `---` divider after each:

   ````
   ### 🔴 Hardcoded DB password
   `src/api/app.module.ts:925` · confirmed · flagged by Security Review + Code Quality

   Password is committed in source instead of read from the environment.

   Evidence: app.module.ts:925 passes a literal; no env fallback in this module.

   ```diff
   -     password: '1223456789',
   +     password: process.env.PG_PASSWORD,
   ```
   ---
   ````

   Severity emoji match `gk rank`'s summary: 🔴 Error, 🟡 Warning, 🔵 Info. Label unproven
   findings as unproven on the context line.

2. Then AskUserQuestion, structured so the suggestion is visible:

   ```
   1. Hardcoded DB password at app.module.ts:925

   Switch to process.env.PG_PASSWORD?

   -     password: '1223456789',
   +     password: process.env.PG_PASSWORD,
   ```

   - Header: `<file> — flagged by <check(s)>`
   - Exactly two options. Do NOT add a custom/"reply in chat" option — AskUserQuestion
     already provides a built-in "Other: (type to answer)".
     - **Fix it** — apply the suggestion
     - **Skip** — leave it, and record the dismissal
   - Honour a custom instruction given via "Other".

Batch up to 4 per call. Print all cards for the batch, then ask together. Only edit
changed files; never touch pre-existing issues in unchanged code.

For every finding the user skipped, record it so it is never asked again:

```bash
node .gatekeeper/bin/gk.mjs dismiss --run <runDir> --id F02,F05 --date <YYYY-MM-DD>
```

`--date` is required: the engine has no trusted clock, so pass today's date from your
context.
