async function sendNotification(udid, deviceName, product) {
  const message = `New tester: ${deviceName} (${product})\nUDID: ${udid}`

  // ntfy.sh — free push notifications, no account needed
  // Set NTFY_TOPIC to any unique string (e.g. "rushdriver-beta-yourname")
  if (process.env.NTFY_TOPIC) {
    try {
      await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
        method: 'POST',
        headers: {
          Title: 'Rush Driver — New Beta Tester',
          Priority: 'high',
          Tags: 'iphone'
        },
        body: message
      })
    } catch (e) {
      console.error('[notify] ntfy failed:', e.message)
    }
  }

  // Discord webhook
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**Rush Driver Beta — New tester enrolled**\nDevice: ${deviceName} (${product})\nUDID: \`${udid}\``
        })
      })
    } catch (e) {
      console.error('[notify] Discord failed:', e.message)
    }
  }

  // Always log — visible in Render dashboard
  console.log(`[notify] ${deviceName} (${product}) — ${udid}`)
}

module.exports = { sendNotification }
