import { App, Alert, Button, Input } from "antd";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getBailianServer, saveBailianServer, testBailianServer } from "@/services/api/bailian";

/** Bailian (DashScope) server settings kept inside the Python gateway; shown for the bailian channel format. */
export function BailianServerManager({ gatewayUrl }: { gatewayUrl: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [url, setUrl] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [keyPreview, setKeyPreview] = useState("");
    const [keyWasCleaned, setKeyWasCleaned] = useState(false);
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
        try {
            const server = await getBailianServer(gatewayUrl);
            setUrl(server.url);
            setKeyPreview(server.hasApiKey ? server.keyPreview : "");
            setKeyWasCleaned(server.keyWasCleaned);
        } catch {
            setKeyPreview("");
        }
    };

    useEffect(() => {
        void refresh();
    }, [gatewayUrl]);

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try {
            await action();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">{t("bailian.serverTitle")}</span>
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void run(async () => message.success(await testBailianServer(gatewayUrl)))}>
                    {t("bailian.test")}
                </Button>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
                <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://dashscope.aliyuncs.com" />
                <Input.Password value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={keyPreview ? t("bailian.serverKeyReplace", { preview: keyPreview }) : t("bailian.serverKeyPlaceholder")} autoComplete="off" />
            </div>
            {keyPreview && <div className="mt-1.5 text-xs text-stone-500">{t("bailian.serverKeyStored", { preview: keyPreview })}</div>}
            {keyWasCleaned && (
                <Alert className="mt-2" type="warning" showIcon message={t("bailian.keyCleanedWarning")} />
            )}
            <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-stone-500">{t("bailian.hint")}</span>
                <Button
                    size="small"
                    type="primary"
                    ghost
                    onClick={() =>
                        void run(async () => {
                            await saveBailianServer(gatewayUrl, url, apiKey || null);
                            setApiKey("");
                            await refresh();
                            message.success(t("bailian.serverSaved"));
                        })
                    }
                >
                    {t("bailian.saveServer")}
                </Button>
            </div>
        </div>
    );
}
