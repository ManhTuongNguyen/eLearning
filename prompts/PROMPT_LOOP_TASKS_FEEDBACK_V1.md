Execution Rules:
1. READ 'POST_COMPLETION_FEEDBACK_V1.md' to find the FIRST uncompleted task by searching specifically for the exact quote "Status: `[ ]`" (ALWAYS include quotes or exact string match in search tools to avoid partial matches).
2. Execute the current task and run test/quality checks (Ruff, pytest, pnpm, etc.).
3. Fix any errors or test failures encountered.
4. ONLY WHEN ALL sub-steps and acceptance criteria pass:
    - Change Status: \`[ ]\` to Status: \`[x]\` in 'POST_COMPLETION_FEEDBACK_V1.md'.
    - Commit code changes to git with message 'feat: complete TASK-AUDIT-XXX'.