// tools/impl/fuzzy-match.js — fuzzy client deduplication for Service Autopilot
// Used by the CRM agent before creating a new client to detect existing accounts
// under nicknames, spouse names, or minor address variations.

// ── Nickname groups ───────────────────────────────────────────────────────────
// Each sub-array is a family of equivalent first names.
const NICKNAME_GROUPS = [
  // Men
  ['robert', 'rob', 'bob', 'bobby', 'robbie'],
  ['william', 'will', 'bill', 'billy', 'willy', 'liam'],
  ['richard', 'rick', 'ricky', 'dick', 'rich'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'johnny', 'jon', 'jonny'],
  ['michael', 'mike', 'mikey', 'mick', 'mickey'],
  ['thomas', 'tom', 'tommy'],
  ['charles', 'chuck', 'charlie', 'chaz'],
  ['david', 'dave', 'davy'],
  ['edward', 'ed', 'eddie', 'ted', 'teddy', 'ned'],
  ['joseph', 'joe', 'joey'],
  ['george', 'georgie'],
  ['steven', 'steve', 'stevie', 'stephen'],
  ['christopher', 'chris'],
  ['matthew', 'matt', 'matty'],
  ['daniel', 'dan', 'danny'],
  ['anthony', 'tony'],
  ['donald', 'don', 'donnie'],
  ['kenneth', 'ken', 'kenny'],
  ['timothy', 'tim', 'timmy'],
  ['patrick', 'pat', 'patty', 'paddy'],
  ['lawrence', 'larry', 'lars'],
  ['jeffrey', 'jeff', 'jeffy'],
  ['frank', 'francis', 'frankie'],
  ['raymond', 'ray'],
  ['gregory', 'greg'],
  ['gerald', 'jerry', 'gerry'],
  ['dennis', 'denny'],
  ['walter', 'walt'],
  ['peter', 'pete'],
  ['harold', 'harry', 'hal'],
  ['ronald', 'ron', 'ronnie'],
  ['gary', 'garry'],
  ['andrew', 'andy', 'drew'],
  ['nicholas', 'nick', 'nicky'],
  ['samuel', 'sam', 'sammy'],
  ['benjamin', 'ben', 'benny'],
  ['henry', 'hank', 'hal'],
  ['nathan', 'nate'],
  ['jonathan', 'jon', 'jonny', 'johnny'],
  ['albert', 'al', 'albie'],
  ['arthur', 'art', 'artie'],
  ['eugene', 'gene'],
  ['fred', 'freddie', 'frederick'],
  ['leo', 'leon', 'leonard'],
  ['louis', 'lou', 'lewis'],
  ['mark', 'marc'],
  ['paul', 'paulie'],
  ['phillip', 'philip', 'phil'],
  ['roger', 'rodger'],
  ['russell', 'russ'],
  ['scott', 'scotty'],
  ['stanley', 'stan'],
  ['vincent', 'vince', 'vinny'],
  ['warren', 'warren'],
  // Women
  ['deborah', 'debra', 'debbie', 'debby', 'deb'],
  ['elizabeth', 'liz', 'beth', 'betty', 'bette', 'eliza', 'lisa', 'libby', 'ellie'],
  ['margaret', 'maggie', 'meg', 'peg', 'peggy', 'marge', 'margie', 'rita'],
  ['catherine', 'cathy', 'kate', 'kat', 'katie', 'kathy', 'katherine', 'kathryn'],
  ['susan', 'sue', 'susie', 'suzy'],
  ['barbara', 'barb', 'babs', 'bobbie'],
  ['jennifer', 'jen', 'jenny'],
  ['carol', 'carole', 'caroline', 'carrie', 'carolyn'],
  ['patricia', 'pat', 'patty', 'tricia', 'trish', 'patti'],
  ['dorothy', 'dot', 'dottie', 'dori'],
  ['sandra', 'sandy', 'sandi'],
  ['sharon', 'sherry', 'sherri', 'shari'],
  ['janet', 'jan', 'janie'],
  ['mary', 'marie', 'molly', 'polly'],
  ['helen', 'helene', 'nell', 'nellie'],
  ['virginia', 'ginny', 'gina', 'bea'],
  ['christine', 'chris', 'christy', 'kristy', 'tina', 'kris'],
  ['judith', 'judy', 'judi'],
  ['diane', 'diana', 'di', 'dian'],
  ['anna', 'anne', 'ann', 'annie', 'ana'],
  ['rebecca', 'becky', 'becca'],
  ['theresa', 'teresa', 'terry', 'terri', 'tess'],
  ['nancy', 'nan', 'nance'],
  ['joan', 'joanne', 'jo', 'joann'],
  ['amanda', 'mandy', 'manda'],
  ['shirley', 'shirl'],
  ['frances', 'fran', 'frannie', 'franny'],
  ['linda', 'lin', 'lindy'],
  ['donna', 'donnie'],
  ['joyce', 'joy'],
  ['gloria', 'glory'],
  ['cheryl', 'cheri', 'sheri'],
  ['alice', 'ali', 'allie'],
  ['ruth', 'ruthie'],
  ['kathleen', 'kathy', 'kate', 'kathi'],
  ['beverly', 'bev'],
  ['marilyn', 'marilynn'],
  ['victoria', 'vicki', 'vickie', 'tori'],
  ['cynthia', 'cindy', 'cindi'],
  ['stephanie', 'steph', 'stevie'],
  ['jacqueline', 'jackie', 'jacky'],
  ['evelyn', 'eve', 'evie', 'lyn'],
  ['wendy', 'wendi'],
  ['andrea', 'andy', 'andi'],
  ['nicole', 'nikki', 'nicky', 'niki'],
  ['melissa', 'mel', 'missy', 'lisa'],
  ['kimberly', 'kim', 'kimmy'],
  ['angela', 'angie', 'angel'],
  ['brenda', 'bren'],
  ['amy', 'amie'],
  ['laura', 'laurie', 'lori'],
  ['pamela', 'pam', 'pammy'],
  ['julie', 'julia', 'jules'],
  ['heather', 'heathy'],
  ['michelle', 'mich', 'mickey', 'shelley'],
  ['jessica', 'jess', 'jessie'],
  ['ashley', 'ash'],
  ['sarah', 'sara', 'sallie', 'sally'],
  ['tiffany', 'tiff', 'tiffie'],
  ['brittany', 'britt', 'britney'],
  ['megan', 'meg', 'meghan'],
];

// Build reverse lookup: normalizedName → groupIndex
const _nameToGroup = new Map();
for (let i = 0; i < NICKNAME_GROUPS.length; i++) {
  for (const n of NICKNAME_GROUPS[i]) _nameToGroup.set(n, i);
}

function sameFirstName(a, b) {
  if (!a || !b) return false;
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return true;
  const ga = _nameToGroup.get(a);
  const gb = _nameToGroup.get(b);
  return ga !== undefined && ga === gb;
}

// ── Address normalization ─────────────────────────────────────────────────────
const ADDR_ABBR = [
  [/\bstreet\b/gi, 'st'],    [/\bavenue\b/gi, 'ave'],
  [/\bboulevard\b/gi, 'blvd'], [/\bdrive\b/gi, 'dr'],
  [/\blane\b/gi, 'ln'],       [/\bcourt\b/gi, 'ct'],
  [/\bplace\b/gi, 'pl'],      [/\broad\b/gi, 'rd'],
  [/\bparkway\b/gi, 'pkwy'],  [/\bhighway\b/gi, 'hwy'],
  [/\bnorth\b/gi, 'n'],       [/\bsouth\b/gi, 's'],
  [/\beast\b/gi, 'e'],        [/\bwest\b/gi, 'w'],
  [/\bsaint\b/gi, 'st'],
  // common ordinal abbreviations already match (1st, 2nd, etc.)
];

function normalizeAddress(addr) {
  if (!addr) return '';
  let s = addr.toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
  for (const [re, abbr] of ADDR_ABBR) s = s.replace(re, abbr);
  return s.replace(/\s+/g, ' ').trim();
}

function streetNumberOf(addr) {
  return normalizeAddress(addr).match(/^(\d+[a-z]?)/)?.[1] ?? null;
}

function sameAddress(a, b) {
  if (!a || !b) return false;
  const na = normalizeAddress(a), nb = normalizeAddress(b);
  if (na === nb) return true;
  // Same street number is a strong signal even if suffix differs slightly
  const numA = streetNumberOf(a), numB = streetNumberOf(b);
  if (!numA || numA !== numB) return false;
  // Street names after number — compare first 6 chars for typo tolerance
  const bodyA = na.replace(/^\d+[a-z]?\s*/, '').slice(0, 6);
  const bodyB = nb.replace(/^\d+[a-z]?\s*/, '').slice(0, 6);
  return bodyA.length >= 3 && bodyA === bodyB;
}

// ── Phone normalization ───────────────────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  if (d.length === 10) return d;
  return null;
}

function samePhone(a, b) {
  const na = normalizePhone(a), nb = normalizePhone(b);
  return !!na && !!nb && na === nb;
}

// ── Email normalization ───────────────────────────────────────────────────────
function normalizeEmail(e) {
  return e ? e.toLowerCase().trim() : null;
}

function sameEmail(a, b) {
  const na = normalizeEmail(a), nb = normalizeEmail(b);
  return !!na && !!nb && na === nb;
}

// ── Last-name normalization ───────────────────────────────────────────────────
function sameLastName(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

// ── Core scorer ──────────────────────────────────────────────────────────────
// Returns a list of matched field labels and a numeric score.
// Score thresholds:
//   ≥ 40 → MATCH (use existing client, skip create)
//   20–39 → POSSIBLE_MATCH (flag for manual review, still use existing)
//   < 20 → NO_MATCH (safe to create new)
function scoreCandidate(incoming, candidate) {
  const fields = [];
  let score = 0;

  // Exact or nickname first-name match
  if (sameFirstName(incoming.firstName, candidate.firstName)) {
    fields.push('firstName'); score += 15;
  }
  // Last name
  if (sameLastName(incoming.lastName, candidate.lastName)) {
    fields.push('lastName'); score += 20;
  }
  // Address
  if (sameAddress(incoming.address, candidate.address)) {
    fields.push('address'); score += 25;
  }
  // Email
  if (sameEmail(incoming.email, candidate.email)) {
    fields.push('email'); score += 40;
  }
  // Phone
  if (samePhone(incoming.phone, candidate.phone)) {
    fields.push('phone'); score += 35;
  }

  return { score, fields };
}

/**
 * fuzzyMatchClient(incoming, candidates) → sorted match results
 *
 * incoming: { firstName, lastName, address, email, phone }
 * candidates: array of SA client objects (same shape + clientId, name)
 *
 * Returns array sorted by score descending:
 * [{ clientId, name, score, verdict, matchedOn: [...] }, ...]
 *
 * verdict values: 'MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH'
 */
export function fuzzyMatchClient(incoming, candidates) {
  const results = [];
  for (const c of candidates) {
    const { score, fields } = scoreCandidate(incoming, c);
    if (score === 0) continue;
    const verdict = score >= 40 ? 'MATCH' : score >= 20 ? 'POSSIBLE_MATCH' : 'NO_MATCH';
    results.push({
      clientId:  c.clientId ?? c.id,
      name:      c.name ?? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
      score,
      verdict,
      matchedOn: fields,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Tool entry point for the agent dispatcher.
 * incoming: contact data from the web form
 * candidates: SA search results (from sa_search_clients — may be from multiple searches)
 */
export function runFuzzyMatchClient({ incoming, candidates }) {
  if (!incoming || !candidates) return { error: 'incoming and candidates are required' };
  const matches = fuzzyMatchClient(incoming, candidates ?? []);
  const best = matches[0] ?? null;
  return {
    bestMatch:    best,
    allMatches:   matches.filter(m => m.verdict !== 'NO_MATCH'),
    recommendation: best?.verdict === 'MATCH' ? 'USE_EXISTING'
                  : best?.verdict === 'POSSIBLE_MATCH' ? 'USE_EXISTING_VERIFY'
                  : 'CREATE_NEW',
  };
}
