"""Celery application for the eLearning backend.

Broker and result backend URLs come from Django settings
(`CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND`) via python-decouple,
matching `.env.example`.
"""

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("elearning")

app.config_from_object("django.conf:settings", namespace="CELERY")

app.autodiscover_tasks()
