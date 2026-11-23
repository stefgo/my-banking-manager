<!--
The hand-written part of the next release: what is new, why it matters, and
what an upgrade needs. It is placed above the list of commits in the GitHub
release and in CHANGELOG.md.

Write below this comment. Use "###" for headings -- "##" is the level of the
version itself. A release with nothing written here is refused. A beta from
dev keeps the text; the stable release from main empties this file again.

Nothing inside an HTML comment is published.
-->

### Umsätze: Rücklastschriften erkennen und richtig auswerten

MBM erkennt jetzt, wenn die Bank eine Lastschrift zurückgibt, und verknüpft die Rückbuchung mit der
ursprünglichen Buchung.

- Die Rückbuchung nennt die richtige Gegenseite und übernimmt die Kategorie der Lastschrift.
- In den Details stehen der Rückgabegrund und ein Sprung zur anderen Buchung.
- Ein verknüpftes Paar zählt nicht mehr in „Eingänge und Ausgaben“ und in den Kategoriesummen, auch
  über Monatsgrenzen. Die Zahlen des ursprünglichen Monats sinken also, sobald die Rückgabe eintrifft.
  Saldo und Umsatzliste bleiben unverändert.
- Eine zurückgekommene Buchung bestätigt keine Überweisung mehr als ausgeführt.
- Vorhandene Rücklastschriften werden beim nächsten Abruf oder Import des Kontos verknüpft.

### Import: Umsätze ohne Gegenseite genauer erkennen

Fehlt bei einem Vergleich der Name der Gegenseite, gilt ein Umsatz nicht mehr automatisch als schon
vorhanden. Der Verwendungszweck aus der Datei muss jetzt im Verwendungszweck des Umsatzes in MBM
enthalten sein. Das gilt auch, wenn die Bank später einen Umsatz liefert, der schon aus einer Datei da
ist.

### Kontenliste: Laufende Aktualisierung sichtbar

Während eines Abrufs dreht sich neben jedem betroffenen Konto ein Symbol. Liegt das Konto in einer
zugeklappten Gruppe, steht das Symbol an der Gruppe. Nach einer unterbrochenen Verbindung holt MBM den
aktuellen Stand der Abrufe nach, sodass kein Symbol hängen bleibt.

### Server-Log: Wer den Server entsperrt hat

Die Log-Zeilen `unlocked` und `unlocked with the recovery key` nennen jetzt die Benutzer-ID der
Anmeldung, die den Server entsperrt hat. Der Name steht bewusst nicht im Log, weil Logs nicht
verschlüsselt sind. Im Terminal stehen solche Angaben jetzt in derselben Zeile, zum Beispiel
`unlocked (userId: 1)`.

### Docker: Start mit Terminal

Läuft der Container mit Terminal (`docker run -t` oder `tty: true`), startet der Server jetzt
zuverlässig und schreibt sein Log wie gewohnt als JSON.

### Umsätze: Details schließen sich mit der Auswahl

Wechselst du das Konto oder änderst Suche oder Filter und der geöffnete Umsatz steht nicht mehr in
der Liste, schließen sich seine Details. Bleibt er in der Liste, bleiben sie offen.

### Import: Saldo von Bankkonten bleibt richtig

Importierst du ältere Umsätze in ein Bankkonto, bleibt der heutige Saldo jetzt auf dem Stand der Bank,
und der Verlauf stimmt sofort. Das gilt auch, wenn du einen Import rückgängig machst.

- Liefert die Bank einen Umsatz, der schon aus einer Datei da ist, steht er nicht mehr doppelt in der
  Liste. Er behält seine Kategorie und lässt sich nicht mehr über „Import rückgängig“ entfernen.
- Vorgemerkte Zeilen aus einer Datei übernimmt MBM bei Bankkonten nicht mehr, weil die Bank sie selbst
  liefert.
- Schon vorhandene doppelte Umsätze bleiben bestehen. Du kannst den betroffenen Import rückgängig
  machen und die Datei neu einspielen.

### Import: Kategorien direkt in der Zeilenauswahl entscheiden

Im Schritt „Prüfen“ entscheidest du jetzt je Zeile, ob eine abweichende Kategorie ersetzt wird. Die
Sammeloption „abweichende Kategorien überschreiben“ entfällt.

- Abweichende Kategorien stehen im Filter **Abweichend** und sind anfangs nicht gewählt, deine
  Kategorie bleibt also erhalten.
- Vorhandene Umsätze **ohne Kategorie** bekommen die Kategorie aus der Datei jetzt als normale
  Ergänzung. Wenn du das nicht möchtest, wählst du die Zeile ab.
- Bei einer Zeile mit abweichender Kategorie und leeren Angaben entscheidest du in den Details getrennt
  über beides.
