import axios from "axios";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { decodeChannelModel, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type ComfyWorkflowSummary = {
    id: string;
    name: string;
    capability: ModelCapability;
    bindings: ComfyBinding[];
    candidates: Array<{ nodeId: string; classType: string; field: string; kind: "text" | "image" | "video" | "audio" | "number"; title?: string; sizeRole?: "width" | "height" | "" }>;
    imageTimeoutSeconds: number;
    videoTimeoutSeconds: number;
    pollIntervalSeconds: number;
};

export type ComfyBinding = {
    nodeId: string;
    classType: string;
    field: string;
    kind: "text" | "image" | "video" | "audio" | "number";
    sizeRole?: "width" | "height" | "";
    source: "prompt" | "image" | "video" | "audio" | "width" | "height" | "random" | "const" | "off";
    index?: number | null;
    value?: string | number | boolean | null;
};

/** Gateway base; empty means same-origin (behind the vite dev proxy or the docker nginx /api/* gateway route). */
export function gateway(gatewayUrl: string) {
    return gatewayUrl.trim().replace(/\/+$/, "");
}

function comfyText(key: string, options?: Record<string, unknown>) {
    return i18n.t(`comfyErrors.${key}`, options);
}

function comfyError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return new Error(comfyText("canceled"));
    if (axios.isAxiosError(error) && !error.response) return new Error(fallback);
    const detail = axios.isAxiosError(error) ? error.response?.data?.detail || error.message : String(error);
    return new Error(detail || fallback);
}

export async function getComfyServer(gatewayUrl: string) {
    try {
        const { data } = await axios.get<{ url: string; hasApiKey: boolean }>(`${gateway(gatewayUrl)}/api/comfy/server`);
        return data;
    } catch (error) {
        throw comfyError(error, comfyText("gatewayUnreachable"));
    }
}

export async function saveComfyServer(gatewayUrl: string, url: string, apiKey: string | null) {
    try {
        await axios.put(`${gateway(gatewayUrl)}/api/comfy/server`, { url, apiKey });
    } catch (error) {
        throw comfyError(error, comfyText("gatewayUnreachable"));
    }
}

export async function testComfyServer(gatewayUrl: string) {
    try {
        const { data } = await axios.post(`${gateway(gatewayUrl)}/api/comfy/server/test`);
        const devices: Array<Record<string, unknown>> = data?.devices || [];
        const gpu = devices.find((item) => item.name && item.name !== "cpu");
        return [data?.system?.comfyui_version && `ComfyUI ${data.system.comfyui_version}`, gpu?.name].filter(Boolean).join(" · ") || comfyText("serverReady");
    } catch (error) {
        throw comfyError(error, comfyText("serverUnreachable"));
    }
}

export async function fetchComfyWorkflows(gatewayUrl: string) {
    try {
        const { data } = await axios.get<ComfyWorkflowSummary[]>(`${gateway(gatewayUrl)}/api/comfy/workflows`);
        return data;
    } catch (error) {
        throw comfyError(error, comfyText("workflowListFailed"));
    }
}

export async function importComfyWorkflow(gatewayUrl: string, name: string, apiJson: Record<string, unknown>) {
    try {
        const { data } = await axios.post<ComfyWorkflowSummary>(`${gateway(gatewayUrl)}/api/comfy/workflows`, { name, apiJson });
        return data;
    } catch (error) {
        throw comfyError(error, comfyText("importFailed"));
    }
}

export async function updateComfyWorkflow(gatewayUrl: string, id: string, patch: { name?: string; bindings?: ComfyBinding[]; imageTimeoutSeconds?: number; videoTimeoutSeconds?: number; pollIntervalSeconds?: number }) {
    try {
        const { data } = await axios.put<ComfyWorkflowSummary>(`${gateway(gatewayUrl)}/api/comfy/workflows/${id}`, patch);
        return data;
    } catch (error) {
        throw comfyError(error, comfyText("updateFailed"));
    }
}

export async function deleteComfyWorkflow(gatewayUrl: string, id: string) {
    try {
        await axios.delete(`${gateway(gatewayUrl)}/api/comfy/workflows/${id}`);
    } catch (error) {
        throw comfyError(error, comfyText("deleteFailed"));
    }
}

async function uploadReference(gatewayUrl: string, file: File) {
    const form = new FormData();
    form.append("file", file);
    try {
        const { data } = await axios.post<{ name: string }>(`${gateway(gatewayUrl)}/api/comfy/upload`, form, { timeout: 180000 });
        return data.name;
    } catch (error) {
        throw comfyError(error, comfyText("uploadFailed"));
    }
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new DOMException("Aborted", "AbortError"))), { once: true });
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/** Upload references, submit the workflow, poll to completion and return every output file. */
export async function requestComfyOutputs(gatewayUrl: string, workflow: ComfyWorkflowSummary, prompt: string, references: ReferenceImage[], videos: File[] = [], audios: File[] = [], size?: { width: number; height: number }, options?: { signal?: AbortSignal }) {
    const base = gateway(gatewayUrl);
    const uploaded: string[] = [];
    for (const reference of references) {
        const file = await dataUrlToFile({ ...reference, dataUrl: await imageToDataUrl(reference) });
        uploaded.push(await uploadReference(base, file));
    }
    let videoName = "";
    for (const video of videos) {
        videoName = await uploadReference(base, video);
    }
    let audioName = "";
    for (const audio of audios) {
        audioName = await uploadReference(base, audio);
    }
    let task: { taskId: string; timeoutSeconds: number; pollIntervalSeconds: number };
    try {
        const { data } = await axios.post(`${base}/api/comfy/run`, { workflowId: workflow.id, prompt, images: uploaded, video: videoName, audio: audioName, width: size?.width || 0, height: size?.height || 0 }, { signal: options?.signal });
        task = data;
    } catch (error) {
        throw comfyError(error, comfyText("runFailed"));
    }
    const deadline = Date.now() + task.timeoutSeconds * 1000;
    for (;;) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let state: { status: string; outputs?: Array<{ subfolder: string; filename: string }>; error?: string };
        try {
            const { data } = await axios.get(`${base}/api/comfy/task/${task.taskId}`, { signal: options?.signal });
            state = data;
        } catch (error) {
            throw comfyError(error, comfyText("taskQueryFailed"));
        }
        if (state.status === "failed") throw new Error(state.error || comfyText("taskFailed"));
        if (state.status === "completed" && state.outputs?.length) {
            const blobs: Blob[] = [];
            for (const output of state.outputs) {
                try {
                    const { data } = await axios.get<Blob>(`${base}/api/comfy/output`, { params: { subfolder: output.subfolder, filename: output.filename }, responseType: "blob", signal: options?.signal });
                    blobs.push(data);
                } catch (error) {
                    throw comfyError(error, comfyText("outputDownloadFailed"));
                }
            }
            return blobs;
        }
        if (Date.now() >= deadline) throw new Error(comfyText("taskTimeout", { seconds: task.timeoutSeconds }));
        await sleep(task.pollIntervalSeconds * 1000, options?.signal);
    }
}

export async function requestComfyImages(gatewayUrl: string, workflow: ComfyWorkflowSummary, prompt: string, references: ReferenceImage[], size?: { width: number; height: number }, options?: { signal?: AbortSignal }) {
    assertWorkflowCapability(workflow, "image");
    const blobs = await requestComfyOutputs(gatewayUrl, workflow, prompt, references, [], [], size, options);
    return Promise.all(blobs.map(blobToDataUrl));
}

export async function requestComfyVideo(gatewayUrl: string, workflow: ComfyWorkflowSummary, prompt: string, references: ReferenceImage[], videos: File[] = [], audios: File[] = [], size?: { width: number; height: number }, options?: { signal?: AbortSignal }) {
    assertWorkflowCapability(workflow, "video");
    const blobs = await requestComfyOutputs(gatewayUrl, workflow, prompt, references, videos, audios, size, options);
    return blobs[0];
}

export async function requestComfyAudio(gatewayUrl: string, workflow: ComfyWorkflowSummary, prompt: string, audios: File[], options?: { signal?: AbortSignal }) {
    assertWorkflowCapability(workflow, "audio");
    const blobs = await requestComfyOutputs(gatewayUrl, workflow, prompt, [], [], audios, undefined, options);
    return blobs[0];
}

/** Guard the canvas slot against workflows of another type, e.g. an audio workflow picked as the video model. */
function assertWorkflowCapability(workflow: ComfyWorkflowSummary, want: ModelCapability) {
    if (workflow.capability !== want) throw new Error(comfyText("wrongCapability", { actual: i18n.t(`comfy.capability.${workflow.capability}`), want: i18n.t(`comfy.capability.${want}`) }));
}

/** Load a canvas-connected audio/video reference (local storage key or URL) into a File for gateway upload. */
export async function referenceMediaFile(item: { name: string; type?: string; url?: string; storageKey?: string }, fallbackName: string, errorKey: string, options?: { signal?: AbortSignal }) {
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(i18n.t(`apiErrors.${errorKey}`));
        try {
            blob = await (await fetch(url, { signal: options?.signal })).blob();
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            throw new Error(i18n.t(`apiErrors.${errorKey}`));
        }
    }
    if (!blob.size) throw new Error(i18n.t(`apiErrors.${errorKey}`));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}

/** Resolve the workflow behind a `channelId::workflowId` model value when its channel uses the comfyui format; null for other channels. */
export async function resolveComfyModel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const channel = config.channels.find((item) => item.id === decoded?.channelId);
    if (!decoded || channel?.apiFormat !== "comfyui") return null;
    const workflows = await fetchComfyWorkflows(channel.baseUrl);
    const workflow = workflows.find((item) => item.id === decoded.model);
    if (!workflow) throw new Error(comfyText("workflowMissing"));
    return { gatewayUrl: channel.baseUrl, workflow };
}
