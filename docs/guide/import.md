# CSV-Import

In **jedes Konto** lassen sich Umsätze aus einer CSV-Datei übernehmen: ältere Umsätze aus dem
Online-Banking, den Export eines anderen Finanzprogramms oder ein Kassenbuch für ein
Offline-Konto.

## So geht es

1. Im Menü eines Kontos **Importieren …** wählen (oder in der Befehlspalette ++cmd+k++ nach
   „Importieren“ suchen).
2. Die Datei in den Dialog ziehen oder auswählen. MBM liest UTF-8 und Windows-1252 und Dateien bis
   20 MB.
3. **Spalten prüfen:** MBM erkennt die Spalten gängiger Exporte (zum Beispiel Sparkasse CSV-CAMT,
   DKB, ING, PayPal und verbreiteter Finanzprogramme) selbst. Passt eine Zuordnung nicht, änderst
   du sie in der Vorschau.
4. **Vorschau ansehen:** Jede Zeile ist *neu*, *doppelt* oder *ungültig* (mit Grund). Nur neue
   Zeilen werden übernommen.
5. **Importieren.**

## Doppelte Umsätze

Ein Umsatz gilt als schon vorhanden, wenn Buchungsdatum, Betrag und IBAN der Gegenseite gleich
sind. Ohne IBAN vergleicht MBM den Namen der Gegenseite, ohne Groß- und Kleinschreibung, Akzente,
Leer- und Satzzeichen. Der Verwendungszweck zählt nicht, weil Exporte ihn oft unterschiedlich
aufbereiten. So kannst du dieselbe Datei auch zweimal importieren, ohne etwas doppelt zu haben.

## Kategorien

Hat die Datei eine Kategorie-Spalte (etwa `Wohnen\Miete`), übernimmt MBM sie. Fehlende Kategorien
legt es auf Wunsch an. Zeilen ohne Kategorie laufen durch die [Regeln](kategorien-regeln.md#regeln).

## Rückgängig machen

Unter **Einstellungen → Importe** steht jeder Import mit Datei, Zeitpunkt, Benutzer und Anzahl.
„Rückgängig“ löscht die Umsätze dieses Imports, die noch da sind.

![Einstellungen, Importe: ein Import mit Datei und Anzahl](../assets/screenshots/einstellungen-importe-dark.png)

*Einstellungen → Importe: jeder Import lässt sich rückgängig machen.*

Importierte Umsätze sind für die anderen Benutzer [neu](umsaetze.md#neue-umsätze), für den
Importierenden nicht.
