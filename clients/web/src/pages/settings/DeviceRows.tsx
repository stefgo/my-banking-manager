import type { Device } from "@mbm/shared";
import { routes } from "@mbm/shared";
import { call } from "../../lib/api";
import { dateTime } from "../../lib/format";
import { useAction } from "../../lib/queries";
import { ui } from "../../lib/ui";

/** Signed-in browsers and device tokens, each with its own way to sign it out. */
export function DeviceRows({ devices }: { devices: Device[] }) {
    const action = useAction();
    return (
        <div className="row-list">
            {devices.map((d) => (
                <div className="row-item" key={d.id}>
                    <span>
                        <b>{d.name}{d.current ? " (dieses Gerät)" : ""}</b>
                        <small>
                            {d.kind === "web" ? "Browser" : "Geräte-Token"} · angemeldet {dateTime(d.createdAt)}
                            {d.lastSeenAt ? ` · zuletzt ${dateTime(d.lastSeenAt)}` : ""}
                        </small>
                    </span>
                    <span className="row-actions">
                        <button
                            className="btn btn-sm btn-ghost btn-danger"
                            aria-label={`${d.name} abmelden`}
                            onClick={() =>
                                ui.confirm({
                                    title: `„${d.name}“ abmelden?`,
                                    text: d.current ? "Du wirst auf diesem Gerät abgemeldet." : "Das Gerät muss sich neu anmelden.",
                                    confirm: "Abmelden",
                                    onConfirm: () => action.succeeds(() => call(routes.revokeDevice, { params: { id: d.id } }), { topics: ["devices"], ok: "Abgemeldet" }),
                                })
                            }
                        >
                            Abmelden
                        </button>
                    </span>
                </div>
            ))}
        </div>
    );
}
