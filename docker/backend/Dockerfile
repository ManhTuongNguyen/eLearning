# eLearning backend image.
#
# Uses the official uv base image so dependency installation matches the
# local workflow (pyproject.toml + uv.lock). The virtualenv lives outside
# /app so a development bind-mount of the source tree cannot shadow it.

FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

# Install dependencies first for better layer caching.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY . .

EXPOSE 8000

# Development server; production deployment overrides this via compose/command.
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
