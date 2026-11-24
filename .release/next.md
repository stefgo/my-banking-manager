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

- Die Suche und Regeln finden die Umsatzart der Bank mit `umsatzart:` (kurz `art:`, englisch `type:`), etwa `umsatzart:lastschrift`. Ein Wort ohne Feld sucht weiterhin nicht in der Umsatzart, bestehende Regeln treffen also dieselben Umsätze wie bisher.
