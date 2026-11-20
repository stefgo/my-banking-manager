import { describe as suite, expect, it } from "vitest";
import { describe } from "./trace.js";

suite("trace", () => {
    it("shows structure and codes, but no contents", () => {
        const msg =
            "HNHBK:1:3+000000000100+300+D1+2'" +
            "HIRMG:2:2+3060::Bitte beachten Sie die Hinweise.'" +
            "HIRMS:3:2:3+3920::Zugelassene Verfahren:923+0020::Ok.'" +
            "HIUPA:4:4:3+geheim+7+0+Erika Mustermann'" +
            "HIUPD:5:6:3+1234567::280:70054306+DE02700543061234567+geheim+1+EUR+Erika Mustermann++Giro+++HKSAL:1+HKKAZ:1'" +
            "HIUPD:6:6:3++++++++Online-Banking'" +
            "HNHBS:7:1+2'";
        const line = describe(Buffer.from(msg, "latin1"));
        expect(line).toBe("HIRMG:2 HIRMS:2>3 HIUPA:4>3 HIUPD:6>3 HIUPD:6>3 | codes G=3060 S3=3920,0020 | UPD version 7, usage 0, 2 HIUPD v6[Nr+IBAN+2GV] v6[-]");
        for (const secret of ["geheim", "Erika", "1234567", "DE02", "Hinweise", "923"]) expect(line).not.toContain(secret);
    });
});
