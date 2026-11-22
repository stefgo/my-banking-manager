<!--
The hand-written part of the next release: what is new, why it matters, and
what an upgrade needs. It is placed above the list of commits in the GitHub
release and in CHANGELOG.md.

Write below this comment. Use "###" for headings -- "##" is the level of the
version itself. A release with nothing written here is refused. A beta from
dev keeps the text; the stable release from main empties this file again.

Nothing inside an HTML comment is published.
-->

### Server-Log: Wer den Server entsperrt hat

Die Log-Zeilen `unlocked` und `unlocked with the recovery key` nennen jetzt die Benutzer-ID der
Anmeldung, die den Server entsperrt hat. Der Name steht bewusst nicht im Log, weil Logs nicht
verschlüsselt sind.

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
