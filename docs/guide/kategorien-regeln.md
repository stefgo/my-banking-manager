# Kategorien und Regeln

Jeder Umsatz kann eine **Kategorie** haben. Kategorien bilden einen Baum, etwa
„Lebensmittel › Supermarkt“. Eine neue Installation startet mit einem Vorschlag, den du frei
änderst.

## Kategorien

Ein Klick auf eine Kategorie im Kategorienbaum zeigt ihre Umsätze mit der Summe, samt
Unterkategorien.

![Die Umsätze der Kategorie Lebensmittel mit Summe](../assets/screenshots/kategorien-dark.png)

*Die Kategorie „Lebensmittel“ mit ihren Unterkategorien Supermarkt und Bäckerei, über alle Konten.*

- **Anlegen, umbenennen, verschieben:** über das Stift-Symbol über dem Baum oder das Menü einer
  Kategorie. Auch „Ohne Kategorie“ lässt sich an einen anderen Platz im Baum ziehen.
- **Symbol und Farbe:** Eine Unterkategorie ohne eigene Farbe nimmt die ihrer Oberkategorie.
- **Nicht in Auswertungen:** Eine Kategorie wie „Umbuchung“ zählt nicht zu Eingängen und
  Ausgaben. So zählt Geld, das du zwischen eigenen Konten verschiebst, nicht als Ausgabe.
- **Löschen:** Die Umsätze wandern in eine andere Kategorie oder werden „Ohne Kategorie“.

## Regeln

Eine **Regel** ist eine [Suche](umsaetze.md#suche) mit einer Kategorie. Jeder neue Umsatz ohne
Kategorie bekommt die Kategorie der **ersten passenden aktiven Regel**: beim Abruf, beim
Erfassen, beim Import und beim Lösen einer Gegenbuchung.

![Einstellungen, Regeln: Suche, Kategorie und Trefferzahl jeder Regel](../assets/screenshots/einstellungen-regeln-dark.png)

*Einstellungen → Regeln: jede Regel mit ihrer Suche, der Kategorie und wie viele Umsätze sie trifft.*

- **Anlegen:** Suche eingeben, Kategorie wählen, „Regel anlegen“. Schneller geht es in den
  Details eines Umsatzes: Setzt du dort eine Kategorie, bietet MBM an, sie für alle Umsätze
  dieser Gegenseite zu merken, und legt die Regel an.
- **Reihenfolge:** Die erste passende Regel gewinnt. Ziehe genauere Regeln nach oben.
- **Aus- und einschalten** mit dem Schalter, ohne die Regel zu löschen.
- **Lupe:** zeigt die Umsätze, die eine Regel trifft.
- **Auf Umsätze ohne Kategorie anwenden:** zeigt zuerst eine Vorschau, welche Umsätze welche
  Kategorie bekämen, und wendet nur die an, die du bestätigst.

Regeln ändern nie eine Kategorie, die ein Umsatz schon hat. Deshalb gibt es in Regeln kein
`kategorie:`, kein `ist:neu` und keine relativen Daten wie `-30t`.

Die Regeln eines Kategorie-Knotens erreichst du auch über „Regeln“ im Kopf der Kategorie
(++g++ dann ++r++ führt direkt zur Liste).
