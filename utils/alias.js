/**
 * Anonymous "vibe seeker" aliases. The astrologer never sees a user's real name
 * or phone — every session shows a randomly generated cosmic alias instead, e.g.
 * "Cosmic Wanderer", "Moonlit Seeker". A fresh alias is minted per session
 * request (product decision: random per-session, not stable across sessions).
 */

const ADJECTIVES = [
  'Cosmic', 'Moonlit', 'Stellar', 'Mystic', 'Celestial', 'Astral', 'Lunar',
  'Solar', 'Radiant', 'Serene', 'Wandering', 'Eternal', 'Hidden', 'Silent',
  'Golden', 'Twilight', 'Dawn', 'Velvet', 'Sacred', 'Ethereal', 'Nebula',
  'Starlit', 'Dreaming', 'Quiet', 'Gentle',
];

const NOUNS = [
  'Seeker', 'Wanderer', 'Dreamer', 'Voyager', 'Soul', 'Sage', 'Pilgrim',
  'Traveller', 'Stargazer', 'Wayfarer', 'Mystic', 'Spirit', 'Nomad',
  'Explorer', 'Sojourner', 'Visionary', 'Whisperer', 'Oracle', 'Drifter',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Generate a fresh random vibe-seeker alias for a session. */
function randomSeekerAlias() {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

module.exports = { randomSeekerAlias };
