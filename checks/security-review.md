---
name: Security Review
description: Flag common security issues in the diff
---

Review the diff for security issues. Fail the check if any of these are true:

- Hardcoded API keys, tokens, passwords, or secrets in source files
- New API endpoints without input validation
- SQL queries built with string concatenation instead of parameterized queries
- Sensitive data (passwords, tokens, PII) logged to stdout or logs
- User-controlled input passed to shell commands, `eval`, or file paths without sanitization

If none of these issues are found, pass the check.
