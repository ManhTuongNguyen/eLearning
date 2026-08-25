#!/bin/bash

trap "echo -e '\n🛑 Loop execution stopped by user.'; exit" INT TERM

echo "🚀 Starting Autonomous Loop Engineering with STATE Tracking..."

while true; do
  echo "=================================================================="
  echo "🔄 Starting Loop Cycle at: $(date)"
  echo "=================================================================="

  opencode run --dangerously-skip-permissions "
    Execution Rules:
    1. READ 'STATE.md' FIRST to recall previous execution context, active micro-steps, or unhandled errors.
    2. READ 'ROADMAP.md' and 'SPEC.md' to identify the overall goals.
    3. Find the FIRST uncompleted task in 'SPEC.md' (marked 'Status: [ ]').
    4. BREAK DOWN the task into smaller sub-steps inside 'STATE.md' under '## Current Active Task', if not already present.
    5. Execute the current sub-step or micro-task.
    6. Run tests or verifications to ensure changes work.
    7. UPDATE 'STATE.md' IMMEDIATELY: mark completed sub-steps, record any issues encountered.
    8. Once the entire task acceptance criteria are met:
       - Mark the task as completed in 'SPEC.md' (change 'Status: [ ]' to 'Status: [x]').
       - Clear/archive the active task section in 'STATE.md'.
       - Commit code changes to git with message 'feat: complete TASK-XXX'.
  "

  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "⚠️ Opencode exited with code $EXIT_CODE (Network/Token limit). Logging crash in STATE.md if possible..."
    echo "🔄 Retrying in 10 seconds..."
    sleep 10
  else
    echo "✅ Cycle step completed. Moving to next in 3 seconds..."
    sleep 3
  fi
done