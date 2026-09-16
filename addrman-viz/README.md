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

* **Square colour** — the Bitprojects share of that bucket, on a single blue
  ramp (light → dark, reversed for dark mode). Grey means the bucket has entries
  but no Bitprojects; the faintest tone means the bucket is empty. The
  *Occupancy* toggle re-colours the same squares by how full they are instead.
  One hue, one quantity at a time: the map reads by lightness, so it stays
  legible for any kind of colour vision.
* **Hover** — exact counts for that bucket, the honest/Bitprojects split, and the
  network mix.
* **Show numbers** — the same data as tables (share histogram, heaviest buckets).

Slot counts are higher than address counts in the new table: one "new" address
can be referenced from up to 8 buckets, and each reference is a separate chance
of being selected, so per-slot is the number that matters.

## The two selection metrics

Both are shown in the second tile row.

### Variables

| Symbol | Meaning | Source |
|---|---|---|
| `T` | a table, either `new` or `tried` | |
| `b` | one bucket of table `T` | |
| `B_T` | the set of **non-empty** buckets of `T` | at most 1024 for new, 256 for tried |
| `\|B_T\|` | how many buckets are in use | |
| `n_b` | entries in bucket `b` (occupied slots) | `1 <= n_b <= 64` |
| `a_b` | Bitprojects entries in bucket `b` | `0 <= a_b <= n_b` |
| `S_T` | occupied slots in `T` = `sum over b of n_b` | `GetEntries()` row count |
| `P_T` | Bitprojects slots in `T` = `sum over b of a_b` | `GetEntries()` rows where `IsBitprojects()` |
| `A_T` | **distinct** addresses in `T` | `AddrMan::Size(nullopt, in_new)` |
| `f_T` | Bitprojects share of table `T` | as defined by the gist, below |

`S_new >= A_new`, because one new-table address can be referenced from up to
`ADDRMAN_NEW_BUCKETS_PER_ADDRESS` (8) buckets and occupies one slot in each.
For the tried table `S_tried == A_tried`.

### q

As defined in the
[model gist](https://gist.github.com/0xB10C/b122747605edb7344da8cb482e98d66c):

```
f_T = P_T / A_T

q   = 1/2 * f_new + 1/2 * f_tried
```

Note the denominator is the **distinct address** count `A_T` while the numerator
counts **slots** — that is what the gist's table and bitcoin/bitcoin#34019 report,
and reproducing their figures requires it. The tile also shows the slot-consistent
variant:

```
q_slots = 1/2 * (P_new / S_new) + 1/2 * (P_tried / S_tried)
```

### q_bucket

Same 50/50 table choice, but then a uniformly random **non-empty bucket** and a
uniformly random entry inside it — the shape of `AddrMan::Select()`. A given
entry in bucket `b` of table `T` is drawn with probability
`1 / (2 * |B_T| * n_b)`, so:

```
q_bucket = 1/2 * (1/|B_new|)   * sum over b in B_new   of (a_b / n_b)
         + 1/2 * (1/|B_tried|) * sum over b in B_tried of (a_b / n_b)
```

Per table that is the **unweighted** mean of the per-bucket shares, whereas
`P_T / S_T` is the same mean **weighted by bucket occupancy**. The exact relation
is the weighted-mean identity:

```
P_T / S_T = mean_b(a_b / n_b) + cov_b(n_b, a_b / n_b) / mean_b(n_b)
            \_______________/   \_________________________________/
             q_bucket term        the entire difference
```

where `mean_b` and `cov_b` are taken over `b in B_T` (unweighted). So the two
agree only when every non-empty bucket holds the same number of entries, or when
bucket occupancy is uncorrelated with Bitprojects share. Bucket-uniform selection
weights every *bucket* equally, so an entry in a bucket of 4 is worth 16x one in
a bucket of 64; the flat share weights every *entry* equally.

`test.js` asserts this identity on every sample file, and checks that `f_new` and
`f_tried` reproduce the gist's table.

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
