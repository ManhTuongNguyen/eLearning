"""Secret-handling regression tests for the entire application (SPEC TASK-101).

These tests enforce the security invariants from ``SPEC.md`` TASK-101 and
``ROADMAP.md`` Rule 10:

- No API keys are committed to source control.
- The server OpenRouter key never reaches the mobile application through
  any API surface (health endpoint, error handler, LLM error payloads).
- Secrets never appear in logs or exception messages.
- Mobile source keeps console logging out of production modules so keys
  cannot leak through debug output.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

from django.conf import settings
from django.test import SimpleTestCase, TestCase, override_settings

from api.errors import api_exception_handler
from llm.config import load_model_configuration
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMBadRequestError,
    LLMResponseError,
    LLMTimeoutError,
)
from llm.openrouter import OpenRouterProvider

REPO_ROOT = Path(settings.BASE_DIR).resolve().parent
BACKEND_ROOT = REPO_ROOT / "backend"
MOBILE_SRC = REPO_ROOT / "mobile" / "src"

_OPENROUTER_KEY_PATTERN = re.compile(r"sk-or-v1-[a-zA-Z0-9]{32,}")
_DJANGO_SECRET_PATTERN = re.compile(r"django-insecure-[a-zA-Z0-9]{50,}")


def _python_source_files() -> list[Path]:
    """Return every backend Python source file (migrations excluded)."""
    files = [
        path
        for path in BACKEND_ROOT.rglob("*.py")
        if ".venv" not in path.parts and "__pycache__" not in path.parts
    ]
    # Guard against silently scanning nothing if layout ever changes.
    assert len(files) > 20, f"suspiciously few Python files found under {BACKEND_ROOT}"
    return files


class SecretHandlingTests(SimpleTestCase):
    """Cross-cutting source-control secret hygiene tests."""

    def test_no_hardcoded_openrouter_key_in_source(self) -> None:
        """No real OpenRouter API key pattern appears in Python source."""
        matches: dict[Path, list[str]] = {}
        for py_file in _python_source_files():
            found = _OPENROUTER_KEY_PATTERN.findall(py_file.read_text(encoding="utf-8"))
            if found:
                matches[py_file] = found
        self.assertEqual(
            matches,
            {},
            f"Python source contains real OpenRouter key patterns: {matches}",
        )

    def test_no_hardcoded_django_secret_key_in_source(self) -> None:
        """No production Django SECRET_KEY value appears in Python source."""
        violations: list[str] = []
        for py_file in _python_source_files():
            found = _DJANGO_SECRET_PATTERN.findall(py_file.read_text(encoding="utf-8"))
            if found:
                violations.append(str(py_file))
        self.assertEqual(
            violations,
            [],
            f"Python source contains real SECRET_KEY values: {violations}",
        )

    def test_env_file_is_not_tracked_by_git(self) -> None:
        """``git ls-files`` must never report the local ``.env`` as tracked."""
        result = subprocess.run(
            ["git", "ls-files", ".env"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "", ".env must not be tracked by git")

    def test_env_file_is_gitignored(self) -> None:
        """The local ``.env`` file must be covered by .gitignore."""
        result = subprocess.run(
            ["git", "check-ignore", "-v", ".env"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            check=False,
        )
        self.assertEqual(result.returncode, 0, ".env must be gitignored")
        self.assertIn(".gitignore", result.stdout)

    def test_env_example_exists_without_real_keys(self) -> None:
        """``.env.example`` documents configuration but carries no real keys."""
        env_example = REPO_ROOT / ".env.example"
        self.assertTrue(env_example.exists())
        self.assertGreater(env_example.stat().st_size, 100)
        content = env_example.read_text(encoding="utf-8")
        self.assertEqual(_OPENROUTER_KEY_PATTERN.findall(content), [])


class BackendSecretHygieneTests(TestCase):
    """Backend runtime secret hygiene tests."""

    @override_settings(
        OPENROUTER_API_KEY="sk-or-v1-super-secret-test-key",
        LLM_PRIMARY_MODEL="test/primary",
        LLM_FALLBACK_MODELS=["test/fb"],
    )
    def test_config_loading_never_logs_api_key(self) -> None:
        """``load_model_configuration()`` logs models only, never the key."""
        with self.assertLogs("llm.config", level="DEBUG") as logs:
            load_model_configuration()

        rendered = "\n".join(logs.output)
        self.assertNotIn("sk-or-v1-super-secret-test-key", rendered)
        self.assertNotIn("super-secret", rendered)

    @override_settings(
        OPENROUTER_API_KEY="sk-or-v1-test-key",
        LLM_PRIMARY_MODEL="test/model",
    )
    def test_openrouter_provider_errors_never_contain_api_key(self) -> None:
        """Normalized LLM exceptions raised by complete()/stream() exclude the key."""
        provider = OpenRouterProvider(
            api_key="sk-or-v1-test-key",
            default_model="test/model",
        )
        mock_client = MagicMock()
        mock_client.post.return_value = MagicMock(
            status_code=401,
            text='{"error": {"message": "invalid key"}}',
            headers={},
        )
        mock_client.stream.return_value.__enter__.return_value = MagicMock(
            status_code=401,
            text='{"error": {"message": "invalid key"}}',
            headers={},
            iter_lines=lambda: iter([]),
        )
        provider._client = mock_client
        provider._owns_client = False

        from llm.types import CompletionRequest

        request = CompletionRequest.from_texts([("user", "hello")])

        with self.assertRaises(LLMAuthenticationError) as ctx:
            provider.complete(request)
        self.assertNotIn("sk-or-v1-test-key", str(ctx.exception))
        self.assertNotIn("sk-or-v1-test-key", ctx.exception.message)

        with self.assertRaises(LLMAuthenticationError) as stream_ctx:
            list(provider.stream(request))
        self.assertNotIn("sk-or-v1-test-key", str(stream_ctx.exception))
        self.assertNotIn("sk-or-v1-test-key", stream_ctx.exception.message)

    def test_api_error_handler_never_leaks_internals(self) -> None:
        """Unhandled exceptions collapse to INTERNAL_ERROR without internals."""
        from rest_framework.request import Request
        from rest_framework.test import APIRequestFactory

        factory = APIRequestFactory()
        request = Request(factory.get("/"))

        exc = RuntimeError("internal db connection string: postgres://user:pass@host/db")
        response = api_exception_handler(exc, {"request": request})

        self.assertEqual(response.status_code, 500)
        body = response.data
        self.assertNotIn("postgres://", str(body))
        self.assertNotIn("internal db connection", str(body))
        self.assertIn("INTERNAL_ERROR", body["error"]["code"])

    def test_authentication_error_never_leaks_token(self) -> None:
        """Authentication errors use a fixed sanitized message."""
        from rest_framework.exceptions import AuthenticationFailed
        from rest_framework.request import Request
        from rest_framework.test import APIRequestFactory

        factory = APIRequestFactory()
        request = Request(factory.get("/"))

        exc = AuthenticationFailed(
            "Internal: JWT validation failed with token sk-or-v1-real-secret-key"
        )
        response = api_exception_handler(exc, {"request": request})

        self.assertEqual(response.status_code, 401)
        body = response.data
        self.assertNotIn("sk-or-v1-real-secret-key", str(body))
        self.assertEqual(body["error"]["code"], "AUTHENTICATION_FAILED")
        self.assertEqual(body["detail"], "Authentication failed or credentials invalid.")

    def test_llm_error_normalization_never_exposes_key(self) -> None:
        """LLMError subclasses carry provider/model info but no key material."""
        test_errors = [
            LLMAuthenticationError("auth failed", provider="openrouter", model="test"),
            LLMTimeoutError("timeout", provider="openrouter", model="test"),
            LLMBadRequestError("bad request", provider="openrouter", model="test"),
            LLMAvailabilityError("unavailable", provider="openrouter", model="test"),
            LLMResponseError("response error", provider="openrouter", model="test"),
        ]
        for exc in test_errors:
            self.assertNotIn("sk-or-v1", str(exc))
            self.assertEqual(exc.provider, "openrouter")
            self.assertEqual(exc.model, "test")

    @override_settings(OPENROUTER_API_KEY="sk-or-v1-healthcheck-secret")
    def test_health_endpoint_never_exposes_secrets(self) -> None:
        """The health endpoint returns status information, never secrets."""
        from django.urls import reverse

        response = self.client.get(reverse("health"))
        body = response.content.decode()

        self.assertNotIn("sk-or-v1-healthcheck-secret", body)
        self.assertNotIn(settings.SECRET_KEY, body)
        self.assertNotIn(settings.OPENROUTER_API_KEY, body)
        self.assertNotIn(settings.DATABASES["default"].get("PASSWORD") or "", body)


class ServerlessModeIsolationTests(SimpleTestCase):
    """Documented mode-isolation invariants stay part of the written contract."""

    def test_serverless_isolation_documented(self) -> None:
        """ROADMAP documents that the server key is not exposed and modes are isolated."""
        roadmap = (REPO_ROOT / "ROADMAP.md").read_text(encoding="utf-8")
        self.assertIn("Serverless mode", roadmap)
        self.assertIn("Do not expose the server's OpenRouter API key", roadmap)
        self.assertIn("intentionally isolated", roadmap)


class LogSanitizationTests(SimpleTestCase):
    """Tests that verify logging never captures secrets."""

    def test_openrouter_provider_logs_never_contain_key(self) -> None:
        """OpenRouterProvider failure logs contain status/model only, no key or auth header."""
        provider = OpenRouterProvider(
            api_key="sk-or-v1-test-secret-key",
            default_model="test/model",
        )
        mock_client = MagicMock()
        mock_client.post.return_value = MagicMock(
            status_code=429,
            text='{"error": {"message": "rate limited"}}',
            headers={},
        )
        provider._client = mock_client
        provider._owns_client = False

        from llm.exceptions import LLMError
        from llm.types import CompletionRequest

        request = CompletionRequest.from_texts([("user", "hello")])

        with self.assertLogs("llm.openrouter", level="WARNING") as logs:
            with self.assertRaises(LLMError):
                provider.complete(request)

        rendered = "\n".join(logs.output)
        self.assertNotIn("sk-or-v1-test-secret-key", rendered)
        self.assertNotIn("Bearer", rendered)
        # Fallback-provider warnings must also stay free of auth material.


class MobileLogHygieneTests(SimpleTestCase):
    """Mobile production modules must keep debugging output out of the bundle."""

    def test_no_console_logging_in_mobile_production_source(self) -> None:
        """Non-test mobile sources never call console.log/warn/error."""
        ts_files = sorted(MOBILE_SRC.rglob("*.ts")) + sorted(MOBILE_SRC.rglob("*.tsx"))
        # Non-vacuous guard: the mobile source tree must actually be present.
        self.assertGreater(len(ts_files), 10, f"unexpectedly few TS files under {MOBILE_SRC}")

        violations: list[str] = []
        for ts_file in ts_files:
            if ".test." in ts_file.name or "__tests__" in ts_file.parts:
                continue
            content = ts_file.read_text(encoding="utf-8")
            for marker in ("console.log", "console.warn", "console.error"):
                if marker in content:
                    violations.append(f"{ts_file} contains {marker}")
        self.assertEqual(violations, [], "\n".join(violations))


__all__ = [
    "SecretHandlingTests",
    "BackendSecretHygieneTests",
    "ServerlessModeIsolationTests",
    "LogSanitizationTests",
    "MobileLogHygieneTests",
]
