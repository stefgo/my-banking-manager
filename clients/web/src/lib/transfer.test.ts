import { describe, expect, it } from "vitest";
import { parseBankText } from "./bankText";
import { CreateTransferRequest, groupIban } from "@mbm/shared";
import { bicToSend, blzOfIban, checkTransfer, emptyForm, ibanAsTyped, newRequestId, remittanceLeft } from "./transfer";

describe("bank text", () => {
    it("builds a tree of the allowed markup and keeps everything else as text", () => {
        expect(parseBankText("<p>Der Name <b>weicht ab</b>.</p><ul><li>eins<li>zwei</ul>")).toEqual([
            { tag: "p", children: ["Der Name ", { tag: "b", children: ["weicht ab"] }, "."] },
            { tag: "ul", children: [{ tag: "li", children: ["eins", { tag: "li", children: ["zwei"] }] }] },
        ]);
        expect(parseBankText("a<br>b &amp; <script>x</script>")).toEqual(["a", { tag: "br", children: [] }, "b & <script>x</script>"]);
        expect(parseBankText("</b>ohne")).toEqual(["ohne"]);
    });
});

describe("transfer form", () => {
    const ok = { ...emptyForm("1"), payeeName: "Erika Mustermann", payeeIban: "DE89 3704 0044 0532 0130 00", amount: "1,00" };

    it("accepts a complete form", () => {
        expect(Object.values(checkTransfer(ok, false)).filter(Boolean)).toEqual([]);
    });

    it("names what is missing or wrong", () => {
        const e = checkTransfer({ ...emptyForm(), payeeIban: "DE89370400440532013001", amount: "0", remittance: ["Rechnung #1", "", "", ""] }, true);
        expect(e).toMatchObject({
            "tr-acc": "Bitte ein Konto wählen.",
            "tr-name": "Bitte den Empfänger eingeben.",
            "tr-iban": expect.stringContaining("Prüfziffer stimmt nicht"),
            "tr-amount": expect.stringContaining("größer als 0"),
            "tr-purpose": "Dieses Zeichen ist in Überweisungen nicht erlaubt: „#“",
            "tr-pin": "Bitte die PIN eingeben.",
        });
    });

    it("writes the IBAN in groups of four while it is typed and keeps the caret", () => {
        // Typing at the end
        expect(ibanAsTyped("de89", 4)).toEqual({ value: "DE89", caret: 4 });
        expect(ibanAsTyped("DE893", 5)).toEqual({ value: "DE89 3", caret: 6 });
        // Typing in the middle: the caret stays behind the new character
        expect(ibanAsTyped("DE89 37X04 0044", 8)).toEqual({ value: "DE89 37X0 4004 4", caret: 8 });
        // Deleting the character in front of a space
        expect(ibanAsTyped("DE8 3704", 3)).toEqual({ value: "DE83 704", caret: 3 });
        // Pasted with other separators, and never longer than 34 characters
        expect(ibanAsTyped("de89-3704-0044-0532-0130-00", 27).value).toBe("DE89 3704 0044 0532 0130 00");
        expect(ibanAsTyped("X".repeat(40), 40)).toEqual({ value: groupIban("X".repeat(34)), caret: 42 });
        // Within a known country, not longer than its IBAN: AT has 20 characters
        expect(ibanAsTyped("AT61 1904 3002 3457 32015", 25)).toEqual({ value: "AT61 1904 3002 3457 3201", caret: 24 });
        expect(ibanAsTyped("AT61 1904 3002 3457 3X201", 22)).toEqual({ value: "AT61 1904 3002 3457 3X20", caret: 22 });
    });

    it("counts the characters left in the lines and within 140", () => {
        const x = (n: number) => "x".repeat(n);
        expect(remittanceLeft(["", "", "", ""])).toBe(137);
        expect(remittanceLeft([x(10), "", "", ""])).toBe(127);
        // Only the last line has room; the 140 would allow more
        expect(remittanceLeft([x(30), x(30), x(30), x(30)])).toBe(5);
        // The 140 with the three joining spaces end before the last line does
        expect(remittanceLeft([x(35), x(35), x(35), x(10)])).toBe(22);
        expect(remittanceLeft([x(35), x(35), x(35), x(32)])).toBe(0);
    });

    it("checks the lines of the remittance information and their joined length", () => {
        const full = "x".repeat(35);
        expect(checkTransfer({ ...ok, remittance: ["Rechnung 4711", "Kunde 12", "", ""] }, false)["tr-purpose"]).toBeUndefined();
        expect(checkTransfer({ ...ok, remittance: ["", "y".repeat(36), "", ""] }, false)["tr-purpose"]).toBe("Zeile 2 hat mehr als 35 Zeichen.");
        expect(checkTransfer({ ...ok, remittance: [full, full, full, full] }, false)["tr-purpose"]).toContain("Höchstens 140 Zeichen");
        expect(checkTransfer({ ...ok, remittance: [full, full, full, "x".repeat(32)] }, false)["tr-purpose"]).toBeUndefined();
    });

    it("sends a BIC only for SEPA countries outside the EEA, and checks its form", () => {
        const swiss = { ...ok, payeeIban: "CH93 0076 2011 6238 5295 7" };
        expect(bicToSend({ ...ok, payeeBic: "COBADEFFXXX" })).toBeNull();
        expect(bicToSend({ ...swiss, payeeBic: " ubswchzh80a " })).toBe("UBSWCHZH80A");
        expect(bicToSend(swiss)).toBeNull();
        expect(checkTransfer({ ...swiss, payeeBic: "UBSWCH" }, false)["tr-bic"]).toContain("8 oder 11");
        expect(checkTransfer({ ...ok, payeeBic: "UBSWCH" }, false)["tr-bic"]).toBeUndefined();
    });

    it("finds the bank code of German IBANs only", () => {
        expect(blzOfIban("DE89 3704 0044 0532 0130 00")).toBe("37040044");
        expect(blzOfIban("AT611904300234573201")).toBeNull();
    });
});

describe("request id", () => {
    it("is a random UUID v4 the server accepts, also without crypto.randomUUID", () => {
        const ids = Array.from({ length: 50 }, newRequestId);
        for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(new Set(ids).size).toBe(50);
        expect(CreateTransferRequest.shape.requestId.safeParse(ids[0]).success).toBe(true);
    });
});
