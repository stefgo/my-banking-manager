// Import formats that come with the app. They are read-only; a copy can be saved as an own format.
// A format is added here only with a real sample of the export it describes.

import type { ImportFormatDefinition } from "./schemas/banking.js";

export interface BuiltinImportFormat {
    key: string;
    name: string;
    definition: ImportFormatDefinition;
}

const column = (name: string) => [{ column: name }];
const part = (name: string) => [{ step: "details", part: name }];

export const BUILTIN_IMPORT_FORMATS: BuiltinImportFormat[] = [
    {
        key: "builtin:moneymoney",
        name: "MoneyMoney (CSV)",
        definition: {
            version: 1,
            file: { encoding: "auto", delimiter: ";", quote: "\"", headerLine: 1 },
            steps: [
                {
                    id: "details",
                    input: { column: "Verwendungszweck" },
                    type: "keywords",
                    prefix: ", ",
                    suffix: ": ",
                    keywords: [
                        { text: "Umsatzart", part: "bookingText" },
                        { text: "Rückgabegrund", part: "returnReason" },
                        { text: "Referenz", part: "reference" },
                        { text: "Mandat", part: "mandateId" },
                        { text: "Gläubiger-ID", part: "creditorId" },
                    ],
                },
            ],
            fields: {
                bookingDate: column("Datum"),
                valueDate: column("Wertstellung"),
                amount: column("Betrag"),
                counterpartyName: column("Name"),
                counterpartyIban: column("Konto"),
                counterpartyBic: column("Bank"),
                category: column("Kategorie"),
                remittance: part("rest"),
                bookingText: part("bookingText"),
                reference: part("reference"),
                mandateId: part("mandateId"),
                creditorId: part("creditorId"),
            },
            values: { dateOrder: "dmy", decimalSeparator: ",", categorySeparator: "auto", pendingWords: [] },
        },
    },
    {
        key: "builtin:sparkasse-camt",
        name: "Sparkasse CSV-CAMT",
        definition: {
            version: 1,
            file: { encoding: "auto", delimiter: ";", quote: "\"", headerLine: 1 },
            steps: [],
            fields: {
                bookingDate: column("Buchungstag"),
                valueDate: column("Valutadatum"),
                amount: column("Betrag"),
                counterpartyName: column("Beguenstigter/Zahlungspflichtiger"),
                counterpartyIban: column("Kontonummer/IBAN"),
                counterpartyBic: column("BIC (SWIFT-Code)"),
                remittance: column("Verwendungszweck"),
                bookingText: column("Buchungstext"),
                reference: column("Kundenreferenz (End-to-End)"),
                mandateId: column("Mandatsreferenz"),
                creditorId: column("Glaeubiger ID"),
                status: column("Info"),
            },
            values: { dateOrder: "dmy", decimalSeparator: ",", categorySeparator: "auto", pendingWords: ["vorgemerkt"] },
        },
    },
];
