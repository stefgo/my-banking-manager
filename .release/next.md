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

### Behoben

- Die Details eines Umsatzes schließen sich jetzt, wenn du die Seite verlässt.
- Der CSV-Import hält Spalten wie „Umsatzart“ oder „Buchungstext“ nicht mehr für Betrag oder Datum.
