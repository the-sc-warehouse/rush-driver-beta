const crypto = require('crypto')

function uuid() {
  return crypto.randomUUID()
}

// Phase 1: iOS downloads this, installs it, then POSTs device info to callbackUrl
function generateEnrollmentProfile(serverUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${serverUrl}/enroll/callback</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
      <string>DEVICE_NAME</string>
      <string>PRODUCT</string>
      <string>VERSION</string>
      <string>SERIAL</string>
    </array>
  </dict>
  <key>PayloadOrganization</key>
  <string>Rush Driver</string>
  <key>PayloadDisplayName</key>
  <string>Rush Driver Beta Enrollment</string>
  <key>PayloadDescription</key>
  <string>Registers your device for the Rush Driver beta. Shares your device ID with Rush Driver only.</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadUUID</key>
  <string>${uuid()}</string>
  <key>PayloadIdentifier</key>
  <string>com.rushdriver.enroll</string>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>`
}

// Phase 2: server responds with this after receiving the UDID.
// iOS 16+ rejects empty PayloadContent — include a web clip so there's something to install.
// The web clip is removable and just adds a home screen shortcut to the install page.
function generateEnrolledProfile() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadIdentifier</key>
      <string>com.rushdriver.webclip</string>
      <key>PayloadUUID</key>
      <string>${uuid()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>Label</key>
      <string>Rush Driver</string>
      <key>URL</key>
      <string>https://spark.scamsclub.store/download</string>
      <key>IsRemovable</key>
      <true/>
      <key>FullScreen</key>
      <false/>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Rush Driver Beta</string>
  <key>PayloadDescription</key>
  <string>Your device is enrolled in the Rush Driver beta program.</string>
  <key>PayloadOrganization</key>
  <string>Rush Driver</string>
  <key>PayloadIdentifier</key>
  <string>com.rushdriver.enrolled</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuid()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`
}

module.exports = { generateEnrollmentProfile, generateEnrolledProfile }
