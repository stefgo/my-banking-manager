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

- **Dauer- und Terminaufträge anlegen, ändern und löschen:** Im Dialog „Überweisen“ wählst du die
  Ausführung **Sofort**, **Am Datum** oder **Regelmäßig** (Turnus, Ausführungstag, erste und
  optional letzte Ausführung, mit Vorschau der nächsten Termine). Auf der Seite „Aufträge“ legst du
  über **Neuer Auftrag** einen an und änderst oder löschst einen Auftrag in seinen Details. Alles
  geht mit Empfängerüberprüfung und Freigabe wie eine Überweisung und nur so, wie deine Bank es für
  das Konto erlaubt. Danach ruft MBM die Aufträge neu ab; kam die Antwort der Bank nicht an, klärt
  der neue Bestand, ob der Auftrag angekommen ist.
- **Hinweis auf eine neue Oberfläche:** Nach einem Update merkt ein offenes Browserfenster, dass der
  Server eine neue Version der Oberfläche ausliefert, und bietet **Neu laden** an. Vor der Anmeldung
  lädt es von selbst neu.

### Behoben

- **Reihenfolge der Konten in den Einstellungen:** Unter „Einstellungen → Konten“ stehen die Konten
  eines Bankzugangs und die Offline-Konten jetzt in der Reihenfolge der Seitenleiste. Bisher waren
  Konten aus verschiedenen Gruppen durcheinander, sobald sie in mehreren Gruppen lagen.
- **Löschen ohne Wartezeit:** „Import rückgängig“, das Löschen eines Kontos und ein Abruf mit vielen
  vorgemerkten Umsätzen hielten den Server bei vielen Buchungen sekundenlang an. Jetzt geht das
  sofort.
- **Gelöste Kreditkarte bleibt Kreditkarte:** Löst du ein Konto von seinem Bankzugang, behält es
  seine Kontoart. Eine Kreditkarte zeigt also weiter ihre Kartennummer statt nur „Offline-Konto“.

### Upgrade

- Beim ersten Start räumt MBM die Datenbank auf (Migrationen 0011–0014). Es löscht dabei nichts:
  Sollte eine Buchung doppelt gespeichert sein, bleiben beide stehen, und nur die jüngere verliert
  ihren Abgleich mit der Bank. Ein bereits gelöstes Konto mit Kartennummer wird wieder eine
  Kreditkarte, andere Offline-Konten bekommen die Kontoart „Sonstiges“.
- **API:** Die Kontoart `offline` gibt es nicht mehr. Ein Konto ist offline, wenn `connectionId`
  leer ist. Selbst angelegte Konten haben die neue Art `other`.

### Lizenz

- **FinTS-Produkt-ID ausgenommen:** Die neue Datei `NOTICE` stellt klar, dass die Produkt-ID in den
  offiziellen Images von `mbm-server-full` nicht unter der MIT-Lizenz steht. Du darfst sie nur mit dem
  unveränderten offiziellen Image nutzen. Alle Images enthalten jetzt `LICENSE` und `NOTICE` unter `/app/`.
