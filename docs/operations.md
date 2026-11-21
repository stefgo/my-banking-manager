# Technische Details

## Verschlüsselung

- Die ganze Datenbank (`/data/mbm.db`, samt WAL) ist mit SQLite3 Multiple Ciphers verschlüsselt
  (SQLCipher-kompatibel, AES-256 mit HMAC).
- Ein zufälliger **Datenschlüssel** verschlüsselt die Datenbank. Er liegt nur verpackt in
  `/data/keystore.json`: je Benutzer einmal mit dessen Passwort (scrypt, 128 MiB) und einmal mit dem
  Wiederherstellungsschlüssel. Passwort ändern heißt nur neu verpacken. Eine eigene Passphrase gibt
  es nicht.
- Ein Passwort ist richtig, wenn es den Datenschlüssel auspackt; einen weiteren Passwort-Hash gibt
  es nicht. Die Namen der Benutzer stehen in `keystore.json` nur als Hash.
- **Jedes Benutzerpasswort öffnet damit die ganze Datenbank.** Das schwächste Passwort bestimmt den
  Schutz bei Diebstahl von Datenvolume oder Backup; deshalb mindestens 12 Zeichen. TOTP schützt die
  Anmeldung, nicht die Verschlüsselung auf der Platte.
- Einzelne Geheimnisse sind zusätzlich mit AES-256-GCM verschlüsselt: TOTP mit dem Datenschlüssel,
  ab M4 Anmeldename und PIN bei der Bank mit dem Schlüssel des jeweiligen Benutzers.
- Der Datenschlüssel liegt nur im Arbeitsspeicher, solange der Server entsperrt ist.
- Unverschlüsselt liegt nur `/data/blz.json`, das öffentliche BLZ-Verzeichnis der Bundesbank (siehe
  *Bankzugänge und FinTS-Konnektor*).

## Entsperren

Nach jedem Start ist der Server gesperrt, bis sich ein Benutzer im Web-Client anmeldet. **Ein
Passwort genügt:** Es öffnet die Datenbank, hebt eine gesperrte Sitzung auf und meldet an. Kein
Passwort liegt auf der Platte; wer Datenvolume oder Backup stiehlt, kann damit nichts lesen. MBM
ruft nie selbstständig bei der Bank ab, nur wenn ein Benutzer im Client einen Abruf auslöst.

| Wer kommt zurück | Was er eingibt |
|---|---|
| Fenster, das vor der Sperre angemeldet war | nur das Passwort |
| Browser mit gültiger Anmeldung, neu geöffnet | Name und Passwort |
| Neue Anmeldung | Name, Passwort und TOTP-Code |

Bei einer neuen Anmeldung bleibt der gesperrte Server gesperrt, bis auch der Code stimmt. Hat der
Benutzer noch kein TOTP eingerichtet, öffnet schon das Passwort, damit er es einrichten kann.

**Sperren** (Werkzeugleiste unten links oder `L`) schließt die Datenbank für alle Benutzer. Die
Anmeldungen bleiben gültig: Zum Entsperren genügt das Passwort, ohne TOTP. Solange eine
Überweisung läuft, lehnt der Server das Sperren ab, sonst ginge ihr Ergebnis verloren.

**Passwort vergessen:** Auf dem Anmeldebildschirm öffnet der Wiederherstellungsschlüssel die
Datenbank und setzt für einen Benutzer ein neues Passwort. Dessen Sitzungen enden; er meldet sich
mit dem neuen Passwort und seinem TOTP-Code an. Ist der Server offen, kann auch ein anderer
Benutzer das Passwort unter *Einstellungen → Benutzer* neu setzen.

## Sperren bei Inaktivität

Drei Werte in `config.yaml` (oder als Umgebungsvariable), alle in Minuten, `0` schaltet ab:

| Wert | Standard | Wirkung |
|---|---|---|
| `sessionIdleMinutes` (`MBM_SESSION_IDLE_MINUTES`) | 10 | Eine Browser-Sitzung ohne Eingabe sperrt sich. Weiter geht es mit dem Passwort; nach fünf Fehlversuchen am offenen Server wird sie abgemeldet. |
| `autoLockMinutes` (`MBM_AUTO_LOCK_MINUTES`) | 10 | Ist kein angemeldeter, nicht gesperrter Client mehr verbunden, sperrt sich der Server und vergisst den Datenschlüssel. |
| `transferConfirmMinutes` (`MBM_TRANSFER_CONFIRM_MINUTES`) | 15 | Vor einer Überweisung fragt MBM das Passwort noch einmal ab, wenn die letzte Passworteingabe dieser Sitzung (Anmelden oder Entsperren) länger her ist. Die eigentliche Sicherung bleibt die Freigabe in der Banking-App. |

Ein vergessenes offenes Fenster sperrt sich also nach 10 Minuten, der Server weitere 10 Minuten
später. Wer danach zurückkommt, gibt einmal sein Passwort ein. Ob ein Fenster
noch offen ist, prüft der Server mit einem Ping alle 30 Sekunden über den WebSocket. Solange ein
Abruf oder eine Überweisung auf eine Freigabe wartet, warten beide Sperren (höchstens bis zu deren
Ablauf nach fünf Minuten).

## Startwerte des Profils

Unter *Einstellungen → Profil* stellt jeder Benutzer Darstellung und „Beträge beim Start
ausblenden“ getrennt für die Geräteklassen **Browser** und **macOS** ein. Bis er das tut, gelten
die Werte aus `config.yaml`:

```yaml
profileDefaults:
  web:      # Browser
    theme: dark              # system, dark oder light
    hideAmountsOnStart: false
  macos:
    theme: dark
    hideAmountsOnStart: false
```

`profileDefaults.web.theme` bestimmt auch die Darstellung des Anmeldebildschirms.

Ansichtswerte speichert jeder Browser selbst in seinem `localStorage`: Breite und Klappzustände der
Seitenleiste, „Verlauf“ der Umsätze, die Filter der Umsatzliste je Konto und die zuletzt gezeigte Ansicht der
Umsätze (Konto, Gruppe oder Kategorie, nur als ID). Gespeichert werden nur IDs und
feste Auswahlwerte, keine Namen, Beträge oder Suchtexte. Wer die Website-Daten des Browsers löscht,
setzt diese Werte zurück.

## Anmeldung

Jeder Benutzer hat Passwort und TOTP. Browser bekommen ein HttpOnly-Cookie (SameSite=Strict, über
HTTPS mit `Secure`), das nach 30 Tagen ohne Nutzung abläuft. Geräte-Tokens für den macOS-Client
erzeugst du unter *Einstellungen → Geräte*; sie gelten, bis sie abgemeldet werden. Nach fünf
Fehlversuchen wartet die Anmeldung, jedes Mal doppelt so lange; das gilt auch, solange der Server
gesperrt ist. Jede Passwortprüfung rechnet scrypt mit 128 MiB, der Server prüft sie nacheinander.

**Bestätigung folgenreicher Schritte.** Eine offene Sitzung allein genügt nicht, um sich einen
dauerhaften Zugang zu verschaffen. Der angemeldete Benutzer bestätigt jedes Mal selbst:

| Schritt | Bestätigung |
|---|---|
| Geräte-Token erzeugen | Code aus der eigenen Authenticator-App |
| Benutzer hinzufügen | Code aus der eigenen Authenticator-App |
| Passwort eines Benutzers setzen | Code aus der eigenen Authenticator-App |
| Benutzer entfernen | Code aus der eigenen Authenticator-App |
| Authenticator eines Benutzers zurücksetzen | eigenes Passwort |

Das Zurücksetzen verlangt das Passwort, damit es auch ohne Telefon geht. Wer seinen eigenen
Authenticator zurücksetzt, wird dabei abgemeldet und richtet die App bei der nächsten Anmeldung
neu ein. Ein Code gilt nur einmal; direkt nach der Anmeldung wartet man also bis zum nächsten Code.
Ein neues Geräte-Token gilt nicht als „Passwort gerade eingegeben“: Vor seiner ersten Überweisung
fragt MBM das Passwort ab.

**Fehlversuche je Sitzung.** Falsche Codes und falsche Passwörter einer angemeldeten Sitzung
zählen zusammen: beim Entsperren, bei den Bestätigungen oben, vor einer Überweisung, beim Ändern
des eigenen Passworts und beim neuen Wiederherstellungsschlüssel. Der fünfte meldet die Sitzung ab.
Ein richtiger Code oder ein richtiges Passwort setzt die Zählung zurück. Jeder Fehlversuch steht im
Aktivitätsprotokoll.

Ab M4 hinterlegt jeder Benutzer seine eigene Anmeldung bei der Bank (Anmeldename und PIN). Sie ist
mit einem Schlüssel verschlüsselt, den nur seine Anmeldung an MBM öffnet. Der Server kann sie also
nur nutzen, während dieser Benutzer selbst etwas auslöst. Setzt ein anderer Benutzer sein Passwort
neu, muss er Anmeldename und PIN bei der Bank neu eingeben.

## Backup

Sichere den Inhalt von `/data` (Datenbank und `keystore.json`), am besten bei gestopptem Container
oder während er gesperrt ist. Das Backup ist ohne ein Benutzerpasswort oder den Wiederherstellungsschlüssel nicht
lesbar. Bewahre den Wiederherstellungsschlüssel getrennt vom Backup auf. Datenbank und
`keystore.json` gehören zusammen: Ein Backup gilt mit den Passwörtern vom Zeitpunkt der Sicherung.

## Netz

Betrieb nur im Heimnetz hinter einem Reverse Proxy mit HTTPS. Der Server liefert eine strenge
Content-Security-Policy aus und lädt nichts von fremden Servern (Schriften sind mitgeliefert).
Einzige Ausnahme: das BLZ-Verzeichnis von bundesbank.de (abschaltbar, siehe unten). Dafür braucht der
Server ausgehend HTTPS zu `www.bundesbank.de`.

**Proxy-Header:** Der Server vertraut `X-Forwarded-For` und `X-Forwarded-Proto` nur, wenn
`trustProxy` es erlaubt (`config.yaml` oder `MBM_TRUST_PROXY`). Standard ist `false`: Ohne diese
Einstellung könnte jeder Client sich eine andere Adresse geben und damit die Bremse für
Fehlversuche bei der Anmeldung umgehen. Hinter dem Reverse Proxy trägst du am besten dessen
Adresse oder Netz ein, z. B. `MBM_TRUST_PROXY=172.16.0.0/12` (Docker-Netze) oder `127.0.0.1`.
`true` vertraut jedem direkten Gegenüber und passt nur, wenn der Port des Servers ausschließlich
für den Proxy erreichbar ist. Ohne die Einstellung erkennt der Server HTTPS hinter dem Proxy
nicht, und bei `secureCookies: auto` fehlt dem Sitzungscookie das `Secure`-Flag.

**Anfragen fremder Seiten:** Das Sitzungscookie (`SameSite=Strict`) geht auch bei Anfragen mit,
die eine andere Seite derselben Site auslöst: eine andere Subdomain (`wiki.home.example` neben
`mbm.home.example`) oder ein anderer Port desselben Rechners. Deshalb lehnt der Server jede
ändernde Anfrage und den WebSocket ab (403 `foreign_origin`), wenn der Browser einen `Origin`
mitschickt, der nicht MBMs eigene Adresse ist. Ohne `Origin` (macOS-Client, Skripte) geht die
Anfrage durch. Die eigene Adresse liest der Server aus dem `Host`-Header, hinter einem
vertrauten Proxy (`trustProxy`) aus `X-Forwarded-Host`. Der Proxy muss also eins von beiden
weitergeben. Caddy und Traefik tun das von selbst. Bei nginx gehört
`proxy_set_header Host $host;` in die Konfiguration, sonst steht dort die Adresse des Upstreams.
Geht beides nicht, trägst du die Adresse, unter der du MBM öffnest, in `allowedOrigins` ein
(`MBM_ALLOWED_ORIGINS`, mehrere mit Komma). Abgelehnte Anfragen stehen mit Origin und Host im
Server-Log.

Der Reverse Proxy muss WebSockets unter `/api/events` durchreichen. Sein Leerlauf-Timeout darf
nicht unter 60 Sekunden liegen (der Server pingt alle 30 Sekunden). Sonst bricht die Verbindung ab,
und das Fenster zählt für die automatische Sperre nicht mehr als offen.

Der FinTS-Konnektor hat keinen Port. Mit `mbm-server-full` läuft er im Prozess des Servers, mit
`mbm-server` und `mbm-fints` als eigener Container hinter einem Unix-Socket (siehe unten).

## Bankzugänge und FinTS-Konnektor

- **Aufbau:** Zwei Betriebsarten, beide mit demselben Konnektor (`connectors/fints`):
  - **Ein Container** (`compose.yaml`, Image `mbm-server-full`, `docker/server-full.Dockerfile`):
    Der Server lädt den Konnektor in seinen eigenen Prozess (`MBM_FINTS_EMBEDDED=1`, im Image
    gesetzt). Es gibt keinen Socket und keinen zweiten Container. Beim Start schreibt der Server
    `MBM FinTS connector … embedded (…)` ins Log.
  - **Zwei Container** (`compose.split.yaml`, Images `mbm-server` und `mbm-fints`): Der Konnektor
    läuft ohne Port und ohne Datenvolume. Server und Konnektor sprechen über den Unix-Socket
    `/run/mbm/fints.sock` im tmpfs-Volume `mbm-sockets`, das nur diese beiden Container einbinden.
    Der Server findet ihn über `MBM_FINTS_SOCKET` oder `connectors.fints.socket` in `config.yaml`.
    Die PIN eines Vorgangs, der auf eine Freigabe wartet, liegt dann nur im Speicher des
    Konnektors, nicht in dem des Servers.
  - `MBM_FINTS_EMBEDDED` und `MBM_FINTS_SOCKET` zusammen lehnt der Server beim Start ab, ebenso
    `MBM_FINTS_EMBEDDED` ohne eingebauten Konnektor (Image `mbm-server`).
  - **Mehrere Benutzer** rufen in beiden Betriebsarten gleichzeitig ab, auch dasselbe Konto: je
    Bank-Anmeldung läuft ein Abruf, die Umsätze werden in einer Transaktion übernommen und
    Doppelte erkannt. Jeder Vorgang (TAN, Freigabe) gehört einem Benutzer; ein anderer erreicht ihn
    nicht.
- **Produkt-ID:** FinTS verlangt eine registrierte Produkt-ID (fints.org → Hersteller →
  Produktregistrierung). Nach den Registrierungsbedingungen gilt sie nur für das registrierte
  Produkt und steht deshalb nie im Quellcode.
  - **Offizielle Images von `mbm-server-full`** (ghcr.io, aus einem Versions-Tag gebaut, z. B.
    `:1.2.0` oder `:latest`) enthalten die Produkt-ID von MBM. `MBM_FINTS_PRODUCT_ID` bleibt dann
    leer. Die laufend gebauten Images `:main` und `:dev` enthalten keine.
  - **`mbm-fints` enthält nie eine Produkt-ID**, auch nicht in Releases. Wer die zwei Container
    betreibt, registriert eine eigene und trägt sie in die `.env` neben `compose.split.yaml` ein:
    `MBM_FINTS_PRODUCT_ID=…`.
  - **Selbst gebaut oder weiterentwickelt** (`docker compose up --build`, ein Fork, ein eigener
    Build): ebenfalls eine eigene Produkt-ID in der `.env`. Sie hat immer Vorrang vor der ID im
    Image.
  - Ohne Produkt-ID nimmt der Konnektor keinen Kontakt zu einer Bank auf; die Einstellungen zeigen
    dann einen Hinweis. Beim Start meldet er, ob er die ID des Images, die aus der Umgebung oder
    keine verwendet (nie den Wert).
- **Was wo liegt:** Bank, BLZ und FinTS-Adresse gehören allen Benutzern. Anmeldename, PIN und
  Zustand des Konnektors liegen je Benutzer verschlüsselt mit dessen Benutzerschlüssel (aus seinem
  Passwort). Bei „PIN nicht speichern“ liegt die PIN nirgends; der Client fragt sie bei jedem
  Abruf. Während ein Vorgang auf eine Freigabe wartet, hält der Konnektor die PIN im
  Arbeitsspeicher, höchstens 5 Minuten.
- **Passwort neu gesetzt** (durch einen anderen Benutzer oder mit dem Wiederherstellungsschlüssel):
  Der Benutzerschlüssel ist verloren, die Bank-Anmeldungen dieses Benutzers verlangen Anmeldename
  und PIN neu. Konten und Umsätze bleiben.
- **Abruf:** nur von Hand (je Konto, je Bankzugang, alle). Sitzung und Server sperren sich nicht,
  solange ein Abruf läuft oder auf eine Freigabe wartet.
- **BLZ-Verzeichnis:** Bankleitzahl, Name, Ort und BIC aller deutschen Banken (Deutsche
  Bundesbank). Der Server prüft kurz nach dem Start und danach einmal am Tag die Download-Seite der
  Bundesbank, auch wenn er gesperrt ist. Die Datei (rund 2 MB) lädt er nur, wenn dort ein neuer
  Link steht (etwa alle drei Monate), prüft sie und legt sie als `/data/blz.json` ab, lesbar
  formatiert und unverschlüsselt (öffentliche Daten). Die Bundesbank sieht dabei nur die Adresse
  des Servers. Schlägt etwas fehl, bleibt der bisherige Stand. Stand und letzte Prüfung zeigt
  *Einstellungen → Status der Kontoabfrage*, dort auch „Jetzt prüfen“.
  - Abschalten: `bankDirectoryUpdate: false` bzw. `MBM_BANK_DIRECTORY_UPDATE=false`. Dann gilt die
    mitgelieferte Kopie `server/data-static/blz.json`; erneuern mit
    `npm run blz -- <blz-aktuell-txt-data.txt>`.
  - Bringt ein neues Image eine neuere Kopie mit als `/data/blz.json`, gilt die neuere.
  - Für das Backup ist `blz.json` nicht nötig; fehlt sie, lädt der Server sie neu.
