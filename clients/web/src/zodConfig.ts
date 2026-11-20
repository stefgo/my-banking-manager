import { z } from "zod";

// The CSP forbids eval. Zod probes for it while schemas are built, so this runs before any other import.
z.config({ jitless: true });
