"""Application user model for identity and authentication."""

from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """User authenticable by username or email.

    Extends :class:`django.contrib.auth.models.AbstractUser` so password
    hashing and management commands behave exactly like stock Django. The
    email address is required and globally unique, letting the authentication
    flow accept either identifier while keeping accounts distinct.
    """

    email = models.EmailField("email address", unique=True)

    def __str__(self) -> str:
        return self.username
