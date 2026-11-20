# Umsätze und Suche

Unter **Umsätze** stehen alle Buchungen. Links wählst du im **Kontenbaum** ein Konto oder eine
Gruppe, im **Kategorienbaum** eine Kategorie. Der Kopf zeigt dann Kontostand, IBAN und die
Aktionen dazu: Abrufen, Überweisen, Verlauf und Infos.

![Die Umsätze des Girokontos, nach Tagen mit Tagessumme und Saldo](../assets/screenshots/umsaetze-dark.png)

*Die Umsätze eines Kontos. Vorgemerkte stehen oben, darunter die gebuchten nach Tagen mit Tagessumme und Saldo.*

Bei einer Kategorie zeigen die Tage nur die Tagessumme; ein Saldo gehört zu Konten, nicht zu
Kategorien.

## Neue Umsätze

Was ein Abruf von der Bank bringt, ist für alle Benutzer **neu**; was jemand importiert, für alle
anderen. Neue Umsätze haben einen Punkt, und ihre Anzahl steht an „Umsätze“ in der Seitenleiste
und an jedem Konto.

Ein Umsatz gilt als gelesen, sobald du seine Details öffnest. Von Hand geht das mit
**Als neu markieren** in den Details, mit „Gelesen“ / „Als neu“ für mehrere ausgewählte Umsätze
oder mit **Alle als gelesen markieren** im Menü eines Kontos.

## Details eines Umsatzes

Ein Klick auf einen Umsatz öffnet die Details daneben: Kategorie (mit der Angabe, ob eine Regel
oder du sie gesetzt hast), Verwendungszweck, Daten, Konto und Herkunft.

![Die Details eines Umsatzes neben der Liste](../assets/screenshots/umsatz-details-dark.png)

*Die Details: Kategorie ändern, als neu markieren, kopieren oder eine Gegenbuchung in einem Offline-Konto anlegen.*

**Mehrere Umsätze** wählst du mit ++x++, ++cmd++-Klick oder ++shift++-Klick aus. Dann weist ++c++
ihnen eine Kategorie zu. Mit ++j++ und ++k++ gehst du durch die Liste, ++enter++ öffnet einen
Umsatz.

## Filter

Über der Liste stehen drei Filter: **Kategorien**, **Eingänge und Ausgaben** und **Zeitraum**
(dieser Monat, Vormonat, 30, 90 oder 365 Tage, alle). Die Liste zeigt die Anzahl und die Summe
aller passenden Umsätze. **Verlauf** im Kopf blendet den Saldoverlauf des gewählten Kontos ein.

## Suche

Das Suchfeld (++slash++) durchsucht Gegenseite, Verwendungszweck, IBAN, Betrag und Kategorie.
Das ⓘ daneben zeigt die ganze Syntax.

![Eine Suche nach einer Gegenseite mit einem Mindestbetrag](../assets/screenshots/suche-dark.png)

*`gegenseite:Frischemarkt betrag:>50`: alle Einkäufe dort über 50 €.*

| Eingabe | Findet |
|---|---|
| `rewe edeka` | beide Wörter (Leerzeichen = UND) |
| `rewe ODER edeka` | eines der Wörter |
| `NICHT paypal` · `-paypal` | ohne dieses Wort |
| `"rewe markt"` | genau diese Zeichenfolge |
| `Test*strasse` · `M??er` | `*` beliebig viele, `?` genau ein Zeichen |
| `gegenseite:rewe` · `zweck:miete` · `iban:DE89*` | nur in diesem Feld |
| `konto:giro` · `kategorie:Wohnen` | Konto oder Gruppe, Kategorie samt Unterkategorien |
| `ist:neu` | nur neue Umsätze |
| `>50` · `<=12,99` · `<-100` | Betrag; negativ heißt Ausgabe |
| `datum:3.2026` · `datum>=1.3.2026` | im März 2026, ab dem 1. März 2026 |
| `datum:-30t` · `-2w` · `-3m` · `-1j` | letzte 30 Tage, 2 Wochen, 3 Monate, 1 Jahr |
| `datum:vormonat` · `heute` · `woche` · `quartal` | relative Zeiträume, auch `vorwoche`, `vorjahr` … |

`UND`, `ODER` und `NICHT` (oder `AND`, `OR`, `NOT`) schreibst du in Großbuchstaben; Klammern
gruppieren. Ein Datum in der Suche ersetzt den Zeitraum-Filter. ++esc++ leert das Feld.

## Am Handy

![Die Umsätze des Girokontos am Handy](../assets/screenshots/handy-umsaetze-dark.png)

*Am Handy führt „Konten“ in der Tableiste zu Konten- und Kategorienbaum.*
