# Sicherheit

MBM verwaltet deine Bankdaten. Deshalb ist es so gebaut, dass ein gestohlener Datenträger, ein
gestohlenes Backup oder ein vergessenes offenes Fenster möglichst wenig verrät. Hier steht das
Wichtigste in Kürze; alle Einzelheiten stehen unter [Technische Details](operations.md).

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
- **Folgenreiche Schritte** bestätigst du jedes Mal selbst: Benutzer anlegen oder entfernen, das
  Passwort eines anderen zurücksetzen und Geräte-Tokens erzeugen mit einem Code aus der
  Authenticator-App; den Authenticator eines anderen zurücksetzen mit deinem Passwort.
- Dein **eigenes Passwort**, deinen **eigenen Authenticator** und den
  **Wiederherstellungsschlüssel** änderst du nur mit Passwort und Code. Ohne Telefon ersetzt der
  Wiederherstellungsschlüssel beim Wechsel des Authenticators den Code.
- Vor einer **Überweisung** fragt MBM das Passwort erneut, wenn die letzte Eingabe länger her ist.
  Freigegeben wird jede Überweisung ohnehin in der Banking-App.

## Sperren

| Wann | Was passiert | Weiter mit |
|---|---|---|
| Nach jedem **Neustart** | MBM ist gesperrt, die Datenbank zu | Name und Passwort |
| **10 Minuten** ohne Eingabe in einem Fenster | Dieses Fenster sperrt sich | Passwort |
| **10 Minuten** ohne offenes, aktives Fenster | Der Server sperrt sich und vergisst den Schlüssel | Passwort |
| **Sperren** von Hand (++l++ oder *Einstellungen → System*) | MBM ist für alle gesperrt | Passwort |

Die Zeiten stellst du unter [Konfiguration](konfiguration.md) ein. Solange ein Abruf oder eine
Überweisung auf eine Freigabe wartet, warten die Sperren.

## Zugang wiederherstellen

Kommst du nicht mehr hinein, wählst du auf dem Anmeldebildschirm **Zugang wiederherstellen**:

| Was dir fehlt | Du gibst ein | Danach | Bankzugänge |
|---|---|---|---|
| **Telefon** | Name, Passwort, Wiederherstellungsschlüssel | Neue Authenticator-App einrichten | bleiben |
| **Passwort** | Name, Wiederherstellungsschlüssel, neues Passwort | Anmelden mit dem Code | Anmeldename und PIN neu eingeben |
| **Beides** | Name, Wiederherstellungsschlüssel, neues Passwort | Neue Authenticator-App einrichten | Anmeldename und PIN neu eingeben |

Dein bisheriger Authenticator gilt, bis du den neuen bestätigt hast. Ist MBM offen, kann dir auch
ein anderer Benutzer helfen und dein Passwort oder deinen Authenticator zurücksetzen.

!!! warning "Der Schlüssel ersetzt Passwort und Telefon"
    Wer Benutzername und Wiederherstellungsschlüssel hat, kommt ohne Telefon in MBM hinein. Deine
    gespeicherten Bank-PINs öffnet der Schlüssel nicht. Bewahre ihn getrennt vom Backup auf, etwa
    ausgedruckt oder in einem Passwortmanager.

**Ohne Passwort und ohne Wiederherstellungsschlüssel sind die Daten verloren.** Verlierst du
Telefon und Schlüssel, kann dir nur noch ein anderer Benutzer helfen. Bist du der einzige Benutzer,
kommst du nach dem Ende deiner Sitzung nicht mehr hinein.

## Im Netz

- MBM gehört **ins Heimnetz hinter einen Reverse Proxy mit HTTPS**, nicht offen ins Internet.
- Das Sitzungscookie ist HttpOnly und `SameSite=Strict`, über HTTPS mit `Secure`.
- Ändernde Anfragen von fremden Seiten (auch anderen Subdomains) lehnt der Server ab.
- Der FinTS-Konnektor hat **keinen Netzwerk-Port**.

