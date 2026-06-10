const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const plist = require('plist')
const forge = require('node-forge')

// Apple POSTs a PKCS7-signed plist. Three decode methods for compatibility.
function parseUDIDPayload(body) {
  // Method 1: openssl smime — available on macOS and Render Linux instances
  const tmp = path.join(os.tmpdir(), `udid_${Date.now()}.der`)
  fs.writeFileSync(tmp, body)
  try {
    const out = execSync(
      `openssl smime -verify -noverify -inform DER -in "${tmp}" 2>/dev/null`,
      { encoding: 'buffer', timeout: 5000 }
    )
    fs.unlinkSync(tmp)
    return plist.parse(out.toString('utf8'))
  } catch (_) {
    try { fs.unlinkSync(tmp) } catch (_) {}
  }

  // Method 2: node-forge PKCS7
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(body))
    const p7 = forge.pkcs7.messageFromAsn1(asn1)
    const content = p7.rawCapture.content.value[0].value
    return plist.parse(content)
  } catch (_) {}

  // Method 3: raw plist fallback (some older iOS sends unencrypted)
  try {
    return plist.parse(body.toString('utf8'))
  } catch (_) {}

  throw new Error('Could not decode UDID payload from Apple')
}

module.exports = { parseUDIDPayload }
