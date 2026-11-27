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
- **PayPal und weitere Banken über PSD2:** Unter „Konto hinzufügen → Bank über PSD2 (Enable
  Banking)“ richtest du Banken ohne FinTS ein, allen voran PayPal. MBM ruft sie über die
  PSD2-Schnittstelle ab, die jede Bank in der EU anbieten muss. Dazwischen steht der zugelassene
  Dienst Enable Banking, durch dessen Server die Umsätze dieser Banken laufen. Du brauchst dafür
  eine eigene, kostenlose Anwendung bei Enable Banking. Du gibst den Zugriff bei der Bank frei, und
  danach ruft MBM Saldo und Umsätze wie bei jeder Bank ab, nur lesend. Der erste Abruf holt so weit
  zurück, wie die Bank erlaubt (bei PayPal zwei Jahre). Die Freigabe gilt höchstens 180 Tage; zwei
  Wochen vorher erinnert MBM daran, und „Freigabe erneuern“ verlängert sie.
- **PayPal: woher das Geld kam.** PayPal meldet über PSD2 nur die Zahlung an den Händler, nicht die
  Abbuchung von deinem Bankkonto oder deiner Karte. MBM ergänzt sie nach der Regel „Guthaben
  zuerst“ als „Abbuchung von Bankkonto oder Karte“; Liste und Saldoverlauf des PayPal-Kontos stimmen
  damit. Ein Kauf mit **Später bezahlen** zählt einmal, am Tag des Kaufs; die Rückzahlung rund
  30 Tage später zählt nicht und trägt die Abbuchung. Auszahlungen aufs Bankkonto und Erstattungen zu
  abgelehnten Zahlungen zählen ebenfalls nicht als Einnahme oder Ausgabe. Sie alle bekommen die
  Vorbelegung für Gegenbuchungen (anfangs „Umbuchung“).
- **Import: nach Datum suchen:** Im Schritt „Prüfen“ findet die Suche Zeilen auch nach dem
  Buchungsdatum, mit derselben Schreibweise wie die Umsatzliste: `datum>=1.3.2026`,
  `datum<1.4.2026`, `datum:3.2026` oder `datum:vormonat`, auch zusammen mit Suchtext.
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
- **Rahmen des Felds „Wenn“:** Beim Bearbeiten einer Regel zeigte das Feld „Wenn“ beim Tippen
  einen zweiten Rahmen innerhalb des eigenen. Jetzt hat es wie die Suche nur einen.

### Upgrade

- Beim ersten Start räumt MBM die Datenbank auf (Migrationen 0011–0014). Es löscht dabei nichts:
  Sollte eine Buchung doppelt gespeichert sein, bleiben beide stehen, und nur die jüngere verliert
  ihren Abgleich mit der Bank. Ein bereits gelöstes Konto mit Kartennummer wird wieder eine
  Kreditkarte, andere Offline-Konten bekommen die Kontoart „Sonstiges“.
- Migration 0015 baut die Tabellen der Bankzugänge für PSD2 um. Bestehende FinTS-Zugänge bleiben,
  wie sie sind.
- Migration 0016 bereitet die ergänzten PayPal-Buchungen vor. Der erste Abruf eines PayPal-Kontos
  danach reicht einmal so weit zurück, wie PayPal erlaubt: Schon gespeicherte Umsätze bekommen ihre
  neue Umsatzart und Kategorie, keiner kommt doppelt. Eine selbst gewählte Kategorie bleibt.
- **Getrennte Container (`compose.split.yaml`):** Neu ist der Dienst `enablebanking` mit dem Image
  `mbm-enablebanking` (in der `.env`: `MBM_IMAGE_ENABLEBANKING`). Übernimm die neue
  `compose.split.yaml`, oder lass den Dienst und `MBM_ENABLEBANKING_SOCKET` weg, wenn du kein PSD2
  willst.
- **Enable Banking abschalten:** Im Image `mbm-server-full` ist der Konnektor eingebaut; mit
  `MBM_ENABLEBANKING_EMBEDDED=0` bietet MBM keine PSD2-Zugänge an und spricht nie mit Enable
  Banking.
- **API:** Die Kontoart `offline` gibt es nicht mehr. Ein Konto ist offline, wenn `connectionId`
  leer ist. Selbst angelegte Konten haben die neue Art `other`.

### Lizenz

- **FinTS-Produkt-ID ausgenommen:** Die neue Datei `NOTICE` stellt klar, dass die Produkt-ID in den
  offiziellen Images von `mbm-server-full` nicht unter der MIT-Lizenz steht. Du darfst sie nur mit dem
  unveränderten offiziellen Image nutzen. Alle Images enthalten jetzt `LICENSE` und `NOTICE` unter `/app/`.
