# Entwicklung

## Arbeitsbereiche

| Paket | Inhalt |
|---|---|
| `shared` | Einzige Quelle für Typen und Prüfungen: Zod-Schemas, die Routenliste `src/api.ts`, Server-Ereignisse, CSV-Lesen, Beträge, Symbole und Farben, Start-Kategorien |
| `server` | Fastify 5, `better-sqlite3-multiple-ciphers`, Umzug-Migrationen, Pino |
| `clients/web` | React 19, Vite, TanStack Router/Query/Virtual, Tailwind 4 (nur Utilities), Radix, cmdk, Recharts, React Hook Form |

## VS Code

Der Ordner `.vscode/` bringt Tasks, Startkonfigurationen und Empfehlungen für Erweiterungen mit
(ESLint, EditorConfig, Vitest, Tailwind CSS).

- **Starten:** `⇧⌘B` (Task „Server + Web starten“) startet Server (Port 3040), FinTS-Konnektor und
  Web-Client (Port 5173) parallel, dann `http://localhost:5173` öffnen. Einzeln: „Server (dev)“,
  „FinTS-Konnektor (dev)“, „Web (dev)“.
- **Debuggen:** Unter *Ausführen und Debuggen* „Server debuggen“, „FinTS-Konnektor debuggen“, „Web
  in Chrome debuggen“ oder alles zusammen als „Server + Web debuggen“. Haltepunkte in `server/src`,
  `connectors/fints/src` und `clients/web/src` greifen.
- **Weitere Tasks:** „Tests“, „Typecheck + Lint“, „Contracts erzeugen“; Tests auch über die
  Vitest-Erweiterung.
- Aus VS Code gestartet lauscht der Server nur auf `127.0.0.1`. Daten liegen in `server/data`.

### FinTS-Konnektor lokal

Die FinTS-Produkt-ID gehört in die Datei `.env` im Projektordner. Git ignoriert diese Datei, und
`docker compose` liest sie ebenfalls. Vorlage: `.env.example`. Wer selbst baut oder
weiterentwickelt, braucht nach den Registrierungsbedingungen eine eigene Produkt-ID (fints.org).

```bash
cp .env.example .env && chmod 600 .env   # dann MBM_FINTS_PRODUCT_ID=… eintragen
npm run dev:fints                        # oder Task „FinTS-Konnektor (dev)“
```

Lokal lauscht der Konnektor auf `.run/fints.sock` im Projektordner. Auch dieser Ordner ist von Git
ausgeschlossen. Server und Konnektor bekommen den Pfad über ihre Dev-Skripte und die
VS-Code-Konfigurationen. Ein eigenes `MBM_FINTS_SOCKET` hat Vorrang. Ohne Produkt-ID startet der
Konnektor trotzdem, spricht aber keine Bank an. In diesem Fall zeigen die Einstellungen einen
Hinweis.

Ohne eigenen Konnektor-Prozess geht es auch: `npm run dev:full` statt `dev:server` und `dev:fints`
lädt den Konnektor wie im Image `mbm-server-full` in den Server (`MBM_FINTS_EMBEDDED=1`). Die
Produkt-ID kommt dann ebenfalls aus der `.env`.

Ob eine Bank erreichbar ist und was sie anbietet, zeigt `bank-info`. Es braucht keine Zugangsdaten
und speichert nichts:

```bash
npm run bank-info -w connectors/fints -- <BLZ> <FinTS-Adresse>
```

Antwortet eine Bank anders als erwartet, schreibt der Konnektor mit `MBM_FINTS_TRACE=1` (in `.env`,
dann Konnektor neu starten) zu jeder Nachricht eine Zeile auf stderr: Segmente mit Version,
Rückmeldecodes und die Form der UPD (Anzahl Konten, ob Kontonummer/IBAN vorhanden). Inhalte wie
Namen, Nummern, Beträge oder Rückmeldetexte erscheinen nicht.

`server/tsconfig.json` leitet `better-sqlite3-multiple-ciphers` per `paths` auf dessen `index.d.ts`
um, weil das Paket seine Typen nicht über `exports` angibt. tsx würde diese Umleitung auch zur
Laufzeit anwenden und die Typdatei laden; deshalb nutzen das Dev-Skript und der Debugger
`server/tsconfig.dev.json` ohne `paths`.

## Die Routenliste ist der Vertrag

Jede Route steht genau einmal in `shared/src/api.ts` mit Methode, Pfad, Zugriff (`none`, `unlocked`,
`user`, `session`) und den Schemas für Parameter, Abfrage, Body und Antwort. `user` verlangt eine
Anmeldung, deren Sitzung nicht nach Inaktivität gesperrt ist; `session` lässt auch eine gesperrte
Sitzung zu (nur `me`, Abmelden und Sitzung sperren). `login` hat den Zugriff `none`: Die Anmeldung
öffnet auch den gesperrten Server und die gesperrte Sitzung (`Vault.attempt` in `server/src/vault.ts`).

- Der Server registriert seine Handler mit `handle(app, ctx, routes.x, …)` (`server/src/http/route.ts`).
  Eingaben werden gegen die Schemas geprüft; außerhalb von Produktion auch die Antwort.
- Der Web-Client ruft ausschließlich `call(routes.x, { params, query, body })` auf (`clients/web/src/lib/api.ts`).
- `npm run contracts` schreibt daraus `contracts/server-api.yaml`; CI prüft mit `contracts:check`,
  dass die Datei aktuell ist.

Eine neue Route ist damit: Schema und Eintrag in `api.ts`, Handler im Server, Aufruf im Client,
`npm run contracts`.

## Ereignisse

Der Server meldet Änderungen über den WebSocket `/api/events` (`shared/src/events.ts`):
`changed` mit Themen (`accounts`, `transactions`, …), `profile`, `locked`, `signed_out`. Der Web-Client
lädt die betroffenen Abfragen neu (`clients/web/src/lib/socket.ts`).

## Datenbank

- Migrationen führt Umzug aus (`server/src/db/database.ts`). Jede steht in einer eigenen Datei in
  `server/src/db/migrations/` (`0001-initial.ts`, …) und ist in `migrations/index.ts` eingetragen.
  Jede läuft genau einmal in einer Transaktion. Eine ausgelieferte Migration wird nie geändert, nur
  eine weitere Datei angehängt. Vor der ersten Version wurden alle zu `0001-initial`
  zusammengefasst (zuletzt am 2026-11-20); ab der ersten Version wird nicht mehr zusammengefasst,
  sonst passen bestehende Datenbanken nicht mehr dazu.
- Passwörter stehen nicht in der Datenbank: Sie werden gegen `keystore.json` geprüft
  (`server/src/crypto/keystore.ts`). Wer Benutzer anlegt, löscht oder ein Passwort
  setzt, pflegt dort den Eintrag über `Vault`.
- Beträge sind ganze Cent, Buchungstage `JJJJ-MM-TT`.
- Kategorien hängen über `transaction_categories` an Buchungen (eine Zeile je Anteil), damit
  Splitbuchungen später ohne Umbau möglich sind.
- Saldo eines Offline-Kontos: Anfangssaldo + alle Buchungen. Der Anfangssaldo ist der Kontostand vor
  der ersten Buchung und hat kein Datum; auch importierte Buchungen jeden Datums zählen.
- Saldo eines Bankkontos: ebenfalls Anfangssaldo + alle Buchungen (`services/accounts.ts`). Ein Abruf
  mit Saldo setzt den Anfangssaldo per `alignBankBalance` so, dass der Saldo der Bank herauskommt;
  dieser enthält alles außer den vorgemerkten Buchungen der Bank. Import und „Import rückgängig“
  verrechnen ihre Summe per `keepBankBalance` im Anfangssaldo, der heutige Saldo bleibt also gleich.
  Ohne Bank-Saldo ändert sich der Anfangssaldo nicht.
- Eine gebuchte Buchung der Bank übernimmt beim Abruf eine gleiche Buchung aus einem CSV-Import
  (`duplicateKey`, `sameCounterparty`): Id, Kategorie und Lesestand bleiben, Quelle wird `bank`,
  `import_id` wird leer. Vorgemerkte CSV-Zeilen nimmt ein Bankkonto nicht an.
- **Neue Umsätze** gelten je Benutzer (`transaction_unread`, nur ungelesene Buchungen haben eine Zeile;
  `services/unread.ts`, Plan `plans/neue-umsaetze.md`):
  - Abruf: neu für alle Benutzer; der gebuchte Nachfolger eines vorgemerkten Umsatzes übernimmt
    dessen Lesestand (`fetchimport.ts`).
  - CSV-Import: neu für alle außer dem Importierenden. Von Hand und Gegenbuchungen: nie neu.
  - `Transaction.unread` gilt für den anfragenden Benutzer; `unreadCounts` zählt je Konto,
    `markRead` markiert per Ids (gelesen oder wieder neu) oder ein ganzes Konto als gelesen.
  - Markieren meldet das Thema `unread` nur an die anderen Geräte desselben Benutzers
    (`events.changedForUser`); der Web-Client ändert seinen Cache sofort (`lib/unread.ts`).
  - Der Web-Client markiert einen Umsatz beim Öffnen der Details als gelesen. Badges stehen an
    „Umsätze“ und an Konten, nie an Kontogruppen.

## Suche in den Umsätzen und Regeln

Die Suchsyntax steht in `shared/src/txquery.ts`. Dazu gehören:
- Wörter, `"Phrasen"` (mit `\"` und `\\`), Platzhalter `*` und `?`
- `UND`/`ODER`/`NICHT` und Klammern
- Felder `gegenseite:`, `zweck:`, `iban:`, `konto:`, `kategorie:`, `betrag:`, `datum:` und `ist:neu`,
  auch englisch (`counterparty:`, `purpose:`, `account:`, `category:`, `amount:`, `date:`, `is:new`);
  `txQueryField` löst beide Sprachen auf, die Vorschläge zeigen englische Namen nur, wenn kein
  deutscher passt
- Vergleiche für Betrag und Datum
- absolute, teilweise und relative Daten (`-30t`, `vormonat` …, englisch `-30d`, `lastmonth` …)

`parseTxQuery` liefert einen Syntaxbaum oder eine deutsche Fehlermeldung mit Position.
`matchTxQuery` wertet den Baum für ein `TxQueryTarget` aus. `dateBounds` nennt die Tage, auf die eine
Abfrage höchstens passen kann.

- **Server:**
  - `services/querytarget.ts` baut die Targets und lädt Kategorie- und Kontopfade einmal je Vorgang.
  - `listTransactions` filtert erst per SQL (Konto, Zeitraum, Kategorie, Richtung) und wertet die Suche
    danach in JS aus.
  - Ungültige Suchen weist das Schema `TransactionQuery.q` mit 400 ab.
- **Regeln** (`rules.query`) nutzen dieselbe Syntax im Modus `rule`: ohne `kategorie:`, ohne
  `ist:`, ohne relative Daten, mit mindestens einem Suchbegriff.
  - `shared/src/ruleEngine.ts` wertet sie aus (`evaluateRules`): Die erste treffende Regel gewinnt.
    Bedingungen und Ausschnitte lesen nur Bankwerte. `shared/src/textExtract.ts` liest Muster und
    Platzhalter ohne reguläre Ausdrücke aus Nutzereingaben.
  - Ergebnisse liegen in `transaction_edits` und `transaction_categories`, die Spalten von
    `transactions` ändert keine Regel. Sie sind fachliche Schlüssel für Duplikate, Vormerkungen,
    Rücklastschriften und Überweisungen.
  - `services/rules.ts`: `planRuleRun` rechnet einen Lauf samt Prüfsumme, `commitRuleRun` rechnet neu
    und schreibt nur bei gleicher Prüfsumme. Neue Umsätze gehen über `evaluateNew`.
- **Web-Client:**
  - Er prüft Eingaben selbst und sendet nur gültige Suchen.
  - Enthält die Suche eine Datumsbedingung, sendet er `range=all`, und der Verlauf nutzt `dateBounds`
    (`SeriesQuery.from`/`to`, höchstens 730 Tage).
  - Das Info-Popover mit der Syntax ist `components/QueryHelp.tsx`.
- Hintergrund: `plans/suchsyntax-plan.md`, `plans/suche-regeln-plan.md` und
  `plans/regelbasierte-anpassungen.md`.

## Termin- und Daueraufträge

MBM zeigt Aufträge nur an (Stand M5b Teil 1); anlegen, ändern und löschen folgen nach den
Überweisungen. Die Bank ist die Quelle: Jeder Abruf ersetzt die Aufträge eines Kontos durch ihre
Liste, lokal wird nichts bearbeitet.

- **Konnektor:**
  - `segments/orders.ts` und `jobs/jobs.ts` lesen Daueraufträge (HKCDB) und Terminüberweisungen
    (HKCSB); die Zahlung selbst steht als pain.001 in der Antwort (`formats/pain001.ts`).
  - Je Konto meldet er, ob die Listen abrufbar sind und ob die Bank dafür jedes Mal eine Freigabe
    verlangt (`standingOrdersTan`, `scheduledTransfersTan`).
- **Server:**
  - `services/orders.ts` speichert die Listen in `standing_orders` und `scheduled_transfers`. Ein
    Auftrag, den die Bank unter derselben Kennung weiter meldet, behält seine ID.
  - Der Abruf (`services/sync.ts`) holt die Aufträge nach den Umsätzen. Verlangt die Bank dafür immer
    eine Freigabe, kommen sie nur über `fetchOrders` (ein Abruf mit `ordersOnly`). Schlägt nur der
    Auftragsteil fehl, gilt der Abruf als erfolgreich und trägt `ordersMessage`.
  - `listOrders`, `upcomingOrders` und die Vorschau in `series` (`forecastDays`) rechnen aus den
    gespeicherten Aufträgen. Ein Auftrag an ein eigenes Konto belastet das eine und erhöht das andere.
- **Termine** berechnet `shared/src/orders.ts` für Server und Clients gleich: Turnus in Monaten oder
  Wochen, Ausführungstag (97–99 zählen vom Monatsende), Bankarbeitstage ohne Wochenenden und
  TARGET-Feiertage. Ein Termin rückt auf den nächsten Bankarbeitstag, am Monatsende auf den
  vorherigen.
- **Web-Client:** Seite `pages/Orders.tsx` mit den Details in `pages/OrderDrawer.tsx`, Karte
  „Demnächst“ und die gestrichelte Vorschau in `components/BalanceChart.tsx`.
- Hintergrund: `plans/m5b-umsetzung.md`.

## Überweisungen

SEPA- und Echtzeitüberweisungen (HKCCS, HKIPZ) mit Empfängerüberprüfung (VoP) und Freigabe.
**Nichts wird automatisch wiederholt:** Ist unklar, ob die Bank eine Überweisung ausgeführt hat,
endet sie als `unknown` („Ausgang unbekannt“).

- **Konnektor:**
  - `formats/pain001.ts` schreibt die Zahlung (pain.001.001.09, sonst .001.03/.003.03, je nach
    HISPAS bzw. HIIPZS), `formats/pain002.ts` liest das Ergebnis der Empfängerüberprüfung.
  - `segments/payments.ts`: HKCCS, HKIPZ (v2 stets ohne Umwandlung in eine Standardüberweisung),
    HKVPP/HIVPP, HKVPA und die Parameter HIVPPS.
  - `jobs/payments.ts` folgt den Rückmeldecodes (Messages – VoP, E.8.1): Challenge → Freigabe
    (HKVPA mit jedem HKTAN, außer die Bank meldet 3091); 3090/3945 → der Vorgang hält an
    (`status: "confirm"`), nach `POST /v1/operations/{id}/confirm` gehen HKVPA, derselbe Auftrag und
    HKTAN an die Bank; Polling-ID → HKVPP allein, bis das Ergebnis vollständig ist. Sieht die
    letzte Antwort darauf wie eine angenommene Zahlung aus (3076, 0010/0020), endet sie als
    `outcome_unknown`: Ob die Bank den gehaltenen Auftrag ausgeführt hat, ist offen, und erneut
    senden könnte doppelt zahlen.
  - Ab der ersten Nachricht mit dem Auftrag wird eine verlorene oder unlesbare Antwort zum Fehler
    `outcome_unknown` (`lostAnswer` in `dialog/errors.ts`, auch bei den Statusabfragen einer
    Freigabe, `JobRunner.run(…, { payment: true })`). Jeder Fehler eines Zahlungsvorgangs, der
    keine Antwort der Bank ist, wird ebenfalls `outcome_unknown`.
  - Solange eine Anfrage eines Vorgangs bei der Bank ist (TAN, Statusabfrage), läuft er nicht ab
    (`Operation.busy`), und `cancelOperation` wartet, bis sie beantwortet ist.
  - Die simulierte Bank spielt alle Fälle mit `payments` (`testing/personal-bank.ts`).
- **Server:** `services/transfers.ts` (TransferManager) führt jede Überweisung im Hintergrund durch
  die Zustände `submitting` → `awaiting_vop_confirm` → `awaiting_tan` → `executed` | `rejected` |
  `failed` | `cancelled` | `unknown`. Benutzerschlüssel und eine nicht gespeicherte PIN liegen nur
  im Arbeitsspeicher, solange sie läuft. Nur der Lauf selbst spricht mit dem Konnektor über seinen
  Vorgang, auch beim Abbrechen; ist eine TAN unterwegs, lehnt der Server das Abbrechen ab
  (`tan_in_flight`). Die Frist für die TAN endet, sobald sie abgeschickt ist. Die Anfrage-ID des
  Clients schützt vor Doppelklicks, auch bei gleichzeitigen Anfragen; dieselbe ID mit anderen
  Angaben ergibt `request_id_conflict`. Solange eine Überweisung läuft, lehnt der Server Sperren
  und das Löschen ihrer Bankverbindung ab.
  Hängende Vorgänge schließt `recover` beim Öffnen der Datenbank ab. Jede Überweisung bekommt eine
  eigene End-to-End-ID (`MBM-…`); daran ordnet der Abruf die Buchung zu (`linkBookedTransfers`), und
  ein „Ausgang unbekannt“ wird dann zu „ausgeführt“ (mit Empfänger und Aktivitätseintrag).
  Ausgeführte Empfänger landen in `payees`.
- **Web-Client:** Seite `pages/Transfer.tsx`: Kopf wie bei Aufträgen, darunter der Verlauf; eine
  neue Überweisung öffnet sich als Dialog (Erfassen → Prüfen → Freigeben, Empfänger). Ein Klick
  neben den Dialog schließt ihn nicht; eine eigene, noch laufende Überweisung öffnet ihn beim Betreten
  der Seite wieder. Details eines Eintrags: `pages/TransferDrawer.tsx`. Vorbelegen geht nur über den
  Arbeitsspeicher (`ui.newTransfer`, `useStartTransfer`), nie über die URL. Den Aufklärungstext der Bank zeigt
  `components/BankText.tsx` ohne HTML (`lib/bankText.ts`).
- Hintergrund: `plans/m5a-umsetzung.md`.

## Bedienmuster im Web-Client

Neue Oberflächen folgen diesen Bausteinen, damit sich alles gleich bedient (Plan
`plans/ergonomie-konsistenz.md`):

- **Tastenkürzel** stehen einmal in `lib/keys.ts` (`KEYS`, `GO_KEYS`). Hilfe, Palette, Seitenleiste
  und Tooltips (`withKeys`) lesen daraus; `shell/shortcuts.ts` führt sie aus.
- **Formulare:** `Field` (`components/form.tsx`) mit `fieldProps(id, error, hasHint)`
  (`lib/fields.ts`). Fehler stehen am Feld, `focusFirstError` setzt den Fokus. Absende-Knöpfe sind
  nur beim Speichern gesperrt: `Button` mit `busy` (`components/common.tsx`).
- **Auswahl** von Konto, Gruppe oder Kategorie über `Picker` mit `PickerButton`, nicht über
  eingerückte `<select>`.
- **Rückfragen** (`ui.confirm`) vor allem, was löscht oder entfernt: Titel als Frage mit Namen,
  Text sagt, was passiert und was bleibt, Knopf nennt die Handlung, rot nur bei Löschen und
  Entfernen. `onConfirm` gibt `false` zurück, wenn es fehlschlug (`action.succeeds`); dann bleibt
  der Dialog offen. Kein Rückgängig.
- **Seitenaktionen** rechts im Seitenkopf (`page-head` → `head-actions`), weitere im „…“-Menü.
- **Menüs** von Konten und Gruppen kommen aus `lib/menus.ts`, damit Baum und Kopfbereich dieselben
  Einträge haben. Sortieren überall gleich: Griff zum Ziehen plus „Nach oben“, „Nach unten“,
  „Verschieben nach …“ (`orderEntries`).
- **Bäume** sind `role="tree"` mit einem Tab-Stopp (`useTreeKeys`, `treeRowProps` in
  `lib/treeKeys.ts`); Knöpfe in einer Zeile haben `tabIndex={-1}`.
- **Laden:** `SkeletonRows` / `SkeletonCard` beim ersten Laden, nicht bei jedem Neuladen.
- **Seitenleiste:** Logo, Suchfeld (öffnet die Palette) und Navigation stehen fest, nur die Bäume
  scrollen (`.sb-scroll`); in niedrigen Fenstern (bis 620 px Höhe) scrollt die ganze Leiste, der Fuß
  bleibt unten stehen. Im Fuß der Benutzerknopf mit Menü (Einstellungen, Darstellung,
  Tastenkürzel, Abmelden, „MBM für alle sperren“) und das Auge „Beträge ausblenden“.
  ☰ links neben dem Logo (oder ⌘B, `toggleSidebar` in `shell/sidebarToggle.ts`) blendet sie aus;
  dann bleibt eine Symbolleiste (`.rail`), und auf „Umsätze“ stehen die Bäume als eigene
  Spalte (`.sb-trees`) daneben, deren Breite der Griff ändert. Der Zustand liegt als
  `sidebarCollapsed` im `localStorage`; in der schmalen Ansicht gilt er nicht.
- **Sitzung beenden** (`shell/session.ts`): `signOut()` meldet nur dieses Gerät ab, `lockServer()`
  schließt die Datenbank für alle Benutzer und Geräte. Beide mit Rückfrage.
- **Schmale Ansicht** (bis 860 px, `NARROW_QUERY`): Kopfleiste mit Suche, Auge und Zahnrad (Blatt
  „Einstellungen“, `shell/SettingsSheet.tsx`, derselbe Inhalt wie das Benutzermenü); Tableiste mit
  Übersicht, Umsätze, Konten (`/accounts`), Überweisen und Aufträge. Ab 1280 px
  (`INSPECTOR_QUERY`) sind die Umsatzdetails ein Panel neben der Liste.
- **Touch:** Klickflächen mindestens 24 px, bei `pointer: coarse` mindestens 40 px.

## Tests

`npm test` führt Vitest für `shared`, `server` und `web` aus. Server-Tests starten die App mit
`createTestApp()` auf einem frischen temporären Datenverzeichnis und einer schnellen
Schlüsselableitung; **kein Test öffnet die Daten einer laufenden Installation.** Tests sprechen nie
mit einer Bank.

## Dokumentation und Screenshots

Die Dokumentation sind die Seiten in `docs/`. MkDocs Material baut daraus die Site, die
`.github/workflows/docs.yml` von `main` auf GitHub Pages veröffentlicht
(stefgo.github.io/my-banking-manager). Jede Seite muss auch auf GitHub lesbar bleiben; Bilder und
Links deshalb relativ.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-docs.txt
.venv/bin/mkdocs serve                # Vorschau auf Port 8000
.venv/bin/mkdocs build --strict       # wie der Workflow: tote Links und Anker brechen ab
npm run screenshots                   # alle Bilder in docs/assets/screenshots/ neu
```

- `mkdocs.yml` setzt `theme.font: false`: Die Site lädt keine Schriften von Google.
- **Nach jeder sichtbaren Änderung** im Web-Client die betroffenen Bilder neu aufnehmen und die
  Seite unter `docs/guide/` anpassen.
- Die Screenshots entstehen ohne Server aus erfundenen Daten, deren Antworten gegen die Schemas der
  Routen geprüft werden: [scripts/screenshots/README.md](https://github.com/stefgo/my-banking-manager/blob/main/scripts/screenshots/README.md).

## Code-Stil

4 Leerzeichen, doppelte Anführungszeichen, TypeScript überall. Code und Kommentare auf Englisch,
die Oberfläche auf Deutsch. ESLint (`eslint.config.js`) mit typescript-eslint sowie react-hooks und
react-refresh für den Web-Client: Eine Datei mit Komponenten exportiert nur Komponenten; Hilfsfunktionen
liegen in eigenen Dateien (`lib/`, `components/rows.ts`, `components/pickItems.tsx`).

## Veröffentlichung (Images)

Vorbild ist DIM (Docker Instance Manager); Version und Release-Notizen kommen aus den zentralen
Workflows in [stefgo/release-workflows](https://github.com/stefgo/release-workflows).

**Branches:** `main` ist der freigegebene Stand, `dev` die Entwicklung. Nur diese beiden werden
gepusht (`.githooks/pre-push`), Themen-Branches bleiben lokal. `dev` wird mit Historie nach `main`
gemergt (kein Squash, kein Rebase), nach einem Release `main` zurück nach `dev`.

**Commit-Nachrichten:** Conventional Commits mit deutschem Betreff, z. B.
`feat: Überweisen als Dialog` oder `fix(umsätze): Filter je Konto bleibt erhalten`. `feat` erhöht
die Minor-Stelle, `fix`, `perf` und `revert` die Patch-Stelle, andere Typen (`refactor`, `docs`,
`chore`, `test`, `build`, `ci`, `style`) lösen kein Release aus. Einen Bruch kennzeichnet eine
Fußzeile `BREAKING CHANGE: …` (erhöht die Minor-Stelle), nie ein `!`. Lokal prüft
`.githooks/commit-msg` (aktiv nach `npm install`), in der CI commitlint die Commits eines Pull
Requests.

**Workflows** (`.github/workflows/`):

| Workflow | Wann | Was |
|---|---|---|
| `ci.yml` „Check Code“ | Push auf Themen-Branches, Pull Requests; von den anderen aufgerufen | build, typecheck, lint, test, `contracts:check`; Commit-Nachrichten (nur PR); deckt `cleanup-packages.yml` alle Images ab? |
| `build.yml` „Build Images“ | Push auf `main`/`dev` (nicht bei reinen `.md`-Änderungen), Versions-Tag, von Hand | Prüfungen, dann alle drei Images je Architektur auf eigenem Runner (amd64, arm64 nativ), Push nur per Digest, Smoke-Test, erst dann Tags |
| `release.yml` „Create Release“ | nur von Hand im Actions-Tab | Release von `main` oder Beta von `dev` (siehe unten) |
| `cleanup-packages.yml` „Prune Registry“ | nachts, von Hand (Standard: Probelauf) | löscht alte, unmarkierte Images in ghcr.io, prüft die geschützten Tags |

**Images** (`ghcr.io/<owner>/…`, jeweils für amd64 und arm64):

| Image | Dockerfile | Inhalt |
|---|---|---|
| `mbm-server` | `docker/server.Dockerfile` | Server und Web-Client; Konnektor über den Socket |
| `mbm-fints` | `docker/fints.Dockerfile` | FinTS-Konnektor allein, **nie** mit Produkt-ID |
| `mbm-server-full` | `docker/server-full.Dockerfile` | Server, Web-Client und FinTS-Konnektor im selben Prozess |

| Anlass | Tags | Produkt-ID in `mbm-server-full` |
|---|---|---|
| Push auf `main` / `dev` | `main` bzw. `dev`, `sha-<kurz>` | nein |
| Release `v1.2.0` | `1.2.0`, `1.2`, `sha-<kurz>`, `latest` | ja |
| Beta `v1.2.0-beta.1` | `1.2.0-beta.1`, `sha-<kurz>` (nie `latest`) | ja |

Der **Smoke-Test** startet `mbm-server` und `mbm-fints` so wie `compose.split.yaml` und daneben
`mbm-server-full` so wie `compose.yaml` (nur lesbares Dateisystem, tmpfs für `/tmp` und den
Socket, `no-new-privileges`, ohne Abruf bei bundesbank.de). Er prüft `/api/health` beider Server,
den Konnektor über den gemeinsamen Socket aus dem Server-Container und die Startzeilen der
Konnektoren: `mbm-fints` immer „no product ID“, `mbm-server-full` „embedded (product ID of this
build)“ in offiziellen Images, sonst „embedded (no product ID …)“. Schlägt er fehl, bleiben die
Images ohne Tag; „Prune Registry“ räumt sie weg.

**Release erstellen:**

1. Den von Hand geschriebenen Teil der Notizen in `.release/next.md` schreiben (unter dem
   Kommentar, Überschriften mit `###`). Ohne Text lehnt der Release ab. Eine Beta behält den Text,
   das stabile Release leert die Datei wieder. `.release/footer.md` steht unter jedem Release.
2. Actions → „Create Release“ → Branch `main` (Release) oder `dev` (Beta) → zuerst mit
   `dry_run` (Standard): zeigt Version und Notizen. `bump: auto` liest die Commit-Typen; `patch`,
   `minor` oder `major` erzwingen die Stufe.
3. Ohne `dry_run`: Tag, GitHub-Release, `CHANGELOG.md`, Version in `package.json` und den vier
   Workspaces (der Konnektor meldet seine Version als Produktversion an die Bank). Danach startet
   und erwartet der Workflow `build.yml` auf dem Tag.

Die Workspace-Einträge in `package-lock.json` behalten bis zum nächsten lokalen `npm install` die
alte Version; `npm ci` nimmt das hin.

**Produkt-ID.** Die FinTS-Produkt-ID darf nach den Registrierungsbedingungen nur im registrierten
Produkt stecken, nicht im Quellcode, nicht separat veröffentlicht und nicht in einer Bibliothek für
Dritte. Deshalb:

- Sie liegt nur als Repository-Secret `FINTS_PRODUCT_ID` auf GitHub und geht als **Build-Secret**
  (nicht als `--build-arg`, das bliebe in der Image-Historie) in `docker/server-full.Dockerfile`.
  Dort landet sie in `connectors/fints/dist/product-id` (von Git und Docker-Kontext
  ausgeschlossen), aber nur mit `--build-arg MBM_FINTS_OFFICIAL=1`; ohne das Secret bricht ein
  solcher Build ab.
- **`mbm-fints` bekommt die ID nie.** `docker/fints.Dockerfile` kennt weder das Secret noch
  `MBM_FINTS_OFFICIAL`; wer den Konnektor als eigenen Container betreibt, setzt
  `MBM_FINTS_PRODUCT_ID` selbst.
- Offiziell ist nur der Build eines **Versions-Tags**. Sein Image `mbm-server-full` entsteht ohne jeden
  Cache (kein `cache-from`, kein `cache-to`): Docker nimmt den Inhalt eines Secrets nicht in den
  Cache-Schlüssel auf, und eine Schicht mit der ID läge sonst im Actions-Cache. Alle anderen
  Builds cachen je Image und Architektur.
- `release.yml` prüft vor dem Anlegen des Tags, ob das Secret gesetzt ist, `build.yml` auf einem
  Tag noch einmal. `:main`, `:dev`, die CI und Pull Requests (auch aus Forks) bauen ohne ID.
- Reihenfolge im Konnektor (`connectors/fints/src/product.ts`): `MBM_FINTS_PRODUCT_ID` vor der
  Datei des Builds, sonst keine.
- Der FinTS-Konnektor wird nicht als eigenständiges Paket (npm) veröffentlicht; ein solches Paket
  bekäme nie eine ID.
- Die ID nie in README, Doku, Tests, Logs oder Commit-Nachrichten schreiben.
