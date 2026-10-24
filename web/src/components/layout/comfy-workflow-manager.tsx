import { App, Button, Input, InputNumber, Select, Upload } from "antd";
import { RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { deleteComfyWorkflow, fetchComfyWorkflows, getComfyServer, importComfyWorkflow, saveComfyServer, testComfyServer, updateComfyWorkflow, type ComfyBinding, type ComfyWorkflowSummary } from "@/services/api/comfyui";
import type { ChannelModel } from "@/stores/use-config-store";

/** ComfyUI gateway settings and imported workflows; shown inside the channel editor for the comfyui format. */
export function ComfyWorkflowManager({ gatewayUrl, onChanged }: { gatewayUrl: string; onChanged: (models: ChannelModel[]) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [workflows, setWorkflows] = useState<ComfyWorkflowSummary[]>([]);
    const [serverUrl, setServerUrl] = useState("");
    const [serverKey, setServerKey] = useState("");
    const [busy, setBusy] = useState(false);
    const onChangedRef = useRef(onChanged);
    onChangedRef.current = onChanged;

    const refresh = useCallback(async () => {
        try {
            const [list, server] = await Promise.all([fetchComfyWorkflows(gatewayUrl), getComfyServer(gatewayUrl).catch(() => ({ url: "", hasApiKey: false }))]);
            setWorkflows(list);
            setServerUrl(server.url);
            onChangedRef.current(list.map((workflow) => ({ name: workflow.id, displayName: workflow.name, capability: workflow.capability })));
        } catch (error) {
            message.warning(error instanceof Error ? error.message : String(error));
        }
    }, [gatewayUrl]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const saveServer = async () => {
        await run(async () => {
            await saveComfyServer(gatewayUrl, serverUrl, serverKey || null);
            message.success(t("comfy.serverSaved"));
        });
    };

    const testServer = async () => {
        await run(async () => {
            message.success(await testComfyServer(gatewayUrl));
        });
    };

    const importFile = async (file: File) => {
        await run(async () => {
            let apiJson: Record<string, unknown>;
            try {
                apiJson = JSON.parse(await file.text());
            } catch {
                throw new Error(t("comfyErrors.notApiWorkflow"));
            }
            await importComfyWorkflow(gatewayUrl, file.name.replace(/\.json$/i, ""), apiJson);
            await refresh();
            message.success(t("comfy.importDone"));
        });
        return false;
    };

    const patchBinding = async (workflow: ComfyWorkflowSummary, index: number, patch: Partial<ComfyBinding>) => {
        const bindings = workflow.bindings.map((binding, i) => (i === index ? { ...binding, ...patch } : binding));
        await run(async () => {
            const updated = await updateComfyWorkflow(gatewayUrl, workflow.id, { bindings });
            setWorkflows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        });
    };

    const patchWorkflow = async (workflow: ComfyWorkflowSummary, patch: { name?: string; imageTimeoutSeconds?: number; videoTimeoutSeconds?: number; pollIntervalSeconds?: number }) => {
        await run(async () => {
            const updated = await updateComfyWorkflow(gatewayUrl, workflow.id, patch);
            setWorkflows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        });
    };

    const removeWorkflow = async (workflow: ComfyWorkflowSummary) => {
        await run(async () => {
            await deleteComfyWorkflow(gatewayUrl, workflow.id);
            await refresh();
        });
    };

    async function run(action: () => Promise<void>) {
        setBusy(true);
        try {
            await action();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold">{t("comfy.serverTitle")}</span>
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={testServer}>
                        {t("comfy.test")}
                    </Button>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                    <Input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://127.0.0.1:8188" />
                    <Input.Password value={serverKey} onChange={(event) => setServerKey(event.target.value)} placeholder={t("comfy.serverKeyPlaceholder")} />
                </div>
                <div className="mt-2 flex justify-end">
                    <Button size="small" type="primary" ghost onClick={saveServer}>
                        {t("comfy.saveServer")}
                    </Button>
                </div>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{t("comfy.workflowsTitle")}</span>
                <Upload accept="application/json,.json" showUploadList={false} beforeUpload={importFile}>
                    <Button size="small" type="primary" icon={<UploadCloud className="size-3.5" />} loading={busy}>
                        {t("comfy.import")}
                    </Button>
                </Upload>
            </div>

            {workflows.length ? (
                <div className="space-y-3">
                    {workflows.map((workflow) => (
                        <div key={workflow.id} className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="flex items-center gap-2">
                                <Input className="flex-1" size="small" value={workflow.name} onChange={(event) => setWorkflows((current) => current.map((item) => (item.id === workflow.id ? { ...item, name: event.target.value } : item)))} onBlur={() => patchWorkflow(workflow, { name: workflow.name })} />
                                <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-500 dark:bg-stone-800">{t(`comfy.capability.${workflow.capability}`)}</span>
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeWorkflow(workflow)} />
                            </div>
                            {workflow.bindings.map((binding, index) => (
                                <div key={`${binding.nodeId}.${binding.field}`} className="flex flex-wrap items-center gap-2 text-xs">
                                    <span className="w-40 shrink-0 truncate text-stone-500" title={`${binding.classType} · ${binding.nodeId}.${binding.field}`}>
                                        {binding.classType} #{binding.nodeId}
                                    </span>
                                    <Select
                                        size="small"
                                        className="w-28 shrink-0"
                                        value={binding.source}
                                        options={[
                                            ...(binding.kind === "text" ? [{ label: t("comfy.source.prompt"), value: "prompt" }, { label: t("comfy.source.const"), value: "const" }] : []),
                                            ...(binding.kind === "image" ? [{ label: t("comfy.source.image"), value: "image" }] : []),
                                            ...(binding.kind === "video" ? [{ label: t("comfy.source.video"), value: "video" }] : []),
                                            ...(binding.kind === "audio" ? [{ label: t("comfy.source.audio"), value: "audio" }] : []),
                                            ...(binding.kind === "number" ? [{ label: t("comfy.source.width"), value: "width" }, { label: t("comfy.source.height"), value: "height" }, { label: t("comfy.source.random"), value: "random" }, { label: t("comfy.source.const"), value: "const" }] : []),
                                            { label: t("comfy.source.off"), value: "off" },
                                        ]}
                                        onChange={(value) => patchBinding(workflow, index, value === "image" && binding.index == null ? { source: "image", index: 0 } : { source: value, index: value === "image" ? binding.index ?? 0 : null })}
                                    />
                                    {binding.source === "image" ? (
                                        <Select
                                            size="small"
                                            className="w-24 shrink-0"
                                            value={binding.index ?? 0}
                                            options={Array.from({ length: 5 }, (_, i) => ({ label: t("comfy.source.imageN", { index: i + 1 }), value: i }))}
                                            onChange={(value) => patchBinding(workflow, index, { index: value })}
                                        />
                                    ) : null}
                                    {binding.source === "const" ? (
                                        <Input
                                            size="small"
                                            className="w-32 shrink-0"
                                            defaultValue={String(binding.value ?? "")}
                                            onBlur={(event) => patchBinding(workflow, index, { value: event.target.value })}
                                        />
                                    ) : null}
                                </div>
                            ))}
                            <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500">
                                <span>{t("comfy.capability.image")}: <InputNumber size="small" min={30} value={workflow.imageTimeoutSeconds} onChange={(value) => value && patchWorkflow(workflow, { imageTimeoutSeconds: value })} addonAfter="s" /></span>
                                <span>{t("comfy.capability.video")}: <InputNumber size="small" min={60} value={workflow.videoTimeoutSeconds} onChange={(value) => value && patchWorkflow(workflow, { videoTimeoutSeconds: value })} addonAfter="s" /></span>
                                <span>
                                    {t("comfy.pollInterval")}:{" "}
                                    <Select size="small" value={workflow.pollIntervalSeconds} options={[10, 30, 60].map((value) => ({ label: `${value}s`, value }))} onChange={(value) => patchWorkflow(workflow, { pollIntervalSeconds: value })} />
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="rounded-lg border border-dashed border-stone-300 px-3 py-8 text-center text-sm text-stone-500 dark:border-stone-700">{t("comfy.empty")}</div>
            )}
        </div>
    );
}
