## 0.1.0 (2026-11-20)

### Erste Version

My Banking Manager ist ein Homebanking, das du selbst betreibst. Alle Daten liegen verschlüsselt
auf deinem eigenen Server. MBM verbindet sich selbst und direkt mit deiner Bank: Kein fremder
Dienstleister ruft deine Konten ab oder bekommt deine Zugangsdaten, deine Daten liegen auf keinem
Server eines Anbieters im Internet, und MBM sendet keine Nutzungsdaten (keine Telemetrie).

### Enthalten

- **Verschlüsselte Datenbank** (SQLite3 Multiple Ciphers, AES-256). Nach jedem Start ist MBM
  gesperrt, bis sich ein Benutzer anmeldet. Anmeldung mit Passwort und TOTP,
  Wiederherstellungsschlüssel, weitere Benutzer.
- **Bankzugänge über FinTS** mit eigenem Konnektor (getestet mit der Sparkasse, S-pushTAN):
  Konten übernehmen, Saldo und Umsätze abrufen, nur von Hand ausgelöst.
- **Offline-Konten** (Bargeld, Sparbuch, Depot …) mit Buchungen, Saldoabgleich und Gegenbuchungen.
- **Umsätze** mit Konten- und Kategorienbaum, Suche und Filtern, Kategorien und Regeln,
  **CSV-Import** in jedes Konto.
- **Neue Umsätze** sind markiert: ein Punkt in der Umsatzliste und die Anzahl neuer Umsätze an
  „Umsätze“ in der Seitenleiste und an jedem Konto. Gelesen ist ein Umsatz, sobald du seine Details
  öffnest; von Hand geht das in den Details, bei mehreren ausgewählten Umsätzen oder mit „Alle als
  gelesen markieren“ im Kontomenü. Die Suche `ist:neu` zeigt nur neue Umsätze.
- **Überweisen** mit Empfängerüberprüfung, Empfängerliste und Verlauf; **Aufträge**: Dauer- und
  Terminaufträge abrufen und ansehen.
- **Übersicht** aus Karten mit Saldoverlauf, Vorschau aus Aufträgen und „Demnächst“.
- **Ohne Bankverbindung** zeigen Übersicht, Umsätze, Überweisen und Aufträge denselben Hinweis mit
  „Bankverbindung einrichten“; Übersicht und Umsätze bieten zusätzlich ein Offline-Konto an.
- **Versionsanzeige** unten in den Einstellungen, für My Banking Manager und den FinTS-Konnektor.
- **Images** für amd64 und arm64:
  - `mbm-server-full`: Server, Web-Client und FinTS-Konnektor in einem Container
    (`compose.yaml`). Das offizielle Image eines Releases bringt die registrierte
    FinTS-Produkt-ID mit.
  - `mbm-server` und `mbm-fints`: Server und Konnektor in zwei Containern (`compose.split.yaml`).
    `mbm-fints` enthält keine Produkt-ID; du brauchst eine eigene (fints.org) in
    `MBM_FINTS_PRODUCT_ID`.

### Upgrade

Erste Version, kein Upgrade nötig. Einrichtung siehe README und `docs/operations.md`. Vor dem
ersten Einsatz das Backup von `/data` einrichten und den Wiederherstellungsschlüssel getrennt
aufbewahren. Ohne Docker brauchst du Node.js 26 oder neuer.
