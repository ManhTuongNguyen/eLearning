#!/bin/bash

trap "echo -e '\n🛑 Loop execution stopped by user.'; exit" INT TERM

echo "🚀 Starting Autonomous Loop Engineering with STATE Tracking..."

while true; do
  REMAINING_TASKS=$(grep -c "Status: \`\[ \]\`" POST_COMPLETION_FEEDBACK_V1.md)

  if [ "$REMAINING_TASKS" -eq 0 ]; then
    echo "=================================================================="
    echo "🎉🎉🎉 ALL FEEDBACK TASKS COMPLETED IN POST_COMPLETION_FEEDBACK_V1.md! 🎉🎉🎉"
    echo "🏁 Autonomous Loop is exiting successfully."
    echo "=================================================================="
    break
  fi

  echo "=================================================================="
  echo "🔄 Starting Loop Cycle at: $(date) | Remaining Tasks: $REMAINING_TASKS"
  echo "=================================================================="

  opencode run "$(cat prompts/PROMPT_LOOP_TASKS_FEEDBACK_V1.md)" --dangerously-skip-permissions 

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