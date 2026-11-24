<!--
The hand-written part of the next release: what is new, why it matters, and
what an upgrade needs. It is placed above the list of commits in the GitHub
release and in CHANGELOG.md.

Write below this comment. Use "###" for headings -- "##" is the level of the
version itself. A release with nothing written here is refused. A beta from
dev keeps the text; the stable release from main empties this file again.

Nothing inside an HTML comment is published.
-->

### Regeln können jetzt mehr

- Regeln ändern neben der Kategorie auch die angezeigte Gegenseite und den Verwendungszweck. Muster, Trennzeichen und Trennwörter lösen dafür Teile wie Händler, Ort oder Rechnungsnummer aus dem Text.
- Regeln gelten für alle oder für ausgewählte Konten. Je Umsatz wirkt die erste passende Regel.
- „Regeln ausführen“ zeigt jede Änderung zur Prüfung und schreibt nur, was du übernimmst. Gibt es nichts zu ändern oder ist nichts gewählt, beendest du den Lauf ohne Änderung.
- Jede Regel lässt sich über ihr Menü „…“ einzeln ausführen, dort liegen jetzt alle ihre Aktionen. Neue Regeln legst du über „Regel hinzufügen“ oben rechts an.
- „Speichern“ ändert nur die Regel. „Speichern & ausführen“ wendet sie danach auf vorhandene Umsätze an, und die Ausführen-Seite zeigt zuerst, was die Regel tut und wie viele Umsätze sie trifft.
- Die Details zeigen die Originaldaten der Bank. Dort kannst du das Original wieder verwenden oder einen eigenen Text setzen. Überweisungen nutzen immer die Daten der Bank.

### Geändertes Verhalten

- Buchungen von Hand durchlaufen Regeln nicht mehr von selbst, auch nicht beim Lösen einer Gegenbuchung.
- Eine verknüpfte Rücklastschrift erbt beim CSV-Import jetzt wie beim Abruf die Kategorie ihrer Buchung.
- Beim Löschen einer Kategorie bleiben Regeln mit weiteren Aktionen erhalten.
- Die Suche mit `*` und `?` kann den Server nicht mehr durch ungünstige Muster blockieren.
- Beim Ändern einer Buchung von Hand bleiben Felder, die nicht mitgesendet werden, jetzt erhalten.
- Überschrift und Beschreibung der Seiten für den Import und das Ausführen von Regeln nutzen jetzt in jedem Schritt die volle Breite.
- „Benutzer hinzufügen“ liegt jetzt wie bei Konten und Regeln oben rechts in den Einstellungen.

### Update

Die Datenbank wird beim Start migriert. Bestehende Regeln gelten unverändert für alle Konten, und kein Umsatz ändert sich dabei.
