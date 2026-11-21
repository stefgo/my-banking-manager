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

- Der CSV-Import übernimmt die Umsatzart. Bei vorhandenen Umsätzen ergänzt er sie, wenn sie noch
  fehlt, und überschreibt nie eine vorhandene.

### Behoben

- Die Details eines Umsatzes schließen sich jetzt, wenn du die Seite verlässt.
- Der CSV-Import hält Spalten wie „Umsatzart“ oder „Buchungstext“ nicht mehr für Betrag oder Datum.
