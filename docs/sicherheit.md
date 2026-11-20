# Sicherheit

MBM verwaltet deine Bankdaten. Deshalb ist es so gebaut, dass ein gestohlener Datenträger, ein
gestohlenes Backup oder ein vergessenes offenes Fenster möglichst wenig verrät. Hier steht das
Wichtigste in Kürze; alle Einzelheiten stehen unter [Betrieb im Detail](operations.md).

## Keine Daten über Dritte

- MBM verbindet sich **selbst und direkt mit deiner Bank** (FinTS). Kein fremder Dienstleister
  ruft deine Konten ab, keiner bekommt deine Zugangsdaten.
- MBM lädt **nichts von fremden Servern**: keine Schriften, keine Skripte, keine Statistik. Es
  sendet keine Nutzungsdaten.
- Einzige Verbindung außer zur Bank: das öffentliche **BLZ-Verzeichnis** der Bundesbank, einmal am
  Tag geprüft. Das lässt sich abschalten (`MBM_BANK_DIRECTORY_UPDATE=false`).

## Verschlüsselt gespeichert

- Die **ganze Datenbank** ist verschlüsselt (SQLite3 Multiple Ciphers, AES-256).
- Der Schlüssel liegt **nur im Arbeitsspeicher**, solange MBM entsperrt ist. Auf der Platte liegt
  er nur verpackt: einmal je Benutzerpasswort und einmal mit dem Wiederherstellungsschlüssel.
- **Anmeldename und PIN deiner Bank** sind zusätzlich mit einem Schlüssel verschlüsselt, den nur
  deine eigene Anmeldung öffnet. Mit „PIN nicht speichern“ liegt die PIN nirgends.
- Der Browser speichert **keine Bankdaten**, nur Ansichtswerte wie die Breite der Seitenleiste.
- Unverschlüsselt liegt nur das öffentliche BLZ-Verzeichnis (`/data/blz.json`).

!!! warning "Jedes Passwort öffnet die ganze Datenbank"
    Das schwächste Passwort aller Benutzer bestimmt, wie gut ein gestohlenes Backup geschützt
    ist. Deshalb verlangt MBM mindestens 12 Zeichen. Die Authenticator-App schützt die Anmeldung,
    nicht die Verschlüsselung auf der Platte.

## Anmelden

- Jeder Benutzer hat ein **Passwort** und eine **Authenticator-App** (TOTP).
- Nach fünf Fehlversuchen wartet die Anmeldung, jedes Mal doppelt so lange.
- **Folgenreiche Schritte** bestätigst du jedes Mal selbst: Benutzer anlegen oder entfernen,
  Passwörter setzen und Geräte-Tokens erzeugen mit einem Code aus der Authenticator-App; den
  Authenticator eines Benutzers zurücksetzen mit deinem Passwort.
- Vor einer **Überweisung** fragt MBM das Passwort erneut, wenn die letzte Eingabe länger her ist.
  Freigegeben wird jede Überweisung ohnehin in der Banking-App.

## Sperren

| Wann | Was passiert | Weiter mit |
|---|---|---|
| Nach jedem **Neustart** | MBM ist gesperrt, die Datenbank zu | Name und Passwort |
| **10 Minuten** ohne Eingabe in einem Fenster | Dieses Fenster sperrt sich | Passwort |
| **10 Minuten** ohne offenes, aktives Fenster | Der Server sperrt sich und vergisst den Schlüssel | Passwort |
| **Sperren** von Hand (++l++ oder *Einstellungen → Sicherheit*) | MBM ist für alle gesperrt | Passwort |

Die Zeiten stellst du unter [Konfiguration](konfiguration.md) ein. Solange ein Abruf oder eine
Überweisung auf eine Freigabe wartet, warten die Sperren.

## Passwort vergessen

Auf dem Anmeldebildschirm öffnet der **Wiederherstellungsschlüssel** die Datenbank und setzt für
einen Benutzer ein neues Passwort. Ist MBM offen, kann auch ein anderer Benutzer dein Passwort
neu setzen. In beiden Fällen gibst du danach Anmeldename und PIN deiner Bank neu ein.

**Ohne Passwort und ohne Wiederherstellungsschlüssel sind die Daten verloren.** Bewahre den
Schlüssel getrennt vom Backup auf, etwa ausgedruckt oder in einem Passwortmanager.

## Im Netz

- MBM gehört **ins Heimnetz hinter einen Reverse Proxy mit HTTPS**, nicht offen ins Internet.
- Das Sitzungscookie ist HttpOnly und `SameSite=Strict`, über HTTPS mit `Secure`.
- Ändernde Anfragen von fremden Seiten (auch anderen Subdomains) lehnt der Server ab.
- Der FinTS-Konnektor hat **keinen Netzwerk-Port**.

