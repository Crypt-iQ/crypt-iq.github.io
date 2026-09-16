/*
 * addrman.js - a pure-JS reader for Bitcoin Core `peers.dat` (AddrMan) files.
 *
 * Mirrors the C++ side closely enough to reproduce bucketing:
 *   src/addrdb.cpp        (file framing: network magic + payload + checksum)
 *   src/addrman.cpp       (AddrManImpl::Unserialize, AddrInfo::Get*Bucket)
 *   src/netaddress.{h,cpp}(BIP155/ADDRv2 address encoding, netgroup inputs)
 *   src/netgroup.cpp      (NetGroupManager::GetGroup, no-asmap path only)
 *
 * Usable both in the browser (defines window.AddrMan) and in node (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.AddrMan = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ------------------------------------------------------------------ SHA-256 */
// Synchronous SHA-256 (WebCrypto is async-only, and we need tens of thousands
// of small hashes while bucketing).
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);

class SHA256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                              0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buf = new Uint8Array(64);
    this.len = 0;   // bytes buffered
    this.total = 0; // total bytes written
    this.w = new Uint32Array(64);
  }
  _block(b, off) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) {
      w[i] = (b[off+i*4] << 24) | (b[off+i*4+1] << 16) | (b[off+i*4+2] << 8) | b[off+i*4+3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      const s0 = ((x>>>7)|(x<<25)) ^ ((x>>>18)|(x<<14)) ^ (x>>>3);
      const s1 = ((y>>>17)|(y<<15)) ^ ((y>>>19)|(y<<13)) ^ (y>>>10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let a=h[0],bb=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      hh=g; g=f; f=e; e=(d+t1)|0; d=c; c=bb; bb=a; a=(t1+t2)|0;
    }
    h[0]=(h[0]+a)|0; h[1]=(h[1]+bb)|0; h[2]=(h[2]+c)|0; h[3]=(h[3]+d)|0;
    h[4]=(h[4]+e)|0; h[5]=(h[5]+f)|0; h[6]=(h[6]+g)|0; h[7]=(h[7]+hh)|0;
  }
  update(data) {
    this.total += data.length;
    let i = 0;
    if (this.len) {
      const need = Math.min(64 - this.len, data.length);
      this.buf.set(data.subarray(0, need), this.len);
      this.len += need; i = need;
      if (this.len === 64) { this._block(this.buf, 0); this.len = 0; }
    }
    for (; i + 64 <= data.length; i += 64) this._block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), this.len);
      this.len += data.length - i;
    }
    return this;
  }
  digest() {
    const bits = this.total * 8;
    const pad = new Uint8Array((this.len < 56 ? 56 : 120) - this.len + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i*4] = this.h[i] >>> 24; out[i*4+1] = (this.h[i] >>> 16) & 0xff;
      out[i*4+2] = (this.h[i] >>> 8) & 0xff; out[i*4+3] = this.h[i] & 0xff;
    }
    return out;
  }
}
function sha256(data) { return new SHA256().update(data).digest(); }
function sha256d(data) { return sha256(sha256(data)); }

/* --------------------------------------------------- serialization helpers */
// HashWriter equivalent: append C++-serialized values, then take the double
// SHA-256 and read back its first 8 bytes little-endian (uint256::GetCheapHash).
class HashWriter {
  constructor() { this.parts = []; this.n = 0; }
  _push(u8) { this.parts.push(u8); this.n += u8.length; }
  raw(bytes) { this._push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)); return this; }
  u8(v) { this._push(Uint8Array.of(v & 0xff)); return this; }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this._push(b); return this; }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this._push(b); return this; }
  // std::vector<unsigned char>: CompactSize length prefix, then the bytes.
  vec(bytes) { this._push(compactSizeBytes(bytes.length)); return this.raw(bytes); }
  cheapHash() {
    const all = new Uint8Array(this.n);
    let o = 0;
    for (const p of this.parts) { all.set(p, o); o += p.length; }
    const h = sha256d(all);
    return new DataView(h.buffer, h.byteOffset, 32).getBigUint64(0, true);
  }
}

function compactSizeBytes(n) {
  if (n < 253) return Uint8Array.of(n);
  if (n <= 0xffff) { const b = new Uint8Array(3); b[0] = 253; new DataView(b.buffer).setUint16(1, n, true); return b; }
  const b = new Uint8Array(5); b[0] = 254; new DataView(b.buffer).setUint32(1, n, true); return b;
}

class Reader {
  constructor(buf) { this.b = buf; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); this.p = 0; }
  need(n) { if (this.p + n > this.b.length) throw new Error('unexpected end of file'); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16be() { this.need(2); const v = this.dv.getUint16(this.p, false); this.p += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  i64() { this.need(8); const v = this.dv.getBigInt64(this.p, true); this.p += 8; return Number(v); }
  u64() { this.need(8); const v = this.dv.getBigUint64(this.p, true); this.p += 8; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  compactSize() {
    const c = this.u8();
    if (c < 253) return c;
    if (c === 253) { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
    if (c === 254) return this.u32();
    return Number(this.u64());
  }
}

/* ------------------------------------------------------------- net address */
const NET = { UNROUTABLE: 0, IPV4: 1, IPV6: 2, ONION: 3, I2P: 4, CJDNS: 5, INTERNAL: 6 };
const NET_NAME = ['unroutable', 'ipv4', 'ipv6', 'onion', 'i2p', 'cjdns', 'internal'];
const IPV4_IN_IPV6_PREFIX = [0,0,0,0,0,0,0,0,0,0,0xff,0xff];
const TORV2_IN_IPV6_PREFIX = [0xfd,0x87,0xd8,0x7e,0xeb,0x43];
const INTERNAL_IN_IPV6_PREFIX = [0xfd,0x6b,0x88,0xc0,0x87,0x24];
const BIP155_SIZE = { 1: 4, 2: 16, 4: 32, 5: 32, 6: 16 };
const BIP155_NET = { 1: NET.IPV4, 2: NET.IPV6, 4: NET.ONION, 5: NET.I2P, 6: NET.CJDNS };

function hasPrefix(a, p) {
  if (a.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (a[i] !== p[i]) return false;
  return true;
}

class NetAddr {
  constructor(net, addr) { this.net = net; this.addr = addr; }
  static invalid() { return new NetAddr(NET.IPV6, new Uint8Array(16)); }

  isIPv4() { return this.net === NET.IPV4; }
  isIPv6() { return this.net === NET.IPV6; }
  isOnion() { return this.net === NET.ONION; }
  isI2P() { return this.net === NET.I2P; }
  isCJDNS() { return this.net === NET.CJDNS; }
  isInternal() { return this.net === NET.INTERNAL; }
  p(...bytes) { return this.addr.length >= bytes.length && hasPrefix(this.addr, bytes); }

  isRFC1918() { const a = this.addr; return this.isIPv4() && (a[0]===10 || (a[0]===192&&a[1]===168) || (a[0]===172&&a[1]>=16&&a[1]<=31)); }
  isRFC2544() { const a = this.addr; return this.isIPv4() && a[0]===198 && (a[1]===18||a[1]===19); }
  isRFC3927() { return this.isIPv4() && this.p(169,254); }
  isRFC6598() { const a = this.addr; return this.isIPv4() && a[0]===100 && a[1]>=64 && a[1]<=127; }
  isRFC5737() { return this.isIPv4() && (this.p(192,0,2) || this.p(198,51,100) || this.p(203,0,113)); }
  isRFC3849() { return this.isIPv6() && this.p(0x20,0x01,0x0d,0xb8); }
  isRFC4862() { return this.isIPv6() && this.p(0xfe,0x80,0,0,0,0,0,0); }
  isRFC4193() { return this.isIPv6() && (this.addr[0] & 0xfe) === 0xfc; }
  isRFC4843() { return this.isIPv6() && this.p(0x20,0x01,0x00) && (this.addr[3] & 0xf0) === 0x10; }
  isRFC7343() { return this.isIPv6() && this.p(0x20,0x01,0x00) && (this.addr[3] & 0xf0) === 0x20; }
  isRFC6145() { return this.isIPv6() && this.p(0,0,0,0,0,0,0,0,0xff,0xff,0,0); }
  isRFC6052() { return this.isIPv6() && this.p(0x00,0x64,0xff,0x9b,0,0,0,0,0,0,0,0); }
  isRFC3964() { return this.isIPv6() && this.p(0x20,0x02); }
  isRFC4380() { return this.isIPv6() && this.p(0x20,0x01,0x00,0x00); }
  isHeNet() { return this.isIPv6() && this.p(0x20,0x01,0x04,0x70); }
  isLocal() {
    if (this.isIPv4() && (this.addr[0] === 127 || this.addr[0] === 0)) return true;
    if (this.isIPv6()) { for (let i = 0; i < 15; i++) if (this.addr[i]) return false; return this.addr[15] === 1; }
    return false;
  }
  isValid() {
    if (this.isIPv6() && this.addr.every(b => b === 0)) return false;
    if (this.isCJDNS() && this.addr[0] !== 0xfc) return false;
    if (this.isRFC3849()) return false;
    if (this.isInternal()) return false;
    if (this.isIPv4()) {
      const a = (this.addr[0]<<24 | this.addr[1]<<16 | this.addr[2]<<8 | this.addr[3]) >>> 0;
      if (a === 0 || a === 0xffffffff) return false;
    }
    return true;
  }
  isRoutable() {
    return this.isValid() && !(this.isRFC1918() || this.isRFC2544() || this.isRFC3927() ||
      this.isRFC4862() || this.isRFC6598() || this.isRFC5737() || this.isRFC4193() ||
      this.isRFC4843() || this.isRFC7343() || this.isLocal() || this.isInternal());
  }
  hasLinkedIPv4() {
    return this.isRoutable() && (this.isIPv4() || this.isRFC6145() || this.isRFC6052() || this.isRFC3964() || this.isRFC4380());
  }
  linkedIPv4Bytes() {
    const a = this.addr;
    if (this.isIPv4()) return [a[0],a[1],a[2],a[3]];
    if (this.isRFC6052() || this.isRFC6145()) return [a[12],a[13],a[14],a[15]];
    if (this.isRFC3964()) return [a[2],a[3],a[4],a[5]];
    if (this.isRFC4380()) return [~a[12]&0xff, ~a[13]&0xff, ~a[14]&0xff, ~a[15]&0xff];
    throw new Error('no linked IPv4');
  }
  // CNetAddr::GetAddrBytes(): the ADDRv1 16-byte form where one exists.
  addrBytes() {
    if (this.net === NET.IPV4) { const b = new Uint8Array(16); b.set(IPV4_IN_IPV6_PREFIX, 0); b.set(this.addr, 12); return b; }
    if (this.net === NET.INTERNAL) { const b = new Uint8Array(16); b.set(INTERNAL_IN_IPV6_PREFIX, 0); b.set(this.addr, 6); return b; }
    return this.addr;
  }
  netClass() {
    if (this.isInternal()) return NET.INTERNAL;
    if (!this.isRoutable()) return NET.UNROUTABLE;
    if (this.hasLinkedIPv4()) return NET.IPV4;
    return this.net;
  }
  // CNetAddr::GetNetwork() - what AddrMan::Size(net) counts.
  network() {
    if (this.isInternal()) return NET.INTERNAL;
    if (!this.isRoutable()) return NET.UNROUTABLE;
    return this.net;
  }
  // The Bitprojects ranges, from CNetAddr::IsBitprojects() in src/netaddress.cpp.
  isBitprojects() {
    if (!this.isIPv4()) return false;
    const a = this.addr;
    for (const [x,y,z] of BITPROJECTS_PREFIXES) if (a[0]===x && a[1]===y && a[2]===z) return true;
    return false;
  }
  toString() {
    const a = this.addr;
    if (this.isIPv4()) return `${a[0]}.${a[1]}.${a[2]}.${a[3]}`;
    if (this.isOnion()) return base32(a) + '.onion';
    if (this.isI2P()) return base32(a).replace(/=+$/, '') + '.b32.i2p';
    if (this.isInternal()) return base32(a) + '.internal';
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(((a[i] << 8) | a[i+1]).toString(16));
    return '[' + parts.join(':') + ']';
  }
}

const BITPROJECTS_PREFIXES = [
  // AS12029
  [45,40,98], [103,47,56], [173,46,87], [206,206,109],
  // AS29798
  [89,106,27], [174,140,231], [184,174,95], [216,107,135],
  // AS401199
  [66,163,223], [103,246,186], [123,100,246], [203,11,72],
];

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let out = '', bits = 0, val = 0;
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function readNetAddr(r, v2) {
  if (!v2) {
    const a = r.bytes(16).slice();
    if (hasPrefix(a, IPV4_IN_IPV6_PREFIX)) return new NetAddr(NET.IPV4, a.subarray(12));
    if (hasPrefix(a, INTERNAL_IN_IPV6_PREFIX)) return new NetAddr(NET.INTERNAL, a.subarray(6, 16));
    return new NetAddr(NET.IPV6, a);
  }
  const id = r.u8();
  const size = r.compactSize();
  if (size > 512) throw new Error('address too long');
  const expect = BIP155_SIZE[id];
  if (expect === undefined) { r.bytes(size); return NetAddr.invalid(); }  // unknown network: ignore
  if (size !== expect) throw new Error(`BIP155 network ${id} with length ${size}`);
  const a = r.bytes(size).slice();
  const net = BIP155_NET[id];
  if (net !== NET.IPV6) return new NetAddr(net, a);
  if (hasPrefix(a, INTERNAL_IN_IPV6_PREFIX)) return new NetAddr(NET.INTERNAL, a.subarray(6, 16));
  if (!hasPrefix(a, IPV4_IN_IPV6_PREFIX) && !hasPrefix(a, TORV2_IN_IPV6_PREFIX)) return new NetAddr(NET.IPV6, a);
  return NetAddr.invalid(); // IPv4/TORv2 embedded in IPv6 is not allowed in ADDRv2
}

const DISK_VERSION_IGNORE_MASK = 0x0007ffff;
const DISK_VERSION_ADDRV2 = 1 << 29;

function readAddrInfo(r, streamV2) {
  const stored = r.u32();
  const hi = (stored & ~DISK_VERSION_IGNORE_MASK) >>> 0;
  let useV2;
  if (hi === 0) useV2 = false;
  else if (hi === (DISK_VERSION_ADDRV2 >>> 0) && streamV2) useV2 = true;
  else throw new Error('Unsupported CAddress disk format version');

  const nTime = r.u32();
  const services = useV2 ? r.compactSize() : Number(r.u64());
  const addr = readNetAddr(r, useV2);
  const port = r.u16be();
  const source = readNetAddr(r, useV2);
  const lastSuccess = r.i64();
  const attempts = r.i32();
  return { addr, port, source, nTime, services, lastSuccess, attempts };
}

/* -------------------------------------------------------------- bucketing */
const TRIED_BUCKET_COUNT = 256;
const NEW_BUCKET_COUNT = 1024;
const BUCKET_SIZE = 64;
const TRIED_BUCKETS_PER_GROUP = 8;
const NEW_BUCKETS_PER_SOURCE_GROUP = 64;
const NEW_BUCKETS_PER_ADDRESS = 8;

// NetGroupManager::GetGroup() with an empty asmap.
function getGroup(a) {
  const out = [];
  if (a.hasLinkedIPv4()) {
    // (netClass() is NET_IPV4 here, matching the C++ push of GetNetClass())
    const ip = a.linkedIPv4Bytes();
    out.push(NET.IPV4, ip[0], ip[1]);
    return Uint8Array.from(out);
  }
  out.push(a.netClass());
  const ab = a.addrBytes();
  let startByte = 0, bits = 0;
  if (a.isLocal()) { /* one group for all */ }
  else if (a.isInternal()) { startByte = INTERNAL_IN_IPV6_PREFIX.length; bits = 10 * 8; }
  else if (!a.isRoutable()) { /* one group for all */ }
  else if (a.isOnion() || a.isI2P()) bits = 4;
  else if (a.isCJDNS()) bits = 12;
  else if (a.isHeNet()) bits = 36;
  else bits = 32;
  const numBytes = Math.floor(bits / 8);
  for (let i = 0; i < numBytes; i++) out.push(ab[startByte + i]);
  const rem = bits % 8;
  if (rem > 0) out.push(ab[numBytes + startByte] | ((1 << (8 - rem)) - 1));
  return Uint8Array.from(out);
}

// CService::GetKey(): address bytes followed by the port, big-endian.
function serviceKey(e) {
  const ab = e.addr.addrBytes();
  const k = new Uint8Array(ab.length + 2);
  k.set(ab, 0);
  k[k.length - 2] = (e.port >> 8) & 0xff;
  k[k.length - 1] = e.port & 0xff;
  return k;
}

function getTriedBucket(e, nKey) {
  const h1 = new HashWriter().raw(nKey).vec(serviceKey(e)).cheapHash();
  const h2 = new HashWriter().raw(nKey).vec(getGroup(e.addr))
    .u64(h1 % BigInt(TRIED_BUCKETS_PER_GROUP)).cheapHash();
  return Number(h2 % BigInt(TRIED_BUCKET_COUNT));
}

function getNewBucket(e, nKey) {
  const srcGroup = getGroup(e.source);
  const h1 = new HashWriter().raw(nKey).vec(getGroup(e.addr)).vec(srcGroup).cheapHash();
  const h2 = new HashWriter().raw(nKey).vec(srcGroup)
    .u64(h1 % BigInt(NEW_BUCKETS_PER_SOURCE_GROUP)).cheapHash();
  return Number(h2 % BigInt(NEW_BUCKET_COUNT));
}

function getBucketPosition(e, nKey, isNew, bucket) {
  const h1 = new HashWriter().raw(nKey).u8(isNew ? 0x4e /*'N'*/ : 0x4b /*'K'*/)
    .i32(bucket).vec(serviceKey(e)).cheapHash();
  return Number(h1 % BigInt(BUCKET_SIZE));
}

/* ------------------------------------------------------------------ parser */
const MAGICS = {
  'f9beb4d9': 'mainnet', '0b110907': 'testnet3', '1c163f28': 'testnet4',
  'fabfb5da': 'regtest', '0a03cf40': 'signet',
};

function toHex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }

/**
 * Parse a peers.dat file.
 * @param {Uint8Array} buf raw file contents
 * @returns {object} parsed addrman, see the fields set at the bottom.
 */
function parse(buf) {
  const warnings = [];
  const r = new Reader(buf);

  const magic = toHex(r.bytes(4));
  const chain = MAGICS[magic];
  if (!chain) throw new Error(`not a peers.dat file (unknown network magic 0x${magic})`);

  const format = r.u8();
  const compat = r.u8();
  if (compat < 32) throw new Error(`corrupt addrman: compat value ${compat} < 32`);
  const lowestCompatible = compat - 32;
  if (lowestCompatible > 4) throw new Error(`unsupported addrman format ${format} (needs >= ${lowestCompatible})`);
  const streamV2 = format >= 3;

  const nKey = r.bytes(32).slice();
  const nNew = r.i32();
  const nTried = r.i32();
  let nUBuckets = r.i32();
  if (format >= 1) nUBuckets ^= (1 << 30);

  if (nNew < 0 || nNew > NEW_BUCKET_COUNT * BUCKET_SIZE) throw new Error(`corrupt addrman: nNew=${nNew}`);
  if (nTried < 0 || nTried > TRIED_BUCKET_COUNT * BUCKET_SIZE) throw new Error(`corrupt addrman: nTried=${nTried}`);

  const newEntries = [];
  for (let i = 0; i < nNew; i++) newEntries.push(readAddrInfo(r, streamV2));
  const triedRaw = [];
  for (let i = 0; i < nTried; i++) triedRaw.push(readAddrInfo(r, streamV2));

  // Stored "new" bucket membership (bucket -> list of indices into newEntries).
  const storedBucketEntries = [];
  for (let b = 0; b < nUBuckets; b++) {
    const n = r.i32();
    for (let i = 0; i < n; i++) {
      const idx = r.i32();
      if (idx >= 0 && idx < nNew) storedBucketEntries.push([b, idx]);
    }
  }

  let asmapVersion = null;
  if (format >= 2) asmapVersion = toHex(r.bytes(32));
  const usedAsmap = asmapVersion !== null && asmapVersion !== '0'.repeat(64);

  // --- tried table: positions are never stored, they are recomputed on load.
  const triedBuckets = Array.from({ length: TRIED_BUCKET_COUNT }, () => new Array(BUCKET_SIZE).fill(null));
  let triedLost = 0;
  const tried = [];
  for (const e of triedRaw) {
    const b = getTriedBucket(e, nKey);
    const pos = getBucketPosition(e, nKey, false, b);
    if (e.addr.isValid() && triedBuckets[b][pos] === null) {
      e.bucket = b; e.pos = pos;
      triedBuckets[b][pos] = e;
      tried.push(e);
    } else {
      triedLost++;
    }
  }

  // --- new table: replay the stored bucket/position layout.
  const newBuckets = Array.from({ length: NEW_BUCKET_COUNT }, () => new Array(BUCKET_SIZE).fill(null));
  const restoreBucketing = nUBuckets === NEW_BUCKET_COUNT;
  for (const e of newEntries) e.refs = 0;
  for (let [bucket, idx] of storedBucketEntries) {
    const e = newEntries[idx];
    if (!e.addr.isValid()) continue;
    if (e.refs >= NEW_BUCKETS_PER_ADDRESS) continue;
    let pos = getBucketPosition(e, nKey, true, bucket);
    if (restoreBucketing && newBuckets[bucket][pos] === null) {
      newBuckets[bucket][pos] = e;
      e.refs++;
    } else {
      bucket = getNewBucket(e, nKey);
      pos = getBucketPosition(e, nKey, true, bucket);
      if (newBuckets[bucket][pos] === null) { newBuckets[bucket][pos] = e; e.refs++; }
    }
  }
  const newTable = newEntries.filter(e => e.refs > 0);

  if (usedAsmap) {
    warnings.push('This file was written by a node using an asmap. The "new" table is shown ' +
      'exactly as stored, but "tried" bucket positions are recomputed without the asmap and ' +
      'will differ from that node\'s.');
  }
  if (triedLost) warnings.push(`${triedLost} tried entries collided on load and were dropped.`);

  return {
    chain, format, nKeyHex: toHex(nKey), asmapVersion, usedAsmap, warnings,
    newEntries: newTable, triedEntries: tried,
    newBuckets, triedBuckets,
    counts: {
      new: newTable.length,
      tried: tried.length,
      // Bitprojects presence is counted per occupied bucket slot: a "new" entry
      // referenced from k buckets occupies k slots and gets k chances of being
      // picked, so that is the number that matters (and what GetEntries returns).
      newSlots: countSlots(newBuckets).total,
      newBitprojects: countSlots(newBuckets).bitprojects,
      triedBitprojects: countSlots(triedBuckets).bitprojects,
    },
  };
}

function countSlots(buckets) {
  let total = 0, bitprojects = 0;
  for (const b of buckets) for (const e of b) if (e) { total++; if (e.addr.isBitprojects()) bitprojects++; }
  return { total, bitprojects };
}

/** Per-bucket aggregates for one table. */
function bucketStats(buckets) {
  return buckets.map((slots, i) => {
    let total = 0, bp = 0;
    const nets = {};
    for (const e of slots) {
      if (!e) continue;
      total++;
      if (e.addr.isBitprojects()) bp++;
      const n = NET_NAME[e.addr.network()];
      nets[n] = (nets[n] || 0) + 1;
    }
    return { index: i, total, bitprojects: bp, honest: total - bp, nets };
  });
}

/**
 * Selection-probability metrics for one parsed addrman.
 *
 * q        - the gist's q = 1/2 f_new + 1/2 f_tried. The gist's f_T is
 *            (Bitprojects bucket slots) / (distinct addresses in T), which is
 *            what bitcoin/bitcoin#34019 reports; `qSlots` is the same thing
 *            with a slot denominator, so numerator and denominator match.
 * qBucket  - the same 50/50 table choice, but then a uniformly random non-empty
 *            bucket and a uniformly random entry inside it (AddrMan's actual
 *            Select() shape). Per table it is the unweighted mean of the
 *            per-bucket shares, whereas f is the slot-weighted mean.
 *
 * Both are reported per table alongside `cov`, the covariance between a
 * bucket's occupancy and its attacker share, which is exactly what separates
 * the two means: shareSlots = bucketUniform + cov / meanN.
 */
function metrics(am) {
  const perTable = (buckets, entries) => {
    const ne = bucketStats(buckets).filter(b => b.total > 0);
    const slots = ne.reduce((a, b) => a + b.total, 0);
    const bpSlots = ne.reduce((a, b) => a + b.bitprojects, 0);
    const addrs = entries.length;
    const bpAddrs = entries.filter(e => e.addr.isBitprojects()).length;
    const bucketUniform = ne.length ? ne.reduce((a, b) => a + b.bitprojects / b.total, 0) / ne.length : 0;
    const meanN = ne.length ? slots / ne.length : 0;
    const cov = ne.length
      ? ne.reduce((a, b) => a + (b.total - meanN) * (b.bitprojects / b.total - bucketUniform), 0) / ne.length
      : 0;
    return {
      buckets: ne.length, slots, bpSlots, addrs, bpAddrs, meanN, cov, bucketUniform,
      shareSlots: slots ? bpSlots / slots : 0,     // slots / slots
      shareAddrs: addrs ? bpAddrs / addrs : 0,     // addresses / addresses
      shareGist: addrs ? bpSlots / addrs : 0,      // slots / addresses (the gist / #34019 figure)
    };
  };
  const n = perTable(am.newBuckets, am.newEntries);
  const t = perTable(am.triedBuckets, am.triedEntries);
  return {
    new: n, tried: t,
    q: 0.5 * n.shareGist + 0.5 * t.shareGist,
    qSlots: 0.5 * n.shareSlots + 0.5 * t.shareSlots,
    qBucket: 0.5 * n.bucketUniform + 0.5 * t.bucketUniform,
  };
}

return { parse, bucketStats, countSlots, metrics, sha256, sha256d, NetAddr, NET, NET_NAME,
         TRIED_BUCKET_COUNT, NEW_BUCKET_COUNT, BUCKET_SIZE,
         getGroup, getTriedBucket, getNewBucket, getBucketPosition };
});
