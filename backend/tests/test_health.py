import os
import tempfile

# must be set before app.main imports app.core.database, which builds the engine at import time
_TMP = tempfile.mkdtemp(prefix="inframonitor_test_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.database import engine  # noqa: E402
from app.main import app  # noqa: E402


# TestClient must be used as a context manager or the lifespan never runs and the
# schema is never created -- the previous version of this test skipped startup entirely
def test_health_ok() -> None:
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"


def test_startup_seeds_admin_and_no_demo_server() -> None:
    with TestClient(app):
        pass
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM users WHERE email = 'admin@inframonitor.local'")).scalar() == 1
        assert conn.execute(text("SELECT count(*) FROM app_settings")).scalar() == 3
        assert conn.execute(text("SELECT count(*) FROM servers")).scalar() == 0


def test_health_degraded_when_schema_missing() -> None:
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE users"))
        response = client.get("/health")
        assert response.status_code == 503
        assert response.json()["database"] == "unavailable"
