#!/bin/bash

trap "echo -e '\n🛑 Loop execution stopped by user.'; exit" INT TERM

echo "🚀 Starting Autonomous Loop Engineering with STATE Tracking..."

while true; do
  REMAINING_TASKS=$(grep -c "Status: \`\[ \]\`" SPEC.md)

  if [ "$REMAINING_TASKS" -eq 0 ]; then
    echo "=================================================================="
    echo "🎉🎉🎉 ALL TASKS COMPLETED IN SPEC.MD! 🎉🎉🎉"
    echo "🏁 Autonomous Loop is exiting successfully."
    echo "=================================================================="
    break
  fi

  echo "=================================================================="
  echo "🔄 Starting Loop Cycle at: $(date) | Remaining Tasks: $REMAINING_TASKS"
  echo "=================================================================="

  opencode run \
    --model opencode/x-preview-f-free \
    --dangerously-skip-permissions "
      Execution Rules:
      1. READ 'STATE.md' FIRST to recall previous execution context, active sub-steps, or unhandled errors.
      2. READ 'ROADMAP.md' and 'SPEC.md' to identify overall project goals.
      3. Find the FIRST uncompleted task in 'SPEC.md' (marked Status: \`[ ]\`).
      4. If 'STATE.md' has no active sub-steps, BREAK DOWN the selected task into small sub-steps inside 'STATE.md' under '## Current Active Task'.
      5. Execute the current sub-step and run quality/test checks (Ruff, pytest, pnpm, etc.).
      6. Fix any errors or test failures encountered.
      7. Once ALL acceptance criteria for the task pass:
         - Mark the task as completed in 'SPEC.md' by changing Status: \`[ ]\` to Status: \`[x]\`.
         - RESET the '## Current Active Task' section in 'STATE.md' back to EMPTY template for the next task.
         - Commit code changes to git with message 'feat: complete TASK-XXX'.
    "

  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "⚠️ Opencode exited with code $EXIT_CODE (Network/Token limit). Logging crash in STATE.md if possible..."
    echo "🔄 Retrying in 30 seconds..."
    sleep 30
  else
    echo "✅ Cycle step completed. Moving to next in 5 seconds..."
    sleep 5
  fi
done