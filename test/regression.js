// Zero-dependency regression tests for omggif.  Run with:
//
//     node test/regression.js
//
// (also works under `node -I test/regression.js` style isolated runs).
//
// The test harness builds GIF bytes with its OWN writer (see the small LZW
// encoder and rawGif() at the bottom of this file).  It shares no code with
// omggif's GifWriter, so a decoded image is checked against expectations that
// were computed independently instead of the encoder and decoder proving each
// other.  Every failure prints the offending sample name and the exact error,
// and the process exits non-zero if anything failed.

"use strict";

var omggif = require("../omggif");
var GifReader = omggif.GifReader;
var GifWriter = omggif.GifWriter;
var GifError = omggif.GifError;

// ---------------------------------------------------------------------------
// Tiny test framework.
// ---------------------------------------------------------------------------

var passed = 0;
var failed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    ++passed;
  } catch (e) {
    ++failed;
    failures.push({ name: name, error: e });
    console.log("FAIL  " + name);
    console.log("      " + (e && e.stack ? e.stack : String(e)));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error("Assertion failed: " + (message || ""));
}

function assertEq(actual, expected, message) {
  if (actual !== expected)
    throw new Error("Assertion failed: " + (message || "values differ") +
        "\n        expected: " + expected +
        "\n        actual:   " + actual);
}

function assertDeepEq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Assertion failed: " + (message || "arrays differ") +
        "\n        expected: " + JSON.stringify(expected) +
        "\n        actual:   " + JSON.stringify(actual));
}

function assertGifError(fn, expectedStage, message) {
  var threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (threw === null)
    throw new Error("Expected a GifError" +
        (expectedStage ? " at stage \"" + expectedStage + "\"" : "") +
        " but no error was thrown (" + (message || "") + ")");
  if (!(threw instanceof Error))
    throw new Error("Thrown value is not an Error: " + threw);
  assertEq(threw.name, "GifError", "error name (" + message + ")");
  if (expectedStage !== undefined && expectedStage !== null)
    assertEq(threw.stage, expectedStage,
        "error stage (" + message + "): " + threw.message);
  if (threw.offset === undefined)
    throw new Error("GifError must always carry an .offset property");
  return threw;
}

function u8(arr) {
  var out = new Uint8Array(arr.length);
  for (var i = 0; i < arr.length; ++i) out[i] = arr[i];
  return out;
}

// ---------------------------------------------------------------------------
// Independently built GIF samples (no omggif code used to create them).
//
// Palettes are small and named by color, and every expected output pixel is
// written out literally from the documented geometry rather than computed
// from the decoded indices.
// ---------------------------------------------------------------------------

// Named palette entries so expected pixels stay readable.
var RED   = 0xff0000, GREEN = 0x00ff00, BLUE  = 0x0000ff,
    WHITE = 0xffffff, BLACK = 0x000000, GRAY  = 0x808080;

function rgba(rgb, a) {
  return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, a];
}

// Untouched destination cell (blitting must leave it at its initial value).
var T = [0, 0, 0, 0];

function buildSamples() {
  // -- Sample A: 4x3 canvas, global 4-color table, one 2x2 frame placed at
  //    (1,1), no transparency, no interlacing. -----------------------------
  var sampleA_palette = [RED, GREEN, BLUE, WHITE];
  // Frame (at x=1,y=1) indices, row by row:
  //   0 1
  //   2 3
  var sampleA_indices = [0, 1, 2, 3];
  var sampleA = rawGif({
    width: 4,
    height: 3,
    globalPalette: sampleA_palette,
    frames: [{
      x: 1, y: 1, w: 2, h: 2,
      indices: sampleA_indices,
      paletteBits: 2,
      transparentIndex: null,
      interlaced: false,
      delay: 0,
      disposal: 0
    }]
  });

  // Expected RGBA for the whole 4x3 canvas, written literally.  Pixels the
  // frame does not cover remain at their initialized zero value.
  var sampleA_expected_rgba = [
    T, T, T, T,
    T, rgba(RED, 255), rgba(GREEN, 255), T,
    T, rgba(BLUE, 255), rgba(WHITE, 255), T
  ];
  var sampleA_expected_bgra = sampleA_expected_rgba.map(function(px) {
    return [px[2], px[1], px[0], px[3]];
  });

  // -- Sample B: 3x2 canvas, no global palette, two frames, local palettes,
  //    transparency and a delay, including a frame with a transparent
  //    index that collides with a used color slot. --------------------------
  // Frame 0 palette: [BLACK, RED]; transparent index 1.  Indices:
  //   0 1 0
  //   1 0 1   -> red cells are transparent.
  var sampleB_f0_indices = [0, 1, 0, 1, 0, 1];
  // Frame 1 palette: [GREEN, GRAY]; transparent index 0, delay 7.  Indices:
  //   0 1 1
  //   1 0 0
  var sampleB_f1_indices = [0, 1, 1, 1, 0, 0];
  var sampleB = rawGif({
    width: 3,
    height: 2,
    globalPalette: null,
    loop: 0,
    frames: [
      {
        x: 0, y: 0, w: 3, h: 2,
        indices: sampleB_f0_indices,
        localPalette: [BLACK, RED],
        transparentIndex: 1,
        interlaced: false,
        delay: 0,
        disposal: 0
      },
      {
        x: 0, y: 0, w: 3, h: 2,
        indices: sampleB_f1_indices,
        localPalette: [GREEN, GRAY],
        transparentIndex: 0,
        interlaced: false,
        delay: 7,
        disposal: 2
      }
    ]
  });

  // Frame 0 expected RGBA, literal geometry.
  var sampleB_f0_expected = [
    rgba(BLACK, 255), T,               rgba(BLACK, 255),
    T,                rgba(BLACK, 255), T
  ];
  // Frame 1 expected RGBA, literal geometry.
  var sampleB_f1_expected = [
    T,                rgba(GRAY, 255),  rgba(GRAY, 255),
    rgba(GRAY, 255), T,                T
  ];

  // -- Sample C: 4x5 canvas, global 2-color table, one interlaced frame
  //    covering the full canvas.  Interlace row order is pass 1 rows
  //    0,2,4, pass 2 row 3, pass 3 rows 1 (GIF 89a interlace). -------------
  // Logical rows (each 4 wide), index per pixel:
  //   row 0: 0 0 1 1
  //   row 1: 0 1 0 1
  //   row 2: 1 1 0 0
  //   row 3: 1 0 1 0
  //   row 4: 0 1 1 0
  var sampleC_rows = [
    [0, 0, 1, 1],
    [0, 1, 0, 1],
    [1, 1, 0, 0],
    [1, 0, 1, 0],
    [0, 1, 1, 0]
  ];
  var sampleC_indices = [];
  interlaceOrder(5).forEach(function(r) {
    sampleC_indices = sampleC_indices.concat(sampleC_rows[r]);
  });
  var sampleC = rawGif({
    width: 4,
    height: 5,
    globalPalette: [BLACK, WHITE],
    frames: [{
      x: 0, y: 0, w: 4, h: 5,
      indices: sampleC_indices,
      paletteBits: 1,
      transparentIndex: null,
      interlaced: true,
      delay: 0,
      disposal: 0
    }]
  });

  // Expected canvas assembled directly from the logical rows, i.e. an
  // independent expression of what interlace de-sorting must produce.
  var sampleC_expected = [];
  sampleC_rows.forEach(function(row) {
    row.forEach(function(idx) {
      sampleC_expected.push(rgba(idx === 0 ? BLACK : WHITE, 255));
    });
  });

  return [
    {
      name: "A-global-palette-subrect",
      bytes: sampleA,
      width: 4, height: 3, numFrames: 1,
      expectedRgba: [sampleA_expected_rgba],
      expectedBgra: [sampleA_expected_bgra]
    },
    {
      name: "B-local-palettes-transparency-animation",
      bytes: sampleB,
      width: 3, height: 2, numFrames: 2,
      expectedRgba: [sampleB_f0_expected, sampleB_f1_expected],
      loop: 0,
      delays: [0, 7]
    },
    {
      name: "C-interlaced",
      bytes: sampleC,
      width: 4, height: 5, numFrames: 1,
      expectedRgba: [sampleC_expected]
    }
  ];
}

// ---------------------------------------------------------------------------
// 1. Independently built samples decode to the hand-written expectations.
// ---------------------------------------------------------------------------

var SAMPLES = buildSamples();

SAMPLES.forEach(function(sample) {
  test("independent sample " + sample.name + " parses and decodes", function() {
    var reader = new GifReader(u8(sample.bytes));
    assertEq(reader.width, sample.width, "width");
    assertEq(reader.height, sample.height, "height");
    assertEq(reader.numFrames(), sample.numFrames, "frame count");
    if (sample.loop !== undefined)
      assertEq(reader.loopCount(), sample.loop, "loop count");

    for (var f = 0; f < sample.numFrames; ++f) {
      var info = reader.frameInfo(f);
      if (sample.delays) assertEq(info.delay, sample.delays[f], "delay");

      var pxOut = new Uint8Array(sample.width * sample.height * 4);
      reader.decodeAndBlitFrameRGBA(f, pxOut);
      assertDeepEq(Array.prototype.slice.call(pxOut),
          flatten(sample.expectedRgba[f]),
          "frame " + f + " RGBA pixels");

      if (sample.expectedBgra) {
        var pxBgra = new Uint8Array(sample.width * sample.height * 4);
        reader.decodeAndBlitFrameBGRA(f, pxBgra);
        assertDeepEq(Array.prototype.slice.call(pxBgra),
            flatten(sample.expectedBgra[f]),
            "frame " + f + " BGRA pixels");
      }
    }
  });
});

test("GifReader accepts plain Array input as well as Uint8Array", function() {
  var reader = new GifReader(SAMPLES[0].bytes);  // plain Array.
  var pxOut = new Uint8Array(SAMPLES[0].width * SAMPLES[0].height * 4);
  reader.decodeAndBlitFrameRGBA(0, pxOut);
  assertDeepEq(Array.prototype.slice.call(pxOut),
      flatten(SAMPLES[0].expectedRgba[0]));
});

// ---------------------------------------------------------------------------
// 2. Legal omggif encoding round-trips through omggif decoding, and the
//    decoded pixels match the same hand-written expectations.
// ---------------------------------------------------------------------------

test("omggif round-trip: global palette, multi frame, loop, delay", function() {
  var buf = new Uint8Array(4096);
  var w = new GifWriter(buf, 3, 2, { loop: 0, palette: [BLACK, RED] });
  var end0 = w.addFrame(0, 0, 3, 2, [0, 1, 0, 1, 0, 1],
      { transparent: 1 });
  var end1 = w.addFrame(0, 0, 3, 2, [1, 0, 0, 0, 1, 1],
      { delay: 7, disposal: 1 });
  assert(end1 > end0, "position advances");
  var size = w.end();

  var reader = new GifReader(buf.subarray(0, size));
  assertEq(reader.numFrames(), 2);
  assertEq(reader.loopCount(), 0);
  assertEq(reader.frameInfo(0).transparent_index, 1);
  assertEq(reader.frameInfo(1).delay, 7);
  assertEq(reader.frameInfo(1).disposal, 1);

  var expected0 = [
    rgba(BLACK, 255), T,               rgba(BLACK, 255),
    T,                rgba(BLACK, 255), T
  ];
  var expected1 = [
    rgba(RED, 255),  rgba(BLACK, 255), rgba(BLACK, 255),
    rgba(BLACK, 255), rgba(RED, 255),  rgba(RED, 255)
  ];
  var px0 = new Uint8Array(3 * 2 * 4);
  reader.decodeAndBlitFrameRGBA(0, px0);
  assertDeepEq(Array.prototype.slice.call(px0), flatten(expected0));
  var px1 = new Uint8Array(3 * 2 * 4);
  reader.decodeAndBlitFrameRGBA(1, px1);
  assertDeepEq(Array.prototype.slice.call(px1), flatten(expected1));
});

test("omggif round-trip: local palette frame", function() {
  var buf = [ ];  // Plain array buffer, per the original interface.
  for (var i = 0; i < 4096; ++i) buf.push(0);
  var w = new GifWriter(buf, 2, 2);
  w.addFrame(0, 0, 2, 2, [0, 1, 1, 0], { palette: [RED, BLUE] });
  var size = w.end();

  var reader = new GifReader(buf.slice(0, size));
  assertEq(reader.frameInfo(0).has_local_palette, true);
  var pxOut = new Uint8Array(2 * 2 * 4);
  reader.decodeAndBlitFrameRGBA(0, pxOut);
  assertDeepEq(Array.prototype.slice.call(pxOut), flatten([
    rgba(RED, 255), rgba(BLUE, 255),
    rgba(BLUE, 255), rgba(RED, 255)
  ]));
});

test("omggif round-trip: subrect frame inside canvas", function() {
  var buf = new Uint8Array(4096);
  var w = new GifWriter(buf, 4, 4, { palette: [BLACK, WHITE] });
  w.addFrame(1, 2, 2, 1, [1, 1]);
  var size = w.end();

  var reader = new GifReader(buf.subarray(0, size));
  var info = reader.frameInfo(0);
  assertEq(info.x, 1); assertEq(info.y, 2);
  assertEq(info.width, 2); assertEq(info.height, 1);
  var pxOut = new Uint8Array(4 * 4 * 4);
  reader.decodeAndBlitFrameRGBA(0, pxOut);
  // Only cells (1,2) and (2,2) are white.
  for (var y = 0; y < 4; ++y) {
    for (var x = 0; x < 4; ++x) {
      var o = (y * 4 + x) * 4;
      if (y === 2 && (x === 1 || x === 2)) {
        assertDeepEq([pxOut[o], pxOut[o+1], pxOut[o+2], pxOut[o+3]],
            rgba(WHITE, 255));
      } else {
        assertDeepEq([pxOut[o], pxOut[o+1], pxOut[o+2], pxOut[o+3]],
            [0, 0, 0, 0]);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Byte-by-byte truncation: every prefix of every sample is rejected.
// ---------------------------------------------------------------------------

SAMPLES.forEach(function(sample) {
  test("truncation sweep on " + sample.name +
       " (every prefix 0..length-1 rejected)", function() {
    var full = u8(sample.bytes);
    var acceptedPrefixes = [];
    var wrongErrors = [];
    for (var len = 0; len < full.length; ++len) {
      try {
        new GifReader(full.subarray(0, len));
        acceptedPrefixes.push(len);
      } catch (e) {
        if (e.name !== "GifError" || e.offset === undefined)
          wrongErrors.push({ len: len, error: e });
      }
    }
    assert(acceptedPrefixes.length === 0,
        "these truncated lengths were wrongly accepted: " +
        acceptedPrefixes.join(", "));
    assert(wrongErrors.length === 0,
        "prefix errors were not GifError values: " +
        wrongErrors.map(function(x) {
          return x.len + "->" + x.error;
        }).join("; "));

    // The full sample itself must still parse (truncation did not flag it).
    var reader = new GifReader(full);
    assertEq(reader.numFrames(), sample.numFrames);
  });
});

test("truncation reports a recognizable stage and byte offset", function() {
  var full = u8(SAMPLES[0].bytes);
  // Header (6) + logical screen descriptor (7) end at offset 13; the global
  // color table occupies 13..24.  Cutting at 16 lands inside the palette.
  var err = assertGifError(function() {
    new GifReader(full.subarray(0, 16));
  }, "global-color-table");
  assert(err.offset === 13, "offset points at the table start, got " +
      err.offset);
  assert(/Truncated GIF/.test(err.message), "message explains truncation");
});

// ---------------------------------------------------------------------------
// 4. Corrupt LZW data is rejected with specific diagnostics.
// ---------------------------------------------------------------------------

// Take sample C (interlaced, 20 pixels) and rebuild its sole frame with
// tampered image data.  The trailer is re-appended so the constructor parses
// successfully and the corruption surfaces at decode time.
function sampleWithImageData(extraImageData) {
  var s = SAMPLES[2];
  var reader = new GifReader(u8(s.bytes));
  var info = reader.frameInfo(0);
  var bytes = s.bytes.slice(0, info.data_offset)
      .concat(extraImageData)
      .concat([0x3b]);
  return u8(bytes);
}

test("LZW: compressed data ending without EOI is rejected", function() {
  // min code size 2, one sub-block with a single clear code (3 bits), no EOI.
  var data = lzwBytes(2, function(emit) {
    emit(1 << 2, 3);  // clear code only, then stop.
  });
  assertGifError(function() {
    var r = new GifReader(sampleWithImageData(data));
    r.decodeAndBlitFrameRGBA(0, new Uint8Array(4 * 5 * 4));
  }, "lzw-data");
});

test("LZW: illegal dictionary reference is rejected", function() {
  // A code above the next available dictionary slot is illegal.  At width 3
  // every representable value is a valid early slot, so drive the decoder to
  // width 4 first (two inserts fill slots 6 and 7), then emit 15 -- well
  // above the next available slot (8) and representable in 4 bits.
  var data = lzwBytes(2, function(emit) {
    emit(4, 3);   // clear, width 3.
    emit(0, 3);   // literal 0 -> insert slot 6.
    emit(1, 3);   // literal 1 -> insert slot 7, decoder widens to width 4.
    emit(15, 4);  // illegal at width 4: slot 15 undefined (next is 8).
    emit(5, 4);   // eoi (never reached).
  });
  assertGifError(function() {
    var r = new GifReader(sampleWithImageData(data));
    r.decodeAndBlitFrameRGBA(0, new Uint8Array(4 * 5 * 4));
  }, "lzw-code");
});

test("LZW: stream producing too many pixels is rejected", function() {
  // 21 well-formed literal codes for a 20-pixel frame.  Widths follow the
  // decoder's exact growth schedule by tracking its next_code counter.
  var data = lzwBytes(2, function(emit) {
    var clear = 4, eoi = 5;
    var nextCode = eoi + 1;
    var width = 3;
    emit(clear, width);
    for (var i = 0; i < 21; ++i) {
      emit(i & 3, width);
      // Mirror the decoder: one insert per output after the first literal.
      if (i >= 1 && nextCode < 4096) {
        ++nextCode;
        if (nextCode >= (1 << width) && width < 12) ++width;
      }
    }
    emit(eoi, width);
  });
  assertGifError(function() {
    var r = new GifReader(sampleWithImageData(data));
    r.decodeAndBlitFrameRGBA(0, new Uint8Array(4 * 5 * 4));
  }, "lzw-output");
});

test("LZW: stream producing too few pixels is rejected", function() {
  // A structurally complete, width-correct stream ending with a real EOI
  // after only 5 pixels: no truncation, just an underflow.
  var data = lzwBytes(2, function(emit) {
    var clear = 4, eoi = 5;
    var nextCode = eoi + 1;
    var width = 3;
    emit(clear, width);
    for (var i = 0; i < 5; ++i) {
      emit(i & 3, width);
      if (i >= 1 && nextCode < 4096) {
        ++nextCode;
        if (nextCode >= (1 << width) && width < 12) ++width;
      }
    }
    emit(eoi, width);  // well-formed EOI, but only 5 of 20 pixels produced.
  });
  assertGifError(function() {
    var r = new GifReader(sampleWithImageData(data));
    r.decodeAndBlitFrameRGBA(0, new Uint8Array(4 * 5 * 4));
  }, "lzw-output");
});

test("LZW: sub-block extending past the file is rejected at parse time",
    function() {
  // min code size 2; sub-block claims 255 bytes but the file ends.  The
  // constructor rejects it before decoding ever starts.
  var data = [2, 4, 0xff];
  assertGifError(function() {
    new GifReader(sampleWithImageData(data));
  }, "image-data");
});

test("LZW: structurally valid blocks but compressed data ending early",
    function() {
  // The sub-block chain itself is well formed, but its bytes hold only a
  // clear code with no EOI before the terminator.
  var data = lzwBytes(2, function(emit) {
    emit(1 << 2, 3);  // clear code only, then stop.
  });
  assertGifError(function() {
    var r = new GifReader(sampleWithImageData(data));
    r.decodeAndBlitFrameRGBA(0, new Uint8Array(4 * 5 * 4));
  }, "lzw-data");
});

test("LZW: missing minimum code size byte is rejected", function() {
  // Image descriptor ends directly at the trailer (no image data at all).
  var s = SAMPLES[2];
  var reader = new GifReader(u8(s.bytes));
  var info = reader.frameInfo(0);
  var bytes = u8(s.bytes.slice(0, info.data_offset).concat([0x3b]));
  assertGifError(function() {
    new GifReader(bytes);
  }, "image-data");
});

test("LZW: invalid minimum code size is rejected", function() {
  // min code size 1 (illegal in GIF, must be 2..8), then a well-formed empty
  // sub-block chain so the constructor succeeds and decoding rejects it.
  var data = [1, 0];
  assertGifError(function() {
    var r = new GifReader(sampleWithImageData(data));
    r.decodeAndBlitFrameRGBA(0, new Uint8Array(4 * 5 * 4));
  }, "lzw-min-code-size");
});

// ---------------------------------------------------------------------------
// 5. Structural decoder validation.
// ---------------------------------------------------------------------------

test("decoder rejects frame rectangle outside the logical canvas",
    function() {
  var bad = rawGif({
    width: 2, height: 2,
    globalPalette: [BLACK, WHITE],
    frames: [{
      x: 1, y: 1, w: 2, h: 2,  // extends to (3,3) on a 2x2 canvas.
      indices: [0, 0, 0, 0],
      paletteBits: 1,
      transparentIndex: null,
      interlaced: false,
      delay: 0,
      disposal: 0
    }]
  });
  assertGifError(function() { new GifReader(u8(bad)); }, "frame-rect");
});

test("decoder rejects transparent index outside the color table",
    function() {
  var bad = rawGif({
    width: 1, height: 1,
    globalPalette: [BLACK, WHITE],
    frames: [{
      x: 0, y: 0, w: 1, h: 1,
      indices: [0],
      paletteBits: 1,
      transparentIndex: 2,  // table only has entries 0 and 1.
      interlaced: false,
      delay: 0,
      disposal: 0
    }]
  });
  assertGifError(function() { new GifReader(u8(bad)); }, "image-descriptor");
});

test("decoder rejects image with no color table at all", function() {
  // Hand-build: header + 1x1 screen descriptor (no GCT flag) + image
  // descriptor with no local table flag + dummy image data + trailer.
  var bad = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    1, 0, 1, 0, 0x00, 0, 0,
    0x2c,
    0, 0, 0, 0, 1, 0, 1, 0, 0x00,
    2, 1, 0x00, 0,
    0x3b
  ];
  assertGifError(function() { new GifReader(u8(bad)); }, "image-descriptor");
});

test("decoder rejects unknown block label", function() {
  var bad = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    1, 0, 1, 0, 0x80, 0, 0,
    // 2-entry global color table = 6 RGB bytes (offsets 13..18).
    0, 0, 0,  0xff, 0xff, 0xff,
    0x21, 0x77,  // extension with an unknown label.
    0,          // empty sub-block chain (terminator).
    0x3b        // trailer, so parsing reaches and rejects the label.
  ];
  assertGifError(function() { new GifReader(u8(bad)); }, "block");
});

test("decoder rejects missing trailer", function() {
  var full = SAMPLES[0].bytes;
  var noTrailer = full.slice(0, full.length - 1);
  assertGifError(function() { new GifReader(u8(noTrailer)); }, "trailer");
});

test("short blit output buffer errors and keeps existing contents",
    function() {
  var reader = new GifReader(u8(SAMPLES[0].bytes));
  // Frame covers (1,1)-(2,2) of a 4x3 canvas: needs 40 values; give 39.
  var pixels = new Uint8Array(39);
  for (var i = 0; i < pixels.length; ++i) pixels[i] = 0xCD;
  var err = assertGifError(function() {
    reader.decodeAndBlitFrameRGBA(0, pixels);
  }, "output-buffer");
  assert(err.offset === null, "argument-style error has null offset");
  for (var j = 0; j < pixels.length; ++j)
    assertEq(pixels[j], 0xCD, "byte " + j + " preserved after failure");
});

// ---------------------------------------------------------------------------
// 6. Writer validation, capacity contract and failure atomicity.
// ---------------------------------------------------------------------------

test("writer validates integer dimensions/coordinates/delay/indices",
    function() {
  var mk = function() { return new GifWriter(new Uint8Array(4096), 2, 2,
      { palette: [BLACK, WHITE] }); };

  assertGifError(function() {
    new GifWriter(new Uint8Array(10), 2.5, 2);
  }, "writer-arguments");
  assertGifError(function() {
    new GifWriter(new Uint8Array(10), 0, 2);
  }, "writer-arguments");
  assertGifError(function() {
    new GifWriter(new Uint8Array(10), 2, 70000);
  }, "writer-arguments");

  var w = mk();
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 2, 1.5]);
  }, "writer-arguments");
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 2, 2]);  // index 2 out of 2-entry table.
  }, "writer-arguments");
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 2, -1]);
  }, "writer-arguments");
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 2], { delay: -1 });
  }, "writer-arguments");
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 2], { delay: 70000 });
  }, "writer-arguments");
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 2], { disposal: 4 });
  }, "writer-arguments");
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 2], { transparent: 2 });
  }, "writer-arguments");
  assertGifError(function() {
    w.addFrame(1, 1, 2, 2, [0, 1, 2, 3]);  // rect outside canvas.
  }, "writer-arguments");
});

test("writer rejects non-integer palette colors and bad palette sizes",
    function() {
  assertGifError(function() {
    new GifWriter(new Uint8Array(10), 1, 1, { palette: [BLACK, 0x1000000] });
  }, "writer-arguments");
  assertGifError(function() {
    new GifWriter(new Uint8Array(10), 1, 1, { palette: [BLACK] });  // 1 entry.
  }, "writer-arguments");
  assertGifError(function() {
    new GifWriter(new Uint8Array(10), 1, 1,
        { palette: [BLACK, WHITE, RED] });  // not power of two.
  }, "writer-arguments");
});

function encodedSize(width, height, palette, indices, frameOpts) {
  var big = new Uint8Array(1 << 20);
  var w = new GifWriter(big, width, height,
      frameOpts && frameOpts.localPalette ? null : { palette: palette });
  if (frameOpts && frameOpts.localPalette) {
    w.addFrame(0, 0, width, height, indices,
        Object.assign({ palette: palette }, frameOpts));
  } else {
    w.addFrame(0, 0, width, height, indices, frameOpts);
  }
  return w.end();
}

test("writer: buffer exactly the right size succeeds (plain + typed)",
    function() {
  var indices = [0, 1, 1, 0];
  var size = encodedSize(2, 2, [RED, BLUE], indices);

  var exactTyped = new Uint8Array(size);
  var w1 = new GifWriter(exactTyped, 2, 2, { palette: [RED, BLUE] });
  w1.addFrame(0, 0, 2, 2, indices);
  assertEq(w1.end(), size);

  var exactPlain = [ ];
  while (exactPlain.length < size) exactPlain.push(0);
  var w2 = new GifWriter(exactPlain, 2, 2, { palette: [RED, BLUE] });
  w2.addFrame(0, 0, 2, 2, indices);
  assertEq(w2.end(), size);

  // And the exact-size output still decodes.
  var reader = new GifReader(exactTyped);
  var pxOut = new Uint8Array(16);
  reader.decodeAndBlitFrameRGBA(0, pxOut);
});

test("writer: buffer one byte too small throws GifError at writer-buffer",
    function() {
  var indices = [0, 1, 1, 0];
  var size = encodedSize(2, 2, [RED, BLUE], indices);

  var smallTyped = new Uint8Array(size - 1);
  assertGifError(function() {
    var w = new GifWriter(smallTyped, 2, 2, { palette: [RED, BLUE] });
    w.addFrame(0, 0, 2, 2, indices);
    w.end();
  }, "writer-buffer");

  var smallPlain = [ ];
  while (smallPlain.length < size - 1) smallPlain.push(0);
  assertGifError(function() {
    var w = new GifWriter(smallPlain, 2, 2, { palette: [RED, BLUE] });
    w.addFrame(0, 0, 2, 2, indices);
    w.end();
  }, "writer-buffer");
});

test("writer: zero-length buffer fails cleanly", function() {
  assertGifError(function() {
    new GifWriter(new Uint8Array(0), 1, 1, { palette: [BLACK, WHITE] });
  }, "writer-buffer");
});

test("failed addFrame changes nothing and the encoder keeps working",
    function() {
  var size = encodedSize(2, 2, [BLACK, WHITE], [0, 1, 1, 0]);
  var buf = new Uint8Array(size);
  var w = new GifWriter(buf, 2, 2, { palette: [BLACK, WHITE] });
  var posBefore = w.getOutputBufferPosition();
  w.addFrame(0, 0, 2, 2, [0, 1, 1, 0]);
  var posAfterFirst = w.getOutputBufferPosition();
  assert(posAfterFirst > posBefore);
  var snapshot = buf.slice(0, posAfterFirst);

  // A capacity failure on the second frame must not move the position or
  // alter existing bytes.
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 1, 0]);  // no room left.
  }, "writer-buffer");
  assertEq(w.getOutputBufferPosition(), posAfterFirst,
      "position restored after failure");
  assertDeepEq(Array.prototype.slice.call(buf.slice(0, posAfterFirst)),
      Array.prototype.slice.call(snapshot),
      "existing bytes unchanged after failure");

  // Argument failures roll back identically.
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 1, 9]);
  }, "writer-arguments");
  assertEq(w.getOutputBufferPosition(), posAfterFirst);

  // Swap in a bigger buffer and finish: the encoder instance is reused.
  var bigger = new Uint8Array(size * 2);
  bigger.set(buf);
  w.setOutputBuffer(bigger);
  w.addFrame(0, 0, 2, 2, [1, 0, 0, 1]);
  var finalSize = w.end();

  var reader = new GifReader(bigger.subarray(0, finalSize));
  assertEq(reader.numFrames(), 2);
  var rgba0 = new Uint8Array(16);
  var rgba1 = new Uint8Array(16);
  reader.decodeAndBlitFrameRGBA(0, rgba0);
  reader.decodeAndBlitFrameRGBA(1, rgba1);
});

test("after end(), a failing frame preserves the trailer and state",
    function() {
  var size = encodedSize(2, 2, [BLACK, WHITE], [0, 1, 1, 0]);
  var buf = new Uint8Array(size);
  var w = new GifWriter(buf, 2, 2, { palette: [BLACK, WHITE] });
  w.addFrame(0, 0, 2, 2, [0, 1, 1, 0]);
  assertEq(w.end(), size);
  assertEq(buf[size - 1], 0x3b, "trailer present");

  // Failing because the buffer has no room: trailer must survive.
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [0, 1, 1, 0]);
  }, "writer-buffer");
  assertEq(w.getOutputBufferPosition(), size, "position stays at trailer");
  assertEq(buf[size - 1], 0x3b, "trailer not eaten by failed frame");
  assertEq(w.end(), size, "re-ending is a no-op");

  // A bad-argument failure after end() also keeps the trailer.
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, [9, 9, 9, 9]);
  }, "writer-arguments");
  assertEq(buf[size - 1], 0x3b);

  // Bigger buffer: un-end, add a legal frame, end again.
  var bigger = new Uint8Array(size * 2);
  bigger.set(buf);
  w.setOutputBuffer(bigger);
  w.addFrame(0, 0, 2, 2, [1, 0, 0, 1]);
  var finalSize = w.end();
  assertEq(bigger[finalSize - 1], 0x3b, "new trailer present");
  var reader = new GifReader(bigger.subarray(0, finalSize));
  assertEq(reader.numFrames(), 2);
});

test("end() reports writer-buffer when the trailer does not fit",
    function() {
  // Find the exact size, then use a buffer that fits the frame but not 0x3b.
  var indices = [0, 1, 1, 0];
  var size = encodedSize(2, 2, [BLACK, WHITE], indices);
  var buf = new Uint8Array(size - 1);
  var w = new GifWriter(buf, 2, 2, { palette: [BLACK, WHITE] });
  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, indices);
    w.end();
  }, "writer-buffer");
});

test("a failed frame preserves every pre-existing byte (canary)",
    function() {
  var indices = [0, 1, 1, 0];
  var size = encodedSize(2, 2, [BLACK, WHITE], indices);
  var buf = new Uint8Array(size);  // Exact fit for one frame + trailer.
  var w = new GifWriter(buf, 2, 2, { palette: [BLACK, WHITE] });
  w.addFrame(0, 0, 2, 2, indices);
  w.end();
  var before = buf.slice(0);

  assertGifError(function() {
    w.addFrame(0, 0, 2, 2, indices);  // no capacity left.
  }, "writer-buffer");

  for (var i = 0; i < size; ++i)
    assertEq(buf[i], before[i], "byte " + i + " unchanged after failure");
  assertEq(w.getOutputBufferPosition(), size);
  assertEq(buf[size - 1], 0x3b, "trailer byte preserved");
});

// ---------------------------------------------------------------------------
// 6b. Stress: many dictionary clears, 12-bit codes and 255-byte sub-blocks.
// ---------------------------------------------------------------------------

test("large noisy frame round-trips across repeated LZW table clears",
    function() {
  // 8-color palette and 20k varied pixels force the 4096-entry table to fill
  // and clear repeatedly, exercising every code width up to 12 bits plus the
  // 255-byte sub-block boundaries.
  var W = 200, H = 100;
  var palette = [BLACK, WHITE, RED, GREEN, BLUE, GRAY, 0xffff00, 0xff00ff];
  var indices = new Array(W * H);
  var seed = 1234567;
  for (var i = 0; i < indices.length; ++i) {
    // Deterministic pseudo-noise (LCG), no third-party RNG.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    indices[i] = seed & 7;
  }

  var buf = new Uint8Array(1 << 18);
  var w = new GifWriter(buf, W, H, { palette: palette });
  w.addFrame(0, 0, W, H, indices);
  var size = w.end();
  assert(size < buf.length, "output fits");

  var reader = new GifReader(buf.subarray(0, size));
  assertEq(reader.numFrames(), 1);
  var pxOut = new Uint8Array(W * H * 4);
  reader.decodeAndBlitFrameRGBA(0, pxOut);

  // Independently verify a sampled set of pixels against the source indices.
  for (var s = 0; s < 500; ++s) {
    var idx = (s * 7919) % indices.length;
    var x = idx % W, y = (idx / W) | 0;
    var o = (y * W + x) * 4;
    assertDeepEq([pxOut[o], pxOut[o+1], pxOut[o+2], pxOut[o+3]],
        rgba(palette[indices[idx]], 255));
  }
});

test("writer position getters/setters and buffer swap still work",
    function() {
  var buf = new Uint8Array(64);
  var w = new GifWriter(buf, 1, 1, { palette: [BLACK, WHITE] });
  var pos = w.getOutputBufferPosition();
  assert(pos > 0 && typeof pos === "number");
  w.setOutputBufferPosition(pos);
  assertEq(w.getOutputBufferPosition(), pos);
  assert(w.getOutputBuffer() === buf);
  var buf2 = new Uint8Array(128);
  w.setOutputBuffer(buf2);
  assert(w.getOutputBuffer() === buf2);
});

// ---------------------------------------------------------------------------
// 7. Export contract stays intact.
// ---------------------------------------------------------------------------

test("module exports keep the original names and Error identity", function() {
  assert(typeof GifReader === "function");
  assert(typeof GifWriter === "function");
  var err = new GifError("x", "block", 0);
  assert(err instanceof Error, "GifError is an instanceof Error");
  assertEq(err.name, "GifError");
  assert(/GifError/.test(err.toString()));
});

// ---------------------------------------------------------------------------
// Independent GIF builder + independent LZW encoder (test-only code).
// ---------------------------------------------------------------------------

function flatten(cells) {
  var out = [];
  for (var i = 0; i < cells.length; ++i) {
    var c = cells[i];
    out.push(c[0], c[1], c[2], c[3]);
  }
  return out;
}

// GIF 89a interlace output row order for |height| rows.
function interlaceOrder(height) {
  var rows = [];
  var starts = [0, 4, 2, 1];
  var steps = [8, 8, 4, 2];
  for (var pass = 0; pass < 4; ++pass) {
    for (var r = starts[pass]; r < height; r += steps[pass])
      rows.push(r);
  }
  return rows;
}

// Independent LZW encoder: returns [min_code_size, sub-block bytes..., 0].
// |codeFn| emits LZW codes with the explicit bit width that was in effect at
// the time; this helper is deliberately low level for the corruption tests.
function lzwBytes(minCodeSize, codeFn) {
  var packed = [];
  var acc = 0, shift = 0;

  codeFn(function(code, bits) {
    acc |= code << shift;
    shift += bits;
    while (shift >= 8) {
      packed.push(acc & 0xff);
      acc >>= 8;
      shift -= 8;
    }
  });

  if (shift > 0) packed.push(acc & 0xff);

  var out = [minCodeSize];
  for (var i = 0; i < packed.length; i += 255) {
    var chunk = packed.slice(i, i + 255);
    out.push(chunk.length);
    out = out.concat(chunk);
  }
  out.push(0);
  return out;
}

// Full-featured raw GIF builder used for both valid samples and structural
// corruption tests.
function rawGif(opts) {
  var b = [];
  function w1(v) { b.push(v & 0xff); }
  function w2(v) { b.push(v & 0xff, (v >> 8) & 0xff); }

  // Header + logical screen descriptor.
  b.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  w2(opts.width);
  w2(opts.height);
  if (opts.globalPalette) {
    var n = opts.globalPalette.length;
    var pow2 = 0;
    while ((1 << (pow2 + 1)) < n) ++pow2;
    b.push(0x80 | pow2, 0, 0);
    opts.globalPalette.forEach(function(rgb) {
      w1((rgb >> 16) & 0xff);
      w1((rgb >> 8) & 0xff);
      w1(rgb & 0xff);
    });
  } else {
    b.push(0x00, 0, 0);
  }

  if (opts.loop !== undefined && opts.loop !== null) {
    b.push(0x21, 0xff, 0x0b);
    b.push(0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45,
           0x32, 0x2e, 0x30);
    b.push(0x03, 0x01);
    w2(opts.loop);
    w1(0);
  }

  opts.frames.forEach(function(frame) {
    var palette = frame.localPalette || opts.globalPalette;
    var numColors = palette.length;
    var paletteBits = frame.paletteBits;
    if (paletteBits === undefined) {
      paletteBits = 0;
      while ((1 << (paletteBits + 1)) < numColors) ++paletteBits;
    }
    var minCodeSize = Math.max(2, paletteBits + 1);

    var useTrans = frame.transparentIndex !== null &&
                   frame.transparentIndex !== undefined;
    if (useTrans || frame.delay || frame.disposal) {
      b.push(0x21, 0xf9, 0x04);
      b.push((frame.disposal || 0) << 2 | (useTrans ? 1 : 0));
      w2(frame.delay || 0);
      w1(useTrans ? frame.transparentIndex : 0);
      w1(0);
    }

    b.push(0x2c);
    w2(frame.x); w2(frame.y); w2(frame.w); w2(frame.h);
    var packed = frame.interlaced ? 0x40 : 0x00;
    if (frame.localPalette) packed |= 0x80 | paletteBits;
    b.push(packed);

    if (frame.localPalette) {
      frame.localPalette.forEach(function(rgb) {
        w1((rgb >> 16) & 0xff);
        w1((rgb >> 8) & 0xff);
        w1(rgb & 0xff);
      });
    }

    if (frame.rawImageData) {
      frame.rawImageData.forEach(w1);
    } else {
      b.push.apply(b, independentLzw(minCodeSize, frame.indices));
    }
  });

  b.push(0x3b);
  return b;
}

// Straightforward textbook LZW encoder (distinct from omggif's table-based
// compressor): builds an actual dictionary of sequences, emits clear/eoi and
// grows code size per the standard timing, then packs into sub-blocks.  The
// bit width in force for each emitted code is recorded alongside it.
function independentLzw(minCodeSize, indices) {
  var clear = 1 << minCodeSize;
  var eoi = clear + 1;
  var dictSize, codeSize, dict;

  function resetDict() {
    dict = Object.create(null);
    dictSize = eoi + 1;
    codeSize = minCodeSize + 1;
    for (var i = 0; i < clear; ++i) dict[String(i)] = i;
  }

  resetDict();
  var emitted = [];  // Pairs of [code, bit width the decoder will read it at].
  emitted.push([clear, codeSize]);

  // Simulate the decoder's exact bookkeeping to know the width at which each
  // emitted output code will be read.  The decoder inserts one dictionary
  // entry per output code (after a clear, while below slot 4096) and widens
  // once its next-code counter reaches 2^codeSize.
  var decNext = eoi + 1;
  var decSize = codeSize;
  var decPrev = null;

  function noteOutput(code) {
    emitted.push([code, decSize]);
    if (code === clear) {
      decNext = eoi + 1;
      decSize = minCodeSize + 1;
      decPrev = null;
      return;
    }
    if (code === eoi) return;
    if (decPrev !== null && decNext < 4096) {
      ++decNext;
      if (decNext >= (1 << decSize) && decSize < 12) ++decSize;
    }
    decPrev = code;
  }

  var w = String(indices[0]);
  for (var i = 1; i < indices.length; ++i) {
    var k = String(indices[i]);
    var wk = w + "," + k;
    if (dict[wk] !== undefined) {
      w = wk;
    } else {
      noteOutput(dict[w]);
      if (dictSize < 4096) {
        dict[wk] = dictSize;
        ++dictSize;
        if (dictSize === (1 << codeSize) && codeSize < 12) ++codeSize;
      } else {
        noteOutput(clear);
        resetDict();
      }
      w = k;
    }
  }
  noteOutput(dict[w]);
  noteOutput(eoi);

  var packed = [];
  var acc = 0, shift = 0;
  for (var c = 0; c < emitted.length; ++c) {
    acc |= emitted[c][0] << shift;
    shift += emitted[c][1];
    while (shift >= 8) {
      packed.push(acc & 0xff);
      acc >>= 8; shift -= 8;
    }
  }
  if (shift > 0) packed.push(acc & 0xff);

  var out = [minCodeSize];
  for (var j = 0; j < packed.length; j += 255) {
    var chunk = packed.slice(j, j + 255);
    out.push(chunk.length);
    out = out.concat(chunk);
  }
  out.push(0);
  return out;
}

// ---------------------------------------------------------------------------
// Result reporting.
// ---------------------------------------------------------------------------

console.log("");
console.log("omggif regression: " + passed + " passed, " + failed + " failed");
if (failed > 0) {
  console.log("");
  console.log("Failed samples/tests:");
  failures.forEach(function(f) {
    console.log("  - " + f.name + ": " +
        (f.error && f.error.stage ?
            "[" + f.error.stage + " @ " + f.error.offset + "] " : "") +
        (f.error && f.error.message ? f.error.message : f.error));
  });
  process.exit(1);
}
