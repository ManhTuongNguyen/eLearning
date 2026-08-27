"""Pytest fixtures and configuration shared across all backend tests.

Provides:
- ``settings`` override that disables per-IP throttling during tests so
  authentication-heavy test suites do not exhaust the bucket.
- A cache reset between tests to prevent throttle state from leaking
  between unrelated tests.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _disable_throttling_for_tests(settings):  # noqa: ARG001
    """Disable anonymous auth throttling in tests by default.

    Individual tests that need to exercise throttling (see
    ``tests/test_auth_security.py::TestAuthenticationThrottling``) patch
    the rate themselves; everything else should not be at the mercy of
    the rate limit.
    """
    settings.REST_FRAMEWORK = {
        **settings.REST_FRAMEWORK,
        "DEFAULT_THROTTLE_RATES": {
            **settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {}),
            "auth": "1000/min",
        },
    }
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()
