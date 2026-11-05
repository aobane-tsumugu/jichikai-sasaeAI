// 「送る」の画面でブラウザが動かす物。素の JavaScript を文字列で持ち、画面の HTML にそのまま入れる。
//
// 役目は二つ。
// 1. Word（.docx）と Excel（.xlsx）を、役員のブラウザで段落とセルに展開する（L-123）。Workers は展開しない。
//    zip を DecompressionStream で開き、XML を正規表現で読む。DOMParser は使わない（試験が Workers の中で動くため）。
// 2. 選んだ物と一行の文を、fetch で受付に送り、返事の文を画面に出す。
//
// 注意: この文字列の中に、バッククォートと ${ を書かない。
export const SEND_SCRIPT = String.raw`(function (root) {
  'use strict';

  function u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }

  async function inflateRaw(data) {
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZip(buffer) {
    var d = new Uint8Array(buffer);
    var eocd = -1;
    for (var i = d.length - 22; i >= Math.max(0, d.length - 22 - 65535); i--) {
      if (d[i] === 0x50 && d[i + 1] === 0x4b && d[i + 2] === 5 && d[i + 3] === 6) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip');
    var count = u16(d, eocd + 10);
    var p = u32(d, eocd + 16);
    var entries = {};
    for (var n = 0; n < count; n++) {
      if (u32(d, p) !== 0x02014b50) throw new Error('zip');
      var nlen = u16(d, p + 28), elen = u16(d, p + 30), clen = u16(d, p + 32);
      var name = new TextDecoder().decode(d.subarray(p + 46, p + 46 + nlen));
      entries[name] = { method: u16(d, p + 10), csize: u32(d, p + 20), lho: u32(d, p + 42) };
      p += 46 + nlen + elen + clen;
    }
    return {
      has: function (name) { return !!entries[name]; },
      text: async function (name) {
        var e = entries[name];
        if (!e) return '';
        var start = e.lho + 30 + u16(d, e.lho + 26) + u16(d, e.lho + 28);
        var raw = d.subarray(start, start + e.csize);
        var bytes = e.method === 0 ? raw : e.method === 8 ? await inflateRaw(raw) : null;
        if (!bytes) throw new Error('zip method');
        return new TextDecoder('utf-8').decode(bytes);
      }
    };
  }

  function unescapeXml(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (m, g) {
      if (g === 'amp') return '&';
      if (g === 'lt') return '<';
      if (g === 'gt') return '>';
      if (g === 'quot') return '"';
      if (g === 'apos') return "'";
      var code = g.charAt(1) === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (e) { return ''; }
    });
  }

  function attr(tag, name) {
    var m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(tag);
    return m ? unescapeXml(m[1]) : '';
  }

  // ---- Word ----
  function wText(xml) {
    var out = '';
    var re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/>|<w:cr\s*\/>/g;
    var m;
    while ((m = re.exec(xml)) !== null) {
      if (m[1] !== undefined) out += unescapeXml(m[1]);
      else if (m[0].indexOf('w:tab') === 1) out += '\t';
      else out += '\n';
    }
    return out;
  }

  function wParagraphs(xml) {
    var list = [];
    var re = /<w:p(?=[\s>])[^>]*>([\s\S]*?)<\/w:p>/g;
    var m;
    while ((m = re.exec(xml)) !== null) list.push(wText(m[1]));
    return list;
  }

  function wTable(xml) {
    var rows = [];
    var reRow = /<w:tr(?=[\s>])[^>]*>([\s\S]*?)<\/w:tr>/g;
    var r;
    while ((r = reRow.exec(xml)) !== null) {
      var cells = [];
      var reCell = /<w:tc(?=[\s>])[^>]*>([\s\S]*?)<\/w:tc>/g;
      var c;
      while ((c = reCell.exec(r[1])) !== null) cells.push(wParagraphs(c[1]).join('\n'));
      rows.push(cells);
    }
    return rows;
  }

  async function extractDocx(zip) {
    var xml = await zip.text('word/document.xml');
    var bodyStart = xml.indexOf('<w:body');
    var body = bodyStart >= 0 ? xml.slice(xml.indexOf('>', bodyStart) + 1) : xml;
    var tokens = /<w:tbl(?=[\s>])|<\/w:tbl>/g;
    var depth = 0, start = 0, last = 0, m;
    var paragraphs = [], tables = [];
    while ((m = tokens.exec(body)) !== null) {
      if (m[0] === '</w:tbl>') {
        depth -= 1;
        if (depth === 0) {
          tables.push({ name: '表 ' + (tables.length + 1), rows: wTable(body.slice(start, m.index + m[0].length)) });
          last = m.index + m[0].length;
        }
      } else {
        if (depth === 0) { paragraphs = paragraphs.concat(wParagraphs(body.slice(last, m.index))); start = m.index; }
        depth += 1;
      }
    }
    paragraphs = paragraphs.concat(wParagraphs(body.slice(last)));
    return { format: 'docx', paragraphs: paragraphs, tables: tables };
  }

  // ---- Excel ----
  function colIndex(ref) {
    var letters = /^[A-Z]+/.exec(ref);
    var n = 0;
    if (!letters) return 0;
    for (var i = 0; i < letters[0].length; i++) n = n * 26 + (letters[0].charCodeAt(i) - 64);
    return n - 1;
  }

  function isDateFormat(id, codes) {
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true;
    var code = codes[id];
    if (!code) return false;
    return /[ymdhs]/i.test(code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''));
  }

  function serialToText(serial) {
    var d = new Date(Math.round((serial - 25569) * 86400000));
    if (isNaN(d.getTime())) return String(serial);
    var iso = d.toISOString();
    return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }

  // 作った道具によっては要素に x: などの接頭辞が付く。読む前に外す
  async function sheetXml(zip, name) {
    return (await zip.text(name)).replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
  }

  async function extractXlsx(zip) {
    var wb = await sheetXml(zip, 'xl/workbook.xml');
    var rels = await zip.text('xl/_rels/workbook.xml.rels');
    var relTarget = {};
    rels.replace(/<Relationship\b[^>]*>/g, function (tag) { relTarget[attr(tag, 'Id')] = attr(tag, 'Target'); return ''; });

    var shared = [];
    var sstXml = await sheetXml(zip, 'xl/sharedStrings.xml');
    sstXml.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, function (m, inner) {
      var text = '';
      inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g, function (mm, t) { text += unescapeXml(t); return ''; });
      shared.push(text);
      return '';
    });

    var codes = {};
    var xfFormat = [];
    var styles = await sheetXml(zip, 'xl/styles.xml');
    styles.replace(/<numFmt\b[^>]*>/g, function (tag) { codes[parseInt(attr(tag, 'numFmtId'), 10)] = attr(tag, 'formatCode'); return ''; });
    var xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
    if (xfs) xfs[1].replace(/<xf\b[^>]*>/g, function (tag) { xfFormat.push(parseInt(attr(tag, 'numFmtId') || '0', 10)); return ''; });

    var tables = [];
    var sheets = [];
    wb.replace(/<sheet\b[^>]*>/g, function (tag) { sheets.push({ name: attr(tag, 'name'), rid: attr(tag, 'r:id') }); return ''; });
    var cells = 0;
    for (var s = 0; s < sheets.length; s++) {
      var target = relTarget[sheets[s].rid] || '';
      var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target;
      var xml = await sheetXml(zip, path);
      var grid = [];
      var maxRow = 0;
      var reCell = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      var m;
      while ((m = reCell.exec(xml)) !== null) {
        var ref = attr(m[1], 'r');
        var type = attr(m[1], 't');
        var style = parseInt(attr(m[1], 's') || '0', 10);
        var inner = m[2] || '';
        var v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        var value = '';
        if (type === 'inlineStr') {
          inner.replace(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g, function (mm, t) { value += unescapeXml(t); return ''; });
        } else if (v) {
          if (type === 's') value = shared[parseInt(v[1], 10)] || '';
          else if (type === 'b') value = v[1] === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'str' || type === 'e') value = unescapeXml(v[1]);
          else value = isDateFormat(xfFormat[style], codes) && v[1] !== '' ? serialToText(parseFloat(v[1])) : v[1];
        }
        if (value === '') continue;
        var rowMatch = /\d+$/.exec(ref);
        if (!rowMatch) continue;
        var row = parseInt(rowMatch[0], 10) - 1;
        var col = colIndex(ref);
        if (!grid[row]) grid[row] = [];
        grid[row][col] = value;
        if (row + 1 > maxRow) maxRow = row + 1;
        cells += 1;
        if (cells > 200000) throw new Error('large');
      }
      var rows = [];
      for (var r = 0; r < maxRow; r++) {
        var line = grid[r] || [];
        var out = [];
        for (var c = 0; c < line.length; c++) out.push(line[c] === undefined ? '' : line[c]);
        rows.push(out);
      }
      tables.push({ name: sheets[s].name, rows: rows });
    }
    return { format: 'xlsx', paragraphs: [], tables: tables };
  }

  async function extractOffice(buffer) {
    var zip = await readZip(buffer);
    if (zip.has('word/document.xml')) return extractDocx(zip);
    if (zip.has('xl/workbook.xml')) return extractXlsx(zip);
    throw new Error('office');
  }

  root.__sendOffice = { extractOffice: extractOffice };
  if (typeof document === 'undefined') return;

  // ---- 画面 ----
  var form = document.getElementById('send-form');
  if (!form) return;
  var statusEl = document.getElementById('send-status');
  var button = document.getElementById('send-button');

  function say(message, isError) {
    statusEl.textContent = message;
    statusEl.className = isError ? 'notice error' : 'notice';
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var picked = [];
    [['cam', 'photo'], ['files', 'file']].forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el && el.files) Array.prototype.forEach.call(el.files, function (f) { picked.push({ file: f, kind: pair[1] }); });
    });
    var text = form.elements['text'].value;
    if (picked.length === 0 && text.trim() === '') { say('送る物を選ぶか、一行の文を書いてください。', true); return; }
    button.disabled = true;
    say('送っています…', false);
    try {
      var fd = new FormData();
      fd.append('project_id', form.elements['project_id'] ? form.elements['project_id'].value : '');
      fd.append('text', text);
      for (var i = 0; i < picked.length; i++) {
        var f = picked[i].file;
        if (picked[i].kind === 'photo' && typeof BarcodeDetector !== 'undefined') {
          try {
            var detector = new BarcodeDetector({ formats: ['qr_code'] });
            var codes = await detector.detect(f);
            for (var q = 0; q < codes.length; q++) if (codes[q].rawValue) fd.append('paper_qr', codes[q].rawValue);
          } catch (ignored) { /* この端末で読めない時は符号を送らず、読み取りへ進む */ }
        }
        var extracted = '';
        if (/\.(docx|xlsx)$/i.test(f.name)) {
          try { extracted = JSON.stringify(await extractOffice(await f.arrayBuffer())); }
          catch (e) { say('「' + f.name + '」を開けませんでした。Word か Excel の新しい形式（.docx、.xlsx）で保存し直してください。', true); button.disabled = false; return; }
        }
        fd.append('part', f, f.name);
        fd.append('part_kind', picked[i].kind);
        fd.append('part_extracted', extracted);
      }
      var res = await fetch(form.action, { method: 'POST', body: fd, headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!(res.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
        var html = await res.text();
        document.open();
        document.write(html);
        document.close();
        return;
      }
      var data = await res.json();
      say(data.message, !data.ok);
      if (data.ok) {
        form.reset();
        setTimeout(function () {
          if (data.redirectTo) location.assign(data.redirectTo);
          else location.reload();
        }, 1500);
      }
    } catch (e) {
      say('送れませんでした。電波を確かめて、もう一度送ってください。', true);
    }
    button.disabled = false;
  });
})(typeof window !== 'undefined' ? window : globalThis);
`;
