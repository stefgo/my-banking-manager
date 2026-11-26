# My Banking Manager

**Homebanking, das du selbst betreibst.** My Banking Manager (MBM) läuft auf deinem eigenen Server,
zum Beispiel zu Hause, und speichert dort alle Daten verschlüsselt. Du öffnest es im Browser, am
Rechner wie am Handy.

**Deine Bankdaten bleiben bei dir.** Viele Finanz-Apps holen Kontostände und Umsätze über einen
fremden Dienstleister ab, der dafür deine Zugangsdaten bekommt, und legen die Daten auf Servern des
Anbieters im Internet ab. MBM macht beides nicht: Es verbindet sich selbst und direkt mit deiner
Bank, und deine Daten verlassen deinen Server nicht. MBM sendet keine Nutzungsdaten und lädt
nichts von fremden Servern.

**Neu hier?** Der [Schnellstart](schnellstart.md) bringt MBM in wenigen Minuten zum Laufen.

## Was MBM kann

- **Bankkonten über FinTS:** Kontostände und Umsätze direkt von der Bank abrufen, mit eigenem
  FinTS-Konnektor. Getestet mit der Sparkasse und S-pushTAN. Abgerufen wird nur, wenn du es
  auslöst.
- **PayPal und andere Banken ohne FinTS** über PSD2, nur lesend. Dazwischen steht der zugelassene
  Dienst Enable Banking, durch dessen Server die Umsätze dieser Banken laufen; abschaltbar.
- **Offline-Konten** für Bargeld, Sparbuch, Depot und alles ohne Online-Zugang: Buchungen von Hand,
  Saldo abgleichen, Gegenbuchungen zu Abhebungen und Umbuchungen.
- **Umsätze** mit Konten- und Kategorienbaum, Saldoverlauf, Filtern und einer Suche, die auch
  Beträge, Zeiträume und Verknüpfungen versteht. Neue Umsätze sind markiert und gezählt.
- **Kategorien und Regeln:** Regeln ordnen neue Umsätze automatisch zu.
- **CSV-Import in jedes Konto**, mit Vorschau, Erkennung von Doppelten und Rückgängig.
- **Überweisen** mit Empfängerüberprüfung, Echtzeitüberweisung, Empfängerliste und Verlauf.
- **Aufträge:** Dauer- und Terminaufträge ansehen, anlegen, ändern und löschen, mit den nächsten
  Terminen und einer Vorschau im Saldoverlauf.
- **Übersicht** aus Karten, die jeder Benutzer selbst zusammenstellt.
- **Mehrere Benutzer**, jeder mit eigener Anmeldung bei MBM und bei der Bank.
- **Sicher von Anfang an:** vollständig verschlüsselte Datenbank, Anmeldung mit Passwort und
  Authenticator-App, gesperrt nach jedem Neustart und bei Inaktivität.

## So sieht es aus

<figure>
  <img src="assets/screenshots/uebersicht-light.png#only-light" alt="Die Übersicht mit Saldo und Verlauf, Kontogruppen, letzten Umsätzen und den nächsten Aufträgen">
  <img src="assets/screenshots/uebersicht-dark.png#only-dark" alt="Die Übersicht mit Saldo und Verlauf, Kontogruppen, letzten Umsätzen und den nächsten Aufträgen">
  <figcaption>Die Übersicht: Saldo aller Konten mit Verlauf und gestrichelter Vorschau aus den Aufträgen, die Kontogruppen, die letzten Umsätze, Eingänge und Ausgaben des Monats und was demnächst abgebucht wird.</figcaption>
</figure>

<figure>
  <img src="assets/screenshots/umsaetze-light.png#only-light" alt="Die Umsätze eines Girokontos mit Konten- und Kategorienbaum in der Seitenleiste">
  <img src="assets/screenshots/umsaetze-dark.png#only-dark" alt="Die Umsätze eines Girokontos mit Konten- und Kategorienbaum in der Seitenleiste">
  <figcaption>Die Umsätze eines Kontos, nach Tagen mit Tagessumme und Saldo. Links stehen Konten und Kategorien als Baum; ein Punkt markiert neue Umsätze.</figcaption>
</figure>

<figure>
  <img src="assets/screenshots/ueberweisen-light.png#only-light" alt="Die Seite Überweisen mit dem Verlauf der letzten Überweisungen">
  <img src="assets/screenshots/ueberweisen-dark.png#only-dark" alt="Die Seite Überweisen mit dem Verlauf der letzten Überweisungen">
  <figcaption>Überweisen: der Verlauf aller Überweisungen, auch die der anderen Benutzer. Eine neue Überweisung prüft den Namen des Empfängers bei der Bank und wird in deiner Banking-App freigegeben.</figcaption>
</figure>

<figure>
  <img src="assets/screenshots/auftraege-light.png#only-light" alt="Dauer- und Terminaufträge mit ihren nächsten Terminen">
  <img src="assets/screenshots/auftraege-dark.png#only-dark" alt="Dauer- und Terminaufträge mit ihren nächsten Terminen">
  <figcaption>Dauer- und Terminaufträge, wie die Bank sie zuletzt gemeldet hat, mit dem nächsten Termin. Ein Pfeil zeigt einen Auftrag an ein eigenes Konto.</figcaption>
</figure>

Alle Bilder zeigen erfundene Beispieldaten.

## Wie MBM aufgebaut ist

```
Browser (Web-Client) ──HTTPS──▶ Reverse Proxy ──▶ MBM-Server ──▶ FinTS-Konnektor ──────────▶ deine Bank
                                                    │       └─▶ Enable-Banking-Konnektor ──▶ Enable Banking ──▶ PayPal …
                                                    └── verschlüsselte Datenbank (/data)
```

- **Nur der Server speichert**, und zwar alles verschlüsselt.
- **Nur die Konnektoren sprechen mit Banken.** Sie laufen im selben Container wie der Server oder
  als eigene Container ohne Netzwerk-Port. Der Enable-Banking-Konnektor ist die einzige Ausnahme von
  „keine Daten über Dritte“ und wird nur für PSD2-Zugänge genutzt.
- **Der Browser spricht nur mit dem Server** und speichert keine Bankdaten.

Weiter: [Schnellstart](schnellstart.md) · [Sicherheit](sicherheit.md) ·
[Benutzung](guide/uebersicht.md)
