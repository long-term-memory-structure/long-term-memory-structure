# A ten-minute check

The [README](../README.md) opens with the claim the design is held to, **Preserve potential indefinitely**, and its [technical debt](../README.md#technical-debt) lists every way three adversarial readings found that claim false, each with its state. This page is a check anyone can run in about ten minutes. It shows five things: the npm package is its git tag's files, file for file; the pin tests pass; the tests of each release's repairs fail on the code before them; ltms has no network code; and two of the report's figures (its 238 sessions and their median first call) come from the table deposited with it.

You need Linux with unprivileged user namespaces (for `unshare -r`), Node 20 or newer with npm (the package's floor), git and curl. The counts are those of 0.2.2, measured with Node 26 (the pin suite's also with Node 24).

```sh
V=0.2.2
mkdir ltms-check && cd ltms-check
P=long-term-memory-structure
counts() { grep -E '^# (pass|fail|skipped) '; }
# 1. The npm package is the git tag's files, file for file: prints "19 files compared" and nothing else
#    (dist/ is the build committed with the source; this check does not rebuild it from src/)
curl -sL "$(npm view $P@$V dist.tarball)" | tar -xz
git clone -q "https://github.com/$P/$P.git" tag && git -C tag checkout -q "v$V"
(cd package && find . -type f) | { n=0; while read -r f; do n=$((n + 1))
  cmp -s "package/$f" "tag/$f" || echo "differs: $f"; done; echo "$n files compared"; }
# 2. The pin tests, nothing to install: 240 pass, 0 fail, 2 skipped (the big tests below), in about a minute
cd tag && node --test --test-reporter=tap test/pin.test.mjs | counts
# 3. Each release's repairs, run against the code before them (about 30 s each). 0.2.2's (a transcript
#    of 2 GiB or more; memory that grew with a file) against 0.2.1's code: 6 fail; against 0.2.2's: 6 pass
mkdir ../v021 && git archive v0.2.1 dist | tar -x -C ../v021
LTMS_PIN="$PWD/../v021/dist/pin.js" LTMS_CLI="$PWD/../v021/dist/cli.js" \
  node --test --test-reporter=tap --test-name-pattern='S369 B5|S369 memory' test/pin.test.mjs | counts
node --test --test-reporter=tap --test-name-pattern='S369 B5|S369 memory' test/pin.test.mjs | counts
#    0.2.1's (S367 temps, S368) against 0.2.0's code: 26 fail (the other 4 check what 0.2.0 did right); here: 30 pass
mkdir ../v020 && git archive v0.2.0 dist | tar -x -C ../v020
LTMS_PIN="$PWD/../v020/dist/pin.js" LTMS_CLI="$PWD/../v020/dist/cli.js" \
  node --test --test-reporter=tap --test-name-pattern='S367 temps|S368' test/pin.test.mjs | counts
node --test --test-reporter=tap --test-name-pattern='S367 temps|S368' test/pin.test.mjs | counts
# 4. No network: no network module, subprocess or fetch in the code (prints nothing); it runs with no network at all
grep -nE "['\"](node:)?(net|http|https|http2|tls|dgram|dns|child_process)['\"]|fetch\(|WebSocket" dist/*.js
unshare -rn node dist/cli.js skeleton test/fixtures/compacted.jsonl | head -3
# 5. Two of the report's figures, from the table deposited with it (column 4, first_total): prints 238 48161
curl -sL "https://zenodo.org/records/24139258/files/sessions_238.csv?download=1" |
  tail -n +2 | cut -d, -f4 | sort -n | awk '{v[NR]=$1} END {print NR, (v[NR/2]+v[NR/2+1])/2}'
```

Step 5's two numbers are the report's 238 sessions and their median first call, 48,161 tokens; its other figures come from records that were not deposited. The report is *Durable Memory on a Fixed Context Budget: Architecture and Measurements of a Long-Lived Coding Agent* (Ben Yanai 2026, DOI [10.5281/zenodo.24139258](https://doi.org/10.5281/zenodo.24139258)).

The other tests named S369 test what 0.2.2 adds (one descriptor per source, a temp only when a write is likely, a read torn by a write in place read again, a step `read`, the chunk size); some of them fail on 0.2.1's code only because 0.2.1 has no step `read` or chunk size for them to act on.

The two skipped pin tests pin sparse transcripts of 1.5 and 4.25 GiB, each under a memory limit of 256 MiB. They run only when `LTMS_BIG_DIR` names a directory on a disk (not tmpfs) with 10 GB free, on a system with `systemd-run --user` and `sha256sum`, and took 13 and 25 s with Node 24. On 0.2.1's code the first is killed at the limit, and the second is refused:

```sh
LTMS_BIG_DIR=/a/disk/dir node --test --test-name-pattern='S369 big' test/pin.test.mjs        # 0.2.2: 2 pass
LTMS_BIG_DIR=/a/disk/dir LTMS_PIN="$PWD/../v021/dist/pin.js" LTMS_CLI="$PWD/../v021/dist/cli.js" \
  node --test --test-name-pattern='S369 big' test/pin.test.mjs                                # 0.2.1: 2 fail
```

Built by Ohav Ben Yanai with Claude Code agents that I direct: I set the design and the rules, review the work, and make every release decision.
