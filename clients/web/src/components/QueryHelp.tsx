import { Popover } from "radix-ui";
import { Info } from "lucide-react";
import { Ic } from "./icons";

type Block = { title: string; rows: [string, string, "search"?][] };

// Rows marked "search" do not apply to rules
const HELP: Block[] = [
    {
        title: "Verknüpfen",
        rows: [
            ["rewe edeka", "beide Wörter (Leerzeichen = UND)"],
            ["rewe ODER edeka", "eines der Wörter"],
            ["(rewe ODER edeka) >50", "Klammern; UND vor ODER"],
            ["NICHT paypal  ·  -paypal", "ohne dieses Wort"],
            ['"rewe markt"', "genau diese Zeichenfolge"],
            ["Test*strasse  ·  M??er", "* beliebig viele, ? genau ein Zeichen"],
        ],
    },
    {
        title: "Felder",
        rows: [
            ["gegenseite:rewe  ·  name:", "nur Gegenseite"],
            ["zweck:miete", "nur Verwendungszweck"],
            ["iban:DE89*", "nur IBAN der Gegenseite"],
            ["konto:giro", "Konto, seine IBAN oder Kontogruppe"],
            ["kategorie:Haushalt  ·  kat:", "Kategorie samt Unterkategorien", "search"],
            ["kat:-", "ohne Kategorie", "search"],
            ["ist:neu", "nur neue Umsätze", "search"],
        ],
    },
    {
        title: "Betrag und Datum",
        rows: [
            [">50  ·  <=12,99  ·  =12,99", "Betrag, Eingänge und Ausgaben"],
            ["<-100  ·  >+1000", "nur Ausgaben / nur Eingänge"],
            ["datum:3.2026  ·  datum:2026", "im März 2026 / im Jahr 2026"],
            ["datum>=1.3.2026  ·  datum<2026", "ab dem Tag / vor 2026"],
            ["datum:-30t  ·  -2w  ·  -3m  ·  -1j", "letzte 30 Tage, 2 Wochen, 3 Monate, 1 Jahr", "search"],
            ["datum:vormonat  ·  datum<-1j", "letzter Monat / älter als ein Jahr", "search"],
            ["heute gestern woche monat quartal jahr", "auch mit vor…: vorwoche, vormonat …", "search"],
        ],
    },
];

/** Overview of the search syntax behind an info button; `rule` leaves out what rules cannot use. */
export function QueryHelp({ mode = "search" }: { mode?: "search" | "rule" }) {
    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button type="button" className="search-help" aria-label="Suchsyntax anzeigen" title="Suchsyntax">
                    <Ic icon={Info} size={16} />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content className="pop-content" align="end" sideOffset={10} collisionPadding={12}>
                    <div className="pop qhelp" role="dialog" aria-label="Suchsyntax">
                        {HELP.map((block) => (
                            <section key={block.title}>
                                <h3 className="label">{block.title}</h3>
                                <dl>
                                    {block.rows
                                        .filter((row) => mode === "search" || row[2] !== "search")
                                        .map(([code, text]) => (
                                            <div key={code}>
                                                <dt className="mono">{code}</dt>
                                                <dd>{text}</dd>
                                            </div>
                                        ))}
                                </dl>
                            </section>
                        ))}
                        <p className="muted small">
                            {mode === "search"
                                ? "UND, ODER und NICHT nur in Großbuchstaben. Ein Datum in der Suche ersetzt die Vorgabe im Menü „Zeitraum“. Esc leert das Feld."
                                : "UND, ODER und NICHT nur in Großbuchstaben. Regeln wirken nur auf Umsätze ohne Kategorie, deshalb gibt es hier kein kategorie: und keine relativen Daten wie -30t oder vormonat."}
                        </p>
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
