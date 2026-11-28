# Diagramme

Erzeugt die Bilder in `docs/assets/diagrams/` für [docs/datenbankmodell.md](../../docs/datenbankmodell.md).

```bash
npm run diagrams
```

| Datei | Inhalt | Definition in `figures.ts` |
| --- | --- | --- |
| `datenbank-tabellen.svg` | alle Tabellen mit ihren Fremdschlüsseln | `overview` |
| `datenbank-schluessel.svg` | Schlüsselkette und Dateien im Datenverzeichnis | `keys` |
| `ueberweisung-zustaende.svg` | Zustände in `transfers.status` | `transferStates` |

## Warum SVG und nicht Mermaid

MkDocs Material lädt Mermaid von einem CDN nach; MBM und seine Dokumentation laden nichts von
Dritten. Außerdem ordnet Mermaid 28 Tabellen selbst an, und das Bild wird unübersichtlich. Die SVG-Dateien
sind fertige Bilder ohne JavaScript, auf GitHub und auf der Site gleich.

## Wie ein Diagramm entsteht

- `figures.ts` legt Kästen (`Box`) auf ein Raster und verbindet sie mit Kanten (`Edge`). Eine Kante
  zeigt vom Fremdschlüssel zur referenzierten Tabelle; `style` ist die Löschregel (`cascade`,
  `setnull`, `restrict`) oder `logical` für einen Verweis ohne Fremdschlüssel.
- `svg.ts` schneidet jede Kante am Rand ihrer Kästen ab, setzt Pfeilspitzen und Beschriftungen und
  schreibt eine eigenständige Datei mit eigenem Stil und Hintergrund. Hell oder dunkel folgt
  `prefers-color-scheme`; die Farben sind die des Web-Clients.
- Verweise, die als Linie quer durch das Bild liefen, stehen als Zeile im Kasten (`sub`: »→ users«),
  Selbstverweise als »↺ spalte«.

Nach einer Änderung: `npm run diagrams`, das Bild ansehen (etwa mit `mkdocs serve`), auf
Überschneidungen achten. `server/src/db/schemaDocs.test.ts` prüft, dass jede Tabelle im Übersichtsbild
steht.
