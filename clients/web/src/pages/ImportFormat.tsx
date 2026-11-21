import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Copy, Save } from "lucide-react";
import { routes, type ImportFormat, type ImportFormatDefinition } from "@mbm/shared";
import { importFormatRoute } from "../router";
import { call, errorText } from "../lib/api";
import { copyName, emptyFormat, formatProblem, useFormatTable } from "../lib/importFormat";
import { useAction, useImportFormats } from "../lib/queries";
import { useLeaveGuard } from "../lib/useLeaveGuard";
import { Button, Empty, Hint } from "../components/common";
import { SkeletonRows } from "../components/Skeleton";
import { FormatWorkbench } from "../components/import/FormatWorkbench";
import { Ic } from "../components/icons";

function FormatEditor({ format, formats }: { format: ImportFormat | null; formats: ImportFormat[] }) {
    const navigate = useNavigate();
    const action = useAction();
    const readOnly = !!format?.builtin;
    const [def, setDef] = useState<ImportFormatDefinition>(() => format?.definition ?? emptyFormat());
    const [name, setName] = useState(format?.name ?? "");
    const [dirty, setDirty] = useState(false);
    const [sample, setSample] = useState<{ name: string; buffer: ArrayBuffer } | null>(null);
    const [error, setError] = useState("");
    const table = useFormatTable(sample, def.file);
    // A sample that does not fit is worth a warning, but does not keep the format from being saved
    const problem = readOnly ? "" : formatProblem(def, table);
    const blocked = !readOnly && !!formatProblem(def, null);
    const guard = useLeaveGuard(dirty, "Änderungen verwerfen?", "Die Änderungen an diesem Format sind noch nicht gespeichert.");
    const back = () => void navigate({ to: "/settings", search: { tab: "imports" } });

    const pickSample = async (f: File) => {
        if (f.size > 20_000_000) return setError("Die Datei ist größer als 20 MB.");
        setError("");
        setSample({ name: f.name, buffer: await f.arrayBuffer() });
    };

    const save = async () => {
        const trimmed = name.trim();
        if (!trimmed) return setError("Bitte einen Namen für das Format eingeben.");
        setError("");
        const saved = await action.run(
            () => (format ? call(routes.updateImportFormat, { params: { id: format.id! }, body: { name: trimmed, definition: def } }) : call(routes.createImportFormat, { body: { name: trimmed, definition: def } })),
            {
                topics: ["importFormats"],
                ok: "Format gespeichert",
                onError: (err) => {
                    setError(errorText(err));
                    return true;
                },
            },
        );
        if (!saved) return;
        guard.release();
        setDirty(false);
        if (!format) void navigate({ to: "/import-format", search: { key: saved.key }, replace: true });
    };

    const copy = async () => {
        const saved = await action.run(() => call(routes.createImportFormat, { body: { name: copyName(format!.name, formats.map((f) => f.name)), definition: format!.definition } }), { topics: ["importFormats"], ok: "Als neues Format gespeichert" });
        if (saved) void navigate({ to: "/import-format", search: { key: saved.key } });
    };

    const discard = () => {
        setDef(format?.definition ?? emptyFormat());
        setName(format?.name ?? "");
        setDirty(false);
        setError("");
    };

    return (
        <div className="imp-page wide">
            <div className="fmt-head">
                <button type="button" className="btn btn-sm btn-ghost" onClick={back}>
                    <Ic icon={ArrowLeft} size={15} />
                    Importe
                </button>
                {readOnly ? (
                    <h1>{format!.name}</h1>
                ) : (
                    <input
                        className="inp fmt-name"
                        aria-label="Name des Formats"
                        placeholder="Name des Formats"
                        maxLength={80}
                        value={name}
                        onChange={(e) => {
                            setName(e.target.value);
                            setDirty(true);
                        }}
                    />
                )}
                <span className="fmt-head-actions">
                    {readOnly ? (
                        <Button className="btn-primary" icon={Copy} busy={action.pending} onClick={() => void copy()}>Als neues Format speichern</Button>
                    ) : (
                        <>
                            <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={discard}>Verwerfen</button>
                            <Button className="btn-primary" icon={Save} busy={action.pending} disabled={blocked || (!dirty && !!format)} onClick={() => void save()}>Speichern</Button>
                        </>
                    )}
                </span>
            </div>
            {readOnly && <Hint>Standardformate sind schreibgeschützt. Speichere das Format als neues Format, um es zu ändern.</Hint>}
            {(problem || error) && <Hint tone="bad">{error || problem}</Hint>}
            <FormatWorkbench
                def={def}
                table={table}
                readOnly={readOnly}
                sampleName={sample?.name}
                onPickSample={(f) => void pickSample(f)}
                onChange={(next) => {
                    setDef(next);
                    setDirty(true);
                }}
            />
        </div>
    );
}

/** Creates, edits or (for a format of the app) shows an import format, with or without a file. */
export function ImportFormatPage() {
    const { key } = importFormatRoute.useSearch();
    const navigate = useNavigate();
    const query = useImportFormats();
    if (query.isPending) return <section className="panel"><SkeletonRows rows={4} plain /></section>;
    const formats = query.data ?? [];
    const format = key === "new" ? null : formats.find((f) => f.key === key);
    if (format === undefined) {
        return (
            <Empty
                title="Format nicht gefunden"
                text="Dieses Importformat gibt es nicht mehr."
                action={<button className="btn" onClick={() => void navigate({ to: "/settings", search: { tab: "imports" } })}>Zu den Importen</button>}
            />
        );
    }
    return <FormatEditor key={key} format={format} formats={formats} />;
}
