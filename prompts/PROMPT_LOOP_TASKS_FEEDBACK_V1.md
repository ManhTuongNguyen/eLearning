Execution Rules:
1. READ 'POST_COMPLETION_FEEDBACK_V1.md' to find the FIRST uncompleted task by searching specifically for the exact quote "Status: `[ ]`" (ALWAYS include quotes or exact string match in search tools to avoid partial matches).
2. If 'STATE.md' has NO active sub-steps, BREAK DOWN the selected task from POST_COMPLETION_FEEDBACK_V1.md into small sub-steps inside 'STATE.md' under '## Current Active Task'.
3. Execute the current sub-step and run test/quality checks (Ruff, pytest, pnpm, etc.).
4. IMMEDIATELY UPDATE 'STATE.md': Mark the completed sub-step as [x] right after finishing it before moving to the next sub-step.
5. Fix any errors or test failures encountered.
6. ONLY WHEN ALL sub-steps and acceptance criteria pass:
    - Change Status: \`[ ]\` to Status: \`[x]\` in 'POST_COMPLETION_FEEDBACK_V1.md'.
    - UPDATE 'STATE.md': Advance 'Current Phase' / 'Metadata', and SET '## Current Active Task' strictly to this exact template text (do NOT delete the structure):
        - **Task ID**:
        - **Sub-steps**:
        - [ ]
        - **Status**: Empty
    - Commit code changes to git with message 'feat: complete TASK-AUDIT-XXX'.