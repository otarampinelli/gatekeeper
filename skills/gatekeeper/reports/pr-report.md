# Report — PR mode

PR mode is an external review. Treat the PR as someone else's work: never offer to fix it
locally, never show the per-finding "Fix it" / "Skip" cards.

Build planned inline comments from `reported.json` for every finding that anchors to a
changed line, render them exactly as they will be posted, then ask:

- **Post all inline PR comments** — post every planned comment as previewed
- **Choose comments** — one checkbox per comment, post only those
- **Stop** — leave the PR untouched

No top-level summary comment. Only post comments that anchor to a changed line; report
unanchorable findings in chat. Build diff blocks from the finding's stored `diff` — do not
re-read files.

Severity emoji match `gk rank`'s summary: 🔴 Error, 🟡 Warning, 🔵 Info. Label unproven
findings as unproven, the same way local mode does — a PR comment carries no other signal
of how much to trust it.

````markdown
🛡️ **Gatekeeper** flagged this via `<check name>` — <severity emoji> <Severity> · <verdict>

**<short finding title>**

<one concise explanation of the problem>

<the evidence line verification confirmed>

Suggested fix: <one concise explanation of how to solve it>

<details>
<summary>Proposed fix</summary>

```diff
- <old code>
+ <new code>
```

</details>
````

Design and non-code findings use the same body without the `<details>` block.

```bash
gh pr view <pr-url> --json number,headRefOid
```

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments \
  -f body="$(cat <<'EOF'
<body from above>
EOF
)" \
  -f commit_id="<headRefOid>" \
  -f path="<file-path>" \
  -F line=<changed-line-number> \
  -f side=RIGHT
```
