// (c) Dean McNamee <dean@gmail.com>, 2013.
//
// https://github.com/deanm/omggif
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
//
// omggif is a JavaScript implementation of a GIF 89a encoder and decoder,
// including animation and compression.  It does not rely on any specific
// underlying system, so should run in the browser, Node, or Plask.

"use strict";

// All validation failures throw a GifError, which is still a plain |Error|
// (instanceof Error stays true).  Every error carries:
//   .name    -- always "GifError".
//   .stage   -- short string naming the parse/encode stage that failed.
//   .offset  -- byte offset inside the input/output buffer where the problem
//               was detected (null when it is a pure argument validation
//               failure with no buffer position).
// Stages used by the reader:
//   header, logical-screen, global-color-table, block,
//   application-extension, graphics-control-extension, comment-extension,
//   image-descriptor, local-color-table, image-data, lzw-min-code-size,
//   lzw-subblock, lzw-data, lzw-code, lzw-output, trailer, frame-rect,
//   palette-index, output-buffer.
// Stages used by the writer:
//   writer-arguments (bad dimensions/coordinates/delay/indices, no offset),
//   writer-buffer (fixed output buffer ran out of space, .offset is the
//                  position that could not be written).
function GifError(message, stage, offset) {
  this.name = "GifError";
  this.message = message;
  this.stage = stage;
  this.offset = (typeof offset === "number") ? offset : null;
}
GifError.prototype = Object.create(Error.prototype);
GifError.prototype.constructor = GifError;
GifError.prototype.toString = function() {
  return "GifError [" + this.stage + " @ " + this.offset + "]: " +
      this.message;
};

function isInteger(v) {
  return typeof v === "number" && isFinite(v) && Math.floor(v) === v;
}

function GifWriter(buf, width, height, gopts) {
  var p = 0;

  var gopts = gopts === undefined ? { } : gopts;
  var loop_count = gopts.loop === undefined ? null : gopts.loop;
  var global_palette = gopts.palette === undefined ? null : gopts.palette;

  if (!isInteger(width) || !isInteger(height) ||
      width <= 0 || height <= 0 || width > 65535 || height > 65535)
    throw new GifError("Width/Height invalid.", "writer-arguments", null);

  function check_palette_and_num_colors(palette) {
    var num_colors = palette.length;
    if (num_colors < 2 || num_colors > 256 ||  num_colors & (num_colors-1)) {
      throw new GifError(
          "Invalid code/color length, must be power of 2 and 2 .. 256.",
          "writer-arguments", null);
    }
    // Every entry is a 24-bit RGB integer.
    for (var i = 0; i < num_colors; ++i) {
      var rgb = palette[i];
      if (!isInteger(rgb) || rgb < 0 || rgb > 0xffffff)
        throw new GifError("Palette entry " + i + " is not a 24-bit RGB integer.",
            "writer-arguments", null);
    }
    return num_colors;
  }

  // Bounds-checked single byte write.  Throws a recognizable error instead of
  // silently dropping bytes (plain Arrays would otherwise grow, typed arrays
  // would silently wrap).
  function put(v) {
    if (p >= buf.length) {
      throw new GifError(
          "Output buffer too small, cannot write byte at offset " + p + ".",
          "writer-buffer", p);
    }
    buf[p++] = v & 0xff;
  }

  // Handling of Global Color Table (palette) and background index.  All
  // validation happens before any byte is emitted.
  var gp_num_colors_pow2 = 0;
  var background = 0;
  if (global_palette !== null) {
    var gp_num_colors = check_palette_and_num_colors(global_palette);
    while (gp_num_colors >>= 1) ++gp_num_colors_pow2;
    gp_num_colors = 1 << gp_num_colors_pow2;
    --gp_num_colors_pow2;
    if (gopts.background !== undefined) {
      background = gopts.background;
      if (!isInteger(background) || background >= gp_num_colors)
        throw new GifError("Background index out of range.",
            "writer-arguments", null);
      // The GIF spec states that a background index of 0 should be ignored, so
      // this is probably a mistake and you really want to set it to another
      // slot in the palette.  But actually in the end most browsers, etc end
      // up ignoring this almost completely (including for dispose background).
      if (background === 0)
        throw new GifError("Background index explicitly passed as 0.",
            "writer-arguments", null);
    }
  }

  if (loop_count !== null &&
      (!isInteger(loop_count) || loop_count < 0 || loop_count > 65535))
    throw new GifError("Loop count invalid.", "writer-arguments", null);

  // - Header.
  put(0x47); put(0x49); put(0x46);  // GIF
  put(0x38); put(0x39); put(0x61);  // 89a

  // - Logical Screen Descriptor.
  // NOTE(deanm): w/h apparently ignored by implementations, but set anyway.
  put(width & 0xff); put(width >> 8 & 0xff);
  put(height & 0xff); put(height >> 8 & 0xff);
  // NOTE: Indicates 0-bpp original color resolution (unused?).
  put((global_palette !== null ? 0x80 : 0) |  // Global Color Table Flag.
      gp_num_colors_pow2);  // NOTE: No sort flag (unused?).
  put(background);  // Background Color Index.
  put(0);  // Pixel aspect ratio (unused?).

  // - Global Color Table
  if (global_palette !== null) {
    for (var i = 0, il = global_palette.length; i < il; ++i) {
      var rgb = global_palette[i];
      put(rgb >> 16 & 0xff);
      put(rgb >> 8 & 0xff);
      put(rgb & 0xff);
    }
  }

  if (loop_count !== null) {  // Netscape block for looping.
    // Extension code, label, and length.
    put(0x21); put(0xff); put(0x0b);
    // NETSCAPE2.0
    put(0x4e); put(0x45); put(0x54); put(0x53);
    put(0x43); put(0x41); put(0x50); put(0x45);
    put(0x32); put(0x2e); put(0x30);
    // Sub-block
    put(0x03); put(0x01);
    put(loop_count & 0xff); put(loop_count >> 8 & 0xff);
    put(0x00);  // Terminator.
  }


  var ended = false;

  this.addFrame = function(x, y, w, h, indexed_pixels, opts) {
    opts = opts === undefined ? { } : opts;

    // Remember all observable state so a failed addFrame rolls everything
    // back: output position, already written bytes and the ended flag.
    var frame_start = p;
    var was_ended = ended;

    // ---- Validation only below this line; no buffer state may change. ----

    // TODO(deanm): Bounds check x, y.  Do they need to be within the virtual
    // canvas width/height, I imagine?
    if (!isInteger(x) || !isInteger(y) || x < 0 || y < 0 ||
        x > 65535 || y > 65535)
      throw new GifError("x/y invalid.", "writer-arguments", null);

    if (!isInteger(w) || !isInteger(h) ||
        w <= 0 || h <= 0 || w > 65535 || h > 65535)
      throw new GifError("Width/Height invalid.", "writer-arguments", null);

    // The decoder rejects frames outside the logical canvas, so do not emit
    // any.
    if (x + w > width || y + h > height)
      throw new GifError(
          "Frame rectangle (" + x + "," + y + " " + w + "x" + h +
          ") extends past the logical canvas (" + width + "x" + height + ").",
          "writer-arguments", null);

    if (indexed_pixels === null || indexed_pixels === undefined ||
        indexed_pixels.length < w * h)
      throw new GifError("Not enough pixels for the frame size.",
          "writer-arguments", null);

    var using_local_palette = true;
    var palette = opts.palette;
    if (palette === undefined || palette === null) {
      using_local_palette = false;
      palette = global_palette;
    }

    if (palette === undefined || palette === null)
      throw new GifError("Must supply either a local or global palette.",
          "writer-arguments", null);

    var num_colors = check_palette_and_num_colors(palette);

    // Compute the min_code_size (power of 2), destroying num_colors.
    var min_code_size = 0;
    while (num_colors >>= 1) ++min_code_size;
    num_colors = 1 << min_code_size;  // Now we can easily get it back.

    var delay = opts.delay === undefined ? 0 : opts.delay;
    if (!isInteger(delay) || delay < 0 || delay > 65535)
      throw new GifError("Delay must be an integer in 0 .. 65535.",
          "writer-arguments", null);

    // From the spec:
    //     0 -   No disposal specified. The decoder is
    //           not required to take any action.
    //     1 -   Do not dispose. The graphic is to be left
    //           in place.
    //     2 -   Restore to background color. The area used by the
    //           graphic must be restored to the background color.
    //     3 -   Restore to previous. The decoder is required to
    //           restore the area overwritten by the graphic with
    //           what was there prior to rendering the graphic.
    //  4-7 -    To be defined.
    // NOTE(deanm): Dispose background doesn't really work, apparently most
    // browsers ignore the background palette index and clear to transparency.
    var disposal = opts.disposal === undefined ? 0 : opts.disposal;
    if (!isInteger(disposal) || disposal < 0 || disposal > 3)  // 4-7 reserved.
      throw new GifError("Disposal out of range.", "writer-arguments", null);

    var use_transparency = false;
    var transparent_index = 0;
    if (opts.transparent !== undefined && opts.transparent !== null) {
      use_transparency = true;
      transparent_index = opts.transparent;
      if (!isInteger(transparent_index) ||
          transparent_index < 0 || transparent_index >= num_colors)
        throw new GifError("Transparent color index.",
            "writer-arguments", null);
    }

    // Every palette index written into the LZW stream must resolve in the
    // frame's color table.  Check the whole input array (the compressor
    // consumes all of its entries), before anything is written.
    for (var pi = 0, pl = indexed_pixels.length; pi < pl; ++pi) {
      var pv = indexed_pixels[pi];
      if (!isInteger(pv) || pv < 0 || pv >= num_colors)
        throw new GifError(
            "Indexed pixel " + pi + " is not a valid palette index " +
            "(0 .. " + (num_colors - 1) + ").",
            "writer-arguments", null);
    }

    // ---- Commit; any failure rolls back to the captured state. ----

    try {
      if (was_ended === true) { --p; ended = false; }  // Un-end.

      if (disposal !== 0 || use_transparency || delay !== 0) {
        // - Graphics Control Extension
        put(0x21); put(0xf9);  // Extension / Label.
        put(4);  // Byte size.

        put(disposal << 2 | (use_transparency === true ? 1 : 0));
        put(delay & 0xff); put(delay >> 8 & 0xff);
        put(transparent_index);  // Transparent color index.
        put(0);  // Block Terminator.
      }

      // - Image Descriptor
      put(0x2c);  // Image Seperator.
      put(x & 0xff); put(x >> 8 & 0xff);  // Left.
      put(y & 0xff); put(y >> 8 & 0xff);  // Top.
      put(w & 0xff); put(w >> 8 & 0xff);
      put(h & 0xff); put(h >> 8 & 0xff);
      // NOTE: No sort flag (unused?).
      // TODO(deanm): Support interlace.
      put(using_local_palette === true ? (0x80 | (min_code_size-1)) : 0);

      // - Local Color Table
      if (using_local_palette === true) {
        for (var i = 0, il = palette.length; i < il; ++i) {
          var rgb = palette[i];
          put(rgb >> 16 & 0xff);
          put(rgb >> 8 & 0xff);
          put(rgb & 0xff);
        }
      }

      p = GifWriterOutputLZWCodeStream(
              buf, p, buf.length,
              min_code_size < 2 ? 2 : min_code_size, indexed_pixels);
    } catch (e) {
      // Roll back output position and ended state.  Nothing past frame_start
      // was observable as part of the output before this call, and an ended
      // stream keeps its trailer byte.
      p = frame_start;
      ended = was_ended;
      if (was_ended === true) buf[p - 1] = 0x3b;
      throw e;
    }

    return p;
  };

  this.end = function() {
    if (ended === false) {
      if (p >= buf.length) {
        throw new GifError(
            "Output buffer too small, cannot write trailer at offset " + p + ".",
            "writer-buffer", p);
      }
      buf[p++] = 0x3b;  // Trailer.
      ended = true;
    }
    return p;
  };

  this.getOutputBuffer = function() { return buf; };
  this.setOutputBuffer = function(v) { buf = v; };
  this.getOutputBufferPosition = function() { return p; };
  this.setOutputBufferPosition = function(v) { p = v; };
}

// Main compression routine, palette indexes -> LZW code stream.
// |index_stream| must have at least one entry.
function GifWriterOutputLZWCodeStream(
    buf, p, buf_limit, min_code_size, index_stream) {
  function put(v) {
    if (p >= buf_limit) {
      throw new GifError(
          "Output buffer too small, cannot write LZW byte at offset " + p + ".",
          "writer-buffer", p);
    }
    buf[p++] = v & 0xff;
  }

  put(min_code_size);
  if (p >= buf_limit) {
    throw new GifError(
        "Output buffer too small, cannot reserve sub-block length at offset " +
        p + ".",
        "writer-buffer", p);
  }
  var cur_subblock = p++;  // Pointing at the length field.

  var clear_code = 1 << min_code_size;
  var code_mask = clear_code - 1;
  var eoi_code = clear_code + 1;
  var next_code = eoi_code + 1;

  var cur_code_size = min_code_size + 1;  // Number of bits per code.
  var cur_shift = 0;
  // We have at most 12-bit codes, so we should have to hold a max of 19
  // bits here (and then we would write out).
  var cur = 0;

  function emit_bytes_to_buffer(bit_block_size) {
    while (cur_shift >= bit_block_size) {
      put(cur & 0xff);
      cur >>= 8; cur_shift -= 8;
      if (p === cur_subblock + 256) {  // Finished a subblock.
        buf[cur_subblock] = 255;
        if (p >= buf_limit) {
          throw new GifError(
              "Output buffer too small, cannot reserve sub-block length at " +
              "offset " + p + ".",
              "writer-buffer", p);
        }
        cur_subblock = p++;
      }
    }
  }

  function emit_code(c) {
    cur |= c << cur_shift;
    cur_shift += cur_code_size;
    emit_bytes_to_buffer(8);
  }

  // I am not an expert on the topic, and I don't want to write a thesis.
  // However, it is good to outline here the basic algorithm and the few data
  // structures and optimizations here that make this implementation fast.
  // The basic idea behind LZW is to build a table of previously seen runs
  // addressed by a short id (herein called output code).  All data is
  // referenced by a code, which represents one or more values from the
  // original input stream.  All input bytes can be referenced as the same
  // value as an output code.  So if you didn't want any compression, you
  // could more or less just output the original bytes as codes (there are
  // some details to this, but it is the idea).  In order to achieve
  // compression, values greater then the input range (codes can be up to
  // 12-bit while input only 8-bit) represent a sequence of previously seen
  // inputs.  The decompressor is able to build the same mapping while
  // decoding, so there is always a shared common knowledge between the
  // encoding and decoder, which is also important for "timing" aspects like
  // how to handle variable bit width code encoding.
  //
  // One obvious but very important consequence of the table system is there
  // is always a unique id (at most 12-bits) to map the runs.  'A' might be
  // 4, then 'AA' might be 10, 'AAA' 11, 'AAAA' 12, etc.  This relationship
  // can be used for an effecient lookup strategy for the code mapping.  We
  // need to know if a run has been seen before, and be able to map that run
  // to the output code.  Since we start with known unique ids (input bytes),
  // and then from those build more unique ids (table entries), we can
  // continue this chain (almost like a linked list) to always have small
  // integer values that represent the current byte chains in the encoder.
  // This means instead of tracking the input bytes (AAAABCD) to know our
  // current state, we can track the table entry for AAAABC (it is guaranteed
  // to exist by the nature of the algorithm) and the next character D.
  // Therefor the tuple of (table_entry, byte) is guaranteed to also be
  // unique.  This allows us to create a simple lookup key for mapping input
  // sequences to codes (table indices) without having to store or search
  // any of the code sequences.  So if 'AAAA' has a table entry of 12, the
  // tuple of ('AAAA', K) for any input byte K will be unique, and can be our
  // key.  This leads to a integer value at most 20-bits, which can always
  // fit in an SMI value and be used as a fast sparse array / object key.

  // Output code for the current contents of the index buffer.
  var ib_code = index_stream[0] & code_mask;  // Load first input index.
  var code_table = { };  // Key'd on our 20-bit "tuple".

  emit_code(clear_code);  // Spec says first code should be a clear code.

  // First index already loaded, process the rest of the stream.
  for (var i = 1, il = index_stream.length; i < il; ++i) {
    var k = index_stream[i] & code_mask;
    var cur_key = ib_code << 8 | k;  // (prev, k) unique tuple.
    var cur_code = code_table[cur_key];  // buffer + k.

    // Check if we have to create a new code table entry.
    if (cur_code === undefined) {  // We don't have buffer + k.
      // Emit index buffer (without k).
      // This is an inline version of emit_code, because this is the core
      // writing routine of the compressor (and V8 cannot inline emit_code
      // because it is a closure here in a different context).  Additionally
      // we can call emit_byte_to_buffer less often, because we can have
      // 30-bits (from our 31-bit signed SMI), and we know our codes will only
      // be 12-bits, so can safely have 18-bits there without overflow.
      // emit_code(ib_code);
      cur |= ib_code << cur_shift;
      cur_shift += cur_code_size;
      while (cur_shift >= 8) {
        put(cur & 0xff);
        cur >>= 8; cur_shift -= 8;
        if (p === cur_subblock + 256) {  // Finished a subblock.
          buf[cur_subblock] = 255;
          if (p >= buf_limit) {
            throw new GifError(
                "Output buffer too small, cannot reserve sub-block length at " +
                "offset " + p + ".",
                "writer-buffer", p);
          }
          cur_subblock = p++;
        }
      }

      if (next_code === 4096) {  // Table full, need a clear.
        emit_code(clear_code);
        next_code = eoi_code + 1;
        cur_code_size = min_code_size + 1;
        code_table = { };
      } else {  // Table not full, insert a new entry.
        // Increase our variable bit code sizes if necessary.  This is a bit
        // tricky as it is based on "timing" between the encoding and
        // decoder.  From the encoders perspective this should happen after
        // we've already emitted the index buffer and are about to create the
        // first table entry that would overflow our current code bit size.
        if (next_code >= (1 << cur_code_size)) ++cur_code_size;
        code_table[cur_key] = next_code++;  // Insert into code table.
      }

      ib_code = k;  // Index buffer to single input k.
    } else {
      ib_code = cur_code;  // Index buffer to sequence in code table.
    }
  }

  emit_code(ib_code);  // There will still be something in the index buffer.
  emit_code(eoi_code);  // End Of Information.

  // Flush / finalize the sub-blocks stream to the buffer.
  emit_bytes_to_buffer(1);

  // Finish the sub-blocks, writing out any unfinished lengths and
  // terminating with a sub-block of length 0.  If we have already started
  // but not yet used a sub-block it can just become the terminator.
  if (cur_subblock + 1 === p) {  // Started but unused.
    buf[cur_subblock] = 0;
  } else {  // Started and used, write length and additional terminator block.
    buf[cur_subblock] = p - cur_subblock - 1;
    put(0);
  }
  return p;
}

function GifReader(buf) {
  var p = 0;

  function fail(stage, offset, message) {
    throw new GifError(message, stage, offset);
  }

  // Assert that |n| more bytes can be read from the current position.
  // Missing bytes are never treated as zero.
  function need(n, stage) {
    if (p + n > buf.length) {
      throw new GifError(
          "Truncated GIF at stage \"" + stage + "\": need " + n +
          " byte(s) at offset " + p + ", only " +
          (buf.length - p) + " byte(s) available.",
          stage, p);
    }
  }

  function readByte(stage) {
    if (p >= buf.length)
      fail(stage, p, "Unexpected end of data while reading a byte at offset " +
          p + " (stage \"" + stage + "\").");
    return buf[p++];
  }

  // Skip a chain of data sub-blocks (length byte + data, terminated by a
  // zero length byte), validating every length against the remaining input.
  function skipSubBlocks(stage) {
    while (true) {
      var block_size = readByte(stage);
      if (block_size === 0) break;  // 0 size is terminator.
      if (p + block_size > buf.length)
        fail(stage, p, "Sub-block of " + block_size +
            " byte(s) at offset " + (p - 1) + " extends past end of file.");
      p += block_size;
    }
  }

  // - Header (GIF87a or GIF89a).
  need(6, "header");
  if (buf[0] !== 0x47 ||            buf[1] !== 0x49 || buf[2] !== 0x46 ||
      buf[3] !== 0x38 || (buf[4]+1 & 0xfd) !== 0x38 || buf[5] !== 0x61) {
    throw new GifError("Invalid GIF 87a/89a header.", "header", 0);
  }
  p = 6;

  // - Logical Screen Descriptor.
  need(7, "logical-screen");
  var width = buf[p++] | buf[p++] << 8;
  var height = buf[p++] | buf[p++] << 8;
  var pf0 = buf[p++];  // <Packed Fields>.
  var global_palette_flag = pf0 >> 7;
  var num_global_colors_pow2 = pf0 & 0x7;
  var num_global_colors = 1 << (num_global_colors_pow2 + 1);
  var background = buf[p++];
  buf[p++];  // Pixel aspect ratio (unused?).

  if (width === 0 || height === 0)
    fail("logical-screen", 6, "Logical canvas width/height must be non-zero.");

  var global_palette_offset = null;
  var global_palette_size   = null;

  if (global_palette_flag) {
    need(num_global_colors * 3, "global-color-table");
    global_palette_offset = p;
    global_palette_size = num_global_colors;
    p += num_global_colors * 3;  // Seek past palette.
    if (background >= num_global_colors)
      fail("global-color-table", 11,
          "Background color index " + background +
          " is outside the global color table of " + num_global_colors +
          " entries.");
  }

  var frames = [ ];

  var delay = 0;
  var transparent_index = null;
  var disposal = 0;  // 0 - No disposal specified.
  var loop_count = null;
  var saw_trailer = false;

  this.width = width;
  this.height = height;

  while (p < buf.length) {
    switch (readByte("block")) {
      case 0x21:  // Extension Block
        var ext_label = readByte("block");
        switch (ext_label) {
          case 0xff:  // Application specific block
            // Try if it's a Netscape block (with animation loop counter).
            need(1, "application-extension");
            var is_netscape = false;
            if (buf[p] === 0x0b) {
              // 21 FF and the block size already read; the full Netscape
              // block is 17 bytes from p (block size, 11 app id/ac bytes,
              // 3-byte loop sub-block, terminator).
              if (p + 17 <= buf.length &&
                  // NETSCAPE2.0
                  buf[p+1 ] == 0x4e && buf[p+2 ] == 0x45 && buf[p+3 ] == 0x54 &&
                  buf[p+4 ] == 0x53 && buf[p+5 ] == 0x43 && buf[p+6 ] == 0x41 &&
                  buf[p+7 ] == 0x50 && buf[p+8 ] == 0x45 && buf[p+9 ] == 0x32 &&
                  buf[p+10] == 0x2e && buf[p+11] == 0x30 &&
                  // Sub-block
                  buf[p+12] == 0x03 && buf[p+13] == 0x01 && buf[p+16] == 0) {
                is_netscape = true;
              }
            }

            if (is_netscape) {
              p += 14;
              loop_count = readByte("application-extension") |
                           readByte("application-extension") << 8;
              var netscape_term = readByte("application-extension");
              if (netscape_term !== 0)
                fail("application-extension", p - 1,
                    "Netscape block terminator must be zero.");
            } else {  // We don't know what it is, just get past it.
              var app_block_size = readByte("application-extension");
              if (app_block_size !== 0) {
                need(app_block_size, "application-extension");
                p += app_block_size;
              }
              skipSubBlocks("application-extension");
            }
            break;

          case 0xf9:  // Graphics Control Extension
            need(6, "graphics-control-extension");  // 4 + 4 bytes + term.
            if (buf[p] !== 0x4 || buf[p+5] !== 0)
              fail("graphics-control-extension", p,
                  "Invalid graphics extension block.");
            var pf1 = buf[p+1];
            delay = buf[p+2] | buf[p+3] << 8;
            transparent_index = buf[p+4];
            if ((pf1 & 1) === 0) transparent_index = null;
            disposal = pf1 >> 2 & 0x7;
            if (disposal > 3)  // Values 4-7 are reserved.
              fail("graphics-control-extension", p + 1,
                  "Reserved disposal method " + disposal + ".");
            p += 6;
            break;

          // Plain Text Extension could be present and we just want to be able
          // to parse past it.  It follows the block structure of the comment
          // extension enough to reuse the path to skip through the blocks.
          case 0x01:  // Plain Text Extension (fallthrough to Comment Extension)
          case 0xfe:  // Comment Extension.
            skipSubBlocks("comment-extension");
            break;

          default:
            fail("block", p - 1,
                "Unknown extension label: 0x" + ext_label.toString(16));
        }
        break;

      case 0x2c:  // Image Descriptor.
        need(9, "image-descriptor");
        var x = buf[p++] | buf[p++] << 8;
        var y = buf[p++] | buf[p++] << 8;
        var w = buf[p++] | buf[p++] << 8;
        var h = buf[p++] | buf[p++] << 8;
        var pf2 = buf[p++];
        var local_palette_flag = pf2 >> 7;
        var interlace_flag = pf2 >> 6 & 1;
        var num_local_colors_pow2 = pf2 & 0x7;
        var num_local_colors = 1 << (num_local_colors_pow2 + 1);
        var palette_offset = global_palette_offset;
        var palette_size = global_palette_size;
        var has_local_palette = false;

        if (w === 0 || h === 0)
          fail("frame-rect", p - 9,
              "Frame width/height must be non-zero.");
        if (x + w > width || y + h > height)
          fail("frame-rect", p - 9,
              "Frame rectangle (" + x + "," + y + " " + w + "x" + h +
              ") is outside the logical canvas (" + width + "x" + height + ").");

        if (local_palette_flag) {
          need(num_local_colors * 3, "local-color-table");
          has_local_palette = true;
          palette_offset = p;  // Override with local palette.
          palette_size = num_local_colors;
          p += num_local_colors * 3;  // Seek past palette.
        }

        if (palette_offset === null)
          fail("image-descriptor", p,
              "Image has neither a local nor a global color table.");

        if (transparent_index !== null &&
            transparent_index >= palette_size)
          fail("image-descriptor", p,
              "Transparent color index " + transparent_index +
              " is outside the frame color table of " + palette_size +
              " entries.");

        var data_offset = p;

        need(1, "image-data");
        ++p;  // LZW minimum code size (validated during LZW decoding).
        skipSubBlocks("image-data");

        frames.push({x: x, y: y, width: w, height: h,
                     has_local_palette: has_local_palette,
                     palette_offset: palette_offset,
                     palette_size: palette_size,
                     data_offset: data_offset,
                     data_length: p - data_offset,
                     transparent_index: transparent_index,
                     interlaced: !!interlace_flag,
                     delay: delay,
                     disposal: disposal});
        break;

      case 0x3b:  // Trailer Marker (end of file).
        saw_trailer = true;
        break;

      default:
        fail("block", p - 1,
            "Unknown gif block: 0x" + buf[p-1].toString(16));
        break;
    }

    if (saw_trailer) break;
  }

  if (!saw_trailer)
    fail("trailer", buf.length,
        "End of file reached without a GIF trailer (0x3b).");

  // Validate that the destination pixel buffer covers every byte the blit
  // would write.  Checked up front so a failure leaves the existing contents
  // completely untouched.
  function checkOutputBuffer(frame, pixels) {
    var required =
        (((frame.y + frame.height - 1) * width) + frame.x + frame.width) * 4;
    if (pixels.length < required)
      fail("output-buffer", null,
          "Output pixel buffer too short: need " + required +
          " BGRA/RGBA values, got " + pixels.length + ".");
  }

  // Decode the LZW index stream and verify every palette index before any
  // destination pixel is touched, making blits all-or-nothing.
  function decodeIndexStream(frame) {
    var num_pixels = frame.width * frame.height;
    var index_stream = new Uint8Array(num_pixels);  // At most 8-bit indices.
    GifReaderLZWOutputIndexStream(
        buf, frame.data_offset, index_stream, num_pixels,
        frame.data_offset + frame.data_length);
    for (var i = 0; i < num_pixels; ++i) {
      var index = index_stream[i];
      if (index >= frame.palette_size)
        fail("palette-index", frame.palette_offset + index * 3,
            "Palette index " + index + " in frame is outside the frame " +
            "color table of " + frame.palette_size + " entries.");
    }
    return index_stream;
  }

  this.numFrames = function() {
    return frames.length;
  };

  this.loopCount = function() {
    return loop_count;
  };

  this.frameInfo = function(frame_num) {
    if (frame_num < 0 || frame_num >= frames.length)
      throw new GifError("Frame index out of range.", "frame-rect", null);
    return frames[frame_num];
  };

  this.decodeAndBlitFrameBGRA = function(frame_num, pixels) {
    var frame = this.frameInfo(frame_num);
    checkOutputBuffer(frame, pixels);
    var index_stream = decodeIndexStream(frame);
    var palette_offset = frame.palette_offset;

    // NOTE(deanm): It seems to be much faster to compare index to 256 than
    // to === null.  Not sure why, but CompareStub_EQ_STRICT shows up high in
    // the profile, not sure if it's related to using a Uint8Array.
    var trans = frame.transparent_index;
    if (trans === null) trans = 256;

    // We are possibly just blitting to a portion of the entire frame.
    // That is a subrect within the framerect, so the additional pixels
    // must be skipped over after we finished a scanline.
    var framewidth  = frame.width;
    var framestride = width - framewidth;
    var xleft       = framewidth;  // Number of subrect pixels left in scanline.

    // Output index of the top left corner of the subrect.
    var opbeg = ((frame.y * width) + frame.x) * 4;
    // Output index of what would be the left edge of the subrect, one row
    // below it, i.e. the index at which an interlace pass should wrap.
    var opend = ((frame.y + frame.height) * width + frame.x) * 4;
    var op    = opbeg;

    var scanstride = framestride * 4;

    // Use scanstride to skip past the rows when interlacing.  This is skipping
    // 7 rows for the first two passes, then 3 then 1.
    if (frame.interlaced === true) {
      scanstride += width * 4 * 7;  // Pass 1.
    }

    var interlaceskip = 8;  // Tracking the row interval in the current pass.

    for (var i = 0, il = index_stream.length; i < il; ++i) {
      var index = index_stream[i];

      if (xleft === 0) {  // Beginning of new scan line
        op += scanstride;
        xleft = framewidth;
        if (op >= opend) { // Catch the wrap to switch passes when interlacing.
          scanstride = framestride * 4 + width * 4 * (interlaceskip-1);
          // interlaceskip / 2 * 4 is interlaceskip << 1.
          op = opbeg + (framewidth + framestride) * (interlaceskip << 1);
          interlaceskip >>= 1;
        }
      }

      if (index === trans) {
        op += 4;
      } else {
        var r = buf[palette_offset + index * 3];
        var g = buf[palette_offset + index * 3 + 1];
        var b = buf[palette_offset + index * 3 + 2];
        pixels[op++] = b;
        pixels[op++] = g;
        pixels[op++] = r;
        pixels[op++] = 255;
      }
      --xleft;
    }
  };

  // I will go to copy and paste hell one day...
  this.decodeAndBlitFrameRGBA = function(frame_num, pixels) {
    var frame = this.frameInfo(frame_num);
    checkOutputBuffer(frame, pixels);
    var index_stream = decodeIndexStream(frame);
    var palette_offset = frame.palette_offset;

    // NOTE(deanm): It seems to be much faster to compare index to 256 than
    // to === null.  Not sure why, CompareStub_EQ_STRICT shows up high in
    // the profile, not sure if it's related to using a Uint8Array.
    var trans = frame.transparent_index;
    if (trans === null) trans = 256;

    // We are possibly just blitting to a portion of the entire frame.
    // That is a subrect within the framerect, so the additional pixels
    // must be skipped over after we finished a scanline.
    var framewidth  = frame.width;
    var framestride = width - framewidth;
    var xleft       = framewidth;  // Number of subrect pixels left in scanline.

    // Output index of the top left corner of the subrect.
    var opbeg = ((frame.y * width) + frame.x) * 4;
    // Output index of what would be the left edge of the subrect, one row
    // below it, i.e. the index at which an interlace pass should wrap.
    var opend = ((frame.y + frame.height) * width + frame.x) * 4;
    var op    = opbeg;

    var scanstride = framestride * 4;

    // Use scanstride to skip past the rows when interlacing.  This is skipping
    // 7 rows for the first two passes, then 3 then 1.
    if (frame.interlaced === true) {
      scanstride += width * 4 * 7;  // Pass 1.
    }

    var interlaceskip = 8;  // Tracking the row interval in the current pass.

    for (var i = 0, il = index_stream.length; i < il; ++i) {
      var index = index_stream[i];

      if (xleft === 0) {  // Beginning of new scan line
        op += scanstride;
        xleft = framewidth;
        if (op >= opend) { // Catch the wrap to switch passes when interlacing.
          scanstride = framestride * 4 + width * 4 * (interlaceskip-1);
          // interlaceskip / 2 * 4 is interlaceskip << 1.
          op = opbeg + (framewidth + framestride) * (interlaceskip << 1);
          interlaceskip >>= 1;
        }
      }

      if (index === trans) {
        op += 4;
      } else {
        var r = buf[palette_offset + index * 3];
        var g = buf[palette_offset + index * 3 + 1];
        var b = buf[palette_offset + index * 3 + 2];
        pixels[op++] = r;
        pixels[op++] = g;
        pixels[op++] = b;
        pixels[op++] = 255;
      }
      --xleft;
    }
  };
}

function GifReaderLZWOutputIndexStream(
    code_stream, p, output, output_length, data_end) {
  function lzwFail(stage, offset, message) {
    throw new GifError(message, stage, offset);
  }

  if (p >= data_end)
    lzwFail("lzw-min-code-size", p,
        "Missing LZW minimum code size byte.");
  var min_code_size_offset = p;
  var min_code_size = code_stream[p++];

  if (min_code_size < 2 || min_code_size > 8)
    lzwFail("lzw-min-code-size", min_code_size_offset,
        "Invalid LZW minimum code size " + min_code_size +
        " (must be in 2 .. 8).");

  var clear_code = 1 << min_code_size;
  var eoi_code = clear_code + 1;
  var next_code = eoi_code + 1;

  var cur_code_size = min_code_size + 1;  // Number of bits per code.
  // NOTE: This shares the same name as the encoder, but has a different
  // meaning here.  Here this masks each code coming from the code stream.
  var code_mask = (1 << cur_code_size) - 1;
  var cur_shift = 0;
  var cur = 0;

  var op = 0;  // Output pointer.

  if (p >= data_end)
    lzwFail("lzw-subblock", p, "Missing first sub-block size byte.");
  var subblock_size = code_stream[p++];

  // Returns the next compressed byte, or -1 when the sub-block chain has
  // reached its zero-length terminator.  Never reads past data_end, so a
  // truncated sub-block is an error instead of an undefined/zero byte.
  function readDataByte() {
    if (subblock_size === 0) return -1;
    if (p >= data_end)
      lzwFail("lzw-data", p,
          "Sub-block declared " + subblock_size +
          " more byte(s) but the image data ended at offset " + data_end + ".");
    var b = code_stream[p++];

    if (subblock_size === 1) {  // Fetch the next sub-block size.
      if (p >= data_end)
        lzwFail("lzw-subblock", p,
            "Missing sub-block size byte or terminator at offset " + p + ".");
      subblock_size = code_stream[p++];
    } else {
      --subblock_size;
    }
    return b;
  }

  // TODO(deanm): Would using a TypedArray be any faster?  At least it would
  // solve the fast mode / backing store uncertainty.
  // var code_table = Array(4096);
  var code_table = new Int32Array(4096);  // Can be signed, we only use 20 bits.

  var prev_code = null;  // Track code-1.

  while (true) {
    // Read up to two bytes, making sure we always 12-bits for max sized code.
    while (cur_shift < 16) {
      var next_byte = readDataByte();
      if (next_byte < 0) break;  // No more data to be read.
      cur |= next_byte << cur_shift;
      cur_shift += 8;
    }

    // Extract whenever a whole code is buffered.  This must happen before the
    // exhaustion guard below, because the terminating EOI commonly shares the
    // last data byte and leaves fewer than one code width of residual bits.
    if (cur_shift >= cur_code_size) {
      var code = cur & code_mask;
      cur >>= cur_code_size;
      cur_shift -= cur_code_size;
    } else {
      // No code can be formed and no more data exists: a terminating EOI was
      // required but never arrived.
      lzwFail("lzw-data", p,
          "Compressed data ended before an EOI code (decoded " + op +
          " of " + output_length + " pixels).");
    }

    // TODO(deanm): Maybe should check that the first code was a clear code,
    // at least this is what you're supposed to do.  But actually our encoder
    // now doesn't emit a clear code first anyway.
    if (code === clear_code) {
      // We don't actually have to clear the table.  This could be a good idea
      // for greater error checking, but we don't really do any anyway.  We
      // will just track it with next_code and overwrite old entries.

      next_code = eoi_code + 1;
      cur_code_size = min_code_size + 1;
      code_mask = (1 << cur_code_size) - 1;

      // Don't update prev_code ?
      prev_code = null;
      continue;
    } else if (code === eoi_code) {
      break;
    }

    // code === next_code is the special KwKwK case and is only legal when
    // there is a previous code to extend.  Anything above next_code references
    // a dictionary entry that has never been defined.
    if (code > next_code ||
        (code === next_code && prev_code === null))
      lzwFail("lzw-code", p,
          "Illegal LZW dictionary code " + code +
          " (next available code is " + next_code + ").");

    // We have a similar situation as the decoder, where we want to store
    // variable length entries (code table entries), but we want to do in a
    // faster manner than an array of arrays.  The code below stores sort of a
    // linked list within the code table, and then "chases" through it to
    // construct the dictionary entries.  When a new entry is created, just the
    // last byte is stored, and the rest (prefix) of the entry is only
    // referenced by its table entry.  Then the code chases through the
    // prefixes until it reaches a single byte code.  We have to chase twice,
    // first to compute the length, and then to actually copy the data to the
    // output (backwards, since we know the length).  The alternative would be
    // storing something in an intermediate stack, but that doesn't make any
    // more sense.  I implemented an approach where it also stored the length
    // in the code table, although it's a bit tricky because you run out of
    // bits (12 + 12 + 8), but I didn't measure much improvements (the table
    // entries are generally not the long).  Even when I created benchmarks for
    // very long table entries the complexity did not seem worth it.
    // The code table stores the prefix entry in 12 bits and then the suffix
    // byte in 8 bits, so each entry is 20 bits.

    var is_special_case = (code === next_code);
    var chase_code = is_special_case ? prev_code : code;

    // Chase what we will output, either {CODE} or {CODE-1}.
    var chase_length = 0;
    var chase = chase_code;
    while (chase > clear_code) {
      chase = code_table[chase] >> 8;
      ++chase_length;
    }

    var k = chase;

    var op_end = op + chase_length + (is_special_case ? 1 : 0);
    if (op_end > output_length) {
      lzwFail("lzw-output", p,
          "Decoded pixel overflow: stream produced more than the " +
          output_length + " pixel(s) the frame requires.");
    }

    // Already have the first byte from the chase, might as well write it fast.
    output[op++] = k;

    op += chase_length;
    var b = op;  // Track pointer, writing backwards.

    if (is_special_case)  // The case of emitting {CODE-1} + k.
      output[op++] = k;

    chase = chase_code;
    while (chase_length--) {
      chase = code_table[chase];
      output[--b] = chase & 0xff;  // Write backwards.
      chase >>= 8;  // Pull down to the prefix code.
    }

    if (prev_code !== null && next_code < 4096) {
      code_table[next_code++] = prev_code << 8 | k;
      // TODO(deanm): Figure out this clearing vs code growth logic better.  I
      // have an feeling that it should just happen somewhere else, for now it
      // is awkward between when we grow past the max and then hit a clear code.
      // For now just check if we hit the max 12-bits (then a clear code should
      // follow, also of course encoded in 12-bits).
      if (next_code >= code_mask+1 && cur_code_size < 12) {
        ++cur_code_size;
        code_mask = code_mask << 1 | 1;
      }
    }

    prev_code = code;
  }

  if (op !== output_length) {
    lzwFail("lzw-output", p,
        "Decoded pixel underflow: stream produced " + op + " of " +
        output_length + " required pixel(s).");
  }

  return output;
}

// CommonJS.
try {
  exports.GifWriter = GifWriter;
  exports.GifReader = GifReader;
  exports.GifError = GifError;
} catch(e) {}
