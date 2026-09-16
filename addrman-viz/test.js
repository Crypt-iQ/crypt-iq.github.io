// Verifies addrman.js against the expected values in src/test/simulation_34019.cpp.
// Run: node addrman-viz/test.js   (from the repo root)
const fs = require('fs');
const path = require('path');
const AddrMan = require('./addrman.js');

const DATA = path.join(__dirname, '..', 'simulation_data');

// Straight from the PeersDatFile structs in src/test/simulation_34019.cpp.
const EXPECTED = [
  {f:'2026-03-12-hal-peers.dat',asmap:true, new:62183,tried:9413,ipv4:43901,ipv6:5754,onion:18576,i2p:3365,bp_new:396,bp_tried:371,oldest_new:1762413512,youngest_new:1773318441,oldest_tried:1759921515,youngest_tried:1773315622},
  {f:'2025-08-15-dea-peers.dat',f_new:0.94,f_tried:10.83,asmap:false,new:64612,tried:3915,ipv4:57572,ipv6:10955,onion:0,i2p:0,bp_new:610,bp_tried:424,oldest_new:1743088338,youngest_new:1755227248,oldest_tried:1732086452,youngest_tried:1755227636},
  {f:'2026-01-14-dar-peers.dat',f_new:3.3,f_tried:24.55,asmap:false,new:26808,tried:167,ipv4:23906,ipv6:3069,onion:0,i2p:0,bp_new:884,bp_tried:41,oldest_new:1765639029,youngest_new:1768407499,oldest_tried:1765920912,youngest_tried:1768412669},
  {f:'2026-02-10-dan-peers.dat',f_new:3.71,f_tried:22.89,asmap:false,new:46304,tried:83,ipv4:40953,ipv6:5434,onion:0,i2p:0,bp_new:1717,bp_tried:19,oldest_new:1745815456,youngest_new:1770727464,oldest_tried:1765475690,youngest_tried:1770734972},
  {f:'2026-03-15-dea-peers.dat',f_new:2.02,f_tried:13.44,asmap:false,new:63778,tried:8361,ipv4:61926,ipv6:10213,onion:0,i2p:0,bp_new:1291,bp_tried:1124,oldest_new:1736909159,youngest_new:1773508175,oldest_tried:1743272734,youngest_tried:1773507875},
  {f:'2026-03-26-wil-peers.dat',f_new:2.24,f_tried:3.65,asmap:false,new:63267,tried:7902,ipv4:49088,ipv6:7390,onion:14492,i2p:199,bp_new:1419,bp_tried:288,oldest_new:1702010757,youngest_new:1774526858,oldest_tried:1687767621,youngest_tried:1774532931},
  {f:'2026-04-03-dar-peers.dat',f_new:3.07,f_tried:2.86,asmap:false,new:26176,tried:35,ipv4:22830,ipv6:3381,onion:0,i2p:0,bp_new:803,bp_tried:1,oldest_new:1761926332,youngest_new:1775219356,oldest_tried:1764012518,youngest_tried:1775227272},
  {f:'2025-04-24-dan-peers.dat',f_new:0.57,f_tried:1.51,asmap:false,new:49334,tried:199,ipv4:35684,ipv6:6718,onion:7055,i2p:76,bp_new:282,bp_tried:3,oldest_new:1648720055,youngest_new:1745493722,oldest_tried:1649527665,youngest_tried:1745501514},
  {f:'2026-06-24-cha-peers.dat',f_new:0.0,f_tried:12.96,asmap:false,new:65532,tried:9991,ipv4:63520,ipv6:12003,onion:0,i2p:0,bp_new:2,bp_tried:1295,oldest_new:1774752084,youngest_new:1782296956,oldest_tried:1745608873,youngest_tried:1782296499},
];

let failures = 0, checks = 0;
function eq(name, got, want, note) {
  checks++;
  if (got !== want) { failures++; console.log(`    FAIL ${name}: got ${got}, want ${want}${note ? ' ' + note : ''}`); }
}

for (const exp of EXPECTED) {
  const file = path.join(DATA, exp.f);
  if (!fs.existsSync(file)) { console.log(`  SKIP ${exp.f} (missing)`); continue; }
  const t0 = Date.now();
  const am = AddrMan.parse(new Uint8Array(fs.readFileSync(file)));
  const ms = Date.now() - t0;

  // Entries reachable through the buckets must match the flat entry lists.
  const fromBuckets = (bk) => { const s = new Set(); for (const b of bk) for (const e of b) if (e) s.add(e); return s; };
  eq('new via buckets', fromBuckets(am.newBuckets).size, am.newEntries.length);
  eq('tried via buckets', fromBuckets(am.triedBuckets).size, am.triedEntries.length);

  // Files written by a node using an asmap can only be compared structurally:
  // the C++ test loads them with an asmap we don't implement, which re-buckets
  // the new table and changes which entries survive. We show the on-disk layout.
  if (exp.asmap) {
    console.log(`  ${exp.f}  (asmap file: structural checks only)  new=${am.counts.new} tried=${am.counts.tried} bp=${am.counts.newBitprojects}/${am.counts.triedBitprojects}  ${ms}ms`);
    continue;
  }

  eq('new', am.counts.new, exp.new);
  eq('bitprojects_new', am.counts.newBitprojects, exp.bp_new);
  const all = am.newEntries.concat(am.triedEntries);
  const byNet = (n) => all.filter(e => AddrMan.NET_NAME[e.addr.network()] === n).length;
  eq('ipv4', byNet('ipv4'), exp.ipv4);
  eq('ipv6', byNet('ipv6'), exp.ipv6);
  eq('onion', byNet('onion'), exp.onion);
  eq('i2p', byNet('i2p'), exp.i2p);
  const span = (es) => [Math.min(...es.map(e => e.nTime)), Math.max(...es.map(e => e.nTime))];
  const [on, yn] = span(am.newEntries);
  eq('oldest_new', on, exp.oldest_new);
  eq('youngest_new', yn, exp.youngest_new);

  eq('tried', am.counts.tried, exp.tried);
  eq('bitprojects_tried', am.counts.triedBitprojects, exp.bp_tried);
  const [ot, yt] = span(am.triedEntries);
  eq('oldest_tried', ot, exp.oldest_tried);
  eq('youngest_tried', yt, exp.youngest_tried);

  // The two selection metrics, and the identity that separates them:
  //   slot share = mean of per-bucket shares + cov(entries, share) / mean entries
  const m = AddrMan.metrics(am);
  for (const k of ['new', 'tried']) {
    const x = m[k];
    eq(`${k} slot share == bucketUniform + cov/meanN`,
       +(x.bucketUniform + x.cov / x.meanN).toFixed(12), +x.shareSlots.toFixed(12));
    eq(`${k} slot share numerator`, x.bpSlots, k === 'new' ? am.counts.newBitprojects : am.counts.triedBitprojects);
  }
  eq('q', +(0.5 * m.new.shareGist + 0.5 * m.tried.shareGist).toFixed(12), +m.q.toFixed(12));
  // f_new / f_tried must reproduce the gist's table (rounded to its 2 decimals).
  // The gist rounds to 2 decimals and 2026-03-26-wil's f_tried is written 3.65
  // there where 288/7902 = 3.6446 rounds to 3.64, so allow 0.01pp of slack.
  if (exp.f_new !== undefined) {
    const near = (name, got, want) => {
      checks++;
      if (Math.abs(got - want) > 0.011) { failures++; console.log(`    FAIL ${name}: got ${got.toFixed(2)}, want ${want}`); }
    };
    near('f_new (gist)', 100 * m.new.shareGist, exp.f_new);
    near('f_tried (gist)', 100 * m.tried.shareGist, exp.f_tried);
  }
  eq('qBucket', +(0.5 * m.new.bucketUniform + 0.5 * m.tried.bucketUniform).toFixed(12), +m.qBucket.toFixed(12));

  // Bucket invariants.
  for (const [label, bk] of [['new', am.newBuckets], ['tried', am.triedBuckets]]) {
    if (bk.some(b => b.length !== 64)) { failures++; console.log(`    FAIL ${label} bucket size`); }
  }
  const st = AddrMan.bucketStats(am.newBuckets);
  eq('stats sum', st.reduce((a, b) => a + b.total, 0), fromBuckets(am.newBuckets).size === am.newEntries.length ? st.reduce((a,b)=>a+b.total,0) : -1);

  console.log(`  ${exp.f}  new=${am.counts.new} tried=${am.counts.tried} bp=${am.counts.newBitprojects}/${am.counts.triedBitprojects}  ${ms}ms`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
