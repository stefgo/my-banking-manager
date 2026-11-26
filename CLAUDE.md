# My Banking Manager — CLAUDE.md

Selbst gehostetes Homebanking. Plan und Stand: `plans/implementation-plan.md`.
Maßgeblich für das Design ist der Web-Client selbst. Antworten an den Nutzer auf Deutsch.

## Grundregeln

- **Keine Daten über Dritte.** Keine CDNs, keine externen Schriften oder Dienste, keine Telemetrie.
  Ausnahmen: Der Server lädt das BLZ-Verzeichnis von bundesbank.de (abschaltbar). PSD2-Zugänge
  (PayPal und andere Banken ohne FinTS) laufen über Enable Banking: nur der Konnektor
  `enablebanking` spricht mit `api.enablebanking.com`, nur für Benutzer, die einen PSD2-Zugang
  einrichten, mit ihrer eigenen Anwendung; abschaltbar (`MBM_ENABLEBANKING_EMBEDDED=0` bzw. ohne
  Konnektor). Sonst kein weiterer Dienst.
- **Alle lokal gespeicherten Daten sind verschlüsselt.** Nichts Unverschlüsseltes auf die Platte,
  keine Bankdaten oder Geheimnisse in Logs. Clients speichern keine Bankdaten (auch nicht im
  Browser-Speicher). Einzige Ausnahme: reine Ansichtswerte ohne Bank- oder Personenbezug (IDs, feste
  Auswahlwerte, Ja/Nein: Breite und Klappzustände der Seitenleiste, „Verlauf“, Filter der Umsatzliste
  je Konto, zuletzt gezeigte Ansicht der Umsätze) liegen unverschlüsselt im `localStorage` des Browsers. Nie Namen, Beträge oder Suchtexte.
  Öffentliche Verzeichnisse ohne Bank- oder Personenbezug (BLZ-Verzeichnis der Bundesbank,
  `<dataDir>/blz.json`) liegen unverschlüsselt, lesbar formatiert.
- **Trennung:** Nur der Server speichert, nur Konnektoren sprechen mit Banken, Clients sprechen nur
  mit dem Server.
- Echte Überweisungen nie ohne den Nutzer. GitHub-Repository erst auf Ansage. Commit oder Push nur
  auf Ansage.
- Größere Änderungen: zuerst einen editierbaren Plan zeigen und freigeben lassen.

## Monorepo

`shared` (Zod-Schemas, Routenliste `src/api.ts`, Ereignisse, CSV, Symbole), `server` (Fastify 5,
better-sqlite3-multiple-ciphers, Umzug, Pino), `clients/web` (React 19, Vite, TanStack, Radix,
Tailwind 4 nur Utilities, Design-CSS in `src/styles/app.css`), `contracts`
(erzeugte OpenAPI-Datei). Details: `docs/development.md`.

## Befehle

```bash
npm run dev:server / dev:web     # Port 3040 / 5173
npm test                         # Vitest: shared, server, web
npm run typecheck && npm run lint
npm run contracts                # nach jeder Änderung an shared/src/api.ts oder den Schemas
npm run screenshots              # Bilder in docs/assets/screenshots/ (scripts/screenshots/README.md)
```

## Muster

- Neue Route: Schema + Eintrag in `shared/src/api.ts` → `handle(...)` im Server → `call(routes.x)` im
  Client → `npm run contracts`.
- Änderungen meldet der Server per `events.changed(<topics>)`; der Client lädt diese Themen neu.
- Beträge in Cent, Daten als `JJJJ-MM-TT`. UI-Texte Deutsch, Code und Kommentare Englisch.
- Commits: Conventional Commits mit deutschem Betreff (`feat: …`, `fix(umsätze): …`), Bruch nur
  per Fußzeile `BREAKING CHANGE:`, nie `!`. Branches `main` (freigegeben) und `dev`; Releases nur
  von Hand über „Create Release“ (`docs/development.md`, Veröffentlichung).
- 4 Leerzeichen, doppelte Anführungszeichen. Eine `.tsx`-Datei mit Komponenten exportiert nur
  Komponenten.
- Tests: Server über `createTestApp()` mit temporärem Datenverzeichnis; nie echte Daten, nie eine
  echte Bank. Browser-Prüfungen gegen eine eigene Instanz mit eigenem Datenverzeichnis (nie
  `server/data`).
- Dokumentation: Seiten in `docs/` (MkDocs Material, `mkdocs build --strict`), Deutsch, in Du-Form.
  Nach sichtbaren Änderungen Seite und Screenshots anpassen; ändert sich eine Antwort der API, die
  eine aufgenommene Seite lädt, auch `scripts/screenshots/fixtures.ts`.
