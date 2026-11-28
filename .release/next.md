<!--
The hand-written part of the next release: what is new, why it matters, and
what an upgrade needs. It is placed above the list of commits in the GitHub
release and in CHANGELOG.md.

Write below this comment. Use "###" for headings -- "##" is the level of the
version itself. A release with nothing written here is refused. A beta from
dev keeps the text; the stable release from main empties this file again.

Nothing inside an HTML comment is published.
-->

### Verbessert

- **Verlauf bei Kategorien:** Auch der Kopf einer Kategorie hat jetzt **Verlauf**. Balken und
  Linie zeigen die Summe der Kategorie je Tag, Monat, Quartal oder Jahr, „Eingänge und Ausgaben“
  beide getrennt. Kontofilter, Richtung und Zeitraum der Liste gelten mit, und ein Klick auf einen
  Wert springt in der Liste zu seinem Zeitraum.
- **Kontoauswahl:** Beim Importieren von Umsätzen, in einer Buchung von Hand und in der
  Gegenbuchung stehen die Konten in derselben Reihenfolge wie in der Seitenleiste.

### Behoben

- **Bank über PSD2:** Beim Einrichten eines weiteren PSD2-Zugangs steht jede eigene
  Enable-Banking-Anwendung nur noch einmal zur Auswahl („Anwendung (App ••••de23)“, darunter die
  Banken, die sie schon nutzen), statt einmal je bestehendem Zugang.
