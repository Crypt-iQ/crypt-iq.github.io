# AddrMan Bucket Map

A single-page viewer for Bitcoin Core `peers.dat` files. Drop a file on the page
and it draws every AddrMan bucket — 1024 for the **new** table, 256 for the
**tried** table — shaded by the share of the bucket that is Bitprojects.

Everything runs in the browser; the file is never uploaded.

## Usage

Open `index.html` in a browser (`file://` works — `addrman.js` is loaded as a
plain script, no server or build step needed), then drop a `peers.dat` on it.
Sample files live in `../simulation_data/`.

## Reading the map

Above each grid is a **share profile**: every non-empty bucket's Bitprojects
share, sorted tallest-first. The mean height of that curve *is* the table's
`q_bucket` term (marked `q_e`), and the dashed line is the flat share
`P_T / S_T`. Whether the curve spends more area above or below that line is the
`q_bucket` vs `q` comparison, at a size you can actually read — an 18px bucket
square is too small to judge a ratio across a thousand cells.

Below it, every square is one bucket on the 0–64 slot scale: grey = entries the
bucket holds (`n_b`), blue = Bitprojects among them (`a_b`), nothing = empty
bucket. This is the view that shows occupancy, so you can see which buckets are
sparse — their entries are the *most* likely to be drawn, since a bucket gets its
full share of the probability mass however few addresses sit in it.

A non-zero blue bar keeps a 1px hairline so small shares stay visible.

**Sort by** reorders the grid (Bitprojects share / count / occupancy / bucket
index). Bucket indices have no spatial meaning, so sorting loses nothing and puts
the interesting buckets in the top-left; the tooltip always reports the real
bucket number.

**Hover** gives exact counts, the honest/Bitprojects split, and the network mix.
**Show numbers** opens the same data as tables.

Slot counts are higher than address counts in the new table: one "new" address
can be referenced from up to 8 buckets, and each reference is a separate chance
of being selected, so per-slot is the number that matters.

## Selection metrics

### Variables

| Symbol | Meaning |
|---|---|
| $T$ | a table, either `new` or `tried` |
| $b$ | one bucket of table $T$ |
| $B_T$ | the non-empty buckets of $T$ (at most 1024 new, 256 tried) |
| $n_b$ | entries in bucket $b$, $1 \leq n_b \leq 64$ |
| $a_b$ | Bitprojects entries in bucket $b$, $0 \leq a_b \leq n_b$ |
| $S_T = \sum_{b \in B_T} n_b$ | occupied slots in $T$ |
| $P_T = \sum_{b \in B_T} a_b$ | Bitprojects slots in $T$ |
| $A_T$ | distinct addresses in $T$ (`AddrMan::Size`) |

$S_{new} \geq A_{new}$: a new-table address can be referenced from up to
`ADDRMAN_NEW_BUCKETS_PER_ADDRESS` (8) buckets and takes a slot in each.
$S_{tried} = A_{tried}$.

### q

As defined in the [model gist](https://gist.github.com/0xB10C/b122747605edb7344da8cb482e98d66c):

$$f_T = \frac{P_T}{A_T} \qquad q = \tfrac{1}{2} f_{new} + \tfrac{1}{2} f_{tried}$$

The numerator counts slots and the denominator counts addresses; that is what the
gist's table and bitcoin/bitcoin#34019 report. The slot-consistent variant:

$$q_{slots} = \tfrac{1}{2}\frac{P_{new}}{S_{new}} + \tfrac{1}{2}\frac{P_{tried}}{S_{tried}}$$

### q_bucket

Pick a table 50/50, then a uniformly random non-empty bucket, then a uniformly
random entry in it. A given entry in bucket $b$ of table $T$ is drawn with
probability $1 / (2 |B_T| n_b)$, so with

$$\mu_T = \frac{1}{|B_T|} \sum_{b \in B_T} \frac{a_b}{n_b}
\qquad
\bar{n}_T = \frac{1}{|B_T|} \sum_{b \in B_T} n_b$$

$$q_{bucket} = \tfrac{1}{2}\mu_{new} + \tfrac{1}{2}\mu_{tried}$$

### How they relate

$\mu_T$ is the unweighted mean of the per-bucket shares; $P_T / S_T$ is the same
mean weighted by bucket occupancy. Exactly:

$$\frac{P_T}{S_T} = \mu_T + \frac{\mathrm{cov}_b\left(n_b,\ a_b/n_b\right)}{\bar{n}_T}$$

They agree only when every non-empty bucket holds the same number of entries, or
when occupancy is uncorrelated with Bitprojects share. Bucket-uniform selection
weights each *bucket* equally, so an entry in a bucket of 4 counts 16x one in a
bucket of 64; the flat share weights each *entry* equally.

`test.js` asserts this identity on every sample file and checks that $f_{new}$
and $f_{tried}$ reproduce the gist's table.

### Distance to the gist's measured q

$q_{bucket}$ models bucket geometry only. The gist's `q measured` comes from full
`TryPickOutboundAddress()` draws, which add two entry-level filters that reject
and redraw. Porting `Select_()` and `TryPickOutboundAddress()` and switching the
filters on (3M draws per cell):

| snapshot | $q_{bucket}$ | `Select_` | + `GetChance` | + services/port | both | gist `q measured` | err |
|---|---|---|---|---|---|---|---|
| 2025-04-24-dan | 1.08% | 1.06% | 1.06% | 1.28% | 1.26% | 1.22% | +0.04 |
| 2025-08-15-dea | 3.65% | 3.65% | 4.59% | 4.59% | 5.89% | 5.68% | +0.21 |
| 2026-01-14-dar | 12.85% | 12.31% | 12.58% | 15.28% | 15.65% | 15.59% | +0.06 |
| 2026-02-10-dan | 11.86% | 11.28% | 11.70% | 13.03% | 13.61% | 13.45% | +0.16 |
| 2026-03-12-hal | 2.72% | 2.83% | 3.09% | 3.29% | 3.60% | 2.41% | +1.19 |
| 2026-03-15-dea | 6.42% | 6.36% | 8.13% | 7.90% | 10.21% | 9.95% | +0.26 |
| 2026-03-26-wil | 3.20% | 3.22% | 3.87% | 3.81% | 4.57% | 4.50% | +0.07 |
| 2026-04-03-dar | 3.31% | 3.30% | 2.61% | 3.71% | 2.95% | 2.97% | -0.02 |
| 2026-06-24-cha | 5.46% | 5.50% | 4.78% | 6.81% | 6.05% | 5.96% | +0.09 |

Mean absolute error over the eight non-asmap snapshots: **0.11pp**.

### Does bucket-uniform selection matter once the filters are in?

Running the same filters on top of two different draws — entry-uniform (what `q`
assumes) and bucket-uniform (what `q_bucket` assumes) — against the measured
values:

| snapshot | flat + filters | bucket + filters | measured |
|---|---|---|---|
| 2025-04-24-dan | 1.25% | 1.26% | 1.22% |
| 2025-08-15-dea | 9.20% | 5.72% | 5.68% |
| 2026-01-14-dar | 17.42% | 16.27% | 15.59% |
| 2026-02-10-dan | 16.02% | 14.55% | 13.45% |
| 2026-03-12-hal | 2.73% | 3.49% | 2.41% |
| 2026-03-15-dea | 11.84% | 9.97% | 9.95% |
| 2026-03-26-wil | 3.82% | 4.43% | 4.50% |
| 2026-04-03-dar | 2.64% | 2.96% | 2.97% |
| 2026-06-24-cha | 7.31% | 6.16% | 5.96% |

Mean absolute error over the eight non-asmap snapshots: **1.53pp** for
entry-uniform, **0.27pp** for bucket-uniform. Bucket-uniform selection is doing
real work: keeping the filters and only swapping the draw costs 1.3pp of
accuracy. Comparing the bare `q` and
`q_bucket` numbers against `measured` is misleading, because `q`'s two errors —
no bucket geometry, no filters — point in opposite directions and partly cancel.

Each filter's effect on its own, in percentage points against the `Select_`
column:

| snapshot | `GetChance` | services/port |
|---|---|---|
| 2025-04-24-dan | +0.00 | +0.22 |
| 2025-08-15-dea | +0.95 | +0.94 |
| 2026-01-14-dar | +0.27 | +2.97 |
| 2026-02-10-dan | +0.42 | +1.75 |
| 2026-03-12-hal | +0.25 | +0.46 |
| 2026-03-15-dea | +1.77 | +1.53 |
| 2026-03-26-wil | +0.66 | +0.60 |
| 2026-04-03-dar | -0.69 | +0.41 |
| 2026-06-24-cha | -0.72 | +1.31 |

- **`GetChance()`** — the accept/retry loop inside `Select_()`. `m_last_try` is
  memory-only and zero after load, so it reduces to
  $0.66^{\min(\mathtt{nAttempts},\ 8)}$. Where honest entries carry accumulated
  failed attempts this lifts the Bitprojects share; where the Bitprojects entries
  themselves have high `nAttempts` (2026-04-03-dar, 2026-06-24-cha) it lowers it.
- **services/port** — `HasAllDesirableServiceFlags` (`NODE_NETWORK|NODE_WITNESS`,
  since `ApproximateBestBlockDepth()` keeps the limited-peer relaxation off) and
  `IsBadPort`, both in `TryPickOutboundAddress()`. Always lifts the Bitprojects
  share, and is the larger of the two on most snapshots.

The two do not simply add: a rejection restarts `Select_()` from
`chance_factor = 1.0`, so the filters partly re-roll the `GetChance` weighting.

`Select_` differs from $q_{bucket}$ only in picking a uniform start position and
scanning forward to the first occupied slot rather than picking an entry
uniformly; it is under 0.1pp on every snapshot except the two sparse-tried ones.

2026-03-12-hal is the asmap snapshot: its tried table is bucketed here without
the asmap, so it is a different table from the one that was measured. Its +1.19
is a different input, not a modelling error.

## How it works

`addrman.js` is a standalone port of the parts of Bitcoin Core needed to read the
file and reproduce its bucketing:

| Concern | Core source |
|---|---|
| file framing (magic + payload + checksum) | `src/addrdb.cpp` |
| addrman payload, `GetTriedBucket` / `GetNewBucket` / `GetBucketPosition` | `src/addrman.cpp`, `src/addrman_impl.h` |
| ADDRv2/BIP155 address encoding, `IsBitprojects()` | `src/netaddress.{h,cpp}` |
| netgroup used for bucketing | `src/netgroup.cpp` |

The **new** table's bucket layout is stored in the file and is replayed as-is.
The **tried** table's is not stored — Core recomputes it on load — so it is
recomputed here the same way.

### Limitation: asmap

`getGroup()` implements the no-asmap path only. A `peers.dat` written by a node
running with an `-asmap` records that asmap's version; the page detects this and
says so. Its new table is still exact (it comes straight off disk), but the tried
bucket indices are recomputed without the asmap and will differ from that node's.

## Tests

```
node addrman-viz/test.js     # from the repo root
```

Checks the parser against the expected values baked into
`src/test/simulation_34019.cpp` for the files in `simulation_data/`: table sizes,
per-network counts, `nTime` ranges, and Bitprojects counts in both tables. All
eight non-asmap files match exactly. The asmap file gets structural checks only —
the C++ test loads it *with* the embedded asmap, which re-buckets its new table,
so its numbers describe a different layout than the one on disk.
