## [0.3.0](https://github.com/stefgo/my-banking-manager/compare/v0.2.0...v0.3.0) (2026-11-21)

### Neu

- Der CSV-Import arbeitet mit **Importformaten**: Du legst Trennzeichen und Trennwörter in bis zu
  fünf Stufen fest, ordnest die Teile den Feldern zu und speicherst das Format. Die Standardformate
  „MoneyMoney (CSV)“ und „Sparkasse CSV-CAMT“ sind dabei und werden anhand der Kopfzeile erkannt.
  Formate bearbeitest du auch direkt unter Einstellungen → Importe, mit oder ohne Beispieldatei.
  Alle Bereiche des Editors sind dabei zu Beginn aufgeklappt, und ein Standardformat übernimmst du
  mit „Als neues Format speichern“. Die Beispielzeile zeigt alle Spalten der Datei und daneben das
  Ergebnis des Imports.
- Der Import ist jetzt eine eigene, übersichtliche Seite mit den Schritten Datei, Format, Konto und
  Prüfen. Ein erkanntes Format ist vorgewählt und wird von dir bestätigt. Beim Prüfen filterst und
  durchsuchst du die Zeilen und wählst einzeln, was du übernimmst. Bei abweichenden Kategorien und
  zu ergänzenden Angaben siehst du den aktuellen Wert neben dem aus der Datei und ob der Import ihn
  übernimmt.
- Umsätze zeigen jetzt auch Referenz, Mandat, Gläubiger-ID und BIC, aus dem Bankabruf wie aus dem
  Import.
- Der CSV-Import übernimmt die Umsatzart. Bei vorhandenen Umsätzen ergänzt er sie und die neuen
  Angaben, wenn sie noch fehlen, und überschreibt nie vorhandene.

### Wichtig beim Update

- Das Format „MoneyMoney (CSV)“ speichert als Verwendungszweck nur den freien Text. Regeln, die dort
  nach Text wie `Umsatzart: Lastschrift` suchen, greifen bei neu importierten Umsätzen nicht mehr.

### Geändert

- Das Menü eines Bankkontos ist aufgeräumt: „Importieren“ und „Vom Bankzugang lösen“ stehen dort
  nicht mehr. Importieren geht weiter über Einstellungen → Importe oder die Befehlspalette, das
  Lösen über Einstellungen → Konten.
- Das Menü der Online-Dokumentation ist übersichtlicher: Gruppen und Einträge sind klar abgesetzt,
  die geöffnete Seite ist hervorgehoben, und die Seiten stehen in einer sinnvolleren Reihenfolge.
  „Betrieb im Detail“ heißt jetzt „Technische Details“.

### Behoben

- Die Details eines Umsatzes schließen sich jetzt, wenn du die Seite verlässt.
- Der CSV-Import hält Spalten wie „Umsatzart“ oder „Buchungstext“ nicht mehr für Betrag oder Datum.

### Features

* **import:** Beispielzeile zeigt alle Spalten als einfache Liste ([e0268a3](https://github.com/stefgo/my-banking-manager/commit/e0268a311d8027eea4a2598f28dbd0392a16e6f5))
* **import:** Format-Editor mit offenen Karten und allen Spalten ([c737cb5](https://github.com/stefgo/my-banking-manager/commit/c737cb53dd3246462d801bdd1b2f99bf9e8fbbdc))
* **import:** Import als eigene Seite und Formate in den Einstellungen ([3746db5](https://github.com/stefgo/my-banking-manager/commit/3746db52067ef433a53c7012f9c26ec097bdcad9))
* **import:** Importformate mit Stufen und Standardformaten ([767ffc1](https://github.com/stefgo/my-banking-manager/commit/767ffc17e60e9b353055c691253680b0b2e971e8))
* **import:** Umsatzart aus CSV-Dateien übernehmen ([ba1c76a](https://github.com/stefgo/my-banking-manager/commit/ba1c76aa6cb43fbb10e8f6ecb81a57b0623a0bbe))
* **import:** Vier klare Schritte und Zeilenauswahl beim Prüfen ([5de0502](https://github.com/stefgo/my-banking-manager/commit/5de05027f53b6e5ad504bed252d4536f1e01166e))
* **import:** Vorher und Nachher beim Prüfen anzeigen ([55b1c91](https://github.com/stefgo/my-banking-manager/commit/55b1c91289263a3d8518ef7f5bd20ef54300394d))
* **konten:** Menü von Bankkonten aufräumen ([19eb4c8](https://github.com/stefgo/my-banking-manager/commit/19eb4c8feadc8373d4262d1d7a36e61be65540c8))

### Bug Fixes

* **umsätze:** Details schließen sich beim Verlassen der Seite ([65d7d09](https://github.com/stefgo/my-banking-manager/commit/65d7d09335a59870dc9aa10f6bccfd225ef0d635))

## [0.2.0](https://github.com/stefgo/my-banking-manager/compare/v0.1.0...v0.2.0) (2026-11-21)

### Verbessert

- **Umsätze:** Die Details zeigen die Umsatzart der Bank („Kartenzahlung“, „Lastschrift“ …).
- **Umsätze:** Meldet die Bank einen abweichenden Empfänger oder Auftraggeber, etwa den Händler
  einer Kartenzahlung statt der abwickelnden Landesbank, zeigt MBM ihn in Liste und Titel. Der
  Abwickler steht in den Details als „Kontoinhaber“; `gegenseite:` und Regeln finden beide Namen.
  Beides gilt für Umsätze, die ab dieser Version abgerufen werden; schon gespeicherte bleiben, wie
  sie sind.
- **CSV-Import:** Die Vorschau zeigt bei schon vorhandenen Umsätzen, wenn die Datei eine andere
  Kategorie nennt („bisher: … → Datei: …“). Auf Wunsch übernimmt MBM die Kategorie aus der Datei;
  aufgeteilte Buchungen bleiben unverändert.
- **CSV-Import:** Unter Einstellungen → Importe startest du über „CSV importieren“ direkt einen
  neuen Import; das Konto wählst du im Dialog.
- **Offline-Konten:** Unter Einstellungen → Konten öffnet der Knopf neben einem Offline-Konto jetzt
  den CSV-Import für dieses Konto (statt „Buchung erfassen“).
- **CSV-Import:** Die Liste der zu importierenden Umsätze ist nur so hoch, dass der ganze Dialog
  ins Fenster passt; „Importieren“ bleibt ohne Scrollen erreichbar.
- **Bankzugang einrichten:** Im Schritt „Konten übernehmen“ scrollt bei vielen Konten nur die
  Liste; Gruppe und „Konten übernehmen“ bleiben im Fenster sichtbar.
- **Umsätze:** Bei einer Kategorie zeigen die Tage in der Umsatzliste keinen Saldo mehr, nur die
  Tagessumme. Der Saldo der Konten passte dort nicht zu den gezeigten Buchungen.
- **Suche und Regeln:** Die Hilfe zur Suchsyntax nennt jetzt auch `AND`, `OR` und `NOT`; sie
  funktionierten schon bisher wie `UND`, `ODER` und `NICHT`.
- **Suche und Regeln:** Die Felder gibt es jetzt auch mit englischen Namen: `counterparty:`,
  `purpose:`, `account:`, `category:` (`cat:`), `amount:`, `date:` und `is:new`, ebenso die
  Zeiträume (`today`, `lastmonth`, `-30d`, `-1y` …).
- **Regeln:** Nach „Regel anlegen“ wird neben der Abfrage auch die gewählte Kategorie
  zurückgesetzt.
- **Bankzugang einrichten:** Der Schritt „TAN-Verfahren wählen“ erklärt jetzt, wozu die Auswahl
  dient, kennzeichnet das empfohlene Verfahren und sagt, wann die Bank nach einem Gerät oder einer
  Freigabe fragt.
- **Symbol und Farbe:** Das Fenster bleibt immer ganz im Browserfenster. In der Seitenleiste öffnet
  es sich jetzt neben dem Symbol statt darunter.

### Features

* **bankzugang:** Schritt „TAN-Verfahren wählen“ verständlicher machen ([59608d0](https://github.com/stefgo/my-banking-manager/commit/59608d08abf9fb8b2da7090d24cbd5eae3172ad7))
* **import:** abweichende Kategorien vorhandener Umsätze zeigen und überschreiben ([e321b36](https://github.com/stefgo/my-banking-manager/commit/e321b369a0cadc8ea9edd64cb8348362b8bffdf5))
* **import:** CSV-Import aus Einstellungen → Importe starten ([bec3081](https://github.com/stefgo/my-banking-manager/commit/bec30818c12ce7027f5e1afd2005783c2b726d7e))
* **konten:** Offline-Konten in den Einstellungen mit Knopf „Buchungen importieren“ ([ad34716](https://github.com/stefgo/my-banking-manager/commit/ad34716903a89279d2f55cce23419678383aa526))
* **suche:** englische Feldnamen und Datumswörter ([8f74194](https://github.com/stefgo/my-banking-manager/commit/8f74194f6e304093dd7b95477fb272f2fe962e59))
* **umsätze:** Umsatzart und abweichenden Empfänger anzeigen ([5cba6c3](https://github.com/stefgo/my-banking-manager/commit/5cba6c33ec26f720b9a26b7e9ad7e6981ea9760d))

### Bug Fixes

* **bankzugang:** Kontenliste in „Konten übernehmen“ scrollt im Fenster ([f293060](https://github.com/stefgo/my-banking-manager/commit/f29306075a8397aedb6d413b9beef36e63c01571))
* **import:** Umsatzliste passt sich der Fensterhöhe an ([11d0154](https://github.com/stefgo/my-banking-manager/commit/11d0154968e0bb18897ef620314744ff793e02c0))
* **konten:** Fenster für Symbol und Farbe bleibt im sichtbaren Bereich ([ff41fb6](https://github.com/stefgo/my-banking-manager/commit/ff41fb66c88135eb672c102cea2a4e1a0a53f6b6))
* **regeln:** Kategorie nach dem Anlegen einer Regel zurücksetzen ([9a00880](https://github.com/stefgo/my-banking-manager/commit/9a008801ce5c5306441297d7b88dcc2daec30f20))
* **umsätze:** kein Saldo in den Tageszeilen bei Kategorien ([d10dca4](https://github.com/stefgo/my-banking-manager/commit/d10dca465608a46f04ae40645949f27402fd2162))

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
