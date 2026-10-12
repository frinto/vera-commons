/**
 * Reading the relay's admission queue so that "cannot see" can never be spelled "nobody is there".
 *
 * WHY THIS MODULE EXISTS
 * Every consumer of `/admission/requests` used to write the same two characters and get the same
 * defect: `(payload.requests ?? [])`. When the answer arrived 200 but WITHOUT a requests list -- an
 * older relay, a shape change, an intermediary returning an HTML 200 -- the default turned an
 * unread answer into an empty queue. Measured live 2026-10-12: the deployed relay does not send
 * `total`, `truncated` or `unreadable` at all, so this is not hypothetical for the relay in service.
 *
 * The defect is asymmetric and it lands on a HUMAN. "0 are waiting" closes the console; the joiner
 * who is in fact waiting is never admitted. So on the operator's path, an unread queue must be a
 * REFUSAL, never a zero.
 *
 * The same reasoning applies one level down. `truncated` and `unreadable` are the relay saying
 * whether the page it sent was the whole queue. Reading them shape-trustingly (`truncated === true`)
 * makes a MALFORMED signal (`truncated: "yes"`) indistinguishable from a reassuring one, and a
 * consumer then prints "page complete" over a page it cannot vouch for.
 *
 * WHY `completeness` KEYS ON `truncated` ALONE
 * The first draft of this module called completeness "reported" when EITHER signal was present, and
 * its own test failed it: a body carrying `truncated: "yes"` (malformed) together with
 * `unreadable: []` (well-formed) was certified as reported, when in truth truncation was unknown.
 * Only `truncated` says whether the page was cut short, so only `truncated` can license the word
 * "complete". `unreadable` is a secondary signal: it can only ever ADD a caveat.
 *
 * CONTRACT (pinned by test/queue-read.test.mjs)
 *   read:false  => rows is null, never []      -- a caller cannot count rows it did not receive
 *   read:false  => caveats is non-empty
 *   requests:[] (field PRESENT) => read:true, rows []  -- a genuinely empty page is not an error
 *   `truncated` absent or malformed => completeness 'not-reported' + a caveat; "page complete" is
 *     unreachable without `truncated === false`
 *   `unreadable` absent or malformed => null + a caveat, never silently dropped to []
 *
 * Zero imports: this is inlined into the Worker bundle and must stay free of any dependency so the
 * console, the CLI and the Worker can never disagree about what the relay said.
 */

/** The relay told us whether this page was the whole queue. */
export const COMPLETENESS_REPORTED = 'reported';
/** The relay said nothing usable about completeness, so nobody can confirm everyone is listed. */
export const COMPLETENESS_NOT_REPORTED = 'not-reported';

/**
 * Turn a relay `/admission/requests` body into facts a caller can act on without guessing.
 *
 * @param {unknown} payload the parsed response body (any shape at all; that is the point)
 * @returns {{
 *   read: boolean, why: string, rows: Array|null, total: number|null,
 *   truncated: boolean|null, unreadable: Array<string>|null,
 *   completeness: string|null, caveats: Array<string>
 * }}
 */
export function readQueue(payload) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;

  // --- the refusal: no requests list means the queue was NOT read --------------------------------
  // `rows` is deliberately null rather than []. A caller that receives [] here would print "nobody
  // is waiting" -- the exact lie this module was written to make impossible. Null forces the caller
  // to handle "could not read" before it can count anything.
  if (!body || !Array.isArray(body.requests)) {
    const why = !body
      ? 'the relay answered with a body that is not an object'
      : body.requests === undefined
        ? 'the relay answered without a requests list'
        : 'the relay answered with a requests field that is not a list';
    return {
      read: false,
      why,
      rows: null,
      total: null,
      truncated: null,
      unreadable: null,
      completeness: null,
      caveats: [`${why} -- an unread queue is NOT an empty queue`],
    };
  }

  const caveats = [];

  // --- `truncated`: the KV binding's own list_complete signal, read strictly ---------------------
  let truncated = null;
  const truncatedAbsent = body.truncated === undefined;
  const truncatedMalformed = !truncatedAbsent && typeof body.truncated !== 'boolean';
  if (typeof body.truncated === 'boolean') {
    truncated = body.truncated;
  } else if (truncatedMalformed) {
    caveats.push('the relay sent a `truncated` value that is not true/false, so whether this page is the whole queue is NOT established');
  }

  // --- `unreadable`: entries that exist on the relay but could not be read -----------------------
  // Present-but-not-a-list is kept as "not known" (null + caveat). Coercing it to [] would erase a
  // reported problem, which is the same defect as dropping the entry in the first place.
  let unreadable = null;
  if (Array.isArray(body.unreadable)) {
    unreadable = body.unreadable.map((x) => String(x));
  } else if (body.unreadable !== undefined) {
    caveats.push('the relay sent an `unreadable` value that is not a list, so which entries could not be read is NOT established');
  }

  const total = Number.isFinite(body.total) ? body.total : null;

  // Only a well-typed `truncated` can license the word "complete".
  const completeness = truncated !== null ? COMPLETENESS_REPORTED : COMPLETENESS_NOT_REPORTED;

  if (completeness === COMPLETENESS_NOT_REPORTED) {
    if (!truncatedMalformed) {
      // Merge the `total` remark into this one when both are missing -- the deployed relay omits all
      // of them, and three warnings over one indistinguishable fact read as noise, which is how
      // warnings stop being read at all.
      caveats.push(total === null
        ? 'this relay does not report completeness (`truncated`, `unreadable` and `total` are all absent), so whether everyone waiting is listed here cannot be confirmed from this answer'
        : 'this relay does not report completeness (`truncated` is absent), so whether everyone waiting is listed here cannot be confirmed from this answer');
    }
  } else if (unreadable === null) {
    caveats.push('the relay did not report which entries could not be read (`unreadable` absent)');
  }

  if (truncated === true) {
    caveats.push('the relay says MORE requests are waiting than this page carries (`truncated: true`)');
  }
  if (unreadable && unreadable.length) {
    caveats.push(`${unreadable.length} entry(ies) exist on the relay but could NOT be read: ${unreadable.join(', ')}`);
  }

  return {
    read: true,
    why: 'the relay sent a requests list',
    rows: body.requests,
    total,
    truncated,
    unreadable,
    completeness,
    caveats,
  };
}

/**
 * One line for a console: is the row list in front of the human the whole story?
 * "page complete" is reachable ONLY from `truncated === false` plus an unreadable list that is
 * present and empty. Every other combination is a stated limit, never a clean bill of health.
 */
export function completenessLine(view) {
  if (!view || view.read !== true) return 'completeness UNKNOWN -- the queue was not read';
  if (view.truncated === null) return 'completeness NOT REPORTED by this relay';
  if (view.truncated === true) return 'INCOMPLETE -- more waiting than shown';
  if (view.unreadable === null) return 'page not truncated; unreadable entries not reported';
  if (view.unreadable.length) return `INCOMPLETE -- ${view.unreadable.length} entry(ies) unreadable`;
  return 'page complete';
}
