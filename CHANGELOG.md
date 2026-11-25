## [0.6.0](https://github.com/stefgo/my-banking-manager/compare/v0.5.0...v0.6.0) (2026-11-25)

### Neu

- Die Suche und Regeln finden die Umsatzart der Bank mit `umsatzart:` (kurz `art:`, englisch `type:`), etwa `umsatzart:lastschrift`. Ein Wort ohne Feld sucht weiterhin nicht in der Umsatzart, bestehende Regeln treffen also dieselben Umsätze wie bisher.
- Die Details eines Umsatzes zeigen neben der Referenz (End-to-End) auch die **Kundenreferenz** (KREF) und die **Bankreferenz**, soweit die Bank sie beim Abruf liefert. Die Kundenreferenz kommt aus `KREF+` im Verwendungszweck oder bei camt aus der Referenz des Auftrags (`PmtInfId`). Bereits gespeicherte Umsätze bekommen die Bankreferenz beim Update; die Kundenreferenz nur, wenn ein Abruf sie noch einmal holt, also ab zwei Wochen vor dem letzten Abruf.
- Importformate ordnen unter **Zahlungsdetails** neben der End-to-End-Referenz auch die **Kundenreferenz** und die **Bankreferenz** je einer eigenen Spalte zu. Für jede Referenz stellst du ein, in welchen Referenzen eines vorhandenen Umsatzes MBM nachsieht, ob ihr Wert schon da ist. Mischt eine Datei die Arten in einer Spalte (etwa `Referenz:` bei MoneyMoney), steht ein Wert, den ein Umsatz schon als Kunden- oder Bankreferenz hat, nicht mehr zusätzlich als End-to-End-Referenz da. Das gilt anfangs für alle Formate, auch die gespeicherten; das bisherige Feld „Referenz“ heißt jetzt „End-to-End-Referenz“.

### Verbessert

- Konten mit seltenen Buchungen verlangen beim Abruf nicht mehr jedes Mal eine Freigabe in der App: Ein Abruf beginnt jetzt zwei Wochen vor dem letzten Abruf des Kontos statt zwei Wochen vor seiner neuesten Buchung, die Monate zurückliegen kann. Nach dem Update gilt für jedes Konto beim ersten Abruf noch die alte Regel.
- Das Fenster „Abruf“, das sich für eine Freigabe öffnet, schließt sich nach einem erfolgreichen Abruf von selbst; das Ergebnis meldet wie gewohnt eine Nachricht. Offen bleibt es nur, wenn es etwas zu lesen gibt, etwa neue oder fehlende Konten bei der Bank. Statt „Alle abrufen“ bietet es bei einem fehlgeschlagenen Abruf „Erneut abrufen“ für diesen Bankzugang an.
- Über der Umsatzliste steht nicht mehr die Zeile mit Anzahl und Summe der Umsätze. Die Summe einer Kategorie zeigt weiterhin ihr Kopf.
- In den Details eines Umsatzes steht sein Name rechts neben dem Symbol der Kategorie statt darunter.
- Suchfeld und Filter der Umsatzliste bleiben beim Scrollen am oberen Rand stehen, auch am Handy unter der oberen Leiste.

### Behoben

- Das X zum Leeren der Suche in der Umsatzliste sitzt mittig in seinem Kreis.
- Wählst du in der Umsatzliste über das Symbol eines Umsatzes eine Kategorie, öffnen sich nicht mehr zusätzlich die Details des Umsatzes.
- In den Details eines Umsatzes bricht eine Kategorie mit langem Namen oder Pfad sauber um: bevorzugt zwischen den Ebenen, das Feld wächst mit, und die Auswahlliste ist mindestens so breit wie das Feld.

### Features

* **abruf:** ab dem letzten Abruf des Kontos statt ab der neuesten Buchung ([90da434](https://github.com/stefgo/my-banking-manager/commit/90da434f2b80b87b2d567b529cd90afc8e8b151d))
* **import:** Kunden- und Bankreferenz zuordnen und vorhandene Referenzen prüfen ([517acea](https://github.com/stefgo/my-banking-manager/commit/517acea18167663307dcaadbe5e81e5583410bf8))
* **umsätze:** Kundenreferenz und Bankreferenz speichern und anzeigen ([de8b440](https://github.com/stefgo/my-banking-manager/commit/de8b440d477d336750e1086c9ded21b074e498f1))
* **umsätze:** nach Umsatzart suchen ([95e53e4](https://github.com/stefgo/my-banking-manager/commit/95e53e40a210d9d44dc11e2a9f68286ece1c4fe7))
* **umsätze:** Name neben dem Symbol und voller Kategoriepfad in den Details ([dd4b8aa](https://github.com/stefgo/my-banking-manager/commit/dd4b8aaf8c0000f793b25017d6ee1a763e76867e))
* **umsätze:** Suche und Filter bleiben beim Scrollen oben stehen ([8fac2ca](https://github.com/stefgo/my-banking-manager/commit/8fac2ca48adda715b3340f4216f5cd92ba051c1c))
* **umsätze:** Zeile mit Anzahl und Summe über der Umsatzliste entfernen ([fd3542a](https://github.com/stefgo/my-banking-manager/commit/fd3542a2c034a7bdc6de3f7514fae3ef824a5a6c))

### Bug Fixes

* **abruf:** Fenster „Abruf“ nach erfolgreichem Abruf schließen ([114b63f](https://github.com/stefgo/my-banking-manager/commit/114b63f6eb6bfaf98f508520f0a22930c79acce0))
* **umsätze:** Kategorieauswahl öffnet nicht mehr die Details des Umsatzes ([3704082](https://github.com/stefgo/my-banking-manager/commit/3704082fbf72b0874393a25413640b597b9d47e3))
* **umsätze:** X zum Leeren der Suche mittig im Kreis ([afa7e83](https://github.com/stefgo/my-banking-manager/commit/afa7e8352fb78d7074c4d6a64e5d7346a78f893d))

## [0.5.0](https://github.com/stefgo/my-banking-manager/compare/v0.4.0...v0.5.0) (2026-11-24)

### Regeln können jetzt mehr

- Regeln ändern neben der Kategorie auch die angezeigte Gegenseite und den Verwendungszweck. Muster, Trennzeichen und Trennwörter lösen dafür Teile wie Händler, Ort oder Rechnungsnummer aus dem Text.
- Regeln gelten für alle oder für ausgewählte Konten. Je Umsatz wirkt die erste passende Regel.
- „Regeln ausführen“ zeigt jede Änderung zur Prüfung und schreibt nur, was du übernimmst. Gibt es nichts zu ändern oder ist nichts gewählt, beendest du den Lauf ohne Änderung.
- Jede Regel lässt sich über ihr Menü „…“ einzeln ausführen, dort liegen jetzt alle ihre Aktionen. Neue Regeln legst du über „Regel hinzufügen“ oben rechts an.
- „Speichern“ ändert nur die Regel. „Speichern & ausführen“ wendet sie danach auf vorhandene Umsätze an, und die Ausführen-Seite zeigt zuerst, was die Regel tut und wie viele Umsätze sie trifft.
- Die Details zeigen die Originaldaten der Bank. Dort kannst du das Original wieder verwenden oder einen eigenen Text setzen. Überweisungen nutzen immer die Daten der Bank.

### Zugang und Sicherheit neu geordnet

- Die Einstellungen trennen jetzt, wen etwas betrifft: **Profil** (nur du), **Benutzer** (andere) und **System** (alle). „Geräte“ und „Sicherheit“ gehen darin auf, alte Links führen weiter.
- Eigenes Passwort und eigenen Authenticator änderst du im Profil mit Passwort und Code. Der bisherige Authenticator gilt, bis der neue bestätigt ist, und du bleibst dabei angemeldet.
- „Zugang wiederherstellen“ auf dem Anmeldebildschirm hilft jetzt auch, wenn das Telefon fehlt oder Passwort und Telefon fehlen. Bisher kam ein einzelner Benutzer ohne Telefon auch mit dem Wiederherstellungsschlüssel nicht mehr hinein.
- Ein neuer Wiederherstellungsschlüssel braucht jetzt Passwort und Code, weil er den bisherigen für alle Benutzer ersetzt.
- Behoben: Das eigene Passwort über die Benutzerliste zu setzen löschte die gespeicherten Bank-Anmeldedaten. Dasselbe konnte passieren, wenn sich MBM während einer Passwortänderung sperrte.

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

### ⚠ BREAKING CHANGES

* **einstellungen:** changePassword und newRecoveryKey verlangen einen
TOTP-Code. setUserPassword und resetUserTotp lehnen das eigene Konto mit
409 self ab. recover antwortet mit RecoverResponse.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
* **regeln:** Regel-Routen der API ändern sich. previewRules liefert
Änderungen je Feld mit Prüfsumme, applyRules verlangt mode und planHash.
Rule hat neue Felder, categoryId darf null sein.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

### Features

* **einstellungen:** Benutzer über den Seitenkopf hinzufügen ([d32398e](https://github.com/stefgo/my-banking-manager/commit/d32398e16455423001b09d592f212685ff66897b))
* **einstellungen:** Zugang und Sicherheit nach Wirkung neu ordnen ([60b8da2](https://github.com/stefgo/my-banking-manager/commit/60b8da28627236b253b0f182578428b9e5461643))
* **regeln:** Speichern und Ausführen von Regeln trennen ([a9d3055](https://github.com/stefgo/my-banking-manager/commit/a9d30557c6f103f7a8ecc093611baf42fd5fd2e3))
* **regeln:** Umsätze regelbasiert anpassen und Regeln geprüft ausführen ([2e3650b](https://github.com/stefgo/my-banking-manager/commit/2e3650b6f7ce3b8e7ddef6e3b9504e009b7e4b28))

### Bug Fixes

* **regeln:** Prüfung auch ohne gewählte Änderungen beenden ([62441ec](https://github.com/stefgo/my-banking-manager/commit/62441eca725968fab10abfa39c46e112af8f1663))

## [0.4.0](https://github.com/stefgo/my-banking-manager/compare/v0.3.0...v0.4.0) (2026-11-23)

### Umsätze: Kontokopf in schmalen Fenstern

Passt die IBAN oder Kontonummer nicht mehr in eine Zeile, entfällt im Kopf der Umsatzliste das Symbol.
Kontodaten und Kontostand stehen dann untereinander, sodass die Nummer nicht mehr umbricht. Auf sehr
schmalen Displays laufen die Umsatzseite und die Regeln in den Einstellungen außerdem nicht mehr
seitlich über, und die Kategorie im Regel-Formular bleibt in einer Zeile.

### Umsätze: Liste bleibt beim Öffnen der Details stehen

Öffnest oder schließt du die Details eines Umsatzes, bleibt die ausgewählte Zeile an ihrer Stelle,
auch wenn Kopfbereich und Filter dabei umbrechen. Mit `J` und `K` scrollt die Liste jetzt immer mit,
die aktuelle Zeile bleibt vollständig sichtbar.

### Umsätze: Buchungen ohne IBAN richtig anzeigen

MBM übernimmt jetzt genauer, was die Bank zu Buchungen ohne IBAN liefert.

- Nennt die Bank statt der IBAN eine Kontonummer oder BLZ, stehen sie in den Details. Bei vorhandenen
  Umsätzen kommen sie mit dem nächsten Abruf dazu, solange die Bank den Umsatz noch liefert.
- Eine Sammelbuchung zeigt die Gesamtsumme mit der Anzahl der Posten. Sie steht nicht mehr unter Name
  und IBAN des ersten Empfängers. Vorhandene Sammelbuchungen korrigiert der nächste Abruf, ihre
  Kategorie bleibt. Was die Bank nicht mehr liefert, bleibt unverändert.
- Eine vorgemerkte Buchung ohne Namen gibt Kategorie und Gelesen-Status nicht mehr an eine fremde
  Buchung mit gleichem Betrag weiter.

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

### Features

* **import:** Kategorien beim Prüfen je Zeile entscheiden ([2c210f4](https://github.com/stefgo/my-banking-manager/commit/2c210f4d679efcecbaab1d38959eae79e96a06a9))
* **konten:** Laufende Aktualisierung in der Kontohierarchie anzeigen ([de678ad](https://github.com/stefgo/my-banking-manager/commit/de678adf243ba0df44e8c5bbc1467901c024fbe5))
* **server:** Benutzer-ID beim Entsperren ins Log schreiben ([4a82bfd](https://github.com/stefgo/my-banking-manager/commit/4a82bfd92b96cd9d57b0cf761dd2ce65e0f7f518))
* **server:** Log-Felder im Terminal in einer Zeile ausgeben ([5a3107f](https://github.com/stefgo/my-banking-manager/commit/5a3107f65a6b8b6903c0fd3eaba6cd58044e6cb4))
* **umsätze:** Rücklastschriften erkennen und verrechnen ([3e823e3](https://github.com/stefgo/my-banking-manager/commit/3e823e35abfb67a7efb7d353bd8440985e281d80))

### Bug Fixes

* **import:** Doppelten Hinweis auf Abweichungen aus der Leiste entfernen ([22dc9ec](https://github.com/stefgo/my-banking-manager/commit/22dc9ece53db57ca686cfa1407248d07b4aa115f))
* **import:** Saldo von Bankkonten beim Import korrekt halten ([0a8ab25](https://github.com/stefgo/my-banking-manager/commit/0a8ab252e7ccf9f0ce724a5f4415dcc1a7b2e788))
* **import:** Umsätze ohne Gegenseite über den Verwendungszweck vergleichen ([3117b99](https://github.com/stefgo/my-banking-manager/commit/3117b99075351d1d23a721927215fdba3e519af4))
* **umsätze:** Buchungen ohne IBAN richtig abbilden ([5375626](https://github.com/stefgo/my-banking-manager/commit/5375626913411c81af0a2b1906526052adcc587a))
* **umsätze:** Details nur bei gültiger Auswahl anzeigen ([6f29535](https://github.com/stefgo/my-banking-manager/commit/6f2953579bd34e404667160606f9292c3ba01bdb))
* **umsätze:** Kontokopf und Überlauf in schmalen Fenstern beheben ([ad8c4e5](https://github.com/stefgo/my-banking-manager/commit/ad8c4e51f04fb261a1a580a06a1ac2dae3d3cd66))
* **umsätze:** Zeile beim Öffnen der Details an ihrer Stelle halten ([38d880f](https://github.com/stefgo/my-banking-manager/commit/38d880f92a100e081f97de71ac30e2b62a1665e0))

## [0.3.0](https://github.com/stefgo/my-banking-manager/compare/v0.2.0...v0.3.0) (2026-11-21)

### Neu

- Der CSV-Import arbeitet mit **Importformaten**: Du legst Trennzeichen und Trennwörter in bis zu
  fünf Stufen fest, ordnest die Teile den Feldern zu und speicherst das Format. Die Standardformate
  „MoneyMoney (CSV)“ und „Sparkasse CSV-CAMT“ sind dabei und werden anhand der Kopfzeile erkannt.
  Formate bearbeitest du auch direkt unter Einstellungen → Importe, mit oder ohne Beispieldatei.
  Alle Bereiche des Editors sind dabei zu Beginn aufgeklappt, und ein Standardformat übernimmst du
  mit „Als neues Format speichern“. Die Beispielzeile zeigt alle Spalten der Datei und daneben das
  Ergebnis des Imports.
- Der Import ist jetzt eine eigene, übersichtliche Seite mit den Schritten Datei, Format, Konto und
  Prüfen. Ein erkanntes Format ist vorgewählt und wird von dir bestätigt. Beim Prüfen filterst und
  durchsuchst du die Zeilen und wählst einzeln, was du übernimmst. Bei abweichenden Kategorien und
  zu ergänzenden Angaben siehst du den aktuellen Wert neben dem aus der Datei und ob der Import ihn
  übernimmt.
- Umsätze zeigen jetzt auch Referenz, Mandat, Gläubiger-ID und BIC, aus dem Bankabruf wie aus dem
  Import.
- Der CSV-Import übernimmt die Umsatzart. Bei vorhandenen Umsätzen ergänzt er sie und die neuen
  Angaben, wenn sie noch fehlen, und überschreibt nie vorhandene.

### Wichtig beim Update

- Das Format „MoneyMoney (CSV)“ speichert als Verwendungszweck nur den freien Text. Regeln, die dort
  nach Text wie `Umsatzart: Lastschrift` suchen, greifen bei neu importierten Umsätzen nicht mehr.

### Geändert

- Das Menü eines Bankkontos ist aufgeräumt: „Importieren“ und „Vom Bankzugang lösen“ stehen dort
  nicht mehr. Importieren geht weiter über Einstellungen → Importe oder die Befehlspalette, das
  Lösen über Einstellungen → Konten.
- Das Menü der Online-Dokumentation ist übersichtlicher: Gruppen und Einträge sind klar abgesetzt,
  die geöffnete Seite ist hervorgehoben, und die Seiten stehen in einer sinnvolleren Reihenfolge.
  „Betrieb im Detail“ heißt jetzt „Technische Details“.

### Behoben

- Die Details eines Umsatzes schließen sich jetzt, wenn du die Seite verlässt.
- Der CSV-Import hält Spalten wie „Umsatzart“ oder „Buchungstext“ nicht mehr für Betrag oder Datum.

### Features

* **import:** Beispielzeile zeigt alle Spalten als einfache Liste ([e0268a3](https://github.com/stefgo/my-banking-manager/commit/e0268a311d8027eea4a2598f28dbd0392a16e6f5))
* **import:** Format-Editor mit offenen Karten und allen Spalten ([c737cb5](https://github.com/stefgo/my-banking-manager/commit/c737cb53dd3246462d801bdd1b2f99bf9e8fbbdc))
* **import:** Import als eigene Seite und Formate in den Einstellungen ([3746db5](https://github.com/stefgo/my-banking-manager/commit/3746db52067ef433a53c7012f9c26ec097bdcad9))
* **import:** Importformate mit Stufen und Standardformaten ([767ffc1](https://github.com/stefgo/my-banking-manager/commit/767ffc17e60e9b353055c691253680b0b2e971e8))
* **import:** Umsatzart aus CSV-Dateien übernehmen ([ba1c76a](https://github.com/stefgo/my-banking-manager/commit/ba1c76aa6cb43fbb10e8f6ecb81a57b0623a0bbe))
* **import:** Vier klare Schritte und Zeilenauswahl beim Prüfen ([5de0502](https://github.com/stefgo/my-banking-manager/commit/5de05027f53b6e5ad504bed252d4536f1e01166e))
* **import:** Vorher und Nachher beim Prüfen anzeigen ([55b1c91](https://github.com/stefgo/my-banking-manager/commit/55b1c91289263a3d8518ef7f5bd20ef54300394d))
* **konten:** Menü von Bankkonten aufräumen ([19eb4c8](https://github.com/stefgo/my-banking-manager/commit/19eb4c8feadc8373d4262d1d7a36e61be65540c8))

### Bug Fixes

* **umsätze:** Details schließen sich beim Verlassen der Seite ([65d7d09](https://github.com/stefgo/my-banking-manager/commit/65d7d09335a59870dc9aa10f6bccfd225ef0d635))

## [0.2.0](https://github.com/stefgo/my-banking-manager/compare/v0.1.0...v0.2.0) (2026-11-21)

### Verbessert

- **Umsätze:** Die Details zeigen die Umsatzart der Bank („Kartenzahlung“, „Lastschrift“ …).
- **Umsätze:** Meldet die Bank einen abweichenden Empfänger oder Auftraggeber, etwa den Händler
  einer Kartenzahlung statt der abwickelnden Landesbank, zeigt MBM ihn in Liste und Titel. Der
  Abwickler steht in den Details als „Kontoinhaber“; `gegenseite:` und Regeln finden beide Namen.
  Beides gilt für Umsätze, die ab dieser Version abgerufen werden; schon gespeicherte bleiben, wie
  sie sind.
- **CSV-Import:** Die Vorschau zeigt bei schon vorhandenen Umsätzen, wenn die Datei eine andere
  Kategorie nennt („bisher: … → Datei: …“). Auf Wunsch übernimmt MBM die Kategorie aus der Datei;
  aufgeteilte Buchungen bleiben unverändert.
- **CSV-Import:** Unter Einstellungen → Importe startest du über „CSV importieren“ direkt einen
  neuen Import; das Konto wählst du im Dialog.
- **Offline-Konten:** Unter Einstellungen → Konten öffnet der Knopf neben einem Offline-Konto jetzt
  den CSV-Import für dieses Konto (statt „Buchung erfassen“).
- **CSV-Import:** Die Liste der zu importierenden Umsätze ist nur so hoch, dass der ganze Dialog
  ins Fenster passt; „Importieren“ bleibt ohne Scrollen erreichbar.
- **Bankzugang einrichten:** Im Schritt „Konten übernehmen“ scrollt bei vielen Konten nur die
  Liste; Gruppe und „Konten übernehmen“ bleiben im Fenster sichtbar.
- **Umsätze:** Bei einer Kategorie zeigen die Tage in der Umsatzliste keinen Saldo mehr, nur die
  Tagessumme. Der Saldo der Konten passte dort nicht zu den gezeigten Buchungen.
- **Suche und Regeln:** Die Hilfe zur Suchsyntax nennt jetzt auch `AND`, `OR` und `NOT`; sie
  funktionierten schon bisher wie `UND`, `ODER` und `NICHT`.
- **Suche und Regeln:** Die Felder gibt es jetzt auch mit englischen Namen: `counterparty:`,
  `purpose:`, `account:`, `category:` (`cat:`), `amount:`, `date:` und `is:new`, ebenso die
  Zeiträume (`today`, `lastmonth`, `-30d`, `-1y` …).
- **Regeln:** Nach „Regel anlegen“ wird neben der Abfrage auch die gewählte Kategorie
  zurückgesetzt.
- **Bankzugang einrichten:** Der Schritt „TAN-Verfahren wählen“ erklärt jetzt, wozu die Auswahl
  dient, kennzeichnet das empfohlene Verfahren und sagt, wann die Bank nach einem Gerät oder einer
  Freigabe fragt.
- **Symbol und Farbe:** Das Fenster bleibt immer ganz im Browserfenster. In der Seitenleiste öffnet
  es sich jetzt neben dem Symbol statt darunter.

### Features

* **bankzugang:** Schritt „TAN-Verfahren wählen“ verständlicher machen ([59608d0](https://github.com/stefgo/my-banking-manager/commit/59608d08abf9fb8b2da7090d24cbd5eae3172ad7))
* **import:** abweichende Kategorien vorhandener Umsätze zeigen und überschreiben ([e321b36](https://github.com/stefgo/my-banking-manager/commit/e321b369a0cadc8ea9edd64cb8348362b8bffdf5))
* **import:** CSV-Import aus Einstellungen → Importe starten ([bec3081](https://github.com/stefgo/my-banking-manager/commit/bec30818c12ce7027f5e1afd2005783c2b726d7e))
* **konten:** Offline-Konten in den Einstellungen mit Knopf „Buchungen importieren“ ([ad34716](https://github.com/stefgo/my-banking-manager/commit/ad34716903a89279d2f55cce23419678383aa526))
* **suche:** englische Feldnamen und Datumswörter ([8f74194](https://github.com/stefgo/my-banking-manager/commit/8f74194f6e304093dd7b95477fb272f2fe962e59))
* **umsätze:** Umsatzart und abweichenden Empfänger anzeigen ([5cba6c3](https://github.com/stefgo/my-banking-manager/commit/5cba6c33ec26f720b9a26b7e9ad7e6981ea9760d))

### Bug Fixes

* **bankzugang:** Kontenliste in „Konten übernehmen“ scrollt im Fenster ([f293060](https://github.com/stefgo/my-banking-manager/commit/f29306075a8397aedb6d413b9beef36e63c01571))
* **import:** Umsatzliste passt sich der Fensterhöhe an ([11d0154](https://github.com/stefgo/my-banking-manager/commit/11d0154968e0bb18897ef620314744ff793e02c0))
* **konten:** Fenster für Symbol und Farbe bleibt im sichtbaren Bereich ([ff41fb6](https://github.com/stefgo/my-banking-manager/commit/ff41fb66c88135eb672c102cea2a4e1a0a53f6b6))
* **regeln:** Kategorie nach dem Anlegen einer Regel zurücksetzen ([9a00880](https://github.com/stefgo/my-banking-manager/commit/9a008801ce5c5306441297d7b88dcc2daec30f20))
* **umsätze:** kein Saldo in den Tageszeilen bei Kategorien ([d10dca4](https://github.com/stefgo/my-banking-manager/commit/d10dca465608a46f04ae40645949f27402fd2162))

## 0.1.0 (2026-11-20)

### Erste Version

My Banking Manager ist ein Homebanking, das du selbst betreibst. Alle Daten liegen verschlüsselt
auf deinem eigenen Server. MBM verbindet sich selbst und direkt mit deiner Bank: Kein fremder
Dienstleister ruft deine Konten ab oder bekommt deine Zugangsdaten, deine Daten liegen auf keinem
Server eines Anbieters im Internet, und MBM sendet keine Nutzungsdaten (keine Telemetrie).

### Enthalten

- **Verschlüsselte Datenbank** (SQLite3 Multiple Ciphers, AES-256). Nach jedem Start ist MBM
  gesperrt, bis sich ein Benutzer anmeldet. Anmeldung mit Passwort und TOTP,
  Wiederherstellungsschlüssel, weitere Benutzer.
- **Bankzugänge über FinTS** mit eigenem Konnektor (getestet mit der Sparkasse, S-pushTAN):
  Konten übernehmen, Saldo und Umsätze abrufen, nur von Hand ausgelöst.
- **Offline-Konten** (Bargeld, Sparbuch, Depot …) mit Buchungen, Saldoabgleich und Gegenbuchungen.
- **Umsätze** mit Konten- und Kategorienbaum, Suche und Filtern, Kategorien und Regeln,
  **CSV-Import** in jedes Konto.
- **Neue Umsätze** sind markiert: ein Punkt in der Umsatzliste und die Anzahl neuer Umsätze an
  „Umsätze“ in der Seitenleiste und an jedem Konto. Gelesen ist ein Umsatz, sobald du seine Details
  öffnest; von Hand geht das in den Details, bei mehreren ausgewählten Umsätzen oder mit „Alle als
  gelesen markieren“ im Kontomenü. Die Suche `ist:neu` zeigt nur neue Umsätze.
- **Überweisen** mit Empfängerüberprüfung, Empfängerliste und Verlauf; **Aufträge**: Dauer- und
  Terminaufträge abrufen und ansehen.
- **Übersicht** aus Karten mit Saldoverlauf, Vorschau aus Aufträgen und „Demnächst“.
- **Ohne Bankverbindung** zeigen Übersicht, Umsätze, Überweisen und Aufträge denselben Hinweis mit
  „Bankverbindung einrichten“; Übersicht und Umsätze bieten zusätzlich ein Offline-Konto an.
- **Versionsanzeige** unten in den Einstellungen, für My Banking Manager und den FinTS-Konnektor.
- **Images** für amd64 und arm64:
  - `mbm-server-full`: Server, Web-Client und FinTS-Konnektor in einem Container
    (`compose.yaml`). Das offizielle Image eines Releases bringt die registrierte
    FinTS-Produkt-ID mit.
  - `mbm-server` und `mbm-fints`: Server und Konnektor in zwei Containern (`compose.split.yaml`).
    `mbm-fints` enthält keine Produkt-ID; du brauchst eine eigene (fints.org) in
    `MBM_FINTS_PRODUCT_ID`.

### Upgrade

Erste Version, kein Upgrade nötig. Einrichtung siehe README und `docs/operations.md`. Vor dem
ersten Einsatz das Backup von `/data` einrichten und den Wiederherstellungsschlüssel getrennt
aufbewahren. Ohne Docker brauchst du Node.js 26 oder neuer.
