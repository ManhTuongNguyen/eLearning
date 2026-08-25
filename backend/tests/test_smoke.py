"""Smoke tests verifying project configuration loads correctly."""

from django.conf import settings
from django.test import SimpleTestCase
from django.urls import reverse


class ConfigurationSmokeTests(SimpleTestCase):
    """Verify core settings and URL wiring without touching the database."""

    def test_secret_key_is_configured(self) -> None:
        self.assertTrue(settings.SECRET_KEY)

    def test_debug_flag_is_boolean(self) -> None:
        self.assertIsInstance(settings.DEBUG, bool)

    def test_postgresql_support_is_available(self) -> None:
        from django.db.backends.postgresql import base  # noqa: F401

    def test_admin_url_resolves(self) -> None:
        self.assertEqual(reverse("admin:index"), "/admin/")
