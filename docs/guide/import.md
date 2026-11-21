# CSV-Import

In **jedes Konto** lassen sich Umsätze aus einer CSV-Datei übernehmen: ältere Umsätze aus dem
Online-Banking, den Export eines anderen Finanzprogramms oder ein Kassenbuch für ein
Offline-Konto.

## So geht es

Unter **Einstellungen → Importe** klickst du auf **CSV importieren**. Alternativ suchst du in der
Befehlspalette ++cmd+k++ nach „Importieren“ oder wählst bei einem Offline-Konto **Importieren …** in
seinem Menü. Der Import läuft dann auf einer eigenen Seite in drei Schritten:

1. **Datei:** Konto wählen und die Datei hineinziehen oder auswählen. MBM liest UTF-8 und
   Windows-1252 und Dateien bis 20 MB.
2. **Format:** MBM wählt anhand der Kopfzeile ein passendes [Importformat](#importformate). Erkennt
   es eines, geht es direkt weiter zu „Prüfen“. Sonst ordnest du hier die Spalten zu. Über
   **Anpassen** kommst du jederzeit zu diesem Schritt zurück.
3. **Prüfen:** Die Kacheln zeigen, wie viele Zeilen *neu*, zu *ergänzen*, *abweichend*, schon
   *vorhanden* oder *unlesbar* sind. Ein Klick auf eine Kachel filtert die Liste, ein Klick auf eine
   Zeile zeigt ihre Details. Anfangs siehst du nur Zeilen, die etwas ändern oder unlesbar sind.

Mit **Umsätze übernehmen** schließt du den Import ab.

![Import, Schritt Prüfen: Kacheln und Liste der Zeilen](../assets/screenshots/import-pruefen-dark.png)

*Der Schritt „Prüfen“: Die Kacheln filtern die Liste.*

## Doppelte Umsätze

Ein Umsatz gilt als schon vorhanden, wenn Buchungsdatum, Betrag und IBAN der Gegenseite gleich
sind. Ohne IBAN vergleicht MBM den Namen der Gegenseite, ohne Groß- und Kleinschreibung, Akzente,
Leer- und Satzzeichen. Der Verwendungszweck zählt nicht, weil Exporte ihn oft unterschiedlich
aufbereiten. So kannst du dieselbe Datei auch zweimal importieren, ohne etwas doppelt zu haben.

## Importformate

Ein Format beschreibt, wie MBM eine Datei liest und welcher Wert in welches Feld kommt. Mitgeliefert
sind die **Standardformate** „MoneyMoney (CSV)“ und „Sparkasse CSV-CAMT“. Sie lassen sich nicht
ändern, du kannst sie aber als neues Format speichern. Passen mehrere Formate zur Kopfzeile einer
Datei, haben deine eigenen Vorrang.

Formate bearbeitest du an zwei Stellen mit demselben Editor:

- **Einstellungen → Importe:** Hier legst du Formate an, bearbeitest, kopierst und löschst sie, auch
  ohne Datei. Die Spalten trägst du dann unter **Datei lesen** von Hand ein. Mit einer
  **Beispieldatei** siehst du sofort das Ergebnis. Sie bleibt im Browser und wird nicht gespeichert.
- **Beim Import:** Im Schritt „Format“ passt du das Format für diese Datei an. Die Änderung gilt für
  diesen Import, bis du sie speicherst.

Der Editor hat drei Bereiche, die zu Beginn alle aufgeklappt sind:

- **Datei lesen:** Spaltentrenner (auch aus mehreren Zeichen) und Kopfzeile. Unter **Erweitert**
  stehen Kodierung, Anführungszeichen, Datumsform, Dezimalzeichen, der Trenner von Kategoriepfaden
  und die Wörter für „vorgemerkt“.
- **Text zerlegen:** Bis zu fünf Stufen, die aufeinander aufbauen. Eine Stufe liest eine Spalte oder
  einen Teil einer früheren Stufe.
- **Felder zuordnen:** Welche Spalte oder welcher Teil einer Stufe in welches Feld kommt. Auf
  schmalen Bildschirmen steht der Wert aus der Beispielzeile direkt daneben.

Daneben zeigt die **Beispielzeile**, was das Format aus einer Zeile der Datei macht. Unter **Aus der
Datei** stehen die unveränderten Werte: die zerlegten Spalten direkt, alle anderen zum Aufklappen.
Unter **Ergebnis** steht, was MBM daraus importiert. Mit den Pfeilen blätterst du durch die Datei.

![Format-Editor: Einrichtung links, Beispielzeile rechts](../assets/screenshots/importformat-bearbeiten-dark.png)

*Der Format-Editor: links die Einrichtung, rechts das Ergebnis für eine Zeile.*

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

Fehlt einem vorhandenen Umsatz eine dieser Angaben, ergänzt MBM sie aus der Datei; die Prüfung zeigt
dann „ergänzen“. So kannst du sie auch für schon importierte Umsätze nachtragen, indem
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

Nennt die Datei bei einem Umsatz, den es schon gibt, eine andere Kategorie, zeigt die Prüfung
„Kategorie abweichend“; die Details der Zeile nennen beide Kategorien. Unter der Liste wählst du
**… abweichende Kategorien überschreiben**; dann bekommen diese Umsätze die Kategorie aus der Datei,
als hättest du sie von Hand vergeben. Regeln ändern sie danach nicht mehr.

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
