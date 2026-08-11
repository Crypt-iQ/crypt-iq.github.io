---
layout: post
title: "Working on incremental snapshots"
date: 2026-08-07
---

As part of my Brink grant, I get to work on fuzzamoto and, more specifically, on something called "incremental snapshots". I won't explain from the ground up what fuzzamoto is so if you want an explainer on that, you should take a look at the brink.dev blog series on fuzzamoto. It is a good read.

The diagram below roughly explains what currently happens in fuzzamoto when a snapshot restore back to the root snapshot occurs (CPU number is arbitrary):

<img src="/root-snapshot.png" alt="" style="max-width:80%;height:auto;display:block;margin:0 auto;" />

After executing the input, the scenario binary invokes the `RELEASE` hypercall which causes a VM exit to the kernel module and then execution continues in the part of `QEMU-Nyx` that handles hypercalls.
Then the `NEXT_PAYLOAD` hypercall is issued and a single character is written to the shared memory region that the `fuzzamoto-libafl` process also maps. `fuzzamoto-libafl` reads this character and knows to provide another input. This input is written to the shared memory region along with a single character to inform `QEMU-Nyx` that an input is ready.
`QEMU-Nyx` reads the character, reads the input and hands it to the scenario binary which executes it. This knowledge will be useful later, so we'll stick a pin in it.

Incremental snapshots exploit the observation that when fuzzing stateful applications, inputs often share a common prefix (e.g. protocols with handshakes). By taking an extra "incremental" snapshot later in the execution (while we still have the root snapshot available), we can fuzz from this later point and avoid repeatedly executing earlier instructions. After some mutations, we can discard the incremental snapshot and return to the root.
The paper that introduced it (https://arxiv.org/pdf/2111.03013v1) used this to solve Super Mario levels with a fuzzer without needing to waste time executing the portion of the input that got Mario to the current state. Importantly, this also constrained the fuzzer to limit mutations to after the "checkpoint" and avoided the all too common effect of having a single bitflip earlier in the input trigger unwanted side effects which in this case would send Mario into the abyss.
Instead of playing Super Mario, we want to get our bitcoind into weird and complex states.

On the implementation side, the `fuzzamoto-libafl` process decides where to insert a snapshot opcode for a given input. This opcode is part of fuzzamoto's intermediate representation (IR). This input is handed off to the `QEMU-Nyx` backend which then gets executed by the scenario binary inside of `QEMU-Nyx`. The scenario binary executes the input normally, sending messages to bitcoind until it hits the snapshot opcode.
At this point, it issues the `CREATE_TMP_SNAPSHOT` hypercall, creating an incremental snapshot at this exact point. Then it continues, executing the rest of the input, except when it calls the `RELEASE` hypercall at the end, the snapshot restore goes back to the point right after the incremental snapshot was taken.
This also requests a new input (via the `NEXT_PAYLOAD` hypercall) from `fuzzamoto-libafl` which knows to mutate inputs only after the snapshot point. This loop continues for a configurable number of times before `fuzzamoto-libafl` decides to discard the incremental snapshot. Taken together, it looks like this:

<img src="/incremental-snapshot.png" alt="" style="max-width:80%;height:auto;display:block;margin:0 auto;" />

If this looks like hieroglyphs to you, you're not alone. I've left out the part of discarding the incremental snapshot after N tries; basically `fuzzamoto-libafl` sets a discard bit in a config struct that's mapped into shared memory that instructs `QEMU-Nyx` to discard. Quite a bit of the paper is dedicated to finding the best place to insert the snapshot opcode in step 1 of the diagram.
They evaluate three different snapshot placement policies:
- `none` - no incremental snapshots, equivalent to running fuzzamoto master
- `balanced` - choose the root snapshot 4% of the time, otherwise select a random index in the whole (50%) or only in the latter half (50%)
- `aggressive` - place the snapshot at the end of the input. If no inputs are found after 50 iterations, place the snapshot one index prior. Loop back to the end when reaching the smallest index.

The coverage and speed gains varied depending on both placement policy and target. The paper states that the `none` policy gave a 4x speedup (clearly just using snapshots "normally" is useful), the `balanced` policy gave a ~5.8x speedup, and the `aggressive` policy gave a ~11x speedup. So, naturally, I wanted to measure different policies and see if fuzzamoto could be made faster.

After writing the incremental snapshot code for fuzzamoto (with little help from Claude -- it mostly hallucinated), I made two additional semi-related changes. First, I increased the instruction count from 4096 to 40960 since incremental snapshots should give a speedup related to the size of the input. Second, I increased the default corpus cache count from 100 to 5000 since the code had to deal with LibAFL constraints where sometimes inputs would get evicted from the cache. This corpus cache patch turned out to be unnecessary. Another LibAFL quirk was that I could not precisely control the number of mutations per input with a small amount of code, but I may have a way to do this. In short, the mutational "stage" runs 50 times per input in my branch and each stage can randomly perform between 1 and 128 mutations if memory serves.

This first iteration attempted to mimic the `balanced` policy, except after re-reading section 3.4 in the paper, I realize that I made a mistake. After falling back to the root snapshot 4% of the time, instead of choosing a random index in the whole space 50% of the time, it just randomly chose the lower half or the upper half, which is incorrect. I then compared this branch to one part of the master tree but with an added commit to increase the instruction count to 40960. The following graph shows the two branches over 10 runs each for 12 hours on 31 cores:

<img src="/fuzzamoto-31c-12h-10r-dir-comparison.png" alt="" style="max-width:80%;height:auto;display:block;margin:0 auto;" />

Averaging the results:

<img src="/incremental-12c-31h-10r-avg.png" alt="" style="max-width:80%;height:auto;display:block;margin:0 auto;" />

These graphs show that the incremental snapshot branch differs from the baseline in all four metrics that I measured. Incremental snapshots:
- achieve less coverage: perhaps because more time is spent mutating certain inputs?
- give a smaller corpus: this is in line with having less coverage
- are clearly faster: this is in line with the paper's findings and what I would expect
- are more stable: perhaps because it mutates less inputs and has a smaller corpus?

The speed gain enough is worth the added code complexity in my opinion, but I still wanted to dig deeper.

After running this benchmark for 5 days and analyzing the results, I realized that the baseline did not include the corpus cache commit I mentioned earlier. Therefore, it was not a fair benchmark. This was a bit disappointing because I use the machine for my fuzzing campaigns and when I benchmark, nothing else runs on the machine. So, I ran a corpus cache benchmark for 12 hours + 31 cores on fuzzamoto master where I varied the corpus cache size in step sizes from 100 to 100K:

<img src="/fuzzamoto-corpuscache-bench.png" alt="" style="max-width:80%;height:auto;display:block;margin:0 auto;" />

There appears to be no speed difference I could observe which was the point of introducing the cache increase patch in the first place.

After ruling out the corpus cache commit as messing with the benchmark, I decided to code up some placement policies:
- `upperquartile`: take the snapshot only in the upper quartile of the input
- `upperhalf`: take the snapshot only in the upper half
- `balanced`: take the snapshot in the upper half or the lower half randomly (the policy that I messed up)
- `aboveN`: take the snapshot only above instruction index N, fallback to root if input less than N instructions

I expected policies that placed the snapshot opcode later in the input to be faster, but this was not necessarily the case. I ran each policy for 12 hours on 31 cores and have graphed only the speed below since the other metrics were uninteresting:

<img src="/fuzzamoto-placement-12h-31c-comparison4.png" alt="" style="max-width:80%;height:auto;display:block;margin:0 auto;" />

The legend is sorted by speed in descending order. The `upperquartile` policy is the fastest at a little above 600 execs/s or more than twice as fast as the baseline branch. Increasing the N value in the "aboveN" policies leads to progressively slower execs/s. I did not investigate further about this confusing slowdown. It could be related to falling back to the root snapshot frequently if inputs are not large enough. This graph has convinced me to change my code to use the `upperquartile` policy as the default.

This post only went into some of the directions I've explored. I went down several other paths that were not as rewarding. In the future, I might try benchmarking an aggressive placement policy like the paper describes. I did code up a version of this, though I did not properly benchmark it and I stopped early as I didn't see any crazy good speed bump. I also tried having `fuzzamoto-libafl` only send the suffix (the portion of the input after the snapshot opcode), but it didn't give any noticeable improvement. Another thing that could be interesting to explore is fiddling with the 50 iteration count that's hardcoded. In theory, the larger this iteration count, the less `QEMU-Nyx` must discard the incremental snapshot and restore to the root snapshot. I think this would give a speed bump. A potentially interesting side project could be to (in an automated way) compare the branches that incremental snapshots hit vs. baseline; in theory, incremental snapshots should drill deeper into targeted code paths. Lastly, it might be interesting to have more heuristics for snapshot placement: like placing it based on if some bitcoind debug log line was encountered in a prior run. The possibilities are probably endless.
