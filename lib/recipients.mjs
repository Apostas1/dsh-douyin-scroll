/** A nickname and an ID are one destination. Never mix explicit and default halves. */
export function resolveRecipient(args = {}, cfg = {}) {
  const to = String(args.to || '').trim()
  const toId = String(args.to_id || '').trim()
  if (to || toId) return { to, toId }
  const primary = Array.isArray(cfg.dmPeers) ? cfg.dmPeers.find(p => p?.sec_uid || p?.nick) : null
  return {
    to: String((primary ? primary.nick : cfg.dmTo) || '').trim(),
    toId: String((primary ? primary.sec_uid : cfg.dmToId) || '').trim(),
  }
}
