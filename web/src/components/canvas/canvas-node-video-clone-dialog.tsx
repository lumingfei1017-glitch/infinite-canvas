import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App, Button, Input, InputNumber, Modal, Segmented, Select, Slider, Steps, Upload as ImageUpload } from "antd";
import { Check, Clapperboard, Layers, Sparkles, Upload as UploadIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetPickerModal } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { videoResolutionOptions, videoSizeOptions } from "@/components/video-settings-panel";
import { VIDEO_CLONE_SYSTEM_PROMPT } from "@/constant/video-clone-prompt";
import { CLIP_MAX_SECONDS, OUTPUT_MIN_SECONDS, clampClipRange, formatClipTime, maxOutputSeconds, splitVideoSegments } from "@/lib/canvas/canvas-video-clone";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { extractVideoFramesForAnalysis } from "@/lib/vision-input";
import { imageToDataUrl } from "@/services/image-storage";
import { requestImageQuestion } from "@/services/api/image";
import { encodeChannelModel, resolveModelRequestConfig, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasVideoCloneMaterial = { nodeId?: string; name: string; dataUrl?: string; storageKey?: string; previewUrl?: string };
export type CanvasVideoClonePayload = {
    prompt: string;
    materials: CanvasVideoCloneMaterial[];
    segments: Array<{ start: number; end: number }>;
    videoModel: string;
    seconds: string;
    followClip: boolean;
    vquality: string;
    size: string;
    sourceAudio: boolean;
};

type Props = {
    node: CanvasNodeData | null;
    materials: CanvasVideoCloneMaterial[];
    open: boolean;
    onClose: () => void;
    onSubmit: (payload: CanvasVideoClonePayload) => void;
};

// 一次分析最多送这么多帧，多段时按段数分摊，防止请求体超过百炼 DashScope 域名的 16MiB 上限。
const ANALYSIS_FRAME_BUDGET = 24;

/** 视频复刻向导：分段截取原视频 → 复用/补充替换素材 → AI 扩写编辑提示词 → 一次生成多段复刻视频。 */
export function CanvasNodeVideoCloneDialog({ node, materials: linkedMaterials, open, onClose, onSubmit }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const [step, setStep] = useState(0);
    const [segments, setSegments] = useState<Array<{ start: number; end: number }>>([]);
    const [resolution, setResolution] = useState("720");
    const [ratio, setRatio] = useState("9:16");
    const [followClip, setFollowClip] = useState(true);
    const [seconds, setSeconds] = useState(10);
    const [sourceAudio, setSourceAudio] = useState(true);
    const [materials, setMaterials] = useState<CanvasVideoCloneMaterial[]>([]);
    const [excluded, setExcluded] = useState<string[]>([]);
    const [requirement, setRequirement] = useState("");
    const [analyzeModel, setAnalyzeModel] = useState("");
    const [videoModel, setVideoModel] = useState("");
    const [prompt, setPrompt] = useState("");
    const [analyzing, setAnalyzing] = useState(false);
    const analyzeAbort = useRef<AbortController | null>(null);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);

    const duration = (node?.metadata?.durationMs || 0) / 1000;
    const longest = segments.reduce((max, segment) => Math.max(max, segment.end - segment.start), 0);
    const outputLimit = maxOutputSeconds(longest);
    const selectedMaterials = useMemo(() => materials.filter((material) => !excluded.includes(materialKey(material))), [excluded, materials]);
    const materialNumbers = useMemo(() => new Map(selectedMaterials.map((material, index) => [materialKey(material), index + 1])), [selectedMaterials]);

    useEffect(() => {
        if (!open || !node) return;
        const total = (node.metadata?.durationMs || 0) / 1000;
        setStep(0);
        setSegments(splitVideoSegments(total));
        setResolution("720");
        setRatio("9:16");
        setFollowClip(true);
        setSeconds(10);
        setSourceAudio(true);
        setMaterials(linkedMaterials);
        setExcluded([]);
        setRequirement("");
        setPrompt("");
        setAnalyzeModel(defaultAnalyzeModel(config));
        setVideoModel(config.videoModel);
        // 只在打开或换节点时重置，config 变化不能把填了一半的向导清空。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node?.id, open]);

    const updateSegment = (index: number, range: { start: number; end: number }) => {
        setSegments((current) => current.map((segment, position) => (position === index ? clampClipRange(range.start, range.end, duration) : segment)));
    };

    const addMaterials = async (files: File[]) => {
        const read = await Promise.all(files.map(async (file) => ({ name: file.name, dataUrl: await readFileAsDataUrl(file) })));
        setMaterials((current) => [...current, ...read]);
    };

    const analyze = async () => {
        if (!node?.metadata?.content) return message.warning(t("canvas.videoClone.emptySource"));
        setAnalyzing(true);
        setPrompt("");
        const controller = new AbortController();
        analyzeAbort.current = controller;
        try {
            const maxFrames = Math.max(4, Math.floor(ANALYSIS_FRAME_BUDGET / Math.max(1, segments.length)));
            const samples = await Promise.all(segments.map((segment) => extractVideoFramesForAnalysis(referenceVideoFromNode(node), { range: { start: segment.start, end: segment.end }, maxFrames })));
            const frames = samples.flatMap((sample) => sample.frames);
            const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
                {
                    type: "text",
                    text: t("canvas.videoClone.materialLegend", {
                        segments: segments.map((segment) => `${formatClipTime(segment.start)}-${formatClipTime(segment.end)}`).join("、"),
                        clip: longest.toFixed(1),
                        seconds: followClip ? t("canvas.videoClone.followClip") : `${seconds}s`,
                        ratio,
                        resolution: `${resolution}p`,
                        audio: sourceAudio ? t("canvas.videoClone.audioOriginal") : t("canvas.videoClone.audioSilent"),
                        frames: frames.length,
                        images: selectedMaterials.length ? selectedMaterials.map((_, index) => `图${index + 1}`).join("、") : t("canvas.videoClone.noImages"),
                    }),
                },
            ];
            frames.forEach((frame, index) => {
                content.push({ type: "text", text: t("canvas.videoClone.frameLabel", { index: index + 1, time: formatClipTime(frame.time) }) });
                content.push({ type: "image_url", image_url: { url: frame.dataUrl } });
            });
            const materialUrls = await Promise.all(
                selectedMaterials.map((material) => imageToDataUrl({ dataUrl: material.dataUrl, storageKey: material.storageKey, url: material.previewUrl }, { signal: controller.signal })),
            );
            materialUrls.forEach((url, index) => {
                content.push({ type: "text", text: `图${index + 1}` });
                content.push({ type: "image_url", image_url: { url } });
            });
            content.push({ type: "text", text: `${t("canvas.videoClone.requirementTitle")}：${requirement.trim() || t("canvas.videoClone.requirementFallback")}` });
            const answer = await requestImageQuestion(
                { ...resolveModelRequestConfig(config, analyzeModel), systemPrompt: VIDEO_CLONE_SYSTEM_PROMPT },
                [{ role: "user", content }],
                setPrompt,
                { signal: controller.signal, stream: false },
            );
            setPrompt(answer);
        } catch (error) {
            if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : t("canvas.videoClone.analyzeFailed"));
        } finally {
            analyzeAbort.current = null;
            setAnalyzing(false);
        }
    };

    const submit = () => {
        if (!prompt.trim()) return message.warning(t("canvas.videoClone.promptRequired"));
        if (!segments.length) return message.warning(t("canvas.videoClone.segmentRequired"));
        onSubmit({
            prompt: prompt.trim(),
            materials: selectedMaterials,
            segments,
            videoModel,
            seconds: String(Math.min(seconds, outputLimit)),
            followClip,
            vquality: resolution,
            size: ratio,
            sourceAudio,
        });
    };

    return (
        <Modal
            title={<span className="inline-flex items-center gap-2 text-base font-semibold"><Clapperboard className="size-4" />{t("canvas.videoClone.title")}</span>}
            open={open && Boolean(node)}
            onCancel={() => (analyzeAbort.current?.abort(), onClose())}
            footer={null}
            width={960}
            centered
            destroyOnHidden
        >
            <Steps size="small" className="!my-5" current={step} items={[t("canvas.videoClone.stepParams"), t("canvas.videoClone.stepMaterials"), t("canvas.videoClone.stepAnalyze"), t("canvas.videoClone.stepConfirm")].map((title) => ({ title }))} />
            {step === 0 ? (
                <div className="space-y-5">
                    <div className="grid gap-5 md:grid-cols-[300px_1fr]">
                        <video src={node?.metadata?.content} controls muted playsInline className="max-h-[300px] w-full rounded-lg bg-black/80 object-contain" />
                        <div className="space-y-4">
                            <Field
                                label={t("canvas.videoClone.segments")}
                                hint={t("canvas.videoClone.segmentsHint", { max: CLIP_MAX_SECONDS, min: OUTPUT_MIN_SECONDS, limit: outputLimit, total: duration ? duration.toFixed(1) : "-" })}
                                action={
                                    <Button size="small" icon={<Layers className="size-3.5" />} onClick={() => setSegments(splitVideoSegments(duration))}>
                                        {t("canvas.videoClone.autoSplit")}
                                    </Button>
                                }
                            >
                                <div className="space-y-2">
                                    {segments.map((segment, index) => (
                                        <div key={`${segment.start}-${segment.end}-${index}`} className="flex items-center gap-2">
                                            <span className="w-12 shrink-0 text-xs opacity-70">#{index + 1}</span>
                                            <InputNumber size="small" className="w-24" min={0} max={Math.max(0, duration)} step={0.1} value={segment.start} onChange={(value) => updateSegment(index, { start: Number(value ?? 0), end: segment.end })} />
                                            <span className="opacity-50">-</span>
                                            <InputNumber size="small" className="w-24" min={0} max={Math.max(0, duration)} step={0.1} value={segment.end} onChange={(value) => updateSegment(index, { start: segment.start, end: Number(value ?? 0) })} />
                                            <span className="w-16 shrink-0 text-xs opacity-70">{(segment.end - segment.start).toFixed(1)}s</span>
                                            <Button size="small" type="text" onClick={() => setSegments((current) => current.filter((_, position) => position !== index))}>
                                                {t("canvas.videoClone.remove")}
                                            </Button>
                                        </div>
                                    ))}
                                    <Button size="small" type="text" onClick={() => setSegments((current) => [...current, clampClipRange(current.at(-1)?.end || 0, (current.at(-1)?.end || 0) + CLIP_MAX_SECONDS, duration)])}>
                                        + {t("canvas.videoClone.addSegment")}
                                    </Button>
                                </div>
                            </Field>
                            <Field label={t("canvas.videoClone.resolution")}>
                                <Segmented value={resolution} options={videoResolutionOptions.map((item) => ({ value: item.value, label: item.label }))} onChange={(value) => setResolution(String(value))} />
                            </Field>
                            <Field label={t("canvas.videoClone.ratio")}>
                                <Select className="w-40" value={ratio} onChange={setRatio} options={videoSizeOptions.filter((item) => item.value !== "auto").map((item) => ({ value: item.value, label: item.value }))} />
                            </Field>
                            <Field label={t("canvas.videoClone.seconds")} hint={t("canvas.videoClone.secondsHint", { min: OUTPUT_MIN_SECONDS, max: outputLimit })}>
                                <Segmented
                                    value={followClip ? "clip" : "manual"}
                                    options={[
                                        { value: "clip", label: t("canvas.videoClone.followClip") },
                                        { value: "manual", label: t("canvas.videoClone.manualSeconds") },
                                    ]}
                                    onChange={(value) => setFollowClip(value === "clip")}
                                />
                                {!followClip ? <Slider className="mt-3" min={OUTPUT_MIN_SECONDS} max={outputLimit} step={1} value={Math.min(seconds, outputLimit)} onChange={setSeconds} /> : null}
                            </Field>
                        </div>
                    </div>
                    <Field label={t("canvas.videoClone.audioTrack")} hint={t("canvas.videoClone.audioHint")}>
                        <Segmented
                            value={sourceAudio ? "original" : "silent"}
                            options={[
                                { value: "silent", label: t("canvas.videoClone.audioSilent") },
                                { value: "original", label: t("canvas.videoClone.audioOriginal") },
                            ]}
                            onChange={(value) => setSourceAudio(value === "original")}
                        />
                    </Field>
                </div>
            ) : null}
            {step === 1 ? (
                <div className="space-y-5">
                    <Field
                        label={t("canvas.videoClone.materialTitle")}
                        hint={t("canvas.videoClone.materialHint")}
                        action={
                            <div className="flex gap-2">
                                <Button size="small" onClick={() => setAssetPickerOpen(true)}>
                                    {t("canvas.videoClone.pickAsset")}
                                </Button>
                                <ImageUpload accept="image/*" multiple showUploadList={false} beforeUpload={(file: File) => (void addMaterials([file]), false)}>
                                    <Button size="small" icon={<UploadIcon className="size-3.5" />}>
                                        {t("canvas.videoClone.addMaterial")}
                                    </Button>
                                </ImageUpload>
                            </div>
                        }
                    >
                        <div className="flex flex-wrap gap-3">
                            {materials.map((material) => {
                                const key = materialKey(material);
                                const active = !excluded.includes(key);
                                return (
                                    <button type="button" key={key} className={`relative size-24 overflow-hidden rounded-lg border text-left transition ${active ? "border-black/10 dark:border-white/10" : "border-black/10 opacity-35 grayscale dark:border-white/10"}`} onClick={() => setExcluded((current) => (active ? [...current, key] : current.filter((item) => item !== key)))}>
                                        {material.previewUrl || material.dataUrl ? <img src={material.previewUrl || material.dataUrl} alt={material.name} className="size-full object-cover" /> : null}
                                        <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">图{materialNumbers.get(key) ?? "-"}</span>
                                        {material.nodeId ? <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{t("canvas.videoClone.fromCanvas")}</span> : null}
                                        {active ? <Check className="absolute right-1 top-1 size-4 text-white drop-shadow" /> : null}
                                    </button>
                                );
                            })}
                        </div>
                    </Field>
                    <Field label={t("canvas.videoClone.requirementTitle")}>
                        <Input.TextArea rows={4} value={requirement} onChange={(event) => setRequirement(event.target.value)} placeholder={t("canvas.videoClone.requirementPlaceholder")} />
                    </Field>
                </div>
            ) : null}
            {step === 2 ? (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-end gap-6">
                        <Field label={t("canvas.videoClone.analyzeModel")}>
                            <ModelPicker config={config} value={analyzeModel} onChange={setAnalyzeModel} capability="text" className="w-64" />
                        </Field>
                        <Field label={t("canvas.videoClone.videoModel")}>
                            <ModelPicker config={config} value={videoModel} onChange={setVideoModel} capability="video" className="w-64" />
                        </Field>
                    </div>
                    <div className="flex items-center gap-3">
                        <Button type="primary" icon={<Sparkles className="size-4" />} loading={analyzing} onClick={() => void analyze()}>
                            {t("canvas.videoClone.analyze")}
                        </Button>
                        {analyzing ? (
                            <Button onClick={() => analyzeAbort.current?.abort()}>{t("canvas.videoClone.stop")}</Button>
                        ) : null}
                        <span className="text-xs opacity-60">{t("canvas.videoClone.analyzeHint")}</span>
                    </div>
                    <Input.TextArea rows={10} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("canvas.videoClone.promptPlaceholder")} />
                </div>
            ) : null}
            {step === 3 ? (
                <div className="space-y-4">
                    <div className="rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/5">
                        {t("canvas.videoClone.summary", {
                            segments: segments.length,
                            clip: segments.map((segment) => `${segment.start.toFixed(1)}-${segment.end.toFixed(1)}`).join("、"),
                            seconds: followClip ? t("canvas.videoClone.followClip") : `${seconds}s`,
                            ratio,
                            resolution: `${resolution}p`,
                            audio: sourceAudio ? t("canvas.videoClone.audioOriginal") : t("canvas.videoClone.audioSilent"),
                            images: selectedMaterials.length,
                        })}
                    </div>
                    <Input.TextArea rows={12} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("canvas.videoClone.promptPlaceholder")} />
                    <div className="flex justify-end">
                        <Button type="primary" size="large" icon={<Clapperboard className="size-4" />} onClick={submit}>
                            {t("canvas.videoClone.generate")}
                        </Button>
                    </div>
                </div>
            ) : null}
            <div className="mt-6 flex justify-between">
                <Button disabled={step === 0} onClick={() => setStep((current) => current - 1)}>
                    {t("canvas.videoClone.previous")}
                </Button>
                {step < 3 ? (
                    <Button type="primary" disabled={step === 2 && !prompt.trim()} onClick={() => setStep((current) => current + 1)}>
                        {t("canvas.videoClone.next")}
                    </Button>
                ) : null}
            </div>
            <AssetPickerModal
                open={assetPickerOpen}
                onClose={() => setAssetPickerOpen(false)}
                onInsert={(payload) => {
                    if (payload.kind === "image") setMaterials((current) => [...current, { name: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey }]);
                    setAssetPickerOpen(false);
                }}
            />
        </Modal>
    );
}

function materialKey(material: CanvasVideoCloneMaterial) {
    return material.nodeId || material.storageKey || material.dataUrl?.slice(-24) || material.name;
}

function referenceVideoFromNode(node: CanvasNodeData) {
    return { id: node.id, name: `${node.title || node.id}.mp4`, type: node.metadata?.mimeType || "video/mp4", url: node.metadata?.content || "", storageKey: node.metadata?.storageKey, durationMs: node.metadata?.durationMs };
}

function Field({ label, hint, action, children }: { label: string; hint?: string; action?: ReactNode; children: ReactNode }) {
    return (
        <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{label}</span>
                {action}
            </div>
            {children}
            {hint ? <div className="mt-1 text-xs opacity-60">{hint}</div> : null}
        </div>
    );
}

// 扩写要看图，默认优先选百炼渠道里的文本模型（如 qwen3.8-flash），没有就退回全局文本模型。
function defaultAnalyzeModel(config: AiConfig) {
    const channel = config.channels.find((item) => item.apiFormat === "bailian" && item.models.some((model) => model.capability === "text"));
    const model = channel?.models.find((item) => item.capability === "text");
    return channel && model ? encodeChannelModel(channel.id, model.name) : config.textModel;
}
