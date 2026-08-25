"""Database configuration tests executed against a real database.

These tests run inside pytest-django's isolated per-session test database
(``test_elearning`` under PostgreSQL) and verify engine selection,
transaction semantics, and isolation from the development database.
"""

import psycopg
import pytest
from decouple import config as env_config
from django.contrib.auth import get_user_model
from django.db import connection, transaction

pytestmark = pytest.mark.django_db


def _is_sqlite_override() -> bool:
    return connection.vendor == "sqlite"


class TestDatabaseConfiguration:
    """Engine selection and test-database isolation."""

    def test_postgresql_is_the_primary_engine(self) -> None:
        if _is_sqlite_override():
            pytest.skip("DB_ENGINE=sqlite3 local-development override is active")
        assert connection.vendor == "postgresql"

    def test_tests_use_an_isolated_database(self) -> None:
        if _is_sqlite_override():
            pytest.skip("DB_ENGINE=sqlite3 local-development override is active")
        active_name = str(connection.settings_dict["NAME"])
        development_name = env_config("POSTGRES_DB", default="elearning")
        assert active_name != development_name
        assert active_name.startswith("test_")

    def test_transactions_are_supported(self) -> None:
        assert connection.features.supports_transactions is True

    def test_test_data_never_reaches_the_development_database(self) -> None:
        if _is_sqlite_override():
            pytest.skip("DB_ENGINE=sqlite3 local-development override is active")
        user_model = get_user_model()
        probe = "isolation-probe"
        user_model.objects.create_user(username=probe, password="x")
        with psycopg.connect(
            dbname=env_config("POSTGRES_DB", default="elearning"),
            user=env_config("POSTGRES_USER", default="elearning"),
            password=env_config("POSTGRES_PASSWORD", default=""),
            host=env_config("POSTGRES_HOST", default="localhost"),
            port=env_config("POSTGRES_PORT", default="5432", cast=int),
            connect_timeout=5,
        ) as dev_connection:
            (count,) = dev_connection.execute(
                "SELECT COUNT(*) FROM auth_user WHERE username = %s", (probe,)
            ).fetchone()
        assert count == 0


class TestTransactionBehavior:
    """Commit/rollback semantics required by application services."""

    def test_committed_writes_persist(self) -> None:
        user_model = get_user_model()
        with transaction.atomic():
            user_model.objects.create_user(username="committed", password="x")
        assert user_model.objects.filter(username="committed").exists()

    def test_exception_inside_atomic_block_rolls_back_all_writes(self) -> None:
        user_model = get_user_model()
        with pytest.raises(RuntimeError):
            with transaction.atomic():
                user_model.objects.create_user(username="rolled-back", password="x")
                raise RuntimeError("boom")
        assert not user_model.objects.filter(username="rolled-back").exists()

    def test_inner_block_failure_discards_only_inner_writes(self) -> None:
        user_model = get_user_model()
        with transaction.atomic():
            user_model.objects.create_user(username="outer-kept", password="x")
            with pytest.raises(RuntimeError):
                with transaction.atomic():
                    user_model.objects.create_user(username="inner-discarded", password="x")
                    raise RuntimeError("boom")
        assert user_model.objects.filter(username="outer-kept").exists()
        assert not user_model.objects.filter(username="inner-discarded").exists()
