// Conventional Commits: the type decides the next version (feat: minor, fix/perf: patch), the
// subject stays German. Checked locally by .githooks/commit-msg and in CI for pull requests.
export default {
    extends: ["@commitlint/config-conventional"],
    // The release commit carries the generated notes as its body, with lines longer than
    // body-max-line-length allows. Without this exception the commit-msg hook would reject the
    // release at its own commit, after the version had already been computed.
    ignores: [(message) => /^chore\(release\): \d+\.\d+\.\d+/.test(message)],
    plugins: [
        {
            rules: {
                // Only the `BREAKING CHANGE:` footer marks a breaking change. semantic-release
                // reads `feat!:` as typeless and would release nothing, and the "!" promises a
                // major step, while a breaking change raises the minor position here.
                "no-breaking-bang": ({ header }) => [
                    !/^[a-z]+(\([^)]*\))?!:/.test(header ?? ""),
                    'Kein "!" nach dem Typ. Stattdessen eine Fußzeile "BREAKING CHANGE: …".',
                ],
            },
        },
    ],
    rules: {
        // German subjects start with a capital letter ("feat: Überweisen als Dialog").
        "subject-case": [0],
        "no-breaking-bang": [2, "always"],
    },
};
