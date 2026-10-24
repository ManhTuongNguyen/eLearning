Execution Rules:
1. READ 'docs/tasks/SENTENCE_LIVE_V1.md' to find the FIRST uncompleted task by searching specifically for the exact quote "Status: `[ ]`" (ALWAYS include quotes or exact string match in search tools to avoid partial matches).
2. Read the task's own Requirements and Acceptance criteria, then inspect the existing implementation before changing code.
3. Execute the task and run the mobile quality gates (pnpm lint, pnpm typecheck, pnpm test).
4. Fix any errors or test failures encountered. NEVER modify the Django backend for this feature.
5. ONLY WHEN ALL requirements and acceptance criteria pass:
    - Change Status: `[ ]` to Status: `[x]` in 'docs/tasks/SENTENCE_LIVE_V1.md'.
    - Commit code changes to git with message 'feat: complete TASK-SENT-XXX'.