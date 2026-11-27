# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/tatsuyakenta77-arch/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/tatsuyakenta77-arch/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

**png-squeeze** — a lossless PNG re-compressor that squeezes 1280×720 screenshots
into the smallest PNG it can. It decodes each stored RGBA screenshot, picks the
smallest exact representation (palette, grey, grey+alpha, RGB or RGBA, with a
tRNS key where one applies), chooses each row's filter adaptively, and writes
the result with its own optimal-parsing DEFLATE encoder. Every pixel decodes
back byte-for-byte, including the colour of fully transparent pixels.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/image.png` for each instance and writes
`/output/<id>/image.png`. No dependencies, no network, no install step —
plain TypeScript (erasable syntax) on Node 22, standard library only.

## How it squeezes

- **Colour-type reduction** — ≤256 colours become a palette (ordered by count,
  luminance, or a greedy nearest-neighbour walk through colour space, whichever
  compresses smallest); grey images drop to 1 byte per pixel; opaque images
  drop the alpha channel; a single transparent colour becomes a tRNS key.
- **Adaptive filters** — every row gets the filter (None, Sub, Up, Average,
  Paeth) that minimises its cost, judged by an entropy estimate from the
  image's own filtered bytes.
- **Lazy-matching DEFLATE** — a from-scratch encoder: hash-chain match
  search, lazy match evaluation, dynamic Huffman tables, and block splitting.
  Deterministic: two runs write byte-identical files.

## Layout

- `main.ts` — the whole program: PNG decode, analysis, filtering, DEFLATE,
  PNG writer.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
