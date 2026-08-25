"""Infrastructure views served outside any domain app."""

from datetime import UTC, datetime

from django.db import connection
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response


def _check_database() -> str:
    """Probe database connectivity, returning its component status."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
    return "ok"


@api_view(["GET"])
@permission_classes([AllowAny])
def health(request: Request) -> Response:
    """Report service health for load balancers and uptime probes.

    Returns 200 when every checked component is healthy and 503 otherwise.
    The payload intentionally contains only component statuses — never
    credentials, hosts, or other environment details.
    """

    try:
        database_status = _check_database()
    except Exception:  # noqa: BLE001 - any probe failure means degraded
        database_status = "unavailable"

    components = {"database": database_status}
    healthy = all(component == "ok" for component in components.values())

    return Response(
        {
            "status": "ok" if healthy else "unavailable",
            "components": components,
            "time": datetime.now(UTC).isoformat(),
        },
        status=status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE,
    )
