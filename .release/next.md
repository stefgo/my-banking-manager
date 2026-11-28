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
- **Konten in den Einstellungen:** Unter Einstellungen → Konten hat jedes Konto jetzt das Menü
  aus der Seitenleiste („…“ oder Rechtsklick): umbenennen direkt in der Zeile, Symbol und Farbe
  (auch per Klick auf das Symbol), Infos, bei Offline-Konten Anfangssaldo, Saldo abgleichen,
  Importieren und Löschen.
- **Kontoauswahl:** Beim Importieren von Umsätzen, in einer Buchung von Hand und in der
  Gegenbuchung stehen die Konten in derselben Reihenfolge wie in der Seitenleiste.

- **Gelöschte endgültig löschen:** Einen gelöschten Umsatz aus einem CSV-Import kannst du unter
  Einstellungen → Gelöschte oder in seinen Details jetzt endgültig löschen. Er lässt sich dann nicht
  mehr wiederherstellen, und ein erneuter Import derselben Datei bringt ihn als neuen Umsatz wieder.
  Bank-Umsätze und Umsätze in PayPal-Konten bleiben ausgenommen.

### Behoben

- **Gelöschte wiederherstellen:** Stellst du einen gelöschten Umsatz wieder her, schließen sich
  seine Details, auch beim Wiederherstellen aus der Liste unter Einstellungen → Gelöschte. Bisher
  blieben sie offen.
- **Gelöschte, Spalten:** Unter Einstellungen → Gelöschte stehen Betrag, „Wiederherstellen“ und
  „Endgültig löschen“ jetzt über alle Konten hinweg untereinander, auch wenn ein Umsatz nicht
  endgültig gelöscht werden kann.

- **Importe entfernen:** „Entfernen“ und „Rückgängig“ unter Einstellungen → Importe fragen jetzt
  nach, wenn dabei gelöschte Umsätze des Imports endgültig verschwinden. Bisher entfernte
  „Entfernen“ sie ohne Hinweis, und ein erneuter Import brachte sie wieder.

- **Neue Umsätze:** Gelöschte Umsätze zählen nicht mehr als neu, weder in der Zahl an
  „Umsätze“ und an den Konten noch bei der Suche `ist:neu`. Sie lassen sich auch nicht mehr als
  neu markieren.

- **Mehrere PayPal-Konten:** Ein PSD2-Zugang hält jetzt mehrere Freigaben, bei PayPal eine je
  Konto. „Weiteres Konto freigeben“ beim Bankzugang fügt ein zweites PayPal-Konto hinzu, ohne die
  Freigabe des ersten zu beenden. Bisher ersetzte eine neue Freigabe die alte, und das erste Konto
  ließ sich nicht mehr abrufen. Jedes Konto zeigt, bis wann seine Freigabe gilt; ist sie
  abgelaufen, überspringt der Abruf nur dieses Konto. Hast du ein zweites PayPal-Konto schon so
  eingerichtet, gib nach dem Update einmal „Weiteres Konto freigeben“ und melde dich mit dem
  ersten Konto an.
- **Bank über PSD2:** Beim Einrichten eines weiteren PSD2-Zugangs steht jede eigene
  Enable-Banking-Anwendung nur noch einmal zur Auswahl („Anwendung (App ••••de23)“, darunter die
  Banken, die sie schon nutzen), statt einmal je bestehendem Zugang.
- **CSV-Import:** Umsätze, bei denen die Bank die Gegenseite nur mit einer Kontonummer nennt (etwa
  Darlehenszinsen), erkennt der Import jetzt als vorhanden, wenn die Kontonummern gleich sind. Er
  liest Kontonummer und BLZ wie der Abruf von der Bank, speichert sie bei neuen Umsätzen und ergänzt
  sie bei vorhandenen ohne IBAN. Eine BLZ gilt nicht mehr als BIC; auch bei Überweisungen muss eine
  BIC mit sechs Buchstaben beginnen.
