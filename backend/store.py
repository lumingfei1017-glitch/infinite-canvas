"""File-backed storage for the gateway: server config and workflow records (no database)."""
import json
import os
import time
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"
WORKFLOW_DIR = DATA_DIR / "workflows"
SERVER_FILE = DATA_DIR / "server.json"
BAILIAN_FILE = DATA_DIR / "bailian.json"
SAFE_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_., ")


def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def load_server() -> dict[str, str]:
    return _read(SERVER_FILE, {"url": "", "apiKey": ""})


def save_server(url: str, api_key: str | None) -> dict[str, str]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    current = load_server()
    config = {"url": url.strip().rstrip("/"), "apiKey": current.get("apiKey", "") if api_key is None else api_key.strip()}
    SERVER_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    return config


def load_bailian() -> dict[str, str]:
    """Bailian server config. The key falls back to env vars when the file has none — DASHSCOPE_API_KEY is what the
    official SDK (and the user's working sample script) reads, so both paths end up using the same credential."""
    config = _read(BAILIAN_FILE, None) or {}
    url = (config.get("url") or os.environ.get("BAILIAN_BASE_URL", "")).strip().rstrip("/") or "https://dashscope.aliyuncs.com"
    api_key = (config.get("apiKey") or "").strip() or os.environ.get("BAILIAN_API_KEY", "").strip() or os.environ.get("DASHSCOPE_API_KEY", "").strip()
    return {"url": url, "apiKey": api_key}


def save_bailian(url: str, api_key: str | None) -> dict[str, str]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # "Keep current" reads the file's own value only, so an env-fallback key is never frozen into the file.
    stored = _read(BAILIAN_FILE, None) or {}
    config = {"url": url.strip().rstrip("/"), "apiKey": (stored.get("apiKey") or "").strip() if api_key is None else api_key.strip()}
    BAILIAN_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    return load_bailian()


def _workflow_path(workflow_id: str) -> Path:
    safe = "".join(char for char in workflow_id if char in SAFE_CHARS).strip() or "workflow"
    return WORKFLOW_DIR / f"{safe}.json"


def list_workflows() -> list[dict[str, Any]]:
    if not WORKFLOW_DIR.exists():
        return []
    records = [_read(path, None) for path in sorted(WORKFLOW_DIR.glob("*.json"))]
    return [{key: value for key, value in record.items() if key != "apiJson"} for record in records if isinstance(record, dict)]


def get_workflow(workflow_id: str) -> dict[str, Any] | None:
    return _read(_workflow_path(workflow_id), None)


def save_workflow(record: dict[str, Any]) -> None:
    WORKFLOW_DIR.mkdir(parents=True, exist_ok=True)
    record["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    _workflow_path(record["id"]).write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")


def delete_workflow(workflow_id: str) -> bool:
    path = _workflow_path(workflow_id)
    if path.exists():
        path.unlink()
        return True
    return False
