import pytest
from httpx import ASGITransport, AsyncClient

from apps.api.app.main import app



@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_run_rejects_traversal_paths_before_queueing():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/run", json={"files": {"../Main.java": "class Main {}"}})
    assert response.status_code == 422
    assert "Invalid Java file path" in response.json()["detail"]


@pytest.mark.anyio
async def test_unknown_job_has_a_clear_not_found_response():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/jobs/not-a-real-job")
    assert response.status_code == 404
    assert response.json()["detail"] == "Run not found. Start a new run and try again."


@pytest.mark.anyio
async def test_runtime_endpoint_always_identifies_the_language():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/runtime")
    assert response.status_code == 200
    assert response.json()["language"] == "Java"
