"""Thin async client for one ComfyUI server plus workflow scanning/injection helpers.

The gateway is the only place that knows the ComfyUI address and credentials.
"""
import copy
import random
import uuid
from typing import Any

import httpx

# class_type -> (field, kind) for nodes auto-detected as editable inputs.
TEXT_NODES = {
    "CLIPTextEncode": ("text", "text"),
    "PrimitiveStringMultiline": ("value", "text"),
    "PrimitiveString": ("value", "text"),
    "String": ("value", "text"),
    "CR Prompt Text": ("prompt", "text"),
}
IMAGE_NODES = {"LoadImage": "image", "LoadImageMask": "image"}
VIDEO_NODES = {"VHS_LoadVideo": "video", "LoadVideo": "video"}
AUDIO_NODES = {"LoadAudio": "audio", "VHS_LoadAudio": "audio", "AudioLoader": "audio"}
# Int-valued nodes that workflows use to drive width/height; the canvas size setting can bind them.
NUMBER_NODES = {"PrimitiveInt": "value", "Int Literal": "int", "INTConstant": "value", "ComfyIntPrimitive|PrimitiveInt": "value"}
IMAGE_OUTPUTS = {"SaveImage", "SaveAnimatedWEBP", "SaveAnimatedPNG"}
VIDEO_OUTPUTS = {"VHS_VideoCombine", "SaveVideo", "CreateVideo", "SaveWEBM"}
AUDIO_OUTPUTS = {"SaveAudio", "SaveAudioFLAC"}


class ComfyError(Exception):
    """User-facing gateway/comfy failure with a stable code and optional detail."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def _base(server: dict[str, str]) -> str:
    return (server.get("url") or "").strip().rstrip("/")


def _headers(server: dict[str, str]) -> dict[str, str]:
    key = (server.get("apiKey") or "").strip()
    return {"Authorization": f"Bearer {key}"} if key else {}


def require_server(server: dict[str, str]) -> None:
    if not _base(server):
        raise ComfyError("comfy_not_configured", "请先在渠道里填写并保存 ComfyUI 服务器地址")


async def test_server(server: dict[str, str]) -> dict[str, Any]:
    require_server(server)
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(f"{_base(server)}/api/system_stats", headers=_headers(server))
    if response.status_code in (401, 403):
        raise ComfyError("comfy_auth_failed")
    if response.status_code >= 400:
        raise ComfyError("comfy_unreachable", f"HTTP {response.status_code}")
    return response.json()


async def upload_media(server: dict[str, str], content: bytes, filename: str, subfolder: str = "", overwrite: bool = True) -> dict[str, str]:
    require_server(server)
    data: dict[str, str] = {"type": "input", "overwrite": "true" if overwrite else "false"}
    if subfolder:
        data["subfolder"] = subfolder
    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(
            f"{_base(server)}/api/upload/image",
            headers=_headers(server),
            data=data,
            files={"image": (filename, content, "application/octet-stream")},
        )
    if response.status_code >= 400:
        raise ComfyError("comfy_upload_failed", response.text[:300])
    payload = response.json()
    return {"name": payload.get("name", filename), "subfolder": payload.get("subfolder", subfolder)}


async def submit_prompt(server: dict[str, str], workflow: dict[str, Any], prompt_text: str, images: list[str], video: str, width: int = 0, height: int = 0, audio: str = "") -> str:
    require_server(server)
    injected = inject(workflow["apiJson"], workflow["bindings"], prompt_text, images, video, width, height, audio)
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(f"{_base(server)}/api/prompt", headers=_headers(server), json={"prompt": injected, "client_id": uuid.uuid4().hex})
    if response.status_code >= 400:
        raise ComfyError("comfy_rejected", response.text[:400])
    payload = response.json()
    if payload.get("error") or payload.get("node_errors"):
        raise ComfyError("comfy_node_errors", str(payload)[:400])
    return payload["prompt_id"]


async def task_status(server: dict[str, str], task_id: str) -> dict[str, Any]:
    require_server(server)
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(f"{_base(server)}/api/history/{task_id}", headers=_headers(server))
    if response.status_code == 404:
        return {"status": "running"}
    response.raise_for_status()
    entry = response.json().get(task_id)
    if not entry:
        return {"status": "running"}
    if entry.get("status", {}).get("status") == "error":
        return {"status": "failed", "error": _history_error(entry)}
    outputs = _flatten_outputs(entry.get("outputs", {}))
    if not outputs:
        return {"status": "failed", "error": "工作流已完成但没有输出文件"}
    return {"status": "completed", "outputs": outputs}


def _flatten_outputs(outputs: dict[str, Any]) -> list[dict[str, str]]:
    items = []
    # History outputs are grouped per node: {nodeId: {"images": [...], "audio": [...], "video": [...], "gifs": [...]}}.
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for group in ("images", "video", "gifs", "audio"):
            for item in node_output.get(group) or []:
                if item.get("filename"):
                    items.append({"subfolder": item.get("subfolder", ""), "filename": item["filename"]})
    return items


def _history_error(entry: dict[str, Any]) -> str:
    for message in entry.get("status", {}).get("messages") or []:
        if isinstance(message, list) and message and message[0] == "execution_error":
            detail = message[1] if len(message) > 1 else {}
            return str(detail.get("exception_message") or detail)[:300]
    return "comfy_task_failed"


async def view_file(server: dict[str, str], subfolder: str, filename: str) -> tuple[bytes, str]:
    require_server(server)
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.get(
            f"{_base(server)}/api/view",
            headers=_headers(server),
            params={"type": "output", "filename": filename, "subfolder": subfolder},
        )
    response.raise_for_status()
    return response.content, response.headers.get("content-type", "application/octet-stream")


# ---- workflow scanning and injection (pure) ----

def scan_workflow(api_json: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(api_json, dict) or not api_json or not all(isinstance(node, dict) and node.get("class_type") for node in api_json.values()):
        raise ComfyError("not_api_workflow")
    capability = "image"
    output_nodes: list[str] = []
    candidates: list[dict[str, Any]] = []
    has_video_output = False
    has_audio_output = False
    for node_id, node in api_json.items():
        class_type = str(node.get("class_type"))
        inputs = node.get("inputs") or {}
        if class_type in IMAGE_OUTPUTS or class_type in VIDEO_OUTPUTS or class_type in AUDIO_OUTPUTS:
            output_nodes.append(node_id)
            has_video_output = has_video_output or class_type in VIDEO_OUTPUTS
            has_audio_output = has_audio_output or class_type in AUDIO_OUTPUTS
        for field, kind in _editable_fields(class_type, inputs):
            if isinstance(inputs.get(field), list):
                continue  # value comes from a link, not editable
            candidate = {"nodeId": node_id, "classType": class_type, "field": field, "kind": kind, "title": str(node.get("_meta", {}).get("title", ""))}
            if kind == "number":
                candidate["sizeRole"] = _trace_size_role(api_json, node_id)
            candidates.append(candidate)
    if not output_nodes:
        raise ComfyError("no_output_node")
    if has_video_output:
        capability = "video"
    elif has_audio_output:
        capability = "audio"
    return {"capability": capability, "candidates": candidates, "outputNodes": output_nodes}


def _trace_size_role(api_json: dict[str, Any], node_id: str, seen: set[str] | None = None, depth: int = 0) -> str:
    """Follow output links until some node consumes this value under a width/height field (flux2 routes Int Literal through PrimitiveInt)."""
    if seen is None:
        seen = set()
    if node_id in seen or depth > 6:
        return ""
    seen.add(node_id)
    for consumer_id, consumer in api_json.items():
        for field, value in (consumer.get("inputs") or {}).items():
            if not (isinstance(value, list) and value and str(value[0]) == node_id):
                continue
            if field == "width":
                return "width"
            if field == "height":
                return "height"
            role = _trace_size_role(api_json, consumer_id, seen, depth + 1)
            if role:
                return role
    return ""


def _editable_fields(class_type: str, inputs: dict[str, Any]) -> list[tuple[str, str]]:
    if class_type in TEXT_NODES:
        field, kind = TEXT_NODES[class_type]
        return [(field, kind)] if field in inputs else []
    if class_type in IMAGE_NODES:
        return [("image", "image")] if "image" in inputs else []
    if class_type in VIDEO_NODES:
        return [("video", "video")] if "video" in inputs else []
    if class_type in AUDIO_NODES:
        field = AUDIO_NODES[class_type]
        return [(field, "audio")] if field in inputs else []
    if class_type in NUMBER_NODES:
        field = NUMBER_NODES[class_type]
        return [(field, "number")] if field in inputs else []
    return []


def default_bindings(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """First text binds the canvas prompt, images bind reference images in order, audio binds the canvas reference audio, width/height numbers bind the canvas size; the rest stay unbound."""
    bindings, image_index, used_prompt, used_audio, used_size = [], 0, False, False, {"width": False, "height": False}
    for candidate in candidates:
        source, index, value = "off", None, None
        if candidate["kind"] == "text" and not used_prompt:
            source, used_prompt = "prompt", True
        elif candidate["kind"] == "image":
            source, index = "image", image_index
            image_index += 1
        elif candidate["kind"] == "video":
            source = "video"
        elif candidate["kind"] == "audio" and not used_audio:
            source, used_audio = "audio", True
        elif candidate["kind"] == "number" and candidate.get("sizeRole") in used_size and not used_size[candidate["sizeRole"]]:
            source, used_size[candidate["sizeRole"]] = candidate["sizeRole"], True
        bindings.append({**candidate, "source": source, "index": index, "value": value})
    return bindings


def inject(api_json: dict[str, Any], bindings: list[dict[str, Any]], prompt_text: str, images: list[str], video: str, width: int = 0, height: int = 0, audio: str = "") -> dict[str, Any]:
    prompt = copy.deepcopy(api_json)
    for binding in bindings:
        if binding.get("source") == "off":
            continue
        node = prompt.get(str(binding.get("nodeId")))
        if not node:
            continue
        inputs = node.setdefault("inputs", {})
        field = binding["field"]
        source = binding.get("source")
        if source == "prompt":
            inputs[field] = prompt_text
        elif source == "image":
            index = int(binding.get("index") or 0)
            if index < len(images):
                inputs[field] = images[index]
        elif source == "video":
            if video:
                inputs[field] = video
        elif source == "audio":
            if audio:
                inputs[field] = audio
        elif source == "width":
            if width:
                inputs[field] = width
        elif source == "height":
            if height:
                inputs[field] = height
        elif source == "random":
            # Keep inside the smallest seed range nodes validate against (0 ~ 2**32-1).
            inputs[field] = random.randint(0, 2**32 - 1)
        elif source == "const":
            inputs[field] = binding.get("value")
    return prompt
