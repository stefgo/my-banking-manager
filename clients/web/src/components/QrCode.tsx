import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCode({ uri }: { uri: string }) {
    const [svg, setSvg] = useState("");
    useEffect(() => {
        let alive = true;
        void QRCode.toString(uri, { type: "svg", margin: 0, errorCorrectionLevel: "M" }).then((s) => alive && setSvg(s));
        return () => {
            alive = false;
        };
    }, [uri]);
    // The SVG is generated locally from the otpauth URI; it never leaves the browser
    return <div className="qr" role="img" aria-label="QR-Code für die Authenticator-App" dangerouslySetInnerHTML={{ __html: svg }} />;
}
