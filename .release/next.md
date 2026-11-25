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

- **Hinweis auf eine neue Oberfläche:** Nach einem Update merkt ein offenes Browserfenster, dass der
  Server eine neue Version der Oberfläche ausliefert, und bietet **Neu laden** an. Vor der Anmeldung
  lädt es von selbst neu.

### Lizenz

- **FinTS-Produkt-ID ausgenommen:** Die neue Datei `NOTICE` stellt klar, dass die Produkt-ID in den
  offiziellen Images von `mbm-server-full` nicht unter der MIT-Lizenz steht. Du darfst sie nur mit dem
  unveränderten offiziellen Image nutzen. Alle Images enthalten jetzt `LICENSE` und `NOTICE` unter `/app/`.
