# A ten-minute check

The [README](../README.md) opens with the claim the design is held to, **Preserve potential indefinitely**, and its [technical debt](../README.md#technical-debt) lists every way three adversarial readings found that claim false, each with its state. This page is a check anyone can run in about ten minutes. It shows five things: the npm package is its git tag's source, file for file; the pin tests pass; each repaired case fails on the code before its repair; ltms uses no network; and the report's figures come from the table deposited with it.

You need Linux, Node 20 or newer (the package's floor), git and curl. The counts are those of 0.2.2, measured with Node 26 (the pin suite's also with Node 24).

```sh
V=0.2.2
mkdir ltms-check && cd ltms-check
P=long-term-memory-structure
counts() { grep -E '^# (pass|fail) '; }
# 1. The npm package is the git tag's source, file for file: prints nothing when all 19 files agree
curl -sL "$(npm view $P@$V dist.tarball)" | tar -xz
git clone -q "https://github.com/$P/$P.git" src && git -C src checkout -q "v$V"
(cd package && find . -type f) |
  while read -r f; do cmp -s "package/$f" "src/$f" || echo "differs: $f"; done
# 2. The pin tests, nothing to install: 240 pass, 0 fail, in about a minute
cd src && node --test --test-reporter=tap test/pin.test.mjs | counts
# 3. Each release's repairs, run against the code before them. 0.2.2's (the tests named S369) against
#    0.2.1's code: 17 fail (the other 8 check what 0.2.1 already did right); against 0.2.2's: 25 pass
mkdir ../v021 && git archive v0.2.1 dist | tar -x -C ../v021
LTMS_PIN="$PWD/../v021/dist/pin.js" LTMS_CLI="$PWD/../v021/dist/cli.js" \
  node --test --test-reporter=tap --test-name-pattern='S369' test/pin.test.mjs | counts
node --test --test-reporter=tap --test-name-pattern='S369' test/pin.test.mjs | counts
#    0.2.1's (S367 temps, S368) against 0.2.0's code: 26 fail (the other 4 check what 0.2.0 did right); here: 30 pass
mkdir ../v020 && git archive v0.2.0 dist | tar -x -C ../v020
LTMS_PIN="$PWD/../v020/dist/pin.js" LTMS_CLI="$PWD/../v020/dist/cli.js" \
  node --test --test-reporter=tap --test-name-pattern='S367 temps|S368' test/pin.test.mjs | counts
node --test --test-reporter=tap --test-name-pattern='S367 temps|S368' test/pin.test.mjs | counts
# 4. No network: no network module in the code (prints nothing); it runs with no network at all
grep -lE "node:(net|http|https|http2|tls|dgram|dns)" dist/*.js
unshare -rn node dist/cli.js skeleton test/fixtures/compacted.jsonl | head -3
# 5. The report's figures, from the table deposited with it: prints 238 48161
curl -sL "https://zenodo.org/records/24139258/files/sessions_238.csv?download=1" |
  tail -n +2 | cut -d, -f4 | sort -n | awk '{v[NR]=$1} END {print NR, (v[NR/2]+v[NR/2+1])/2}'
```

Step 5's two numbers are the report's 238 sessions and their median first call, 48,161 tokens. The report is *Durable Memory on a Fixed Context Budget: Architecture and Measurements of a Long-Lived Coding Agent* (Ben Yanai 2026, DOI [10.5281/zenodo.24139258](https://doi.org/10.5281/zenodo.24139258)).

Two of the pin tests are skipped here: they pin sparse transcripts of 1.5 and 4.25 GiB, each under a memory limit of 256 MiB, and run only when `LTMS_BIG_DIR` names a directory on a disk (not tmpfs) with 10 GB free, on a system with `systemd-run --user` and `sha256sum`. On 0.2.1's code the first is killed at the limit, and the second is refused.

Built by Ohav Ben Yanai with Claude Code agents that I direct: I set the design and the rules, review the work, and make every release decision.
