<!--
The hand-written part of the next release: what is new, why it matters, and
what an upgrade needs. It is placed above the list of commits in the GitHub
release and in CHANGELOG.md.

Write below this comment. Use "###" for headings -- "##" is the level of the
version itself. A release with nothing written here is refused. A beta from
dev keeps the text; the stable release from main empties this file again.

Nothing inside an HTML comment is published.
-->

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
