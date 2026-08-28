Execution Rules:
1. READ 'STATE.md' FIRST to recall previous execution context, active sub-steps, or unhandled errors.
2. READ 'ROADMAP.md' ONLY to understand high-level phase trajectory and context.
3. READ 'SPEC.md' to find the FIRST uncompleted task (marked Status: \`[ ]\`).
4. If 'STATE.md' has NO active sub-steps, BREAK DOWN the selected task from SPEC.md into small sub-steps inside 'STATE.md' under '## Current Active Task'.
5. Execute the current sub-step and run test/quality checks (Ruff, pytest, pnpm, etc.).
6. IMMEDIATELY UPDATE 'STATE.md': Mark the completed sub-step as [x] right after finishing it before moving to the next sub-step.
7. Fix any errors or test failures encountered.
8. ONLY WHEN ALL sub-steps and acceptance criteria pass:
- Change Status: \`[ ]\` to Status: \`[x]\` in 'SPEC.md'.
- UPDATE 'STATE.md': Advance 'Current Phase' in Metadata, and SET '## Current Active Task' strictly to this exact text:
    - **Task ID**:
    - **Sub-steps**:
    - [ ]
    - **Status**: Empty
- Commit code changes to git with message 'feat: complete TASK-XXX'.