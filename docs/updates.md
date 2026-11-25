# Updates und Backup

## Updates

1. **Release-Notizen lesen:** Jede Version steht im
   [CHANGELOG](https://github.com/stefgo/my-banking-manager/blob/main/CHANGELOG.md) und unter
   [Releases](https://github.com/stefgo/my-banking-manager/releases). Der Abschnitt **Upgrade** sagt,
   ob du etwas tun musst, etwa eine geänderte `compose.yaml` übernehmen.
2. **Backup machen**, siehe unten.
3. **Aktualisieren:**

    ```bash
    docker compose pull && docker compose up -d
    ```

4. **Anmelden:** Nach dem Neustart ist MBM gesperrt; dein Passwort entsperrt es. Ändert eine
   Version die Datenbank, passt der Server sie beim ersten Entsperren selbst an.
5. **Offene Fenster:** Ein Browserfenster, das noch die alte Oberfläche zeigt, merkt das Update
   und blendet oben **Eine neue Version von MBM ist da.** ein. **Neu laden** holt die neue
   Oberfläche. Vor der Anmeldung lädt das Fenster von selbst neu, solange du nichts eingetippt hast.

Mit `:latest` bekommst du immer die neueste Version. Eine feste Version wie `:1.2.0` in
`MBM_IMAGE_SERVER_FULL` aktualisiert nur, wenn du die Nummer änderst. Die Images `:main` und
`:dev` sind für Entwickler und enthalten keine FinTS-Produkt-ID.

## Backup

Sichere den **Inhalt von `/data`** (im Volume `mbm-data`): die Datenbank `mbm.db` und
`keystore.json`. Am besten bei gestopptem Container oder während MBM gesperrt ist.

```bash
docker compose stop
docker run --rm -v mbm-data:/data -v "$PWD":/backup debian:trixie-slim \
    tar czf /backup/mbm-backup-$(date +%F).tar.gz -C /data .
docker compose start
```

Der Name des Volumes kann den Projektnamen enthalten, etwa `mbm_mbm-data`; `docker volume ls`
zeigt ihn.

- Das Backup ist **ohne ein Passwort oder den Wiederherstellungsschlüssel nicht lesbar**.
- **Datenbank und `keystore.json` gehören zusammen.** Ein Backup gilt mit den Passwörtern vom
  Zeitpunkt der Sicherung.
- `blz.json` musst du nicht sichern; fehlt sie, lädt MBM sie neu.
- Bewahre den **Wiederherstellungsschlüssel getrennt** vom Backup auf.

## Zurückspielen

Container stoppen, den Inhalt des Backups zurück nach `/data` legen, Container starten und mit
einem Passwort anmelden, das zum Zeitpunkt der Sicherung galt.
