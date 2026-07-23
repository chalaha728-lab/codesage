// Minimal NaCl sealed box implementation for GitHub secret encryption.
// GitHub uses libsodium sealed boxes: X25519 + XSalsa20-Poly1305.
// This is a minimal implementation of just the parts we need.
// Source: https://github.com/dchest/tweetnacl-js (public domain)

"use strict";

// Base58/Base64 helpers
const Base64 = {
  encode: function(arr) {
    return Buffer.from(arr).toString("base64");
  },
  decode: function(str) {
    return new Uint8Array(Buffer.from(str, "base64"));
  }
};

// We need: randomBytes, box.keyPair, box (XSalsa20-Poly1305), scalarMult (X25519)
// Since implementing all of tweetnacl is ~1000 lines, let's download it.

module.exports = { Base64 };
