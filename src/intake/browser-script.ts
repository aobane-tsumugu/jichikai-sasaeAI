// 「送る」の画面でブラウザが動かす物。素の JavaScript を文字列で持ち、画面の HTML にそのまま入れる。
//
// 役目は二つ。
// 1. Word（.docx）と Excel（.xlsx）を、役員のブラウザで段落とセルに展開する（L-123）。Workers は展開しない。
//    zip を DecompressionStream で開き、XML を正規表現で読む。DOMParser は使わない（試験が Workers の中で動くため）。
// 2. 選んだ物と一行の文を、fetch で受付に送り、返事の文を画面に出す。
//
// 注意: この文字列の中に、バッククォートと ${ を書かない。
import { PHOTO_SCRIPT } from "./photo-script";
import { MAX_FILE_BYTES, MAX_PARTS, MAX_TOTAL_BYTES } from "./receive";

// 送れる数と大きさの上限は、受付（receive.ts）と同じ値を渡す。落とした時に、送る前に分かるように。
export const SEND_SCRIPT = PHOTO_SCRIPT + `var SEND_LIMITS = { parts: ${MAX_PARTS}, file: ${MAX_FILE_BYTES}, total: ${MAX_TOTAL_BYTES} };\n` + String.raw`(function (root) {
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
    async function bytes(name) {
        var e = entries[name];
        if (!e) return new Uint8Array(0);
        var start = e.lho + 30 + u16(d, e.lho + 26) + u16(d, e.lho + 28);
        var raw = d.subarray(start, start + e.csize);
        var result = e.method === 0 ? raw : e.method === 8 ? await inflateRaw(raw) : null;
        if (!result) throw new Error('zip method');
        return result;
    }
    return {
      has: function (name) { return !!entries[name]; },
      bytes: bytes,
      text: async function (name) { return new TextDecoder('utf-8').decode(await bytes(name)); }
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
          tables.push({ name: '表' + (tables.length + 1), rows: wTable(body.slice(start, m.index + m[0].length)) });
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

  function serialToText(serial, date1904, formatId, codes) {
    // Excelの日付の起点から1970年1月1日までの日数を引く。
    var d = new Date(Math.round((serial - (date1904 ? 24107 : 25569)) * 86400000));
    if (isNaN(d.getTime())) return String(serial);
    var iso = d.toISOString();
    // 時刻だけの書式には、資料にない日付を付けない。秒のある書式は秒も残す。
    var format = codes[formatId] || (formatId === 18 || formatId === 20 ? 'h:mm' : formatId === 19 || formatId === 21 ? 'h:mm:ss' : '');
    var clock = format.replace(/"[^"]*"|\\./g, '');
    // [h] などの経過時間は、時計の時刻とは分ける。
    if (!/\[[hms]+\]/i.test(clock)) {
      clock = clock.replace(/\[[^\]]*\]/g, '');
      if (!/[yd]/i.test(clock) && /[hs]/i.test(clock)) return iso.slice(11, /s/i.test(clock) ? 19 : 16);
    }
    return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }

  // 作った道具によっては要素にx: などの接頭辞が付く。読む前に外す
  async function sheetXml(zip, name) {
    return (await zip.text(name)).replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
  }

  async function extractXlsx(zip) {
    var wb = await sheetXml(zip, 'xl/workbook.xml');
    var date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(wb);
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
          inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g, function (mm, t) { value += unescapeXml(t); return ''; });
        } else if (v) {
          if (type === 's') value = shared[parseInt(v[1], 10)] || '';
          else if (type === 'b') value = v[1] === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'str' || type === 'e') value = unescapeXml(v[1]);
          else if (type === 'd') value = unescapeXml(v[1]);
          else value = isDateFormat(xfFormat[style], codes) && v[1] !== '' ? serialToText(parseFloat(v[1]), date1904, xfFormat[style], codes) : v[1];
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

  // ---- PowerPoint ----
  function pptXml(xml) {
    return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
  }

  function officePath(base, target) {
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return '';
    var parts = target.charAt(0) === '/' ? [] : base.split('/').slice(0, -1);
    target.split('/').forEach(function (part) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    });
    return parts.join('/');
  }

  async function pptRels(zip, path) {
    var slash = path.lastIndexOf('/');
    var xml = pptXml(await zip.text(path.slice(0, slash + 1) + '_rels/' + path.slice(slash + 1) + '.rels'));
    var rels = {};
    xml.replace(/<Relationship\b[^>]*>/g, function (tag) {
      if (attr(tag, 'TargetMode') !== 'External') rels[attr(tag, 'Id')] = { path: officePath(path, attr(tag, 'Target')), type: attr(tag, 'Type') };
      return '';
    });
    return rels;
  }

  function pptParagraphs(xml) {
    var list = [];
    xml.replace(/<p(?=[\s>])[^>]*>([\s\S]*?)<\/p>/g, function (_, inner) {
      var text = '';
      inner.replace(/<t(?:\s[^>]*)?>([^<]*)<\/t>|<br\b[^>]*\/>/g, function (tag, value) {
        text += value === undefined ? '\n' : unescapeXml(value);
        return '';
      });
      if (text.trim()) list.push(text);
      return '';
    });
    return list;
  }

  async function extractPptx(zip) {
    var presentation = pptXml(await zip.text('ppt/presentation.xml'));
    var rels = await pptRels(zip, 'ppt/presentation.xml');
    var slides = [];
    presentation.replace(/<sldId\b[^>]*>/g, function (tag) { slides.push(attr(tag, 'r:id')); return ''; });
    if (!slides.length) throw new Error('slides');
    var tables = [], images = [];
    for (var s = 0; s < slides.length; s++) {
      var rel = rels[slides[s]];
      if (!rel || !/\/slide$/.test(rel.type) || !zip.has(rel.path)) throw new Error('slide');
      var xml = pptXml(await zip.text(rel.path));
      var name = 'スライド' + (s + 1);
      var slideTables = [];
      var body = xml.replace(/<tbl\b[^>]*>([\s\S]*?)<\/tbl>/g, function (_, inner) {
        var rows = [];
        inner.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g, function (tag, row) {
          var cells = [];
          row.replace(/<tc\b[^>]*>([\s\S]*?)<\/tc>/g, function (cellTag, cell) { cells.push(pptParagraphs(cell).join('\n')); return ''; });
          rows.push(cells);
          return '';
        });
        slideTables.push({ name: name + ' 表' + (slideTables.length + 1), rows: rows });
        return '';
      });
      var paragraphs = pptParagraphs(body);
      tables.push({ name: name, rows: paragraphs.map(function (p) { return [p]; }) });
      tables = tables.concat(slideTables);
      var slideRels = await pptRels(zip, rel.path);
      // メモの文字はスライド本文の有無に含めない。
      var hasText = paragraphs.length || slideTables.some(function (table) {
        return table.rows.some(function (row) { return row.some(function (cell) { return cell.trim(); }); });
      });
      if (!hasText) {
        var seen = {};
        var imageCount = 0;
        var blips = /<blip\b[^>]*>/g, blip;
        while ((blip = blips.exec(xml)) !== null) {
          var imageRel = slideRels[attr(blip[0], 'r:embed')];
          if (!imageRel || !/\/image$/.test(imageRel.type) || imageRel.path.indexOf('ppt/media/') !== 0 || seen[imageRel.path]) continue;
          seen[imageRel.path] = true;
          if (!zip.has(imageRel.path)) throw new Error('slide image');
          var ext = imageRel.path.split('.').pop().toLowerCase();
          var mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' }[ext];
          // 写真と同じ道で読める画像だけを渡す。描き直す部品は足さない。
          if (mime) {
            imageCount++;
            images.push({ name: name + 'の画像' + (imageCount > 1 ? String(imageCount) : '') + '.' + ext, type: mime, bytes: await zip.bytes(imageRel.path) });
          }
        }
      }
      for (var id in slideRels) {
        var note = slideRels[id];
        if (!/\/notesSlide$/.test(note.type) || note.path.indexOf('ppt/notesSlides/') !== 0) continue;
        var notesXml = pptXml(await zip.text(note.path));
        // スライドの縮小図、ページ番号、日付などの欄をメモの本文に混ぜない。
        notesXml = notesXml.replace(/<sp\b[^>]*>([\s\S]*?)<\/sp>/g, function (tag, inner) {
          var placeholder = /<ph\b[^>]*>/.exec(inner);
          return placeholder && /^(sldImg|sldNum|dt|hdr|ftr)$/.test(attr(placeholder[0], 'type')) ? '' : tag;
        });
        var notes = pptParagraphs(notesXml);
        if (notes.length) tables.push({ name: name + ' メモ', rows: notes.map(function (p) { return [p]; }) });
      }
    }
    return { format: 'pptx', paragraphs: [], tables: tables, images: images };
  }

  async function extractOffice(buffer) {
    var zip = await readZip(buffer);
    var result;
    if (zip.has('word/document.xml')) result = await extractDocx(zip);
    else if (zip.has('xl/workbook.xml')) result = await extractXlsx(zip);
    else if (zip.has('ppt/presentation.xml')) result = await extractPptx(zip);
    else throw new Error('office');
    var core = await zip.text('docProps/core.xml');
    ['modified', 'created'].some(function (key) {
      var match = new RegExp('<dcterms:' + key + '(?:\\s[^>]*)?>([^<]*)</dcterms:' + key + '>').exec(core);
      var date = match ? unescapeXml(match[1]).trim() : '';
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(date) || !Number.isFinite(Date.parse(date))) return false;
      result.documentDate = date;
      result.documentDateSource = 'office_' + key;
      return true;
    });
    return result;
  }

  root.__sendOffice = { extractOffice: extractOffice };
  if (typeof document === 'undefined') return;

  // ---- 画面 ----
  var form = document.getElementById('send-form');
  if (!form) return;
  var statusEl = document.getElementById('send-status');
  var button = document.getElementById('send-button');

  // パソコンから落としたファイル。選んだファイルと合わせて送る。
  var dropped = [];
  var limits = root.SEND_LIMITS || { parts: 30, file: 25 * 1024 * 1024, total: 80 * 1024 * 1024 };
  var mb = function (bytes) { return Math.ceil(bytes / 1024 / 1024); };

  function say(message, isError) {
    statusEl.textContent = message;
    statusEl.className = isError ? 'notice error' : 'notice';
  }

  function pickedFiles(extra) {
    var picked = [];
    [['cam', 'photo'], ['files', 'file']].forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el && el.files) Array.prototype.forEach.call(el.files, function (f) { picked.push({ file: f, kind: pair[1] }); });
    });
    dropped.concat(extra || []).forEach(function (f) { picked.push({ file: f, kind: 'file' }); });
    return picked;
  }

  // 写真は送る前に小さく整える（長い辺 2400、5MB まで）ので、元の大きさでは断らない。
  var isPhotoFile = function (f) { return /^image\//i.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name); };
  var sentSize = function (f) { return isPhotoFile(f) ? Math.min(f.size, 5 * 1024 * 1024) : f.size; };

  // 上限を超えた時の文。超えていなければ空。
  function limitError(picked) {
    if (picked.length > limits.parts) return '一度に送れるのは' + limits.parts + '点までです。今は' + picked.length + '点あります。分けて送ってください。';
    var big = picked.filter(function (p) { return !isPhotoFile(p.file) && p.file.size > limits.file; });
    if (big.length) return big.map(function (p) { return '「' + p.file.name + '」'; }).join('、') + 'は' + mb(limits.file) + 'MBを超えているので送れません。ファイルを分けて送ってください。';
    var total = picked.reduce(function (sum, p) { return sum + sentSize(p.file); }, 0);
    if (total > limits.total) return '合わせて' + mb(limits.total) + 'MBまで送れます。今は' + mb(total) + 'MBあります。分けて送ってください。';
    return '';
  }

  var dropCount = document.getElementById('drop-count');
  function showDropped() {
    if (dropCount) dropCount.textContent = dropped.length ? '落としたファイル' + dropped.length + '件: ' + dropped.map(function (f) { return f.name; }).join('、') : '';
  }

  [['cam', 'cam-count'], ['files', 'files-count']].forEach(function (pair) {
    var input = document.getElementById(pair[0]);
    var count = document.getElementById(pair[1]);
    if (!input || !count || typeof input.addEventListener !== 'function') return;
    input.addEventListener('change', function () {
      count.textContent = input.files && input.files.length ? input.files.length + '件を選びました' : '';
      var error = limitError(pickedFiles());
      if (error) say(error, true);
    });
  });

  var zone = document.getElementById('drop-zone');
  // 欄の外に落としても、ブラウザがファイルを開いて画面から離れないように、画面のどこに落としても受け取る。
  if (zone && typeof document.addEventListener === 'function') {
    ['dragenter', 'dragover'].forEach(function (name) {
      document.addEventListener(name, function (ev) { ev.preventDefault(); zone.className = 'drop-zone over'; });
    });
    document.addEventListener('dragleave', function (ev) { if (!ev.relatedTarget) zone.className = 'drop-zone'; });
    document.addEventListener('drop', function (ev) {
      ev.preventDefault();
      zone.className = 'drop-zone';
      var list = ev.dataTransfer && ev.dataTransfer.files ? Array.prototype.slice.call(ev.dataTransfer.files) : [];
      if (!list.length) return;
      var error = limitError(pickedFiles(list));
      if (error) { say(error + '（落としたファイルは入れていません）', true); return; }
      dropped = dropped.concat(list);
      showDropped();
      say('「送る」を押すと、落としたファイルも送ります。', false);
    });
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var picked = pickedFiles();
    var text = form.elements['text'].value;
    if (picked.length === 0 && text.trim() === '') { say('送るものを選ぶか、一行の文を書いてください。', true); return; }
    // 古い形式（.doc、.xls）は、そのまま送ってWorkerで読み取る。
    var tooMuch = limitError(picked);
    if (tooMuch) { say(tooMuch, true); return; }
    button.disabled = true;
    say('送っています…', false);
    try {
      var fd = new FormData();
      fd.append('project_id', form.elements['project_id'] ? form.elements['project_id'].value : '');
      fd.append('text', text);
      var sentParts = [];
      for (var i = 0; i < picked.length; i++) {
        var f = picked[i].file;
        if (picked[i].kind === 'photo' && typeof BarcodeDetector !== 'undefined') {
          try {
            var detector = new BarcodeDetector({ formats: ['qr_code'] });
            var codes = await detector.detect(f);
            for (var q = 0; q < codes.length; q++) if (codes[q].rawValue) fd.append('paper_qr', codes[q].rawValue);
          } catch (ignored) { /* この端末で読めないときは符号を送らず、読み取りへ進む */ }
        }
        var extracted = '';
        var slideImages = [];
        if (/\.(docx|xlsx|pptx)$/i.test(f.name) || f.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
          try {
            var office = await extractOffice(await f.arrayBuffer());
            slideImages = office.images || [];
            delete office.images;
            extracted = JSON.stringify(office);
          }
          catch (e) { say('「' + f.name + '」を開けませんでした。Word、Excel、PowerPointの新しい形式（.docx、.xlsx、.pptx）で保存し直してください。', true); button.disabled = false; return; }
        }
        var uploads = [{ file: f, kind: picked[i].kind, extracted: extracted }];
        slideImages.forEach(function (img) {
          var imageFile = new File([img.bytes], f.name.replace(/\.[^.]*$/, '') + ' ' + img.name, { type: img.type, lastModified: f.lastModified });
          uploads.push({ file: imageFile, kind: 'photo', extracted: '' });
        });
        for (var u = 0; u < uploads.length; u++) {
          var upload = uploads[u];
          var prepared = await root.__sendPhoto.preparePhoto(upload.file);
          sentParts.push({ file: prepared.file });
          var expandedError = limitError(sentParts);
          if (expandedError) { say(expandedError, true); button.disabled = false; return; }
          fd.append('part', prepared.file, prepared.sourceHash ? upload.file.name.replace(/\.[^.]*$/, '') + '.jpg' : upload.file.name);
          fd.append('part_kind', upload.kind);
          fd.append('part_extracted', upload.extracted);
          fd.append('part_source_hash', prepared.sourceHash);
          fd.append('part_last_modified', String(prepared.lastModified || ''));
        }
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
        dropped = [];
        showDropped();
        if (data.redirectTo) location.assign(data.redirectTo);
        else location.reload();
      }
    } catch (e) {
      say('送れませんでした。電波を確かめて、もう一度送ってください。', true);
    }
    button.disabled = false;
  });
})(typeof window !== 'undefined' ? window : globalThis);
`;
