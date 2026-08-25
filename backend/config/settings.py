"""Django settings for the eLearning backend.

Configuration is sourced from environment variables via python-decouple,
following the naming conventions documented in the root `.env.example`.
"""

from datetime import timedelta
from pathlib import Path

from decouple import Csv, config
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent

_DEV_SECRET_KEY = "dev-only-insecure-secret-key"

DEBUG = config("DJANGO_DEBUG", default=True, cast=bool)

SECRET_KEY = config("DJANGO_SECRET_KEY", default=_DEV_SECRET_KEY)

ALLOWED_HOSTS = config("DJANGO_ALLOWED_HOSTS", default="localhost,127.0.0.1", cast=Csv())

if DEBUG and "10.0.2.2" not in ALLOWED_HOSTS:
    # Android emulator alias for the host loopback interface.
    ALLOWED_HOSTS.append("10.0.2.2")


def validate_production_configuration(
    *,
    secret_key: str,
    allowed_hosts: list[str] | tuple[str, ...],
    database_password: str,
    openrouter_api_key: str,
) -> None:
    """Fail clearly when required values are missing for production.

    Called once at settings import when ``DJANGO_DEBUG=False`` so a misconfigured
    production deployment stops immediately with an explicit message naming
    every offending variable instead of failing later in subtle ways.
    """

    missing: list[str] = []
    if not secret_key or secret_key == _DEV_SECRET_KEY:
        missing.append("DJANGO_SECRET_KEY")
    if not allowed_hosts:
        missing.append("DJANGO_ALLOWED_HOSTS")
    if not database_password:
        missing.append("POSTGRES_PASSWORD")
    if not openrouter_api_key:
        missing.append("OPENROUTER_API_KEY")
    if missing:
        raise ImproperlyConfigured(
            "Missing required production environment variables: "
            + ", ".join(missing)
            + ". Set them via the environment or .env file before running "
            "with DJANGO_DEBUG=False."
        )


if not DEBUG:
    validate_production_configuration(
        secret_key=SECRET_KEY,
        allowed_hosts=ALLOWED_HOSTS,
        database_password=config("POSTGRES_PASSWORD", default=""),
        openrouter_api_key=config("OPENROUTER_API_KEY", default=""),
    )

# Application definition

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    # JWT refresh-token invalidation support (logout blacklisting).
    "rest_framework_simplejwt.token_blacklist",
    # Project apps
    "accounts",
    "learning",
    "conversations",
    "vocabulary",
    "llm",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# Database
#
# PostgreSQL is the primary database. For quick local development before the
# Docker services exist, set `DB_ENGINE=sqlite3` in the environment.

_DB_ENGINE = config("DB_ENGINE", default="postgresql")

if _DB_ENGINE == "sqlite3":
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": config("POSTGRES_DB", default="elearning"),
            "USER": config("POSTGRES_USER", default="elearning"),
            "PASSWORD": config("POSTGRES_PASSWORD", default=""),
            "HOST": config("POSTGRES_HOST", default="localhost"),
            "PORT": config("POSTGRES_PORT", default="5432", cast=int),
            # Test runs never touch the development database; pytest-django
            # creates and destroys this dedicated database per session.
            "TEST": {
                "NAME": config("POSTGRES_TEST_DB", default="test_elearning"),
            },
        }
    }

# Authentication
#
# The custom user model must be declared before any migration references it.

AUTH_USER_MODEL = "accounts.User"

# Transaction policy: Django's default autocommit mode with opt-in
# ``transaction.atomic()`` blocks in application services. ATOMIC_REQUESTS
# stays off so long-running LLM streaming responses do not hold open
# transactions against PostgreSQL.

# Password validation

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# Internationalization

LANGUAGE_CODE = "en-us"

TIME_ZONE = "UTC"

USE_I18N = True

USE_TZ = True

# Static files

STATIC_URL = "static/"

# Default primary key field type

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Django REST Framework
#
# Authentication defaults to JWT; permissions default to deny-unauthenticated
# so every new endpoint is protected unless it explicitly opts out with
# AllowAny (registration, login, refresh, health).

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 20,
}

# Celery
#
# URLs are sourced from the environment (REDIS_URL / CELERY_BROKER_URL /
# CELERY_RESULT_BACKEND). Defaults suit local non-Docker development.

CELERY_BROKER_URL = config("CELERY_BROKER_URL", default="redis://localhost:6379/1")
CELERY_RESULT_BACKEND = config("CELERY_RESULT_BACKEND", default="redis://localhost:6379/2")
CELERY_TASK_ALWAYS_EAGER = config("CELERY_TASK_ALWAYS_EAGER", default=False, cast=bool)

REDIS_URL = config("REDIS_URL", default="redis://localhost:6379/0")

# JWT authentication (djangorestframework-simplejwt)

JWT_ACCESS_TOKEN_MINUTES = config("JWT_ACCESS_TOKEN_MINUTES", default=15, cast=int)
JWT_REFRESH_TOKEN_DAYS = config("JWT_REFRESH_TOKEN_DAYS", default=7, cast=int)

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=JWT_ACCESS_TOKEN_MINUTES),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=JWT_REFRESH_TOKEN_DAYS),
    "AUTH_HEADER_TYPES": ("Bearer",),
}

# OpenRouter / LLM
#
# The server-side OpenRouter key must never reach the mobile application.
# Defaults exist so development works without a key; production validation
# above requires one when DEBUG is disabled.

OPENROUTER_API_KEY = config("OPENROUTER_API_KEY", default="")
OPENROUTER_BASE_URL = config("OPENROUTER_BASE_URL", default="https://openrouter.ai/api/v1")
LLM_PRIMARY_MODEL = config("LLM_PRIMARY_MODEL", default="openai/gpt-4o-mini")
LLM_FALLBACK_MODELS = config(
    "LLM_FALLBACK_MODELS",
    default="openai/gpt-4o,anthropic/claude-3.5-haiku",
    cast=Csv(),
)
LLM_REQUEST_TIMEOUT_SECONDS = config("LLM_REQUEST_TIMEOUT_SECONDS", default=60, cast=int)
