"""Client for one Alibaba Cloud Bailian (DashScope) server.

Only video generation (wan3.0) is wired here; the gateway is the single place that
knows the DashScope address and API key, and it proxies the result download because
the returned OSS url is short-lived and not readable from the browser cross-origin.
"""
import asyncio
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com"
# Media limits from the wan3.0 docs; the canvas rejects over-limit input before uploading.
MAX_REFERENCE_IMAGES = 10
MAX_REFERENCE_VIDEO_AUDIO = 5
MAX_TOTAL_MEDIA = 20
# 视觉对话（compatible-mode）一次带多帧图片，上游响应较慢，给足整体超时；超时后前端按失败处理。
CHAT_TIMEOUT_SECONDS = 300
# 网关本机 ffmpeg 处理（裁剪参考片段、回贴原声）的超时与输出帧率。
FFMPEG_TIMEOUT_SECONDS = 300
FFMPEG_OUTPUT_FPS = 30
MEDIA_TYPES = {"first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"}


class BailianError(Exception):
    """User-facing gateway/bailian failure with a stable code and optional detail."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def validate_media(media: list[dict[str, str]]) -> None:
    """Re-check the wan3.0 media rules the canvas already enforces, before spending an API call."""
    if len(media) > MAX_TOTAL_MEDIA:
        raise BailianError("bailian_too_many_media", f"参考素材总数不能超过 {MAX_TOTAL_MEDIA} 个")
    counts: dict[str, int] = {}
    for item in media:
        media_type = str(item.get("type") or "")
        if media_type not in MEDIA_TYPES:
            raise BailianError("bailian_bad_media_type", f"不支持的素材类型: {media_type}")
        counts[media_type] = counts.get(media_type, 0) + 1
    if counts.get("first_frame", 0) > 1 or counts.get("last_frame", 0) > 1:
        raise BailianError("bailian_bad_media_type", "首帧/尾帧图像最多各 1 张")
    if (counts.get("first_frame", 0) or counts.get("last_frame", 0)) and any(counts.get(key) for key in ("reference_image", "reference_video", "reference_audio")):
        raise BailianError("bailian_bad_media_type", "首尾帧与参考素材不能混用")
    if counts.get("reference_image", 0) > MAX_REFERENCE_IMAGES:
        raise BailianError("bailian_bad_media_type", f"参考图片最多 {MAX_REFERENCE_IMAGES} 张")
    if counts.get("reference_video", 0) > MAX_REFERENCE_VIDEO_AUDIO or counts.get("reference_audio", 0) > MAX_REFERENCE_VIDEO_AUDIO:
        raise BailianError("bailian_bad_media_type", f"参考视频/音频最多各 {MAX_REFERENCE_VIDEO_AUDIO} 段")


def _base(server: dict[str, str]) -> str:
    # Accept bare host, SDK-style ".../api/v1" and OpenAI-compatible ".../compatible-mode/v1" spellings without doubling the prefix.
    url = (server.get("url") or DEFAULT_BASE_URL).strip().rstrip("/")
    for suffix in ("/compatible-mode/v1", "/api/v1"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
    return url or DEFAULT_BASE_URL


def _clean_key(server: dict[str, str]) -> str:
    """Strip an accidental leading "Bearer " and any clipboard whitespace/newlines from the stored key."""
    key = re.sub(r"^Bearer\s+", "", (server.get("apiKey") or "").strip(), flags=re.I)
    return "".join(key.split())


def _headers(server: dict[str, str]) -> dict[str, str]:
    key = _clean_key(server)
    if not key:
        raise BailianError("bailian_not_configured", "请先在渠道里填写并保存百炼 API Key")
    return {"Authorization": f"Bearer {key}"}


def mask_api_key(raw: str) -> dict[str, Any]:
    """Non-secret view of the stored key so the UI can show which key the gateway actually holds."""
    key = _clean_key({"apiKey": raw})
    preview = f"{key[:4]}…{key[-2:]}（{len(key)} 位）" if len(key) > 8 else (f"（{len(key)} 位）" if key else "")
    return {"hasApiKey": bool(key), "keyPreview": preview, "keyWasCleaned": bool(raw) and raw != key}


AUTH_ERROR_CODES = ("InvalidApiKey", "InvalidApiToken", "InvalidAuthentication", "NotAuthorize", "AccessDenied")


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        parsed = response.json()
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _is_auth_error(status_code: int, code: str) -> bool:
    return status_code in (401, 403) or code in AUTH_ERROR_CODES


def _dashscope_error(payload: dict[str, Any], response: httpx.Response) -> str:
    """Surface DashScope's own code/message so users can match the error code docs instead of a generic failure.

    The OpenAI-compatible endpoint nests the same fields under "error", so read both shapes.
    """
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    parts = [str(payload.get("code") or error.get("code") or error.get("type") or ""), str(payload.get("message") or error.get("message") or "")]
    parts = [p for p in parts if p] or [f"HTTP {response.status_code}"]
    request_id = str(payload.get("request_id") or "")
    if request_id:
        parts.append(f"request_id={request_id}")
    return "百炼返回：" + " | ".join(parts)


async def test_server(server: dict[str, str]) -> dict[str, Any]:
    """Probe the native /api/v1 path with a random nonexistent task id: free, and the same auth + base URL the real calls use.

    A task-not-found response (any status) proves the endpoint and API key are valid; only an auth status or a
    non-DashScope reply (wrong base URL, captive portal) counts as a failure, so a passing test means generation works.
    """
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            response = await client.get(f"{_base(server)}/api/v1/tasks/{uuid.uuid4().hex}", headers=_headers(server))
    except httpx.HTTPError as error:
        raise BailianError("bailian_unreachable", str(error)[:200])
    payload = _json_object(response)
    code = str(payload.get("code") or "")
    if _is_auth_error(response.status_code, code):
        raise BailianError("bailian_auth_failed", _dashscope_error(payload, response))
    # A well-formed DashScope body (request_id / output / code) means the URL and key reached the real API.
    if not any(key in payload for key in ("request_id", "output", "code")):
        raise BailianError("bailian_unreachable", f"HTTP {response.status_code}")
    return {"reachable": True}


async def upload_media(server: dict[str, str], content: bytes, filename: str, model: str) -> str:
    """Two-step temp upload: getPolicy, then an OSS form POST; returns an oss:// url valid 48h."""
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename) or "input.bin"
    async with httpx.AsyncClient(timeout=60) as client:
        policy_response = await client.get(
            f"{_base(server)}/api/v1/uploads",
            headers={**_headers(server), "Content-Type": "application/json"},
            params={"action": "getPolicy", "model": model},
        )
    if policy_response.status_code >= 400:
        raise BailianError("bailian_upload_failed", policy_response.text[:300])
    data = (policy_response.json() or {}).get("data") or {}
    required = ("policy", "signature", "upload_dir", "upload_host", "oss_access_key_id", "x_oss_object_acl", "x_oss_forbid_overwrite")
    if not all(data.get(field) is not None for field in required):
        raise BailianError("bailian_upload_failed", str(policy_response.json())[:300])
    if data.get("max_file_size_mb") and len(content) > int(data["max_file_size_mb"]) * 1024 * 1024:
        raise BailianError("bailian_file_too_large", f"素材超过 {data['max_file_size_mb']}MB 限制")
    key = f"{data['upload_dir']}/{uuid.uuid4().hex[:8]}_{safe_name}"
    form = {
        "OSSAccessKeyId": data["oss_access_key_id"],
        "policy": data["policy"],
        "Signature": data["signature"],
        "key": key,
        "x-oss-object-acl": data["x_oss_object_acl"],
        "x-oss-forbid-overwrite": data["x_oss_forbid_overwrite"],
        "success_action_status": "200",
    }
    async with httpx.AsyncClient(timeout=300) as client:
        upload_response = await client.post(data["upload_host"], data=form, files={"file": (safe_name, content, "application/octet-stream")})
    if upload_response.status_code >= 400:
        raise BailianError("bailian_upload_failed", upload_response.text[:300])
    return f"oss://{key}"


async def create_video_task(server: dict[str, str], model: str, prompt: str, media: list[dict[str, str]], parameters: dict[str, Any]) -> str:
    if not prompt.strip() and not media:
        raise BailianError("bailian_empty_input", "提示词和参考素材至少填写一项")
    validate_media(media)
    body: dict[str, Any] = {"model": model, "input": {"prompt": prompt}}
    if media:
        body["input"]["media"] = media
    if parameters:
        body["parameters"] = parameters
    headers = {**_headers(server), "Content-Type": "application/json", "X-DashScope-Async": "enable"}
    if any(str(item.get("url", "")).startswith("oss://") for item in media):
        headers["X-DashScope-OssResourceResolve"] = "enable"
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(f"{_base(server)}/api/v1/services/aigc/video-generation/video-synthesis", headers=headers, json=body)
    payload = _json_object(response)
    code = str(payload.get("code") or "")
    if _is_auth_error(response.status_code, code):
        raise BailianError("bailian_auth_failed", _dashscope_error(payload, response))
    if response.status_code >= 400 or code:
        raise BailianError("bailian_rejected", _dashscope_error(payload, response))
    task_id = (payload.get("output") or {}).get("task_id")
    if not task_id:
        raise BailianError("bailian_no_task_id", str(payload)[:300])
    return task_id


async def task_status(server: dict[str, str], task_id: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(f"{_base(server)}/api/v1/tasks/{task_id}", headers=_headers(server))
    if response.status_code == 404:
        return {"status": "running"}
    payload = _json_object(response)
    code = str(payload.get("code") or "")
    if _is_auth_error(response.status_code, code):
        raise BailianError("bailian_auth_failed", _dashscope_error(payload, response))
    if response.status_code >= 400:
        raise BailianError("bailian_task_query_failed", _dashscope_error(payload, response))
    output = payload.get("output") or {}
    status = output.get("task_status") or payload.get("code")
    if status in ("PENDING", "RUNNING"):
        return {"status": "running"}
    if status == "SUCCEEDED":
        video_url = output.get("video_url") or ""
        if not video_url:
            return {"status": "failed", "error": "任务成功但没有视频链接"}
        return {"status": "completed", "videoUrl": video_url}
    if status in ("FAILED", "CANCELED", "UNKNOWN"):
        return {"status": "failed", "error": str(output.get("message") or payload.get("message") or status)[:300]}
    return {"status": "failed", "error": str(payload)[:300]}


async def chat_completions(server: dict[str, str], payload: dict[str, Any]) -> tuple[str, Any]:
    """Proxy the OpenAI-compatible chat endpoint (vision models like qwen flash) and stream the body through.

    DashScope reports a bad key or an over-limit image as JSON before the stream starts, so that surfaces as a plain 400.
    """
    client = httpx.AsyncClient(timeout=CHAT_TIMEOUT_SECONDS)
    try:
        response = await client.send(
            client.build_request(
                "POST",
                f"{_base(server)}/compatible-mode/v1/chat/completions",
                headers={**_headers(server), "Content-Type": "application/json"},
                json=payload,
            ),
            stream=True,
        )
    except httpx.HTTPError as error:
        await client.aclose()
        raise BailianError("bailian_unreachable", str(error)[:200]) from error
    if response.status_code >= 400:
        await response.aread()
        detail = _json_object(response)
        await response.aclose()
        await client.aclose()
        code = str(detail.get("code") or "")
        raise BailianError("bailian_auth_failed" if _is_auth_error(response.status_code, code) else "bailian_rejected", _dashscope_error(detail, response))

    async def stream():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return response.headers.get("content-type", "application/json"), stream()


def _ffmpeg_exe() -> str:
    exe = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or ""
    if not exe:
        raise BailianError("bailian_ffmpeg_missing", "网关未找到 ffmpeg，无法裁剪参考视频或回贴原声；请安装 ffmpeg 或在网关环境设置 FFMPEG_PATH")
    return exe


def _run_ffmpeg(args: list[str]) -> None:
    # 输出写到临时文件而不是管道：mp4 需要回填 moov，非 seekable 输出会直接失败。
    completed = subprocess.run([_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True, timeout=FFMPEG_TIMEOUT_SECONDS)
    if completed.returncode:
        detail = completed.stderr.decode("utf-8", "ignore").strip()
        raise BailianError("bailian_ffmpeg_failed", detail[-300:] or "ffmpeg 处理失败")


async def trim_video(content: bytes, start: float, end: float) -> bytes:
    """Cut [start,end] out of an uploaded video and re-encode it to the mp4 wan3.0 reference_video requires."""
    source = max(0.0, start)
    duration = max(0.1, end - source)
    with tempfile.TemporaryDirectory() as workdir:
        path = Path(workdir) / "source"
        path.write_bytes(content)
        output = Path(workdir) / "clip.mp4"
        await asyncio.to_thread(
            _run_ffmpeg,
            [
                "-ss",
                f"{source:.2f}",
                "-t",
                f"{duration:.2f}",
                "-i",
                str(path),
                # 参考视频要求单边不超过 4096、帧率不低于 16，重编码时一并归一。
                "-vf",
                "scale='if(gt(iw,4096),4096,iw)':'if(gt(ih,4096),4096,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
                "-r",
                str(FFMPEG_OUTPUT_FPS),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(output),
            ],
        )
        return output.read_bytes()


async def mux_audio(result: bytes, source_video: bytes, start: float, end: float) -> bytes:
    """Put the original clip soundtrack back onto the generated video; equal lengths keep it in sync."""
    source = max(0.0, start)
    duration = max(0.1, end - source)
    with tempfile.TemporaryDirectory() as workdir:
        result_path = Path(workdir) / "result.mp4"
        source_path = Path(workdir) / "source.mp4"
        result_path.write_bytes(result)
        source_path.write_bytes(source_video)
        try:
            output = Path(workdir) / "muxed.mp4"
            await asyncio.to_thread(
                _run_ffmpeg,
                [
                    "-i",
                    str(result_path),
                    "-ss",
                    f"{source:.2f}",
                    "-t",
                    f"{duration:.2f}",
                    "-i",
                    str(source_path),
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(output),
                ],
            )
            return output.read_bytes()
        except BailianError as error:
            if "does not match any stream" in error.detail or "Stream map" in error.detail:
                raise BailianError("bailian_audio_missing", "原视频片段里没有可回贴的音轨，请改用「无音频」或换一个带声音的片段") from error
            raise


async def cancel_task(server: dict[str, str], task_id: str) -> str:
    """Cancel a queued async task so a mistaken request stops spending quota.

    DashScope only cancels tasks that have not started generating; a running task still answers with an error, which the caller treats as "already too late".
    """
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.delete(f"{_base(server)}/api/v1/tasks/{task_id}", headers=_headers(server))
    payload = _json_object(response)
    code = str(payload.get("code") or "")
    if _is_auth_error(response.status_code, code):
        raise BailianError("bailian_auth_failed", _dashscope_error(payload, response))
    if response.status_code >= 400:
        raise BailianError("bailian_task_cancel_failed", _dashscope_error(payload, response))
    return str((payload.get("output") or {}).get("task_status") or payload.get("code") or "")


async def download_result(url: str) -> tuple[bytes, str]:
    """Proxy the result download; only Aliyun hosts are allowed to avoid SSRF."""
    host = urlparse(url).hostname or ""
    if not host.endswith(".aliyuncs.com"):
        raise BailianError("bailian_bad_result_url", "结果地址不是可信的阿里云域名")
    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
        response = await client.get(url)
    response.raise_for_status()
    return response.content, response.headers.get("content-type", "video/mp4")
