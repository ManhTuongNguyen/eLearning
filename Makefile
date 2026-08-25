# Quality gates for the eLearning project.
# `make quality` runs every backend gate; individual targets are available for local use.
#
# Gates:
#   backend-lint         Ruff linting (ruff check)
#   backend-format-check Ruff formatting verification (ruff format --check)
#   backend-test         pytest + pytest-django suite
#   backend-check        Django system checks

.DEFAULT_GOAL := quality
.PHONY: quality backend-lint backend-format-check backend-test backend-check

quality: backend-lint backend-format-check backend-test backend-check

backend-lint:
	cd backend && uv run ruff check .

backend-format-check:
	cd backend && uv run ruff format --check .

backend-test:
	cd backend && uv run pytest

backend-check:
	cd backend && uv run python manage.py check
