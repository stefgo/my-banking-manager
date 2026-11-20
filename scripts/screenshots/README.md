# Screenshots

Erzeugt alle Bilder in `docs/assets/screenshots/`.

```bash
npm run screenshots                         # Web-Client bauen, dann alle Bilder aufnehmen
npm run screenshots -- --no-build           # ohne neuen Build
npm run screenshots -- --no-build suche     # nur einzelne Bilder (Namen aus SHOTS in capture.ts)
```

Beim ersten Lauf braucht Playwright seinen Browser:

```bash
npx playwright install chromium
```

## Was dabei nicht läuft

Kein MBM-Server, keine Datenbank, kein Konnektor, keine Bank. `serve.ts` liefert den gebauten
Web-Client aus, und jede Anfrage an `/api` beantwortet Playwright im Browser aus den erfundenen
Daten in `fixtures.ts`. Der WebSocket `/api/events` öffnet sich und bleibt still. Deshalb läuft
eine Aufnahme auf jedem Checkout gleich und braucht keine echten Daten.

## Die Antworten werden geprüft

`capture.ts` ordnet jede Anfrage über die Routenliste `shared/src/api.ts` einer Route zu
(feste Pfade vor Pfaden mit Platzhalter, wie Fastify). Dann prüft es:

- Parameter und Query gegen die Schemas der Route; was der Client dort sendet, muss gültig sein.
- **Die Antwort gegen das Antwortschema der Route.** Ändert sich die API, passt `fixtures.ts` nicht
  mehr, und der Lauf bricht mit dem Feld ab, das nicht passt.
- Anfragen ohne Antwort in `ANSWERS`, Fehler beim Rendern und Fehler in der Konsole.
- Ob die Seite statt der App die Fehlerseite des Routers zeigt.

**Ein sauberer Lauf meldet nichts** außer den Dateien. Jedes Problem steht am Ende, der Lauf endet
dann mit Exit-Code 1. Die Bilder trotzdem ansehen: Eine Antwort kann zum Schema passen und
inhaltlich falsch sein.

## Gleiche Bilder bei jedem Lauf

Zwei Läufe hintereinander erzeugen byte-gleiche PNGs. Dafür sorgen:

- **die Uhr:** Der Browser steht auf `FIXED_NOW` in `fixtures.ts` (20.11.2026, 10:30), alle Daten
  sind relativ zu `TODAY` gewählt.
- **Zeitzone und Sprache:** `Europe/Berlin` und `de-DE`.
- **die Version:** aus der `package.json` im Wurzelverzeichnis.
- **die Zufallsbeträge:** ein fester Startwert in `fixtures.ts`.

## Die Beispieldaten

`fixtures.ts` hält eine Liste erfundener Buchungen und leitet daraus alles ab: Kontostände,
Saldoverlauf, Eingänge und Ausgaben, Kategoriesummen, Trefferzahlen der Regeln und die Termine der
Aufträge. So passen alle Zahlen auf allen Bildern zueinander. Die Abfragen (Konto, Gruppe,
Kategorie, Zeitraum, Suche) wertet es so aus wie der Server, die Suche mit `parseTxQuery` und
`matchTxQuery` aus `shared`.

- **Erfunden:** Namen, Beträge, Banken. Die IBANs haben gültige Prüfziffern; `fixtures.ts` prüft
  sie beim Laden mit `ibanProblem`, sonst zeigt ein Formular im Bild einen Fehler.
- **Neue Felder** in einem Antwortschema meldet der Lauf als Problem; dann das Feld in
  `fixtures.ts` ergänzen.

## Ein Bild hinzufügen

Einen Eintrag in `SHOTS` in `capture.ts` ergänzen und das Bild in einer Seite unter `docs/`
einbinden. Was die URL nicht tragen kann (ein offener Dialog, eine Eingabe), gehört in
`prepare(page)`; es läuft, wenn die Seite geladen ist.

- **Höhe:** Ohne `viewport` passt sich die Höhe dem Inhalt von `main` an (640 bis 1500 Pixel).
  Dialoge und die Bildschirme vor der Anmeldung bekommen einen festen `viewport`.
- **Hell und Dunkel:** Nur die Bilder auf `docs/index.md` sind Paare. Diese Seite liegt im
  Wurzelverzeichnis der Site, deshalb funktioniert dort das HTML mit `#only-light` und
  `#only-dark`, das Material je nach Darstellung umschaltet. Alle anderen Seiten liegen eine Ebene
  tiefer und binden mit normalem Markdown nur das dunkle Bild ein (`themes: ["dark"]`).
- **Handy:** `phone: true` nimmt 390 × 844 Pixel mit Touch auf.
