// Ciphertext bytes before transport encoding. The page build embeds this same object.
export const syncLimits = Object.freeze({
  docBytes: 1900000,
  batchBytes: 2800000,
  maxDocs: 100,
  pageRows: 200
});
