# Konfiguration

MBM braucht für den Start keine Konfiguration. Was du anpassen willst, setzt du als
**Umgebungsvariable** in `compose.yaml` bzw. der `.env` daneben, oder in einer Datei
**`config.yaml`**. Im Image sucht der Server sie unter `/app/config.yaml`; eine andere Stelle nennt
`MBM_CONFIG`. Umgebungsvariablen haben Vorrang vor der Datei.

```yaml
# compose.yaml, Ausschnitt: eine eigene config.yaml einbinden
services:
  server:
    volumes:
      - mbm-data:/data
      - ./config.yaml:/app/config.yaml:ro
```

## Die wichtigsten Einstellungen

| `config.yaml` | Umgebungsvariable | Standard | Wirkung |
|---|---|---|---|
| `trustProxy` | `MBM_TRUST_PROXY` | `false` | Adresse oder Netz des Reverse Proxys, dessen `X-Forwarded-*` gilt |
| `allowedOrigins` | `MBM_ALLOWED_ORIGINS` | leer | Weitere Adressen, unter denen du MBM öffnest (nur nötig, wenn der Proxy weder `Host` noch `X-Forwarded-Host` weitergibt) |
| `sessionIdleMinutes` | `MBM_SESSION_IDLE_MINUTES` | `10` | Eine Browser-Sitzung ohne Eingabe sperrt sich |
| `autoLockMinutes` | `MBM_AUTO_LOCK_MINUTES` | `10` | Der Server sperrt sich, wenn kein aktives Fenster mehr offen ist |
| `transferConfirmMinutes` | `MBM_TRANSFER_CONFIRM_MINUTES` | `15` | Vor einer Überweisung fragt MBM das Passwort erneut, wenn es länger her ist |
| `bankDirectoryUpdate` | `MBM_BANK_DIRECTORY_UPDATE` | `true` | BLZ-Verzeichnis täglich bei der Bundesbank prüfen |
| `connectors.enablebanking` | `MBM_ENABLEBANKING_EMBEDDED` / `MBM_ENABLEBANKING_SOCKET` | im Image `mbm-server-full` eingebaut | PSD2 über Enable Banking (PayPal und andere Banken ohne FinTS). `MBM_ENABLEBANKING_EMBEDDED=0` schaltet es ab, siehe [Technische Details](operations.md#psd2-über-enable-banking) |
| `logLevel` | `MBM_LOG_LEVEL` | `info` | Ausführlichkeit des Logs (`fatal` … `trace`); Bankdaten stehen nie darin |
| `port` | `MBM_PORT` | `3040` | Port des Servers |
| `sessionDays` | – | `30` | Eine Browser-Anmeldung endet nach so vielen Tagen ohne Nutzung |
| `profileDefaults` | – | dunkel | Startwerte von Darstellung und „Beträge beim Start ausblenden“, siehe unten |

Bei den Zeiten schaltet `0` die Sperre ab. Was die Sperren genau tun, steht unter
[Sicherheit](sicherheit.md#sperren).

## Hinter dem Reverse Proxy

MBM gehört ins Heimnetz hinter einen Reverse Proxy mit HTTPS. Damit das zusammenspielt:

- **`MBM_TRUST_PROXY`** auf die Adresse oder das Netz des Proxys setzen, etwa `172.16.0.0/12`
  (Docker-Netze) oder `127.0.0.1`. Ohne diese Einstellung erkennt MBM HTTPS nicht, und das
  Sitzungscookie bekommt kein `Secure`. `true` vertraut jedem und passt nur, wenn der Port von MBM
  ausschließlich für den Proxy erreichbar ist.
- **Host weitergeben:** Caddy und Traefik tun das von selbst. Bei nginx gehört
  `proxy_set_header Host $host;` in die Konfiguration.
- **WebSockets** unter `/api/events` durchreichen, mit einem Leerlauf-Timeout von mindestens
  60 Sekunden.

```nginx
location / {
    proxy_pass http://mbm:3040;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
```

## FinTS-Produkt-ID

Wer über FinTS mit einer Bank spricht, braucht eine **Produkt-ID**: eine Nummer, mit der die
Deutsche Kreditwirtschaft ein Banking-Programm registriert. Sie gilt nur für das registrierte
Programm und steht deshalb nicht im Quellcode.

| Du nutzt … | Produkt-ID |
|---|---|
| das offizielle Image `mbm-server-full` aus einem Release (`:latest`, `:1.2.0` …) | ist enthalten, nichts zu tun |
| die laufend gebauten Images `:main` oder `:dev` | keine, eigene nötig |
| `mbm-server` und `mbm-fints` (zwei Container) | keine, eigene nötig |
| ein selbst gebautes oder verändertes MBM | eigene nötig |

Eine eigene Produkt-ID beantragst du kostenlos auf
[fints.org](https://www.fints.org/de/hersteller/produktregistrierung) und trägst sie als
`MBM_FINTS_PRODUCT_ID` in die `.env` ein. Sie hat immer Vorrang vor der ID im Image. Ohne
Produkt-ID nimmt MBM keinen Kontakt zu einer Bank auf; die Einstellungen zeigen dann einen
Hinweis. Offline-Konten funktionieren trotzdem.

Die Produkt-ID im offiziellen Image steht nicht unter der MIT-Lizenz von MBM. Du darfst sie nur mit
dem unveränderten offiziellen Image nutzen: nicht herauslösen, nicht in anderen Programmen
verwenden und nicht in veränderten oder darauf aufbauenden Images weitergeben. Den genauen Wortlaut
findest du in der Datei
[NOTICE](https://github.com/stefgo/my-banking-manager/blob/main/NOTICE), im Image unter
`/app/NOTICE`.

## Startwerte des Profils

Jeder Benutzer stellt Darstellung und „Beträge beim Start ausblenden“ unter
*Einstellungen → Profil* selbst ein. Bis dahin gelten diese Werte; `web.theme` bestimmt auch den
Anmeldebildschirm:

```yaml
profileDefaults:
  web:
    theme: dark              # system, dark oder light
    hideAmountsOnStart: false
  macos:
    theme: dark
    hideAmountsOnStart: false
```

## Diagnose des Konnektors

`MBM_FINTS_TRACE=1` in der Umgebung des Containers mit dem Konnektor (`server` bei einem
Container, `fints` bei zweien) lässt ihn den Aufbau jeder Nachricht an die Bank ins Log schreiben,
ohne Inhalte. Das hilft, wenn eine Bank sich anders verhält als erwartet.

Alle Einzelheiten zu Verschlüsselung, Anmeldung, Netz und Konnektor stehen unter
[Technische Details](operations.md).
