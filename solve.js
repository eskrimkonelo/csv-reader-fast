// A faster drop-in for csv-reader 1.0.0: readCsv, answered exactly as the reference does,
// but by delimiter scanning with slice() instead of one character at a time.
//
// The reference reads a CSV text once, left to right, by a written broken-row policy; this
// module keeps every rule of it and only changes how the text is walked:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it
//     one quote, and each CRLF or lone CR inside it is read as LF; what follows its closing
//     quote, up to the next comma or line break, is appended to it as it stands (quote_junk,
//     when the field ends); a quote that never closes is a literal character and the text
//     after it is read again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF,
//     CRLF and lone CR inside a quoted field counted), row its record's index in rows (null
//     for the header), in the order met, a field's quote_junk when the field ends and a
//     record's short_row or long_row when the record ends.
//
// Speed comes from scans, never from one character at a time. A record with no quote before
// its line break is split wholesale (slice + split(',')). Any other field is taken with one
// slice() up to the next comma or the record's line end (recEol, the next LF, found once per
// record and refreshed only when a quoted field crosses a line break); a field is only ever
// built up a piece at a time when a stray CR falls inside it, which is rare. A quoted field
// is found by indexOf('"'), its doubled quotes by the next indexOf('"') after that. Field
// readers report through shared variables instead of allocating a result per field, and line
// numbers are kept exactly: a quoted field's line breaks are counted in a local tally and
// added only once the field is known to close, so a quote that never closes leaves the line
// where it opened, as the reference does.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors} (the header). */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The first LF at or after the current field's start (n when there is none left): the line
  // break an unquoted field can end at. Set at each record's start and refreshed only when a
  // quoted field crosses a line break, which is the only way the next LF moves past it.
  let recEol = n;

  // What the last field read was: its value, how it ended, and how many characters an unquoted
  // read of it kept (what quote_junk looks at). Shared so no result object is made per field.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // How many line breaks the last normalize() call found in its segment.
  let normBreaks = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters from pos up to the next comma or line break: a CR not followed by LF
  // is dropped (stray_cr) and the field goes on. `init` is the value already read (the quoted part
  // of a field whose closing quote was followed by junk, or '"' for a quote that never closed);
  // `added` counts the characters this read keeps, which is what quote_junk looks at.
  function readUnquoted(init, added) {
    const p = pos;
    const c = text.indexOf(',', p);
    let end;
    let ended;
    if (c !== -1 && c < recEol) {
      end = c;
      ended = COMMA;
    } else if (recEol < n) {
      end = recEol;
      ended = LINE_BREAK;
    } else {
      end = n;
      ended = END;
    }
    const seg = text.slice(p, end);
    let value;
    if (seg.indexOf('\r') === -1) {
      value = init === '' ? seg : init + seg;
      added += seg.length;
    } else {
      // Every CR in seg is stray, except a trailing one when the field ends at a CRLF line
      // break: no comma or LF sits inside seg, so a CR in it cannot be followed by LF except
      // that trailing one, which is followed by the LF at end.
      const crlfTail = ended === LINE_BREAK && seg.charCodeAt(seg.length - 1) === 13;
      const body = crlfTail ? seg.slice(0, -1) : seg;
      const parts = body.split('\r');
      for (let k = 1; k < parts.length; k++) error('stray_cr');
      value = parts.length === 1 ? (init === '' ? body : init + body) : init + parts.join('');
      added += value.length - init.length;
    }
    pos = ended === END ? n : end + 1;
    if (ended === LINE_BREAK) line += 1;
    fValue = value;
    fEnded = ended;
    fAdded = added;
  }

  // A quoted segment's value with every CRLF or lone CR in it read as LF; how many line breaks
  // it held lands in normBreaks. Segments with no line break at all come back untouched.
  function normalize(seg) {
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') === -1) {
        normBreaks = 0;
        return seg;
      }
      let breaks = 0;
      let i = -1;
      while ((i = seg.indexOf('\n', i + 1)) !== -1) breaks += 1;
      normBreaks = breaks;
      return seg;
    }
    const found = seg.match(/\r\n?|\n/g);
    normBreaks = found === null ? 0 : found.length;
    return seg.replace(/\r\n?/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let lineDelta = 0; // line breaks inside, added to line only once the field is known to close
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as an unquoted field. The line goes back to where the quote opened, and the
        // next LF is still recEol: no LF was crossed between where it was found and the open.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        readUnquoted('"', 0);
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // '""': one quote, and the field goes on.
        value += normalize(text.slice(p, q));
        lineDelta += normBreaks;
        value += '"';
        p = q + 2;
        continue;
      }
      value += normalize(text.slice(p, q));
      lineDelta += normBreaks;
      line += lineDelta;
      pos = q + 1;
      // The field crossed line breaks: the next LF from here is no longer recEol.
      if (lineDelta > 0) {
        const e = text.indexOf('\n', pos);
        recEol = e === -1 ? n : e;
      }
      break;
    }
    if (pos >= n) {
      fValue = value;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value, 0);
    if (fAdded > 0) error('quote_junk');
  }

  // A record's fields, padded with "" or cut to the first record's width, with its short_row or
  // long_row error; the header record is kept as columns instead.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // A record with no quote before its line break holds no quoted field: its fields are plain
    // text up to the break, split wholesale, unless a stray CR sits inside it. The quote and CR
    // checks run on the record's own line only, never past its break.
    const eol = text.indexOf('\n', pos);
    const eolIdx = eol === -1 ? n : eol;
    recEol = eolIdx;
    const lineText = text.slice(pos, eolIdx);
    if (lineText.indexOf('"') === -1) {
      const r = lineText.indexOf('\r');
      const crlf = eolIdx < n && lineText.charCodeAt(lineText.length - 1) === 13;
      if (r === -1 || (crlf && r === lineText.length - 1)) {
        const fields = (crlf ? lineText.slice(0, -1) : lineText).split(',');
        pos = eolIdx < n ? eolIdx + 1 : n;
        if (eolIdx < n) line += 1;
        finishRecord(fields);
        continue;
      }
    }

    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('', 0);
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
