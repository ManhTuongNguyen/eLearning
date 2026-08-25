"""Tests for the GET /api/v1/health/ endpoint."""

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from django.conf import settings
from django.test import TestCase
from django.urls import reverse

from config import views


class HealthEndpointTests(TestCase):
    """Verify health reporting, secret hygiene, and failure behavior."""

    def test_health_returns_200_with_healthy_components(self) -> None:
        response = self.client.get(reverse("health"))

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["components"]["database"], "ok")

    def test_health_timestamp_is_recent_and_utc(self) -> None:
        before = datetime.now(UTC)

        response = self.client.get(reverse("health"))

        parsed = datetime.fromisoformat(response.json()["time"])
        self.assertIsNotNone(parsed.tzinfo)
        self.assertLessEqual(parsed, datetime.now(UTC))
        self.assertGreater(parsed, before - timedelta(minutes=1))

    def test_health_does_not_expose_secrets(self) -> None:
        response = self.client.get(reverse("health"))

        body = response.content.decode()
        self.assertNotIn(settings.SECRET_KEY, body)
        db_password = settings.DATABASES["default"].get("PASSWORD") or ""
        if db_password:
            self.assertNotIn(db_password, body)
        self.assertNotIn(settings.OPENROUTER_API_KEY or "\x00", body)

    def test_wrong_method_is_rejected(self) -> None:
        response = self.client.post(reverse("health"))

        self.assertEqual(response.status_code, 405)

    def test_database_failure_returns_503(self) -> None:
        with patch.object(views, "_check_database", side_effect=RuntimeError("boom")):
            response = self.client.get(reverse("health"))

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["components"]["database"], "unavailable")
