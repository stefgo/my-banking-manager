<!--
The hand-written part of the next release: what is new, why it matters, and
what an upgrade needs. It is placed above the list of commits in the GitHub
release and in CHANGELOG.md.

Write below this comment. Use "###" for headings -- "##" is the level of the
version itself. A release with nothing written here is refused. A beta from
dev keeps the text; the stable release from main empties this file again.

Nothing inside an HTML comment is published.
-->

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
