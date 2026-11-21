# CSV Reader, Faster

A faster drop-in for make.fun's csv-reader 1.0.0 that returns identical answers on every case, by delimiter scanning with slice() instead of one character at a time.

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/eskrimkonelo/csv-reader-fast/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/eskrimkonelo/csv-reader-fast/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

[Bounty: Read broken CSV files faster, 21 November 2026](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

## How it works

Record-level fast path for clean records (slice + split), indexOf-based field scanning, slice() instead of char-by-char concatenation, no per-field allocations.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> node main.ts
```

Requires Node 22.

## License

MIT.
