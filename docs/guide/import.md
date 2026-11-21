# CSV-Import

In **jedes Konto** lassen sich Umsätze aus einer CSV-Datei übernehmen: ältere Umsätze aus dem
Online-Banking, den Export eines anderen Finanzprogramms oder ein Kassenbuch für ein
Offline-Konto.

## So geht es

1. Unter **Einstellungen → Importe** auf **CSV importieren** klicken (dann wählst du das Konto im
   Dialog) oder in der Befehlspalette ++cmd+k++ nach „Importieren“ suchen. Bei einem Offline-Konto
   geht es auch über **Importieren …** in seinem Menü.
2. Die Datei in den Dialog ziehen oder auswählen. MBM liest UTF-8 und Windows-1252 und Dateien bis
   20 MB.
3. **Format prüfen:** MBM wählt anhand der Kopfzeile ein passendes [Importformat](#importformate).
   Passt keines, erkennt es die Spalten gängiger Exporte (zum Beispiel DKB, ING und PayPal) selbst.
   Stimmt eine Zuordnung nicht, änderst du sie in der Vorschau.
4. **Vorschau ansehen:** Jede Zeile ist *neu*, *doppelt* oder *ungültig* (mit Grund). Nur neue
   Zeilen werden übernommen; bei doppelten kannst du die Kategorie aus der Datei übernehmen
   ([abweichende Kategorien](#abweichende-kategorien)).
5. **Importieren.**

## Doppelte Umsätze

Ein Umsatz gilt als schon vorhanden, wenn Buchungsdatum, Betrag und IBAN der Gegenseite gleich
sind. Ohne IBAN vergleicht MBM den Namen der Gegenseite, ohne Groß- und Kleinschreibung, Akzente,
Leer- und Satzzeichen. Der Verwendungszweck zählt nicht, weil Exporte ihn oft unterschiedlich
aufbereiten. So kannst du dieselbe Datei auch zweimal importieren, ohne etwas doppelt zu haben.

## Importformate

Ein Format beschreibt, wie MBM eine Datei liest und welcher Wert in welches Feld kommt. Mitgeliefert
sind die **Standardformate** „MoneyMoney (CSV)“ und „Sparkasse CSV-CAMT“. Sie lassen sich nicht
ändern, du kannst sie aber als eigenes Format kopieren. Passen mehrere Formate zur Kopfzeile einer
Datei, haben deine eigenen Vorrang.

In der Vorschau wählst du das Format aus. Über **Format bearbeiten …** stellst du ein:

- **Datei:** Kodierung, Spaltentrenner (auch aus mehreren Zeichen), Anführungszeichen, Kopfzeile,
  Datumsform, Dezimalzeichen und den Trenner von Kategoriepfaden.
- **Stufen:** Bis zu fünf Zerlegungen, die aufeinander aufbauen. Eine Stufe liest eine Spalte oder
  einen Teil einer früheren Stufe.
- **Felder:** Welche Spalte oder welcher Teil einer Stufe in welches Feld kommt.

Die Beispielzeilen zeigen jede Änderung sofort. Danach verwendest du das Format nur für diesen
Import oder speicherst es. Unter **Einstellungen → Importe** kannst du Formate kopieren, umbenennen
und löschen. Bearbeiten geht im Import-Dialog, weil dafür eine Beispieldatei gebraucht wird.

### Stufen

Eine Stufe zerlegt einen Wert auf eine von zwei Arten:

- **Trennzeichen:** Der Wert wird an einem festen Text geteilt, etwa ` // `. Die Teile benennst du
  der Reihe nach.
- **Trennwörter:** MBM sucht feste Wörter mit einem Text davor und danach. Der Wert eines Worts
  reicht bis zum nächsten Trennwort. Kommt ein Wort mehrfach vor, zählt das letzte.

Ein Beispiel mit dem Text davor `, ` und danach `: ` und den Trennwörtern `Umsatzart` und `Referenz`:

```text
Miete Oktober, Umsatzart: Dauerauftrag, Referenz: 12345
```

| Teil | Wert |
|---|---|
| Umsatzart | `Dauerauftrag` |
| Referenz | `12345` |
| Rest | `Miete Oktober` |

Der **Rest** enthält alles, was keinem Feld zugeordnet ist, also auch ein Trennwort ohne Feld. So geht
keine Angabe verloren. Trenner sind immer fester Text, reguläre Ausdrücke gibt es nicht.

## Umsatzart und weitere Angaben

Neben Datum, Betrag und Gegenseite übernimmt MBM die **Umsatzart** (etwa „Lastschrift“), die
**Referenz**, das **Mandat**, die **Gläubiger-ID** und die **BIC**. Sie stehen danach in den
[Details des Umsatzes](umsaetze.md#details-eines-umsatzes).

Fehlt einem vorhandenen Umsatz eine dieser Angaben, ergänzt MBM sie aus der Datei; die Vorschau zeigt
dann „Angaben werden ergänzt“. So kannst du sie auch für schon importierte Umsätze nachtragen, indem
du die Datei noch einmal importierst. Vorhandene Angaben und der Verwendungszweck bleiben dabei
erhalten.

!!! warning "Regeln und gekürzter Verwendungszweck"
    Das Format „MoneyMoney (CSV)“ speichert als Verwendungszweck nur den freien Text. Eine Regel, die
    dort nach `Umsatzart: Lastschrift` sucht, greift bei neu importierten Umsätzen deshalb nicht mehr.

Eine Referenz aus einer Datei verknüpft nie eine Überweisung und bestätigt sie auch nicht. Das
geschieht nur über den Abruf von der Bank.

## Kategorien

Hat die Datei eine Kategorie-Spalte (etwa `Wohnen\Miete`), übernimmt MBM sie. Fehlende Kategorien
legt es auf Wunsch an. Zeilen ohne Kategorie laufen durch die [Regeln](kategorien-regeln.md#regeln).

### Abweichende Kategorien

Nennt die Datei bei einem Umsatz, den es schon gibt, eine andere Kategorie, zeigt die Vorschau
„Kategorie abweichend“ und darunter `bisher: … → Datei: …`. Unten im Dialog wählst du
**Kategorie bei … vorhandenen Umsätzen überschreiben**; dann bekommen diese Umsätze die Kategorie
aus der Datei, als hättest du sie von Hand vergeben. Regeln ändern sie danach nicht mehr.

- Fehlt die Kategorie der Datei noch, wird sie nur übernommen, wenn du auch **Fehlende Kategorien
  anlegen** wählst.
- Aufgeteilte Buchungen bleiben, wie sie sind („aufgeteilt, bleibt“).
- Zeilen ohne Kategorie in der Datei ändern nichts.

## Rückgängig machen

Unter **Einstellungen → Importe** steht jeder Import mit Datei, Zeitpunkt, Benutzer und Anzahl;
über **CSV importieren** startest du dort auch einen neuen.
„Rückgängig“ löscht die Umsätze dieses Imports, die noch da sind. Kategorien und Angaben, die der
Import bei vorhandenen Umsätzen geändert oder ergänzt hat, bleiben erhalten.

![Einstellungen, Importe: ein Import mit Datei und Anzahl](../assets/screenshots/einstellungen-importe-dark.png)

*Einstellungen → Importe: jeder Import lässt sich rückgängig machen.*

Importierte Umsätze sind für die anderen Benutzer [neu](umsaetze.md#neue-umsätze), für den
Importierenden nicht.
