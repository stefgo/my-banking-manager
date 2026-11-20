import { describe, expect, it } from "vitest";
import { MAX_FAILURES, Throttle } from "./throttle.js";

const fakeClock = () => {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
};

const status = (fn: () => unknown): number | "ok" => {
    try {
        fn();
        return "ok";
    } catch (err) {
        return (err as { status: number }).status;
    }
};

describe("throttling of failed sign-ins", () => {
    it("counts tries under way, so tries at the same time cannot exceed the limit", () => {
        const throttle = new Throttle(fakeClock().now);
        const releases = Array.from({ length: MAX_FAILURES }, () => throttle.begin("a"));
        expect(status(() => throttle.begin("a"))).toBe(429);
        expect(status(() => throttle.begin("b"))).toBe("ok");
        for (const r of releases) {
            throttle.fail("a");
            r();
        }
        expect(status(() => throttle.begin("a"))).toBe(429);
    });

    it("allows one try at a time after the wait, and a success forgets everything", () => {
        const clock = fakeClock();
        const throttle = new Throttle(clock.now);
        for (let i = 0; i < MAX_FAILURES; i++) {
            const release = throttle.begin("a");
            throttle.fail("a");
            release();
        }
        expect(status(() => throttle.begin("a"))).toBe(429);
        clock.advance(30_001);
        const release = throttle.begin("a");
        expect(status(() => throttle.begin("a"))).toBe(429);
        throttle.succeed("a");
        release();
        expect(throttle.size).toBe(0);
    });

    it("forgets entries a while after their last failure", () => {
        const clock = fakeClock();
        const throttle = new Throttle(clock.now);
        for (let i = 0; i < 1000; i++) {
            const release = throttle.begin(`ip|name-${i}`);
            throttle.fail(`ip|name-${i}`);
            release();
        }
        expect(throttle.size).toBe(1000);
        clock.advance(16 * 60_000);
        throttle.begin("fresh")();
        expect(throttle.size).toBe(0);
    });

    it("keeps at most the given number of entries, dropping those without a wait first", () => {
        const clock = fakeClock();
        const throttle = new Throttle(clock.now, 10);
        for (let i = 0; i < MAX_FAILURES; i++) {
            const release = throttle.begin("target");
            throttle.fail("target");
            release();
        }
        for (let i = 0; i < 50; i++) {
            const release = throttle.begin(`flood-${i}`);
            throttle.fail(`flood-${i}`);
            release();
        }
        throttle.begin("one-more")();
        expect(throttle.size).toBeLessThanOrEqual(10);
        // The client that must wait still waits
        expect(status(() => throttle.begin("target"))).toBe(429);
    });
});
