import type { WebSocket } from "ws";
import { ClientEvent, type ServerEvent, type Topic } from "@mbm/shared";

interface Client {
    socket: WebSocket;
    userId: number;
    deviceId: number;
    kind: "web" | "device";
    /** Pings without an answer in a row. */
    missed: number;
}

export interface Connection {
    userId: number;
    deviceId: number;
    kind: "web" | "device";
}

/** Close codes the client understands. */
export const CLOSE_SIGNED_OUT = 4401;
export const CLOSE_SESSION_LOCKED = 4403;
export const CLOSE_LOCKED = 4423;

/** A connection counts as gone after this many pings without an answer. */
const MAX_MISSED_PINGS = 2;

/** The open WebSocket connections and who they belong to. */
export class EventHub {
    private readonly clients = new Set<Client>();
    private readonly changeListeners = new Set<() => void>();
    private readonly activeListeners = new Set<(deviceId: number) => void>();

    add(socket: WebSocket, conn: Connection): void {
        const client: Client = { socket, ...conn, missed: 0 };
        this.clients.add(client);
        socket.on("pong", () => {
            client.missed = 0;
        });
        socket.on("message", (data) => {
            client.missed = 0; // any message shows the connection is alive
            let parsed: ReturnType<typeof ClientEvent.safeParse>;
            try {
                parsed = ClientEvent.safeParse(JSON.parse(String(data)));
            } catch {
                return;
            }
            if (parsed.success && parsed.data.type === "active") for (const l of this.activeListeners) l(client.deviceId);
        });
        socket.on("close", () => this.remove(client));
        this.notifyChange();
    }

    private remove(client: Client): void {
        if (this.clients.delete(client)) this.notifyChange();
    }

    private notifyChange(): void {
        for (const l of this.changeListeners) l();
    }

    /** Called whenever a connection opens or closes. */
    onChange(listener: () => void): void {
        this.changeListeners.add(listener);
    }

    /** Called when a client reports input of its user. */
    onActive(listener: (deviceId: number) => void): void {
        this.activeListeners.add(listener);
    }

    connections(): Connection[] {
        return [...this.clients].map(({ userId, deviceId, kind }) => ({ userId, deviceId, kind }));
    }

    /** Pings every connection; one that did not answer the last pings is dropped. */
    heartbeat(): void {
        for (const c of [...this.clients]) {
            if (c.missed >= MAX_MISSED_PINGS) {
                c.socket.terminate();
                this.remove(c);
                continue;
            }
            c.missed++;
            c.socket.ping();
        }
    }

    private send(client: Client, event: ServerEvent): void {
        if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(event));
    }

    private closeWhere(match: (c: Client) => boolean, event: ServerEvent, code: number, reason: string): void {
        for (const c of [...this.clients]) {
            if (!match(c)) continue;
            this.send(c, event);
            c.socket.close(code, reason);
            this.remove(c);
        }
    }

    /** Shared data changed: every signed-in client refetches what it shows of these topics. */
    changed(...topics: Topic[]): void {
        for (const c of this.clients) this.send(c, { type: "changed", topics });
    }

    /** Data of one user changed on `fromDevice` (what is new for them); their other clients refetch it. */
    changedForUser(userId: number, fromDevice: number | null, ...topics: Topic[]): void {
        for (const c of this.clients) if (c.userId === userId && c.deviceId !== fromDevice) this.send(c, { type: "changed", topics });
    }

    /** The profile of `userId` changed on `fromDevice`; its other clients reload it. */
    profileChanged(userId: number, fromDevice: number): void {
        for (const c of this.clients) if (c.userId === userId && c.deviceId !== fromDevice) this.send(c, { type: "profile" });
    }

    /** An event for every client of one user (fetch progress). */
    toUser(userId: number, event: ServerEvent): void {
        for (const c of this.clients) if (c.userId === userId) this.send(c, event);
    }

    signOutDevice(deviceId: number): void {
        this.closeWhere((c) => c.deviceId === deviceId, { type: "signed_out" }, CLOSE_SIGNED_OUT, "signed out");
    }

    signOutUser(userId: number): void {
        this.closeWhere((c) => c.userId === userId, { type: "signed_out" }, CLOSE_SIGNED_OUT, "signed out");
    }

    /** The session was locked after inactivity: all its windows show the password prompt. */
    sessionLocked(deviceId: number): void {
        this.closeWhere((c) => c.deviceId === deviceId, { type: "session_locked" }, CLOSE_SESSION_LOCKED, "session locked");
    }

    locked(): void {
        this.closeWhere(() => true, { type: "locked" }, CLOSE_LOCKED, "locked");
    }

    get size(): number {
        return this.clients.size;
    }
}
