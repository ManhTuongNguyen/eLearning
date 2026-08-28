"""Tests for server-mode LLM/model configuration (llm.config, TASK-023)."""

import re
from dataclasses import FrozenInstanceError
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, override_settings

from llm.config import ModelConfiguration, load_model_configuration
from llm.fallback import FallbackProvider
from llm.gemini import GeminiProvider
from llm.openrouter import OpenRouterProvider

LLM_DIR = Path(__file__).resolve().parents[1] / "llm"

# Business modules that must never carry model names or read LLM settings.
_BUSINESS_MODULES = (
    "config.py",
    "exceptions.py",
    "fallback.py",
    "gemini.py",
    "ninerouter.py",
    "openai.py",
    "openai_compatible.py",
    "openrouter.py",
    "provider.py",
    "provider_errors.py",
    "provider_specs.py",
    "registry.py",
    "types.py",
)

# Model-id fragments (vendor token followed by a version separator/digit,
# e.g. "gpt-4o" or "claude/3.5") — bare vendor names like the "gemini"
# provider id itself are not model names.
_MODEL_NAME_PATTERN = re.compile(
    r"\b(gpt|claude|gemini|llama|mistral|deepseek|qwen|grok)([-_/]|\d)[a-z0-9_/.-]*",
    re.IGNORECASE,
)


def _configuration(**overrides: object) -> ModelConfiguration:
    values: dict[str, object] = {
        "provider": "openrouter",
        "api_key": "sk-test",
        "base_url": "https://openrouter.ai/api/v1",
        "timeout_seconds": 30.0,
        "connect_timeout_seconds": 10.0,
        "read_timeout_seconds": 30.0,
        "primary_model": "vendor/main",
        "fallback_models": ("vendor/f1",),
    }
    values.update(overrides)
    return ModelConfiguration(**values)  # type: ignore[arg-type]


class ModelConfigurationTests(SimpleTestCase):
    """The configuration value object is a frozen ordered chain."""

    def test_model_chain_places_primary_before_fallbacks(self) -> None:
        config = _configuration(fallback_models=("vendor/f2", "vendor/f1"))
        self.assertEqual(
            config.model_chain,
            ("vendor/main", "vendor/f2", "vendor/f1"),
        )

    def test_chain_without_fallbacks_is_primary_only(self) -> None:
        config = _configuration(fallback_models=())
        self.assertEqual(config.model_chain, ("vendor/main",))

    def test_configuration_is_frozen(self) -> None:
        config = _configuration()
        with self.assertRaises(FrozenInstanceError):
            config.primary_model = "vendor/other"  # type: ignore[misc]


class LoadModelConfigurationTests(SimpleTestCase):
    """Values are assembled and normalized from Django settings."""

    @override_settings(
        OPENROUTER_API_KEY="sk-or-v1-abc",
        OPENROUTER_BASE_URL="https://openrouter.ai/api/v1/",
        LLM_REQUEST_TIMEOUT_SECONDS=45,
        LLM_CONNECT_TIMEOUT_SECONDS=12,
        LLM_READ_TIMEOUT_SECONDS=45,
        LLM_PRIMARY_MODEL="acme/primary",
        LLM_FALLBACK_MODELS=["acme/fb-1", "acme/fb-2"],
    )
    def test_reads_documented_settings(self) -> None:
        config = load_model_configuration()

        self.assertEqual(config.provider, "openrouter")
        self.assertEqual(config.api_key, "sk-or-v1-abc")
        self.assertEqual(config.base_url, "https://openrouter.ai/api/v1")
        self.assertEqual(config.timeout_seconds, 45.0)
        self.assertEqual(config.connect_timeout_seconds, 12.0)
        self.assertEqual(config.read_timeout_seconds, 45.0)
        self.assertEqual(config.model_chain, ("acme/primary", "acme/fb-1", "acme/fb-2"))

    @override_settings(
        LLM_PROVIDER="gemini",
        GEMINI_API_KEY="gem-key-123",
        LLM_PRIMARY_MODEL="acme/primary",
        LLM_FALLBACK_MODELS=["acme/fb-1"],
    )
    def test_provider_selection_resolves_dedicated_settings(self) -> None:
        config = load_model_configuration()

        self.assertEqual(config.provider, "gemini")
        self.assertEqual(config.api_key, "gem-key-123")
        self.assertEqual(config.base_url, "https://generativelanguage.googleapis.com/v1beta")

    @override_settings(
        LLM_PROVIDER=" GEMINI ",
        GEMINI_API_KEY="gem-key-123",
        GEMINI_BASE_URL="https://gemini.example/v1beta",
        LLM_PRIMARY_MODEL="acme/primary",
    )
    def test_provider_name_is_normalized(self) -> None:
        config = load_model_configuration()

        self.assertEqual(config.provider, "gemini")
        self.assertEqual(config.base_url, "https://gemini.example/v1beta")

    @override_settings(
        LLM_PROVIDER="openai-compatible",
        OPENAI_COMPATIBLE_API_KEY="sk-compat",
        OPENAI_COMPATIBLE_BASE_URL="https://compat.example/v1",
        LLM_PRIMARY_MODEL="acme/primary",
    )
    def test_generic_openai_compatible_provider_requires_explicit_base_url(self) -> None:
        config = load_model_configuration()

        self.assertEqual(config.provider, "openai-compatible")
        self.assertEqual(config.base_url, "https://compat.example/v1")

    @override_settings(
        LLM_PROVIDER="openai-compatible",
        OPENAI_COMPATIBLE_API_KEY="sk-compat",
        OPENAI_COMPATIBLE_BASE_URL="   ",
        LLM_PRIMARY_MODEL="acme/primary",
    )
    def test_blank_generic_provider_base_url_is_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            load_model_configuration()
        self.assertIn("OPENAI_COMPATIBLE_BASE_URL", str(ctx.exception))

    @override_settings(LLM_PROVIDER="not-a-provider", LLM_PRIMARY_MODEL="acme/primary")
    def test_unknown_provider_is_rejected_by_name(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            load_model_configuration()
        self.assertIn("LLM_PROVIDER", str(ctx.exception))
        self.assertIn("not-a-provider", str(ctx.exception))

    @override_settings(
        OPENROUTER_API_KEY="sk",
        OPENROUTER_BASE_URL="https://openrouter.ai/api/v1",
        LLM_PRIMARY_MODEL="  acme/primary  ",
        LLM_FALLBACK_MODELS=[" acme/fb-1 ", "", "   ", "acme/fb-1", "acme/primary", "acme/fb-2"],
    )
    def test_strips_names_and_drops_blank_duplicate_or_primary_fallbacks(self) -> None:
        config = load_model_configuration()

        self.assertEqual(config.primary_model, "acme/primary")
        self.assertEqual(config.fallback_models, ("acme/fb-1", "acme/fb-2"))

    @override_settings(
        OPENROUTER_API_KEY="sk",
        OPENROUTER_BASE_URL="https://openrouter.ai/api/v1",
        LLM_PRIMARY_MODEL="acme/primary",
        LLM_FALLBACK_MODELS=["", "   "],
    )
    def test_all_blank_fallbacks_reduce_to_primary_only(self) -> None:
        config = load_model_configuration()

        self.assertEqual(config.fallback_models, ())
        self.assertEqual(config.model_chain, ("acme/primary",))

    @override_settings(
        OPENROUTER_API_KEY="",
        OPENROUTER_BASE_URL="https://openrouter.ai/api/v1",
        LLM_PRIMARY_MODEL="acme/primary",
        LLM_FALLBACK_MODELS=[],
    )
    def test_empty_api_key_passes_through_for_development(self) -> None:
        # Production key enforcement lives in validate_production_configuration;
        # the loader itself must not block development without a key.
        config = load_model_configuration()

        self.assertEqual(config.api_key, "")

    @override_settings(LLM_PRIMARY_MODEL="   ")
    def test_blank_primary_model_is_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            load_model_configuration()
        self.assertIn("LLM_PRIMARY_MODEL", str(ctx.exception))

    @override_settings(OPENROUTER_BASE_URL="   ")
    def test_blank_base_url_is_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            load_model_configuration()
        self.assertIn("OPENROUTER_BASE_URL", str(ctx.exception))

    @override_settings(LLM_REQUEST_TIMEOUT_SECONDS="not-a-number")
    def test_non_numeric_timeout_is_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            load_model_configuration()
        self.assertIn("LLM_REQUEST_TIMEOUT_SECONDS", str(ctx.exception))

    @override_settings(LLM_REQUEST_TIMEOUT_SECONDS=0)
    def test_zero_timeout_is_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            load_model_configuration()
        self.assertIn("LLM_REQUEST_TIMEOUT_SECONDS", str(ctx.exception))

    @override_settings(LLM_REQUEST_TIMEOUT_SECONDS=-5)
    def test_negative_timeout_is_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            load_model_configuration()
        self.assertIn("LLM_REQUEST_TIMEOUT_SECONDS", str(ctx.exception))

    def test_missing_setting_attribute_is_reported_by_name(self) -> None:
        from llm import config as config_module

        class _EmptySettings:
            pass

        original = config_module.settings
        config_module.settings = _EmptySettings
        try:
            with self.assertRaises(ImproperlyConfigured) as ctx:
                load_model_configuration()
            self.assertIn("LLM_PRIMARY_MODEL", str(ctx.exception))
        finally:
            config_module.settings = original


class ProviderWiringTests(SimpleTestCase):
    """Providers build themselves from the loaded configuration."""

    @override_settings(
        OPENROUTER_API_KEY="sk-wiring",
        OPENROUTER_BASE_URL="https://openrouter.ai/api/v1/",
        LLM_REQUEST_TIMEOUT_SECONDS=11,
        LLM_CONNECT_TIMEOUT_SECONDS=5,
        LLM_READ_TIMEOUT_SECONDS=11,
        LLM_PRIMARY_MODEL="wiring/primary",
        LLM_FALLBACK_MODELS=["wiring/fb"],
    )
    def test_openrouter_provider_from_settings_uses_configuration(self) -> None:
        provider = OpenRouterProvider.from_settings()
        self.addCleanup(provider.close)

        self.assertEqual(provider.api_key, "sk-wiring")
        self.assertEqual(provider.base_url, "https://openrouter.ai/api/v1")
        self.assertEqual(provider.default_model, "wiring/primary")
        self.assertEqual(provider.connect_timeout, 5.0)
        self.assertEqual(provider.read_timeout, 11.0)

    @override_settings(
        OPENROUTER_API_KEY="sk-wiring",
        LLM_PROVIDER="gemini",
        LLM_PRIMARY_MODEL="wiring/primary",
    )
    def test_openrouter_provider_from_settings_rejects_provider_mismatch(self) -> None:
        with self.assertRaises(ImproperlyConfigured):
            OpenRouterProvider.from_settings()

    @override_settings(
        OPENROUTER_API_KEY="sk-wiring",
        OPENROUTER_BASE_URL="https://openrouter.ai/api/v1",
        LLM_REQUEST_TIMEOUT_SECONDS=12,
        LLM_CONNECT_TIMEOUT_SECONDS=6,
        LLM_READ_TIMEOUT_SECONDS=12,
        LLM_PRIMARY_MODEL="wiring/primary",
        LLM_FALLBACK_MODELS=["wiring/fb-1", "wiring/fb-2"],
    )
    def test_fallback_provider_from_settings_builds_full_chain(self) -> None:
        fallback = FallbackProvider.from_settings()
        self.addCleanup(fallback.close)

        assert isinstance(fallback.provider, OpenRouterProvider)
        self.assertEqual(fallback.provider.default_model, "wiring/primary")
        self.assertEqual(
            fallback.models,
            ("wiring/primary", "wiring/fb-1", "wiring/fb-2"),
        )

    @override_settings(
        LLM_PROVIDER="gemini",
        GEMINI_API_KEY="gem-wiring",
        LLM_CONNECT_TIMEOUT_SECONDS=7,
        LLM_READ_TIMEOUT_SECONDS=13,
        LLM_PRIMARY_MODEL="wiring/primary",
        LLM_FALLBACK_MODELS=["wiring/fb"],
    )
    def test_fallback_provider_from_settings_builds_selected_provider(self) -> None:
        fallback = FallbackProvider.from_settings()
        self.addCleanup(fallback.close)

        assert isinstance(fallback.provider, GeminiProvider)
        self.assertEqual(fallback.provider.api_key, "gem-wiring")
        self.assertEqual(
            fallback.models,
            ("wiring/primary", "wiring/fb"),
        )


class NoHardcodedModelsTests(SimpleTestCase):
    """Model names exist only in configuration, never in business logic."""

    def test_business_modules_contain_no_model_name_literals(self) -> None:
        for filename in _BUSINESS_MODULES:
            source = (LLM_DIR / filename).read_text(encoding="utf-8")
            matches = _MODEL_NAME_PATTERN.findall(source)
            self.assertEqual(
                matches,
                [],
                f"{filename} contains hard-coded model name fragments: {matches}",
            )

    def test_business_modules_do_not_read_llm_settings_directly(self) -> None:
        for filename in _BUSINESS_MODULES:
            source = (LLM_DIR / filename).read_text(encoding="utf-8")
            for forbidden in (
                "settings.LLM_",
                "settings.OPENROUTER_",
                "settings.GEMINI_",
                "settings.OPENAI_",
                "settings.NINEROUTER_",
            ):
                self.assertNotIn(
                    forbidden,
                    source,
                    f"{filename} must access {forbidden[:-1]}* via llm.config",
                )


class SecretHygieneTests(SimpleTestCase):
    """Loading never logs the API key or full model payloads."""

    @override_settings(
        OPENROUTER_API_KEY="sk-or-v1-super-secret",
        LLM_PRIMARY_MODEL="hygiene/primary",
        LLM_FALLBACK_MODELS=["hygiene/fb"],
    )
    def test_api_key_never_appears_in_config_logs(self) -> None:
        with self.assertLogs("llm.config", level="DEBUG") as logs:
            load_model_configuration()

        rendered = "\n".join(logs.output)
        self.assertNotIn("sk-or-v1-super-secret", rendered)
