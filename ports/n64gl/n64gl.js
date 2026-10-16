// n64gl: a light renderer for N64 recomps on a page. It draws each graphics task's F3DEX2 display list with WebGL2:
// no WebGPU, and no threads of its own, so it runs where RT64 can't (phones, old GPUs). It draws what the console
// draws, nothing more:
//   - the RSP's vertex work: matrices, viewport, lights, texture coordinates (and texgen), fog;
//   - the RDP's texture memory (TMEM, 4 KB) emulated byte for byte by the loads (LOADBLOCK, LOADTILE, LOADTLUT), each
//     tile decoded from it as the RDP reads it (odd lines' words swapped, 32-bit texels split in two banks);
//   - the color combiner as generated shaders, one per combine mode; the blender's usual modes as WebGL blending, its
//     fog step in the shader; alpha compare; z modes;
//   - color images as framebuffers (one depth buffer per size, as the console has one z buffer), and the VI's origin
//     picked out of them at each retrace, or read from RDRAM when the CPU drew it.
// Two halves. The reader runs where the program sends the task (the runtime's graphics thread, a web worker): it reads
// the list straight from RDRAM (the wasm heap is shared memory), does the RSP and TMEM work and decodes new textures,
// and posts one packet a list (vertices, draws in order, new textures) to the page's thread, the drawer, which holds
// the WebGL objects and draws it there. The game waits only for the reading; at most 2 packets wait for the drawer.
// The program side is gl_renderer.cpp (runTask, init, present). Game-agnostic. The combiner and blender tables and
// the texel formats follow noclip.website's N64 code (src/Common/N64, MIT); the rest is written for a live frame.
// Linked with --pre-js, so this file runs on every thread.
var n64gl = (function () {
  'use strict';
  const onPage = typeof document !== 'undefined';
  const log = (...a) => console.log('[n64gl]', ...a);
  const VS = 10;   // vertex: clip x, y, z, w, shade r, g, b, a, texel s, t
  const ex3 = (n) => ((n << 5) | (n << 2) | (n >> 1)) & 0xFF, ex4 = (n) => (n << 4) | n, ex5 = (n) => ((n << 3) | (n >> 2)) & 0xFF;
  const fbHeightFor = (w) => w === 320 ? 240 : w === 640 ? 480 : Math.max(1, Math.round(w * 3 / 4));
  const GL_NEAREST = 0x2600, GL_LINEAR = 0x2601, GL_REPEAT = 0x2901, GL_CLAMP = 0x812F, GL_MIRROR = 0x8370;
  const G_ZBUFFER = 1, G_CULL_FRONT = 0x200, G_CULL_BACK = 0x400, G_FOG = 0x10000, G_LIGHTING = 0x20000,
    G_TEXTURE_GEN = 0x40000, G_TEXTURE_GEN_LINEAR = 0x80000, G_SHADING_SMOOTH = 0x200000;

  // ======================================================================================== the reader (RSP, RDP)
  function makeReader(deliver) {
    let R = 0, ackIdx = -1, sent = 0, listNo = 0, notes = [];
    // A worker's console may not reach the page's log: the reader's messages travel with the packet.
    const log = (...a) => notes.push(a.join(' '));
    // RDRAM: the recomp keeps it as native (little endian) 32-bit words, so a byte is at addr ^ 3, a halfword at
    // addr ^ 2. Addresses here are physical (24 bits).
    const r32 = (a) => HEAPU32[(R + (a & 0xFFFFFC)) >>> 2];
    const r16 = (a) => HEAPU16[(R + ((a & 0xFFFFFE) ^ 2)) >>> 1];
    const rs16 = (a) => HEAP16[(R + ((a & 0xFFFFFE) ^ 2)) >>> 1];
    const r8 = (a) => HEAPU8[R + ((a & 0xFFFFFF) ^ 3)];
    const rs8 = (a) => HEAP8[R + ((a & 0xFFFFFF) ^ 3)];

    // RSP state
    const seg = new Uint32Array(16);
    const segAddr = (a) => (seg[(a >>> 24) & 0xF] + (a & 0xFFFFFF)) & 0xFFFFFF;
    const ident = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
    const mtxStack = []; let mv = ident(), proj = ident(), mvp = ident();
    let geom = 0, texOn = false, texTile = 0, texScaleS = 1, texScaleT = 1;
    let vpScale = [160, 120, 511], vpTrans = [160, 120, 511];
    let numLights = 0; const lights = []; for (let i = 0; i < 8; i++) lights.push({ r: 0, g: 0, b: 0, x: 0, y: 0, z: 0 });
    const lookat = [[0, 0, 0], [0, 0, 0]];
    let fogMul = 0, fogOff = 0, half1 = 0, half2 = 0;
    const vbuf = new Float32Array(64 * VS);
    // RDP state
    let othH = 0, othL = 0, combH = 0, combL = 0, primLod = 0, fillColor = 0, zimg = 0;
    const prim = [1, 1, 1, 1], env = [1, 1, 1, 1], fogC = [0, 0, 0, 0], blendC = [0, 0, 0, 0];
    let cimg = { addr: 0, fmt: 0, siz: 2, width: 320 }, timg = { addr: 0, fmt: 0, siz: 0, width: 1 };
    const tiles = []; for (let i = 0; i < 8; i++) tiles.push({ fmt: 0, siz: 0, line: 0, tmem: 0, pal: 0, cmt: 0, maskt: 0, shiftt: 0, cms: 0, masks: 0, shifts: 0, uls: 0, ult: 0, lrs: 0, lrt: 0 });
    const tmem = new Uint8Array(4096);
    let tmemSerial = 1, scissor = [0, 0, 320, 240];

    // matrices (row vectors: v * M, as the N64)
    function mul(a, b) { // a then b
      const o = new Float32Array(16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
        o[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
      return o;
    }
    function readMtx(a) {
      const m = new Float32Array(16);
      for (let i = 0; i < 16; i++) m[i] = ((rs16(a + i * 2) << 16) | r16(a + 0x20 + i * 2)) / 65536;
      return m;
    }

    function loadVertices(a, n, v0) {
      const light = (geom & G_LIGHTING) !== 0, texgen = (geom & G_TEXTURE_GEN) !== 0, fog = (geom & G_FOG) !== 0;
      const W = cimg.width, H = fbHeightFor(cimg.width);
      for (let i = 0; i < n; i++, a += 16) {
        const x = rs16(a), y = rs16(a + 2), z = rs16(a + 4);
        const cx = x * mvp[0] + y * mvp[4] + z * mvp[8] + mvp[12];
        const cy = x * mvp[1] + y * mvp[5] + z * mvp[9] + mvp[13];
        const cz = x * mvp[2] + y * mvp[6] + z * mvp[10] + mvp[14];
        const cw = x * mvp[3] + y * mvp[7] + z * mvp[11] + mvp[15];
        const o = (v0 + i) * VS;
        // Viewport into the color image's pixels, then that image's clip space (y down, as the console draws).
        const sx = cx * vpScale[0] + cw * vpTrans[0], sy = cw * vpTrans[1] - cy * vpScale[1];
        vbuf[o] = 2 * sx / W - cw; vbuf[o + 1] = cw - 2 * sy / H; vbuf[o + 2] = cz; vbuf[o + 3] = cw;
        let r = r8(a + 12) / 255, g = r8(a + 13) / 255, b = r8(a + 14) / 255; const al = r8(a + 15) / 255;
        let s = rs16(a + 8) / 32 * texScaleS, t = rs16(a + 10) / 32 * texScaleT;
        if (light || texgen) {
          const nx = rs8(a + 12), ny = rs8(a + 13), nz = rs8(a + 14);
          let ex = nx * mv[0] + ny * mv[4] + nz * mv[8], ey = nx * mv[1] + ny * mv[5] + nz * mv[9], ez = nx * mv[2] + ny * mv[6] + nz * mv[10];
          const len = Math.hypot(ex, ey, ez) || 1; ex /= len; ey /= len; ez /= len;
          if (light) {
            const amb = lights[numLights]; r = amb.r; g = amb.g; b = amb.b;
            for (let l = 0; l < numLights; l++) {
              const L = lights[l], d = ex * L.x + ey * L.y + ez * L.z;
              if (d > 0) { r += L.r * d; g += L.g * d; b += L.b * d; }
            }
            r = Math.min(r, 1); g = Math.min(g, 1); b = Math.min(b, 1);
          }
          if (texgen) {
            const lx = lookat[0], ly = lookat[1];
            let dx = ex * lx[0] + ey * lx[1] + ez * lx[2], dy = ex * ly[0] + ey * ly[1] + ez * ly[2];
            if (geom & G_TEXTURE_GEN_LINEAR) { dx = Math.acos(-Math.max(-1, Math.min(1, dx))) / Math.PI * 2 - 1; dy = Math.acos(-Math.max(-1, Math.min(1, dy))) / Math.PI * 2 - 1; }
            s = (dx + 1) * 512 * texScaleS; t = (dy + 1) * 512 * texScaleT;
          }
        }
        vbuf[o + 4] = r; vbuf[o + 5] = g; vbuf[o + 6] = b;
        vbuf[o + 7] = fog ? Math.max(0, Math.min(255, (cw !== 0 ? cz / cw : 0) * fogMul + fogOff)) / 255 : al;
        vbuf[o + 8] = s; vbuf[o + 9] = t;
      }
    }

    // TMEM loads
    function load(tileIdx, uls, ult, lrs, lrt, block, dxt) {
      const tile = tiles[tileIdx], siz = timg.siz, base = tile.tmem * 8;
      tmemSerial++;
      if (block) {
        const texels = lrs - uls + 1, src = timg.addr + (((ult * timg.width + uls) << siz) >> 1);
        if (siz === 3) {
          for (let k = 0; k < texels; k++) {
            let d = (base + k * 2) & 0x7FF; if ((((k >> 1) * dxt) >> 11) & 1) d ^= 4;
            const p = src + k * 4;
            tmem[d] = r8(p); tmem[d + 1] = r8(p + 1); tmem[d + 0x800] = r8(p + 2); tmem[d + 0x801] = r8(p + 3);
          }
        } else {
          const words = (((texels << siz) >> 1) + 7) >> 3;
          for (let w = 0; w < words; w++) {
            const sw = (((w * dxt) >> 11) & 1) ? 4 : 0;
            for (let b = 0; b < 8; b++) tmem[(base + w * 8 + (b ^ sw)) & 0xFFF] = r8(src + w * 8 + b);
          }
        }
      } else {
        const sl = uls >> 2, tl = ult >> 2, sh = lrs >> 2, th = lrt >> 2, stride = tile.line * 8;
        for (let y = tl; y <= th; y++) {
          const row = y - tl, sw = (row & 1) ? 4 : 0;
          if (siz === 3) {
            for (let x = sl; x <= sh; x++) {
              let d = (base + row * stride + (x - sl) * 2) & 0x7FF; if (sw) d ^= 4;
              const p = timg.addr + (y * timg.width + x) * 4;
              tmem[d] = r8(p); tmem[d + 1] = r8(p + 1); tmem[d + 0x800] = r8(p + 2); tmem[d + 0x801] = r8(p + 3);
            }
          } else {
            const bytes = (((sh - sl + 1) << siz) >> 1), src = timg.addr + (((y * timg.width + sl) << siz) >> 1);
            for (let b = 0; b < bytes; b++) tmem[(base + row * stride + (b ^ sw)) & 0xFFF] = r8(src + b);
          }
        }
      }
    }
    function loadTLUT(tileIdx, uls, lrs) {
      const tile = tiles[tileIdx], n = ((lrs - uls) >> 2) + 1, src = timg.addr + (uls >> 2) * 2;
      tmemSerial++;
      for (let i = 0; i < n; i++) {
        const hi = r8(src + i * 2), lo = r8(src + i * 2 + 1), d = (tile.tmem * 8 + i * 8) & 0xFFF;
        for (let q = 0; q < 4; q++) { tmem[(d + q * 2) & 0xFFF] = hi; tmem[(d + q * 2 + 1) & 0xFFF] = lo; }
      }
    }

    // tile decode (TMEM -> RGBA8). A texture is known to the drawer by a key: the tile's description and a hash of
    // the TMEM it reads. New ones go out with the packet; the drawer is told to drop those unused for a while.
    function tileSize(t) {
      const cw = ((t.lrs - t.uls) >> 2) + 1, ch = ((t.lrt - t.ult) >> 2) + 1;
      const w = t.masks ? Math.min(1 << t.masks, Math.max(cw, 1)) : Math.max(cw, 1);
      const h = t.maskt ? Math.min(1 << t.maskt, Math.max(ch, 1)) : Math.max(ch, 1);
      return [Math.min(w, 1024), Math.min(h, 1024)];
    }
    function hashTmem(t, h) {
      let hsh = 2166136261 >>> 0;
      const start = t.tmem * 8, len = Math.min(4096, Math.max(t.line * 8, 8) * h + 8);
      for (let i = 0; i < len; i += 4) hsh = Math.imul(hsh ^ (tmem[(start + i) & 0xFFF] | (tmem[(start + i + 1) & 0xFFF] << 8) | (tmem[(start + i + 2) & 0xFFF] << 16) | (tmem[(start + i + 3) & 0xFFF] << 24)), 16777619);
      if (t.siz === 3) for (let i = 0; i < len; i += 4) hsh = Math.imul(hsh ^ (tmem[(0x800 + ((start + i) & 0x7FF)) & 0xFFF] | (tmem[(0x801 + ((start + i) & 0x7FF)) & 0xFFF] << 8)), 16777619);
      if (t.fmt === 2) { const ps = t.siz === 0 ? 0x800 + t.pal * 128 : 0x800, pl = t.siz === 0 ? 128 : 2048; for (let i = 0; i < pl; i += 8) hsh = Math.imul(hsh ^ ((tmem[ps + i] << 8) | tmem[ps + i + 1]), 16777619); }
      return hsh >>> 0;
    }
    function decodeTile(t, w, h, tlutType) {
      const out = new Uint8Array(w * h * 4), stride = t.line * 8, base = t.tmem * 8;
      const pal16 = (idx) => { const a = (0x800 + idx * 8) & 0xFFF; return (tmem[a] << 8) | tmem[a + 1]; };
      const put5551 = (o, p) => { out[o] = ex5(p >> 11); out[o + 1] = ex5((p >> 6) & 31); out[o + 2] = ex5((p >> 1) & 31); out[o + 3] = (p & 1) ? 255 : 0; };
      const putIA16 = (o, p) => { out[o] = out[o + 1] = out[o + 2] = p >> 8; out[o + 3] = p & 0xFF; };
      const putPal = (o, p) => (tlutType === 3 ? putIA16(o, p) : put5551(o, p));
      for (let y = 0; y < h; y++) {
        const sw = (y & 1) ? 4 : 0;
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          switch (t.siz) {
            case 0: {
              const b = tmem[((base + y * stride + (x >> 1)) ^ sw) & 0xFFF], n = (x & 1) ? (b & 15) : (b >> 4);
              if (t.fmt === 2) putPal(o, pal16((t.pal << 4) | n));
              else if (t.fmt === 3) { const i = ex3(n >> 1); out[o] = out[o + 1] = out[o + 2] = i; out[o + 3] = (n & 1) ? 255 : 0; }
              else { const i = ex4(n); out[o] = out[o + 1] = out[o + 2] = out[o + 3] = i; }
            } break;
            case 1: {
              const b = tmem[((base + y * stride + x) ^ sw) & 0xFFF];
              if (t.fmt === 2) putPal(o, pal16(b));
              else if (t.fmt === 3) { const i = ex4(b >> 4); out[o] = out[o + 1] = out[o + 2] = i; out[o + 3] = ex4(b & 15); }
              else { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = b; }
            } break;
            case 2: {
              const a = ((base + y * stride + x * 2) ^ sw) & 0xFFF, p = (tmem[a] << 8) | tmem[(a + 1) & 0xFFF];
              if (t.fmt === 3) putIA16(o, p); else if (t.fmt === 2) putPal(o, pal16(p >> 8)); else put5551(o, p);
            } break;
            default: { // 32b: R G in the low bank, B A in the high one
              const a = ((base + y * stride + x * 2) ^ sw) & 0x7FF;
              out[o] = tmem[a]; out[o + 1] = tmem[a + 1]; out[o + 2] = tmem[a + 0x800]; out[o + 3] = tmem[a + 0x801];
            }
          }
        }
      }
      return out;
    }
    const known = new Map();   // texture key -> the list it was last used in
    let uploads = [];
    const tileMemo = []; for (let i = 0; i < 8; i++) tileMemo.push({ memo: '', tex: null });
    function tileTexture(idx) {
      const t = tiles[idx], [w, h] = tileSize(t), tlutType = (othH >> 14) & 3;
      const memo = `${t.fmt}.${t.siz}.${t.line}.${t.tmem}.${t.pal}.${w}.${h}.${tlutType}.${tmemSerial}`;
      const m = tileMemo[idx];
      if (m.memo === memo && known.has(m.tex.k)) { known.set(m.tex.k, listNo); return m.tex; }
      const k = `${t.fmt}.${t.siz}.${t.line}.${t.tmem}.${t.pal}.${w}.${h}.${tlutType}.${hashTmem(t, h)}`;
      if (!known.has(k)) { const d = decodeTile(t, w, h, tlutType); uploads.push({ k, w, h, d }); }
      known.set(k, listNo);
      m.memo = memo; m.tex = { k, w, h };
      return m.tex;
    }
    function wrapFor(cm, mask, coord) { // RDP clamp, mirror and wrap as GL's
      if ((cm & 2) && !(mask && (1 << mask) < coord)) return GL_CLAMP;
      if (cm & 1) return GL_MIRROR;
      return mask ? GL_REPEAT : GL_CLAMP;
    }

    // Batching: the list's triangles go into one vertex buffer; each run of one state is a draw. Draws, clears and
    // changes of color image are kept in order as ops.
    const MAXV = 1 << 18, batch = new Float32Array(MAXV * VS);
    let nb = 0, drawStart = 0, batchState = null, ops = [], states = [], dirty = true, curTarget = 0;
    function stateKey() {
      return `${cimg.addr}.${combH}.${combL}.${othH}.${othL}.${geom & (G_CULL_BACK | G_CULL_FRONT | G_ZBUFFER | G_SHADING_SMOOTH)}.${texOn ? texTile + '.' + tmemSerial : 'x'}.${prim}.${env}.${fogC}.${blendC}.${primLod}.${scissor}`;
    }
    function closeDraw() {
      if (batchState && nb > drawStart) ops.push({ o: 'd', st: batchState.index, f: drawStart, n: nb - drawStart });
      drawStart = nb;
    }
    const shiftScale = (sh) => sh === 0 ? 1 : sh <= 10 ? 1 / (1 << sh) : (1 << (16 - sh));
    function captureState(key, rect) {
      const cyc = (othH >> 20) & 3, twoCycle = cyc === 1;
      // Fog in the blender's first step (P = fog color, A = shade alpha) in 2-cycle mode.
      const fogBlend = twoCycle && ((othL >>> 30) & 3) === 3 && ((othL >>> 26) & 3) === 2;
      const ac = othL & 3, cvgxa = (othL >> 12) & 1, acs = (othL >> 13) & 1;
      const alphaTest = ac === 1 ? 1 : (cvgxa && acs) ? 2 : 0;   // threshold, or a texture edge (alpha times coverage)
      const flat = !(geom & G_SHADING_SMOOTH) ? 1 : 0;
      const st = { key, index: states.length, ch: combH, cl: combL, two: twoCycle ? 1 : 0, flat, fog: fogBlend ? 1 : 0, at: alphaTest,
        cyc, othL, geom: rect ? geom & ~(G_CULL_BACK | G_CULL_FRONT) : geom, sc: scissor.slice(), tex: [null, null],
        prim: prim.slice(), env: env.slice(), fogc: fogC.slice(), blend: blendC.slice(), lod: [primLod, 0] };
      if (texOn) {
        const filter = ((othH >> 12) & 3) === 0 ? GL_NEAREST : GL_LINEAR, halfT = filter === GL_LINEAR ? 0.5 : 0;
        for (let k = 0; k < 2; k++) {
          const ti = (texTile + k) & 7, t = tiles[ti], e = tileTexture(ti);
          st.tex[k] = { k: e.k, w: e.w, h: e.h, filter, ws: wrapFor(t.cms, t.masks, ((t.lrs - t.uls) >> 2) + 1), wt: wrapFor(t.cmt, t.maskt, ((t.lrt - t.ult) >> 2) + 1),
            tr: [shiftScale(t.shifts), shiftScale(t.shiftt), t.uls / 4 - halfT, t.ult / 4 - halfT] };
        }
      }
      states.push(st);
      return st;
    }
    function useState(key, rect) {
      if (batchState === null || batchState.key !== key) { closeDraw(); batchState = captureState(key, rect); }
    }
    function pushTri(i0, i1, i2) {
      if (dirty || batchState === null) { dirty = false; useState(stateKey(), false); }
      if (nb + 3 > MAXV) return;
      let o = nb * VS;
      for (let k = 0; k < VS; k++) batch[o + k] = vbuf[i0 * VS + k]; o += VS;
      for (let k = 0; k < VS; k++) batch[o + k] = vbuf[i1 * VS + k]; o += VS;
      for (let k = 0; k < VS; k++) batch[o + k] = vbuf[i2 * VS + k];
      nb += 3;
    }
    function setTarget() {
      if (cimg.addr === zimg || cimg.addr === curTarget) return;
      closeDraw(); curTarget = cimg.addr; dirty = true;
      ops.push({ o: 't', a: cimg.addr, w: cimg.width, s: cimg.siz });
    }

    // rectangles (FILLRECT, TEXRECT), in the color image's pixels. A rectangle has no shade (the RDP's shade
    // coefficients are zero for it).
    function rect(x0, y0, x1, y1, s0, t0, s1, t1, flip) {
      const W = cimg.width, H = fbHeightFor(cimg.width);
      const X = (x) => 2 * x / W - 1, Y = (y) => 1 - 2 * y / H;
      dirty = true;
      useState(stateKey() + '.r', true);
      if (nb + 6 > MAXV) return;
      const v = (x, y, s, t) => { const o = (nb++) * VS; batch[o] = X(x); batch[o + 1] = Y(y); batch[o + 2] = -1; batch[o + 3] = 1; batch[o + 4] = batch[o + 5] = batch[o + 6] = batch[o + 7] = 0; batch[o + 8] = s; batch[o + 9] = t; };
      const st = (cx, cy) => flip ? [s0 + (cy ? s1 - s0 : 0), t0 + (cx ? t1 - t0 : 0)] : [cx ? s1 : s0, cy ? t1 : t0];
      const a = st(0, 0), b = st(1, 0), c = st(1, 1), d = st(0, 1);
      v(x0, y0, a[0], a[1]); v(x1, y0, b[0], b[1]); v(x1, y1, c[0], c[1]);
      v(x0, y0, a[0], a[1]); v(x1, y1, c[0], c[1]); v(x0, y1, d[0], d[1]);
    }
    function fillRect(ulx, uly, lrx, lry) {
      const cyc = (othH >> 20) & 3;
      if (cyc >= 2) { lrx += 1; lry += 1; }
      if (cimg.addr === zimg) { closeDraw(); ops.push({ o: 'z' }); return; } // the z buffer cleared through the color pipeline
      setTarget();
      if (cyc === 3) { // fill mode: the fill color, as a clear of the rectangle
        let c;
        if (cimg.siz === 3) c = [(fillColor >>> 24) / 255, ((fillColor >>> 16) & 255) / 255, ((fillColor >>> 8) & 255) / 255, (fillColor & 255) / 255];
        else { const p = fillColor >>> 16; c = [ex5(p >> 11) / 255, ex5((p >> 6) & 31) / 255, ex5((p >> 1) & 31) / 255, 1]; }
        const x0 = Math.max(ulx, scissor[0]), y0 = Math.max(uly, scissor[1]), x1 = Math.min(lrx, scissor[2]), y1 = Math.min(lry, scissor[3]);
        if (x1 <= x0 || y1 <= y0) return;
        closeDraw(); ops.push({ o: 'f', r: [x0, y0, x1, y1], c });
        return;
      }
      // 1/2-cycle mode: the RDP still runs the texture unit, at the tile's first texel (a rectangle has no texture
      // coordinates), so a combiner that multiplies by TEXEL0 gets whatever TMEM holds there.
      const saveOn = texOn, saveTile = texTile, t0 = tiles[0];
      texOn = true; texTile = 0;
      rect(ulx, uly, lrx, lry, t0.uls / 4, t0.ult / 4, t0.uls / 4, t0.ult / 4, false);
      texOn = saveOn; texTile = saveTile; dirty = true;
    }
    function texRect(w0, w1, flip) {
      const lrx = ((w0 >>> 12) & 0xFFF) / 4, lry = (w0 & 0xFFF) / 4, ti = (w1 >>> 24) & 7, ulx = ((w1 >>> 12) & 0xFFF) / 4, uly = (w1 & 0xFFF) / 4;
      const s = (half1 >> 16) / 32, t = ((half1 << 16) >> 16) / 32;
      let dsdx = (half2 >> 16) / 1024, dtdy = ((half2 << 16) >> 16) / 1024;
      const cyc = (othH >> 20) & 3;
      let x1 = lrx, y1 = lry;
      if (cyc === 2) { dsdx /= 4; x1 += 1; y1 += 1; } else if (cyc === 3) { x1 += 1; y1 += 1; }
      setTarget();
      const saveOn = texOn, saveTile = texTile; texOn = true; texTile = ti;
      const s1 = s + (flip ? (y1 - uly) * dsdx : (x1 - ulx) * dsdx), t1 = t + (flip ? (x1 - ulx) * dtdy : (y1 - uly) * dtdy);
      rect(ulx, uly, x1, y1, s, t, s1, t1, flip);
      texOn = saveOn; texTile = saveTile; dirty = true;
    }

    // the display list
    const unknown = new Set();
    function runDL(start) {
      const stack = []; let pc = start, guard = 0;
      setTarget();
      for (;;) {
        if (++guard > 1000000) { log('display list too long'); return; }
        const w0 = r32(pc), w1 = r32(pc + 4); pc += 8;
        const op = w0 >>> 24;
        if (op > 0x07 && op !== 0xDE && op !== 0xDF && op !== 0xE1 && op !== 0xF1) dirty = true;
        switch (op) {
          case 0x01: { const n = (w0 >>> 12) & 0xFF, v0 = ((w0 >>> 1) & 0x7F) - n; if (n > 0 && v0 >= 0) loadVertices(segAddr(w1), Math.min(n, 64 - v0), v0); } break;
          case 0x02: { // G_MODIFYVTX
            const where = (w0 >>> 16) & 0xFF, o = ((w0 & 0xFFFF) >> 1) * VS;
            if (where === 0x14) { vbuf[o + 8] = (w1 >> 16) / 32; vbuf[o + 9] = ((w1 << 16) >> 16) / 32; }
            else if (where === 0x10) { vbuf[o + 4] = (w1 >>> 24) / 255; vbuf[o + 5] = ((w1 >>> 16) & 255) / 255; vbuf[o + 6] = ((w1 >>> 8) & 255) / 255; vbuf[o + 7] = (w1 & 255) / 255; }
          } break;
          case 0x03: break; // G_CULLDL: everything is drawn
          case 0x04: pc = segAddr(half1); break; // G_BRANCH_Z: always the near (detailed) branch
          case 0x05: pushTri(((w0 >>> 16) & 0xFF) >> 1, ((w0 >>> 8) & 0xFF) >> 1, (w0 & 0xFF) >> 1); break;
          case 0x06: case 0x07:
            pushTri(((w0 >>> 16) & 0xFF) >> 1, ((w0 >>> 8) & 0xFF) >> 1, (w0 & 0xFF) >> 1);
            pushTri(((w1 >>> 16) & 0xFF) >> 1, ((w1 >>> 8) & 0xFF) >> 1, (w1 & 0xFF) >> 1);
            break;
          case 0x00: case 0xE6: case 0xE7: case 0xE8: case 0xE9: case 0xDD: case 0xEC: case 0xEB: case 0xEA: case 0xEE: break;
          case 0xD7: texOn = ((w0 >>> 1) & 0x7F) !== 0; texTile = (w0 >>> 8) & 7; texScaleS = ((w1 >>> 16) || 1) / 65536; texScaleT = ((w1 & 0xFFFF) || 1) / 65536; break;
          case 0xD8: { const n = (w1 >>> 6) || 1; for (let i = 0; i < n && mtxStack.length; i++) mv = mtxStack.pop(); mvp = mul(mv, proj); } break;
          case 0xD9: geom = (geom & (w0 & 0xFFFFFF)) | w1; break;
          case 0xDA: {
            const p = (w0 & 0xFF) ^ 1, m = readMtx(segAddr(w1));
            if (p & 4) proj = (p & 2) ? m : mul(m, proj);
            else { if ((p & 1) && mtxStack.length < 32) mtxStack.push(mv); mv = (p & 2) ? m : mul(m, mv); }
            mvp = mul(mv, proj);
          } break;
          case 0xDB: { // G_MOVEWORD
            const idx = (w0 >>> 16) & 0xFF, off = w0 & 0xFFFF;
            if (idx === 0x06) seg[(off >> 2) & 15] = w1 & 0xFFFFFF;
            else if (idx === 0x02) numLights = Math.min(7, Math.floor(w1 / 24));
            else if (idx === 0x08) { fogMul = (w1 >> 16); fogOff = ((w1 << 16) >> 16); }
            else if (idx === 0x0A) { const L = lights[Math.floor(off / 0x18)]; if (L && (off % 0x18) === 0) { L.r = (w1 >>> 24) / 255; L.g = ((w1 >>> 16) & 255) / 255; L.b = ((w1 >>> 8) & 255) / 255; } }
          } break;
          case 0xDC: { // G_MOVEMEM
            const idx = w0 & 0xFF, off = ((w0 >>> 8) & 0xFF) * 8, a = segAddr(w1);
            if (idx === 8) { vpScale = [rs16(a) / 4, rs16(a + 2) / 4, rs16(a + 4) / 4]; vpTrans = [rs16(a + 8) / 4, rs16(a + 10) / 4, rs16(a + 12) / 4]; }
            else if (idx === 10) {
              const x = rs8(a + 8), y = rs8(a + 9), z = rs8(a + 10), l = Math.hypot(x, y, z) || 1;
              if (off === 0 || off === 0x18) lookat[off / 0x18] = [x / l, y / l, z / l];
              else { const L = lights[off / 0x18 - 2]; if (L) { L.r = r8(a) / 255; L.g = r8(a + 1) / 255; L.b = r8(a + 2) / 255; L.x = x / l; L.y = y / l; L.z = z / l; } }
            }
          } break;
          case 0xDE: { const to = segAddr(w1); if (((w0 >>> 16) & 0xFF) === 0) stack.push(pc); pc = to; } break;
          case 0xDF: if (!stack.length) return; pc = stack.pop(); break;
          case 0xE1: half1 = w1; break;
          case 0xF1: half2 = w1; break;
          case 0xE2: { const len = (w0 & 0xFF) + 1, sft = 32 - ((w0 >>> 8) & 0xFF) - len, mask = (len >= 32 ? 0xFFFFFFFF : ((1 << len) - 1) << sft) >>> 0; othL = ((othL & ~mask) | (w1 & mask)) >>> 0; } break;
          case 0xE3: { const len = (w0 & 0xFF) + 1, sft = 32 - ((w0 >>> 8) & 0xFF) - len, mask = (len >= 32 ? 0xFFFFFFFF : ((1 << len) - 1) << sft) >>> 0; othH = ((othH & ~mask) | (w1 & mask)) >>> 0; } break;
          case 0xE4: case 0xE5: half1 = r32(pc + 4); half2 = r32(pc + 12); pc += 16; texRect(w0, w1, op === 0xE5); break;
          case 0xED: scissor = [((w0 >>> 12) & 0xFFF) / 4, (w0 & 0xFFF) / 4, ((w1 >>> 12) & 0xFFF) / 4, (w1 & 0xFFF) / 4]; break;
          case 0xEF: othH = w0 & 0xFFFFFF; othL = w1 >>> 0; break;
          case 0xF0: loadTLUT((w1 >>> 24) & 7, (w0 >>> 12) & 0xFFF, (w1 >>> 12) & 0xFFF); break;
          case 0xF2: { const t = tiles[(w1 >>> 24) & 7]; t.uls = (w0 >>> 12) & 0xFFF; t.ult = w0 & 0xFFF; t.lrs = (w1 >>> 12) & 0xFFF; t.lrt = w1 & 0xFFF; } break;
          case 0xF3: load((w1 >>> 24) & 7, (w0 >>> 12) & 0xFFF, w0 & 0xFFF, (w1 >>> 12) & 0xFFF, 0, true, w1 & 0xFFF); break;
          case 0xF4: load((w1 >>> 24) & 7, (w0 >>> 12) & 0xFFF, w0 & 0xFFF, (w1 >>> 12) & 0xFFF, w1 & 0xFFF, false, 0); break;
          case 0xF5: { const t = tiles[(w1 >>> 24) & 7]; t.fmt = (w0 >>> 21) & 7; t.siz = (w0 >>> 19) & 3; t.line = (w0 >>> 9) & 0x1FF; t.tmem = w0 & 0x1FF; t.pal = (w1 >>> 20) & 15; t.cmt = (w1 >>> 18) & 3; t.maskt = (w1 >>> 14) & 15; t.shiftt = (w1 >>> 10) & 15; t.cms = (w1 >>> 8) & 3; t.masks = (w1 >>> 4) & 15; t.shifts = w1 & 15; } break;
          case 0xF6: fillRect(((w1 >>> 14) & 0x3FF), ((w1 >>> 2) & 0x3FF), ((w0 >>> 14) & 0x3FF), ((w0 >>> 2) & 0x3FF)); break;
          case 0xF7: fillColor = w1 >>> 0; break;
          case 0xF8: fogC[0] = (w1 >>> 24) / 255; fogC[1] = ((w1 >>> 16) & 255) / 255; fogC[2] = ((w1 >>> 8) & 255) / 255; fogC[3] = (w1 & 255) / 255; break;
          case 0xF9: blendC[0] = (w1 >>> 24) / 255; blendC[1] = ((w1 >>> 16) & 255) / 255; blendC[2] = ((w1 >>> 8) & 255) / 255; blendC[3] = (w1 & 255) / 255; break;
          case 0xFA: primLod = (w0 & 0xFF) / 255; prim[0] = (w1 >>> 24) / 255; prim[1] = ((w1 >>> 16) & 255) / 255; prim[2] = ((w1 >>> 8) & 255) / 255; prim[3] = (w1 & 255) / 255; break;
          case 0xFB: env[0] = (w1 >>> 24) / 255; env[1] = ((w1 >>> 16) & 255) / 255; env[2] = ((w1 >>> 8) & 255) / 255; env[3] = (w1 & 255) / 255; break;
          case 0xFC: combH = w0 & 0xFFFFFF; combL = w1 >>> 0; break;
          case 0xFD: timg = { fmt: (w0 >>> 21) & 7, siz: (w0 >>> 19) & 3, width: (w0 & 0xFFF) + 1, addr: segAddr(w1) }; break;
          case 0xFE: zimg = segAddr(w1); break;
          case 0xFF: cimg = { fmt: (w0 >>> 21) & 7, siz: (w0 >>> 19) & 3, width: (w0 & 0xFFF) + 1, addr: segAddr(w1) }; setTarget(); break;
          default: if (!unknown.has(op)) { unknown.add(op); log('unknown command ' + op.toString(16)); }
        }
      }
    }

    // ?gldump=<n>: the n-th list's draws in the console (state and the box the vertices cover, in image pixels).
    let dumpList = 0;   // set by the page in the shared words (a worker's location is its script's)
    function dump() {
      const W = cimg.width, H = fbHeightFor(cimg.width);
      for (const op of ops) {
        if (op.o !== 'd') { log('dump', JSON.stringify(op)); continue; }
        const s = states[op.st];
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (let i = op.f; i < op.f + op.n; i++) {
          const w = batch[i * VS + 3] || 1, x = (batch[i * VS] / w + 1) * W / 2, y = (1 - batch[i * VS + 1] / w) * H / 2;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        log('dump', `draw ${op.n / 3} tris box ${x0.toFixed(0)},${y0.toFixed(0)}-${x1.toFixed(0)},${y1.toFixed(0)} cyc ${s.cyc} comb ${s.ch.toString(16)}/${s.cl.toString(16)} othL ${s.othL.toString(16)} prim ${s.prim.map((v) => (v * 255) | 0)} env ${s.env.map((v) => (v * 255) | 0)} tex ${s.tex.map((t) => t ? t.k + ' ' + t.tr.map((v) => +v.toFixed(2)) : '-').join(' | ')} key ${s.key.endsWith('.r') ? 'rect' : 'tri'}`);
      }
    }

    // One list: read it, then hand its packet to the drawer. With 2 packets already waiting for the drawer this
    // thread waits (the game slows a little rather than the picture falling behind).
    function runTask(rdram, dataPtr, ack) {
      R = rdram >>> 0; ackIdx = ack >>> 2;
      dumpList = HEAP32[ackIdx + 1];
      listNo++;
      const t0 = performance.now();
      ops = []; states = []; uploads = []; nb = 0; drawStart = 0; batchState = null; curTarget = 0; dirty = true;
      try { runDL(dataPtr & 0xFFFFFF); } catch (e) { log('display list error: ' + e + '\n' + e.stack); }
      closeDraw();
      if (dumpList && listNo === dumpList) dump();
      let evicts = null;
      if (listNo % 120 === 0) {
        evicts = [];
        for (const [k, used] of known) if (listNo - used > 900) { known.delete(k); evicts.push(k); }
      }
      const verts = batch.slice(0, nb * VS);
      const packet = { verts, ops, states, uploads, evicts, ms: performance.now() - t0, notes };
      notes = [];
      sent++;
      deliver(packet, [verts.buffer, ...uploads.map((u) => u.d.buffer)]);
      if (ackIdx > 0) {
        for (let tries = 0; tries < 20; tries++) {
          const done = Atomics.load(HEAP32, ackIdx);
          if (sent - done <= 2) break;
          Atomics.wait(HEAP32, ackIdx, done, 50);
        }
      }
    }
    return { runTask };
  }

  // ======================================================================================== the drawer (WebGL2)
  function makeDrawer() {
    let gl = null, canvas = null, R = 0, ackIdx = -1, scale = 1, frameNo = 0, white = null, vbo = null, vao = null;
    let blitProg = null, ramTex = null, quadVao = null, lastTarget = null;
    const debug = /[?&]gldebug=1/.test(location.search);
    const stats = { lists: 0, draws: 0, tris: 0, readMs: 0, drawMs: 0 };
    const textures = new Map(), fbs = new Map(), depthBufs = new Map(), progs = new Map(), samplers = new Map();
    const r16 = (a) => HEAPU16[(R + ((a & 0xFFFFFE) ^ 2)) >>> 1];

    // framebuffers: one per color image address; a depth buffer per size, shared
    function fbFor(addr, w, siz) {
      let f = fbs.get(addr);
      const h = fbHeightFor(w);
      if (f && f.w === w && f.scale === scale) { f.drawn = frameNo; return f; }
      if (f) { gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.tex); }
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0); cur.tex[0] = tex; gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w * scale, h * scale, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const dkey = `${w * scale}x${h * scale}`;
      let depth = depthBufs.get(dkey);
      if (!depth) {
        depth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w * scale, h * scale); depthBufs.set(dkey, depth);
      }
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      setEnable(gl.SCISSOR_TEST, 'scisOn', false); if (cur.dm !== 1) { cur.dm = 1; gl.depthMask(true); }
      gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      cur.fbo = fbo; gl.viewport(0, 0, w * scale, h * scale);
      f = { addr, w, h, siz, tex, fbo, scale, drawn: frameNo, bytes: w * h * (siz === 3 ? 4 : 2) };
      fbs.set(addr, f);
      return f;
    }
    function bindFbo(f) { if (cur.fbo !== f.fbo) { cur.fbo = f.fbo; gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo); gl.viewport(0, 0, f.w * scale, f.h * scale); } }

    // shaders: one program per combine mode (and the few other bits that change the code)
    const VSRC = `#version 300 es
    in vec4 aPos; in vec4 aShade; in vec2 aST;
    out vec4 vShade; out vec2 vST; flat out vec4 vFlat;
    void main() { gl_Position = aPos; vShade = aShade; vFlat = aShade; vST = aST; }`;
    const colA = ['comb.rgb', 't0.rgb', 't1.rgb', 'uPrim.rgb', 'shade.rgb', 'uEnv.rgb', 'vec3(1.0)', 'vec3(noise)'];
    const colB = ['comb.rgb', 't0.rgb', 't1.rgb', 'uPrim.rgb', 'shade.rgb', 'uEnv.rgb', 'vec3(0.0)', 'vec3(0.0)'];
    const colC = ['comb.rgb', 't0.rgb', 't1.rgb', 'uPrim.rgb', 'shade.rgb', 'uEnv.rgb', 'vec3(0.0)', 'vec3(comb.a)',
      'vec3(t0.a)', 'vec3(t1.a)', 'vec3(uPrim.a)', 'vec3(shade.a)', 'vec3(uEnv.a)', 'vec3(uLod.y)', 'vec3(uLod.x)', 'vec3(0.0)'];
    const colD = ['comb.rgb', 't0.rgb', 't1.rgb', 'uPrim.rgb', 'shade.rgb', 'uEnv.rgb', 'vec3(1.0)', 'vec3(0.0)'];
    const alABD = ['comb.a', 't0.a', 't1.a', 'uPrim.a', 'shade.a', 'uEnv.a', '1.0', '0.0'];
    const alC = ['uLod.y', 't0.a', 't1.a', 'uPrim.a', 'shade.a', 'uEnv.a', 'uLod.x', '0.0'];
    function cycleSrc(a, b, c, d, aa, ab, ac, ad) {
      const v3 = (tbl, i) => tbl[i] || 'vec3(0.0)', v1 = (tbl, i) => tbl[i] || '0.0';
      return `vec4((${v3(colA, a)} - ${v3(colB, b)}) * ${v3(colC, c)} + ${v3(colD, d)}, (${v1(alABD, aa)} - ${v1(alABD, ab)}) * ${v1(alC, ac)} + ${v1(alABD, ad)})`;
    }
    function program(s) {
      const key = `${s.ch}.${s.cl}.${s.two}.${s.flat}.${s.fog}.${s.at}`;
      let p = progs.get(key);
      if (p !== undefined) return p;
      const w0 = s.ch, w1 = s.cl;
      const c0 = [(w0 >>> 20) & 15, (w1 >>> 28) & 15, (w0 >>> 15) & 31, (w1 >>> 15) & 7, (w0 >>> 12) & 7, (w1 >>> 12) & 7, (w0 >>> 9) & 7, (w1 >>> 9) & 7];
      const c1 = [(w0 >>> 5) & 15, (w1 >>> 24) & 15, w0 & 31, (w1 >>> 6) & 7, (w1 >>> 21) & 7, (w1 >>> 3) & 7, (w1 >>> 18) & 7, w1 & 7];
      // In 1-cycle mode the RDP uses the second cycle's settings; in the second cycle TEXEL0 and TEXEL1 trade places.
      const body = s.two
        ? `vec4 comb = vec4(0.5); comb = clamp(${cycleSrc(...c0)}, 0.0, 1.0);
          { vec4 tt = t0; t0 = t1; t1 = tt; } comb = clamp(${cycleSrc(...c1)}, 0.0, 1.0);`
        : `vec4 comb = vec4(0.5); comb = clamp(${cycleSrc(...c1)}, 0.0, 1.0);`;
      const fsrc = `#version 300 es
      precision highp float;
      in vec4 vShade; in vec2 vST; flat in vec4 vFlat;
      uniform sampler2D uTex0, uTex1;
      uniform vec4 uT0, uT1, uSize, uPrim, uEnv, uFog, uBlend; uniform vec2 uLod;
      out vec4 oColor;
      void main() {
        vec4 shade = ${s.flat ? 'vFlat' : 'vShade'};
        vec4 t0 = texture(uTex0, (vST * uT0.xy - uT0.zw) / uSize.xy);
        vec4 t1 = texture(uTex1, (vST * uT1.xy - uT1.zw) / uSize.zw);
        float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        ${body}
        ${s.at === 1 ? 'if (comb.a < max(uBlend.a, 1.0 / 255.0)) discard;' : s.at === 2 ? 'if (comb.a < 0.5) discard;' : ''}
        ${s.fog ? 'comb.rgb = mix(comb.rgb, uFog.rgb, shade.a);' : ''}
        oColor = comb;
      }`;
      p = link(VSRC, fsrc);
      if (p) {
        p.u = {}; p.cache = {};
        for (const n of ['uTex0', 'uTex1', 'uT0', 'uT1', 'uSize', 'uPrim', 'uEnv', 'uFog', 'uBlend', 'uLod']) p.u[n] = gl.getUniformLocation(p, n);
        gl.useProgram(p); cur.prog = p; gl.uniform1i(p.u.uTex0, 0); gl.uniform1i(p.u.uTex1, 1);
      }
      progs.set(key, p);
      return p;
    }
    function link(vs, fs) {
      const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { log('shader', gl.getShaderInfoLog(sh), src); return null; } return sh; };
      const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
      if (!v || !f) return null;
      const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aShade'); gl.bindAttribLocation(p, 2, 'aST');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { log('link', gl.getProgramInfoLog(p)); return null; }
      return p;
    }
    function sampler(filter, ws, wt) {
      const k = filter * 1e8 + ws * 1e4 + wt;
      let sm = samplers.get(k);
      if (!sm) {
        sm = gl.createSampler();
        gl.samplerParameteri(sm, gl.TEXTURE_MIN_FILTER, filter); gl.samplerParameteri(sm, gl.TEXTURE_MAG_FILTER, filter);
        gl.samplerParameteri(sm, gl.TEXTURE_WRAP_S, ws); gl.samplerParameteri(sm, gl.TEXTURE_WRAP_T, wt);
        samplers.set(k, sm);
      }
      return sm;
    }
    // WebGL state as last set, so a draw only sends what changed.
    const cur = {};
    function resetCur() { Object.assign(cur, { prog: null, tex: [null, null], samp: [null, null], fbo: undefined, scis: '', scisOn: -1, blend: -1, bf: '', depth: -1, df: 0, dm: -1, poff: -1, cull: -1, cf: 0 }); }
    resetCur();
    function setEnable(cap, field, on) { if (cur[field] !== on) { cur[field] = on; on ? gl.enable(cap) : gl.disable(cap); } }
    function uni(p, name, v) {
      const c = p.cache[name];
      if (c && c[0] === v[0] && c[1] === v[1] && c[2] === v[2] && c[3] === v[3]) return;
      p.cache[name] = v;
      if (v.length === 2) gl.uniform2f(p.u[name], v[0], v[1]); else gl.uniform4f(p.u[name], v[0], v[1], v[2], v[3]);
    }
    function applyRenderMode(s, H) {
      const L = s.othL, sc = s.sc;
      setEnable(gl.SCISSOR_TEST, 'scisOn', true);
      const sk = `${sc}`;
      if (cur.scis !== sk) { cur.scis = sk; gl.scissor(sc[0] * scale, (H - sc[3]) * scale, Math.max(0, sc[2] - sc[0]) * scale, Math.max(0, sc[3] - sc[1]) * scale); }
      if (s.cyc >= 2) { setEnable(gl.BLEND, 'blend', false); setEnable(gl.DEPTH_TEST, 'depth', false); setEnable(gl.CULL_FACE, 'cull', false); setEnable(gl.POLYGON_OFFSET_FILL, 'poff', false); return; }
      const zcmp = (L >> 4) & 1, zupd = (L >> 5) & 1, zmode = (L >> 10) & 3;
      if (zcmp || zupd) {
        setEnable(gl.DEPTH_TEST, 'depth', true);
        const f = zcmp ? (zmode === 3 ? gl.LEQUAL : gl.LESS) : gl.ALWAYS;
        if (cur.df !== f) { cur.df = f; gl.depthFunc(f); }
        if (cur.dm !== zupd) { cur.dm = zupd; gl.depthMask(!!zupd); }
      } else setEnable(gl.DEPTH_TEST, 'depth', false);
      setEnable(gl.POLYGON_OFFSET_FILL, 'poff', zmode === 3);
      // Blending: the blender's last step (cycle 2's in 2-cycle mode, else cycle 1's) when it mixes with memory.
      const m2 = (L >>> 20) & 3, a2 = (L >>> 24) & 3, b2 = (L >>> 16) & 3, forceBl = (L >> 14) & 1;
      if (forceBl && m2 === 1) {
        const src = a2 === 3 ? gl.ZERO : gl.SRC_ALPHA;
        const dst = b2 === 0 ? (src === gl.SRC_ALPHA ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE) : b2 === 1 ? gl.DST_ALPHA : b2 === 2 ? gl.ONE : gl.ZERO;
        setEnable(gl.BLEND, 'blend', true);
        const bf = src + '.' + dst;
        if (cur.bf !== bf) { cur.bf = bf; gl.blendFunc(src, dst); }
      } else setEnable(gl.BLEND, 'blend', false);
      const cb = s.geom & G_CULL_BACK, cf = s.geom & G_CULL_FRONT;
      if (cb || cf) {
        setEnable(gl.CULL_FACE, 'cull', true);
        const face = cb && cf ? gl.FRONT_AND_BACK : cb ? gl.BACK : gl.FRONT;
        if (cur.cf !== face) { cur.cf = face; gl.cullFace(face); }
      } else setEnable(gl.CULL_FACE, 'cull', false);
    }

    // One packet from the reader, drawn in order.
    function draw(p) {
      const t0 = performance.now();
      if (p.notes) for (const n of p.notes) log(n);
      if (!gl) return ack();
      for (const u of p.uploads) {
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0); cur.tex[0] = tex; gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, u.w, u.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, u.d);
        const old = textures.get(u.k); if (old) gl.deleteTexture(old);
        textures.set(u.k, tex);
      }
      if (p.evicts) for (const k of p.evicts) { const t = textures.get(k); if (t) { gl.deleteTexture(t); textures.delete(k); } }
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, p.verts, gl.STREAM_DRAW);
      let target = lastTarget;
      for (const op of p.ops) {
        if (op.o === 't') { target = fbFor(op.a, op.w, op.s); bindFbo(target); continue; }
        if (!target) continue;
        if (op.o === 'z') { bindFbo(target); setEnable(gl.SCISSOR_TEST, 'scisOn', false); if (cur.dm !== 1) { cur.dm = 1; gl.depthMask(true); } gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT); continue; }
        if (op.o === 'f') {
          bindFbo(target); setEnable(gl.SCISSOR_TEST, 'scisOn', true);
          const [x0, y0, x1, y1] = op.r;
          cur.scis = ''; gl.scissor(x0 * scale, (target.h - y1) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
          gl.clearColor(op.c[0], op.c[1], op.c[2], op.c[3]); gl.clear(gl.COLOR_BUFFER_BIT);
          continue;
        }
        const s = p.states[op.st], prog = program(s);
        if (!prog) continue;
        bindFbo(target);
        if (cur.prog !== prog) { cur.prog = prog; gl.useProgram(prog); }
        for (let k = 0; k < 2; k++) {
          const t = s.tex[k], tex = (t && textures.get(t.k)) || white, samp = t ? sampler(t.filter, t.ws, t.wt) : null;
          if (cur.tex[k] !== tex) { cur.tex[k] = tex; gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, tex); }
          if (cur.samp[k] !== samp) { cur.samp[k] = samp; gl.bindSampler(k, samp); }
        }
        const t0s = s.tex[0], t1s = s.tex[1] || s.tex[0];
        uni(prog, 'uT0', t0s ? t0s.tr : [1, 1, 0, 0]); uni(prog, 'uT1', t1s ? t1s.tr : [1, 1, 0, 0]);
        uni(prog, 'uSize', [t0s ? t0s.w : 1, t0s ? t0s.h : 1, t1s ? t1s.w : 1, t1s ? t1s.h : 1]);
        uni(prog, 'uPrim', s.prim); uni(prog, 'uEnv', s.env); uni(prog, 'uFog', s.fogc); uni(prog, 'uBlend', s.blend); uni(prog, 'uLod', s.lod);
        applyRenderMode(s, target.h);
        gl.drawArrays(gl.TRIANGLES, op.f, op.n);
        stats.draws++; stats.tris += op.n / 3;
      }
      lastTarget = target;
      stats.lists++; stats.readMs += p.ms; stats.drawMs += performance.now() - t0;
      ack();
    }
    function ack() { if (ackIdx > 0) { Atomics.add(HEAP32, ackIdx, 1); Atomics.notify(HEAP32, ackIdx); } }

    // presenting the VI's image
    function present(status, origin, width) {
      if (!gl) return;
      frameNo++;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const cw = canvas.width, ch = canvas.height;
      gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      gl.viewport(0, 0, cw, ch); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      if ((status & 3) === 0 || !width) { resetCur(); report(); return; }
      const addr = origin & 0xFFFFFF;
      let src = null;
      for (const f of fbs.values()) if (addr >= f.addr && addr < f.addr + f.bytes && frameNo - f.drawn < 8) { src = f; break; }
      if (debug && frameNo % 120 === 0) log(`VI origin ${addr.toString(16)} width ${width} -> ${src ? 'fb ' + src.addr.toString(16) + ' ' + src.w + 'x' + src.h : 'RDRAM'}`);
      let tex;
      if (src) tex = src.tex;
      else { // drawn by the CPU: read it from RDRAM (16-bit)
        const w = width, h = fbHeightFor(width), px = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const pp = r16(addr + (y * w + x) * 2), o = ((h - 1 - y) * w + x) * 4;
          px[o] = ex5(pp >> 11); px[o + 1] = ex5((pp >> 6) & 31); px[o + 2] = ex5((pp >> 1) & 31); px[o + 3] = 255;
        }
        if (!ramTex) ramTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        tex = ramTex;
      }
      // 4:3, letterboxed in the canvas.
      let vw = cw, vh = Math.round(cw * 3 / 4);
      if (vh > ch) { vh = ch; vw = Math.round(ch * 4 / 3); }
      gl.viewport((cw - vw) >> 1, (ch - vh) >> 1, vw, vh);
      gl.useProgram(blitProg); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.bindSampler(0, null);
      gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLES, 0, 6);
      globalThis.n64glFrames = (globalThis.n64glFrames || 0) + 1;   // the page's start-up line counts these
      resetCur();
      report();
    }
    function report() {
      if (frameNo % 600 !== 0 || !stats.lists) return;
      log(`frame ${frameNo}: ${stats.lists} lists, ${stats.draws} draws, ${Math.round(stats.tris)} triangles, ${textures.size} textures, ${fbs.size} framebuffers; a list: ${(stats.readMs / stats.lists).toFixed(2)} ms reading, ${(stats.drawMs / stats.lists).toFixed(2)} ms drawing`);
      stats.lists = stats.draws = stats.tris = stats.readMs = stats.drawMs = 0;
    }

    function init(rdram, ack) {
      R = rdram >>> 0; ackIdx = ack >>> 2;
      const dm = /[?&]gldump=(\d+)/.exec(location.search); if (dm) HEAP32[ackIdx + 1] = +dm[1];
      canvas = document.getElementById('canvas');
      gl = canvas && canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
      if (!gl) { log('no WebGL2'); return false; }
      const q = globalThis.n64webQuality;
      scale = q === 2 ? 3 : q === 1 ? 2 : 1;
      vbo = gl.createBuffer(); vao = gl.createVertexArray();
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, VS * 4, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, VS * 4, 16);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, VS * 4, 32);
      white = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, white);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      blitProg = link(`#version 300 es
        in vec2 aPos; out vec2 vUV; void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`,
        `#version 300 es
        precision mediump float; in vec2 vUV; uniform sampler2D uTex; out vec4 o; void main() { o = vec4(texture(uTex, vUV).rgb, 1.0); }`);
      quadVao = gl.createVertexArray(); gl.bindVertexArray(quadVao);
      const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      resetCur();
      log(`WebGL2 renderer on (${gl.getParameter(gl.VERSION)}), framebuffers at ${scale}x`);
      return true;
    }
    function setQuality(q) { scale = q === 2 ? 3 : q === 1 ? 2 : 1; }
    return { init, draw, present, setQuality };
  }

  // ======================================================================================== wiring
  if (onPage) {
    // n64gl is used when the page asks for it (globalThis.n64webRenderer = 'gl', ?renderer=gl) and wherever the browser
    // has no WebGPU. Then the WebGPU device RT64 would need is never asked for: the kit's plume_webgpu_device.js,
    // linked after this file, queues that request in Module.preRun (and aborts the program without WebGPU), so
    // Module.preRun here drops what it queues.
    if (globalThis.n64webRenderer === 'gl' || /[?&]renderer=gl/.test(location.search) || !navigator.gpu) {
      globalThis.n64webRenderer = 'gl';
      if (typeof Module !== 'undefined') {
        const queue = (list) => {
          const a = [].concat(list || []).filter((f) => !String(f).includes('plume-webgpu-device'));
          const push = a.push.bind(a);
          a.push = (...fs) => push(...fs.filter((f) => !String(f).includes('plume-webgpu-device')));
          return a;
        };
        let pre = queue(Module.preRun);
        Object.defineProperty(Module, 'preRun', { get: () => pre, set: (v) => { pre = queue(v); }, configurable: true });
      }
    }
    const drawer = makeDrawer();
    // A list read on this thread (the program sent it here) is drawn at once.
    const reader = makeReader((packet) => drawer.draw(packet));
    // Packets from the graphics thread arrive through Emscripten's worker messages (cmd 9 calls Module[handler]).
    if (typeof Module !== 'undefined') Module.n64glPacket = (packet) => drawer.draw(packet);
    return { init: drawer.init, present: drawer.present, setQuality: drawer.setQuality, runTask: reader.runTask };
  }
  const reader = makeReader((packet, transfer) => globalThis.postMessage({ cmd: 9, handler: 'n64glPacket', args: [packet] }, transfer));
  return { runTask: reader.runTask };
})();
