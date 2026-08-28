"""Tests for the provider registry (llm.registry, TASK-AUDIT-013).

The registry is the seam that lets conversation features stay provider-
agnostic: selecting a provider must be a configuration change only. These
tests prove that every supported provider can be built from the same
normalized configuration and that unknown providers fail loudly.
"""

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, override_settings

from llm.config import ModelConfiguration
from llm.gemini import GeminiProvider
from llm.ninerouter import NineRouterProvider
from llm.openai import OpenAIProvider
from llm.openai_compatible import OpenAICompatibleProvider
from llm.openrouter import OpenRouterProvider
from llm.provider_specs import (
    DEFAULT_PROVIDER_NAME,
    PROVIDER_SPECS,
    get_provider_spec,
)
from llm.registry import (
    PROVIDER_FACTORIES,
    available_provider_names,
    build_provider,
    build_provider_from_settings,
)


def _config(provider: str, **overrides: object) -> ModelConfiguration:
    values: dict[str, object] = {
        "provider": provider,
        "api_key": "sk-test",
        "base_url": "https://provider.example/api/v1",
        "timeout_seconds": 30.0,
        "connect_timeout_seconds": 10.0,
        "read_timeout_seconds": 30.0,
        "primary_model": "vendor/main",
        "fallback_models": (),
    }
    values.update(overrides)
    return ModelConfiguration(**values)  # type: ignore[arg-type]


class ProviderSpecTests(SimpleTestCase):
    """Static provider metadata resolves consistently."""

    def test_default_provider_is_openrouter(self) -> None:
        self.assertEqual(DEFAULT_PROVIDER_NAME, "openrouter")

    def test_specs_cover_every_registered_factory(self) -> None:
        self.assertEqual(set(PROVIDER_SPECS), set(PROVIDER_FACTORIES))

    def test_setting_names_follow_the_prefix_convention(self) -> None:
        spec = get_provider_spec("gemini")
        self.assertEqual(spec.api_key_setting, "GEMINI_API_KEY")
        self.assertEqual(spec.base_url_setting, "GEMINI_BASE_URL")

    def test_unknown_provider_raises_naming_the_setting(self) -> None:
        with self.assertRaises(ImproperlyConfigured) as ctx:
            get_provider_spec("not-a-provider")
        self.assertIn("LLM_PROVIDER", str(ctx.exception))
        self.assertIn("not-a-provider", str(ctx.exception))

    def test_blank_provider_raises(self) -> None:
        with self.assertRaises(ImproperlyConfigured):
            get_provider_spec("   ")


class BuildProviderTests(SimpleTestCase):
    """Every provider builds from the same normalized configuration."""

    def test_openai_compatible_providers_share_one_implementation(self) -> None:
        for provider_name in ("openrouter", "openai", "ninerouter"):
            provider = build_provider(_config(provider_name))
            self.addCleanup(provider.close)
            self.assertIsInstance(provider, OpenAICompatibleProvider)
            self.assertEqual(provider.provider_name, provider_name)

    def test_openrouter_builds_dedicated_class(self) -> None:
        provider = build_provider(_config("openrouter"))
        self.addCleanup(provider.close)
        self.assertIsInstance(provider, OpenRouterProvider)
        self.assertEqual(provider.provider_name, "openrouter")

    def test_gemini_builds_dedicated_class(self) -> None:
        provider = build_provider(_config("gemini"))
        self.addCleanup(provider.close)
        self.assertIsInstance(provider, GeminiProvider)
        self.assertEqual(provider.provider_name, "gemini")

    def test_configuration_flows_into_the_built_provider(self) -> None:
        provider = build_provider(
            _config(
                "openai",
                api_key="sk-flow",
                base_url="https://openai.example/v1",
                connect_timeout_seconds=4.0,
                read_timeout_seconds=9.0,
                primary_model="vendor/main",
            )
        )
        self.addCleanup(provider.close)

        self.assertEqual(provider.api_key, "sk-flow")
        self.assertEqual(provider.base_url, "https://openai.example/v1")
        self.assertEqual(provider.default_model, "vendor/main")
        self.assertEqual(provider.connect_timeout, 4.0)
        self.assertEqual(provider.read_timeout, 9.0)

    def test_generic_openai_compatible_provider_uses_configured_url(self) -> None:
        provider = build_provider(_config("openai-compatible"))
        self.addCleanup(provider.close)
        self.assertEqual(type(provider), OpenAICompatibleProvider)
        self.assertEqual(provider.base_url, "https://provider.example/api/v1")

    def test_unknown_provider_is_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured):
            build_provider(_config("not-a-provider"))


class RegistrySettingsWiringTests(SimpleTestCase):
    """from_settings paths stay consistent with the registry selection."""

    @override_settings(
        LLM_PROVIDER="openai",
        OPENAI_API_KEY="sk-wiring",
        LLM_PRIMARY_MODEL="wiring/primary",
    )
    def test_build_provider_from_settings_reads_llm_provider(self) -> None:
        provider = build_provider_from_settings()
        self.addCleanup(provider.close)
        self.assertIsInstance(provider, OpenAIProvider)
        self.assertEqual(provider.base_url, "https://api.openai.com/v1")

    @override_settings(
        LLM_PROVIDER="ninerouter",
        NINEROUTER_API_KEY="sk-wiring",
        LLM_PRIMARY_MODEL="wiring/primary",
    )
    def test_build_provider_from_settings_supports_ninerouter(self) -> None:
        provider = build_provider_from_settings()
        self.addCleanup(provider.close)
        self.assertIsInstance(provider, NineRouterProvider)
        self.assertEqual(provider.base_url, "http://localhost:20128/v1")

    @override_settings(
        LLM_PROVIDER="gemini",
        GEMINI_API_KEY="gem-wiring",
        LLM_PRIMARY_MODEL="wiring/primary",
    )
    def test_build_provider_from_settings_supports_gemini(self) -> None:
        provider = build_provider_from_settings()
        self.addCleanup(provider.close)
        self.assertIsInstance(provider, GeminiProvider)
        self.assertEqual(provider.base_url, "https://generativelanguage.googleapis.com/v1beta")

    @override_settings(LLM_PROVIDER="bogus", LLM_PRIMARY_MODEL="wiring/primary")
    def test_build_provider_from_settings_rejects_unknown_provider(self) -> None:
        with self.assertRaises(ImproperlyConfigured):
            build_provider_from_settings()

    def test_available_provider_names_cover_every_factory(self) -> None:
        self.assertEqual(set(available_provider_names()), set(PROVIDER_FACTORIES))


class RegistryDoesNotLeakSecretsTests(SimpleTestCase):
    """Registry logging names providers and settings, never key material."""

    def test_build_logs_never_contain_the_api_key(self) -> None:
        with self.assertLogs("llm.registry", level="DEBUG") as logs:
            provider = build_provider(_config("openrouter", api_key="sk-registry-secret"))
        self.addCleanup(provider.close)

        rendered = "\n".join(logs.output)
        self.assertNotIn("sk-registry-secret", rendered)
