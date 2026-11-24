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
- Die Details eines Umsatzes zeigen neben der Referenz (End-to-End) auch die **Kundenreferenz** (KREF) und die **Bankreferenz**, soweit die Bank sie beim Abruf liefert. Die Kundenreferenz kommt aus `KREF+` im Verwendungszweck oder bei camt aus der Referenz des Auftrags (`PmtInfId`). Bereits gespeicherte Umsätze bekommen die Bankreferenz beim Update; die Kundenreferenz nur, wenn ein Abruf sie noch einmal holt, also ab zwei Wochen vor dem letzten Abruf.

### Verbessert

- Konten mit seltenen Buchungen verlangen beim Abruf nicht mehr jedes Mal eine Freigabe in der App: Ein Abruf beginnt jetzt zwei Wochen vor dem letzten Abruf des Kontos statt zwei Wochen vor seiner neuesten Buchung, die Monate zurückliegen kann. Nach dem Update gilt für jedes Konto beim ersten Abruf noch die alte Regel.
- Das Fenster „Abruf“, das sich für eine Freigabe öffnet, schließt sich nach einem erfolgreichen Abruf von selbst; das Ergebnis meldet wie gewohnt eine Nachricht. Offen bleibt es nur, wenn es etwas zu lesen gibt, etwa neue oder fehlende Konten bei der Bank. Statt „Alle abrufen“ bietet es bei einem fehlgeschlagenen Abruf „Erneut abrufen“ für diesen Bankzugang an.
