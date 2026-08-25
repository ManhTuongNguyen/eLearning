"""Tests for environment-driven configuration management (TASK-008)."""

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

from config.settings import validate_production_configuration

_PRODUCTION_KWARGS = {
    "secret_key": "a-real-production-secret",
    "allowed_hosts": ["example.com"],
    "database_password": "s3cret",
    "openrouter_api_key": "sk-or-v1-test",
}


class ValidateProductionConfigurationTests(SimpleTestCase):
    """The production guard must fail clearly and completely."""

    def test_complete_values_pass(self) -> None:
        validate_production_configuration(**_PRODUCTION_KWARGS)

    def test_missing_secret_key_is_reported(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            validate_production_configuration(**{**_PRODUCTION_KWARGS, "secret_key": ""})
        self.assertIn("DJANGO_SECRET_KEY", str(ctx.exception))

    def test_development_default_secret_is_rejected(self) -> None:
        from config.settings import _DEV_SECRET_KEY

        with self.assertRaises(ImproperlyConfigured) as ctx:
            validate_production_configuration(
                **{**_PRODUCTION_KWARGS, "secret_key": _DEV_SECRET_KEY}
            )
        self.assertIn("DJANGO_SECRET_KEY", str(ctx.exception))

    def test_empty_allowed_hosts_are_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            validate_production_configuration(**{**_PRODUCTION_KWARGS, "allowed_hosts": []})
        self.assertIn("DJANGO_ALLOWED_HOSTS", str(ctx.exception))

    def test_missing_database_password_is_reported(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            validate_production_configuration(**{**_PRODUCTION_KWARGS, "database_password": ""})
        self.assertIn("POSTGRES_PASSWORD", str(ctx.exception))

    def test_missing_openrouter_api_key_is_reported(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            validate_production_configuration(**{**_PRODUCTION_KWARGS, "openrouter_api_key": ""})
        self.assertIn("OPENROUTER_API_KEY", str(ctx.exception))

    def test_all_missing_values_are_reported_at_once(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            validate_production_configuration(
                secret_key="",
                allowed_hosts=(),
                database_password="",
                openrouter_api_key="",
            )
        message = str(ctx.exception)
        for variable in (
            "DJANGO_SECRET_KEY",
            "DJANGO_ALLOWED_HOSTS",
            "POSTGRES_PASSWORD",
            "OPENROUTER_API_KEY",
        ):
            self.assertIn(variable, message)


class EnvironmentConfigurationSmokeTests(SimpleTestCase):
    """Every documented configuration category resolves to a usable value."""

    def test_redis_url_is_configured(self) -> None:
        self.assertTrue(settings.REDIS_URL.startswith("redis://"))

    def test_jwt_lifetimes_are_positive_integers(self) -> None:
        self.assertGreater(settings.JWT_ACCESS_TOKEN_MINUTES, 0)
        self.assertGreater(settings.JWT_REFRESH_TOKEN_DAYS, 0)

    def test_openrouter_settings_are_configured(self) -> None:
        self.assertTrue(settings.OPENROUTER_BASE_URL.startswith("https://"))
        self.assertIsInstance(settings.LLM_PRIMARY_MODEL, str)
        self.assertTrue(settings.LLM_PRIMARY_MODEL)

    def test_llm_fallback_models_are_a_list(self) -> None:
        self.assertIsInstance(settings.LLM_FALLBACK_MODELS, list)

    def test_llm_request_timeout_is_positive(self) -> None:
        self.assertGreater(settings.LLM_REQUEST_TIMEOUT_SECONDS, 0)
