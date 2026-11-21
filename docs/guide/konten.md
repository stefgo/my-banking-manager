# Konten

MBM kennt zwei Arten von Konten: **Bankkonten**, deren Umsätze MBM über FinTS von der Bank holt,
und **Offline-Konten**, die du selbst führst. Beide legst du unter
**Einstellungen → Konto hinzufügen** an.

![Konto hinzufügen: Bank (FinTS) oder Offline-Konto](../assets/screenshots/konto-hinzufuegen-dark.png)

*Konto hinzufügen: ein Bankzugang über FinTS oder ein Offline-Konto.*

## Bankzugang einrichten

1. **Bank** suchen, nach Name, BLZ oder BIC; das Verzeichnis der Bundesbank kennt alle
   deutschen Banken. Dazu die **FinTS-Adresse**: Sie steht im Online-Banking deiner Bank, meist
   unter „Online-Banking-Software“ oder „HBCI/FinTS“, und beginnt mit `https://`.
2. **Anmeldename und PIN** deines Online-Bankings. „PIN speichern“ kannst du abwählen; dann fragt
   MBM bei jedem Abruf nach der PIN und speichert sie nirgends.
3. **TAN-Verfahren** wählen. Damit gibst du Abrufe und Überweisungen frei. MBM zeigt die Verfahren,
   die deine Bank dir anbietet, und empfiehlt eines mit Freigabe in der App, etwa S-pushTAN.
   Manche Verfahren gehören zu einem bestimmten Gerät, etwa deinem Handy mit der App: Dann holt
   „Geräte abrufen“ die Namen bei der Bank, und du wählst deins. Beim Abruf der Konten fragt die
   Bank meist nach einer Freigabe.
4. MBM holt die **Liste deiner Konten**. Du wählst, welche es übernimmt und in welche Gruppe.

Danach stehen die Konten im Kontenbaum. Konten, die MBM noch nicht übernehmen kann (etwa ein
Depot), stehen unter „Weitere Konten bei der Bank“.

![Einstellungen, Konten: Status, Bankzugang mit Anmeldungen und Konten, Offline-Konten](../assets/screenshots/einstellungen-konten-dark.png)

*Einstellungen → Konten: Status der Kontoabfrage, der Bankzugang mit den Anmeldungen der Benutzer und seinen Konten, darunter die Offline-Konten.*

### Mehrere Benutzer an einer Bank

Bank, BLZ und FinTS-Adresse gehören allen Benutzern. **Anmeldename und PIN hinterlegt jeder
Benutzer selbst**; sie sind mit einem Schlüssel verschlüsselt, den nur seine eigene Anmeldung an
MBM öffnet. Wer gemeinsame Konten hat, sieht sie einmal, egal wer sie abgerufen hat.

## Abrufen

MBM ruft **nur ab, wenn du es auslöst**: im Kopf eines Kontos, einer Gruppe oder mit dem Knopf
unten links für alle Konten. Verlangt die Bank eine Freigabe, zeigt MBM ihren Text, und du gibst
den Abruf in der Banking-App frei. Neue Umsätze bekommen ihre Kategorie über die
[Regeln](kategorien-regeln.md) und sind als [neu](umsaetze.md#neue-umsätze) markiert. Zusammen mit
den Umsätzen holt MBM auch die [Aufträge](auftraege.md).

## Offline-Konten

Für Bargeld, Sparbuch, Depot und alles ohne Online-Zugang. Ein Offline-Konto hat einen Namen, eine
Gruppe und einen **Anfangssaldo**: den Kontostand vor der ersten Buchung.

![Die Buchungen des Offline-Kontos Bargeld](../assets/screenshots/bargeld-dark.png)

*Ein Offline-Konto: Buchungen erfasst du selbst, importierst sie oder legst sie als Gegenbuchung an.*

- **Buchung erfassen** (++b++ oder im Menü des Kontos): Datum, Betrag, Gegenseite, Zweck,
  Kategorie. Lässt du die Kategorie leer, entscheiden die Regeln.
- **Saldo abgleichen:** Du gibst den gezählten Bestand ein, MBM bucht die Differenz.
- **Gegenbuchung:** In den Details eines Umsatzes, etwa einer Abhebung am Geldautomaten, legt
  „Gegenbuchung in Offline-Konto“ denselben Betrag mit umgekehrtem Vorzeichen im Offline-Konto
  an. Beide Buchungen stehen dann unter „Umbuchung“ und zählen nicht als Einnahme oder Ausgabe.
- **Importieren:** siehe [CSV-Import](import.md).

## Konten ordnen

Im Kontenbaum ordnest du Konten in **Gruppen** und Untergruppen, unabhängig von der Bank. Das
Stift-Symbol über dem Baum schaltet in den Bearbeitungsmodus; dort ziehst du Konten und Gruppen
an ihren Platz. Das Menü eines Kontos (Rechtsklick, am Handy langes Drücken) bietet unter anderem
Umbenennen, Symbol und Farbe, Infos, Verschieben und Löschen.

**Infos** sind eigene Merkmale und Notizen zu einem Konto, einer Gruppe oder Kategorie, etwa
Kontoinhaber oder Ansprechpartner.

**Vom Bankzugang lösen** macht aus einem Bankkonto ein Offline-Konto mit allen Buchungen oder
löscht es; die Bank meldet es dann nicht mehr als neu.
