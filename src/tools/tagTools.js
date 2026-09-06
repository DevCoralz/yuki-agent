// Real WhatsApp mentions — @name in plain message text does NOT notify or
// render as a tappable mention; Baileys requires the JIDs populated in the
// message's own `mentions` array. This tool is what makes an actual
// mention possible, as opposed to Yuki just typing "@everyone" as text
// (which is what happened before this existed — looked like a mention in
// the chat log but didn't actually notify anyone).

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().trim();
}

/**
 * Resolves a requested name (or "everyone") against this session's known
 * participants (from sessionStore.getParticipants). Matching is
 * case-insensitive substring match against the tracked display name —
 * good enough for "tag Sarg" matching a stored "Sarg Tech", without
 * requiring an exact match the model is unlikely to produce verbatim.
 *
 * tagSender bypasses fuzzy matching entirely: it resolves directly from
 * the real JID of whoever sent the triggering message, which is reliable
 * where fuzzy name matching against model-inferred text is not — this is
 * specifically what fixes "tag me" tagging the wrong person, since it
 * never depends on the model correctly tracking who's speaking across a
 * multi-person group conversation.
 */
function resolveMentions(participants, requestedNames, { everyone = false, tagSender = false, senderJid = null, senderName = null } = {}) {
  if (tagSender && senderJid) {
    return [{ participant_jid: senderJid, display_name: senderName || null }];
  }
  if (everyone) {
    return participants.filter(p => p.participant_jid);
  }
  if (!requestedNames?.length) return [];

  const resolved = [];
  for (const name of requestedNames) {
    const needle = normalizeForMatch(name);
    if (!needle) continue;
    const match = participants.find(p => normalizeForMatch(p.display_name).includes(needle));
    if (match) resolved.push(match);
  }
  return resolved;
}

/**
 * Sends a message in the group with real WhatsApp mentions — either
 * everyone tracked in this session, specific people by (fuzzy) name, or
 * the actual sender of the triggering message (tagSender: true — always
 * prefer this for "tag me" requests, since it can't misfire onto the
 * wrong person the way fuzzy name matching against conversation history
 * theoretically could).
 */
export async function tagUsers(sock, jid, participants, { tagSender, senderJid, senderName, names, everyone, message }) {
  const targets = resolveMentions(participants, names, { everyone, tagSender, senderJid, senderName });

  if (!targets.length) {
    const attempted = tagSender ? 'the sender' : everyone ? 'everyone' : (names || []).join(', ');
    return {
      tagged: [],
      note: `No matching participants found for "${attempted}". Known participants must have sent at least one message in this chat to be taggable.`,
    };
  }

  const mentionText = targets.map(t => `@${t.participant_jid.split('@')[0]}`).join(' ');
  const text = message ? `${mentionText}\n${message}` : mentionText;

  await sock.sendMessage(jid, {
    text,
    mentions: targets.map(t => t.participant_jid),
  });

  return {
    tagged: targets.map(t => t.display_name || t.participant_jid),
    count: targets.length,
  };
}
