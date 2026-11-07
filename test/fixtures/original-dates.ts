// U89のための架空資料。実在の資料は含まない。
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 試験用の zip を作る。method 0（そのまま）と 8（deflate）の両方を試せる。 */
export async function makeOriginalDateZip(files: Record<string, string>, deflate: boolean): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const data = deflate ? await deflateRaw(raw) : raw;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(8, deflate ? 8 : 0, true);
    header.setUint32(14, crc32(raw), true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(header.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, deflate ? 8 : 0, true);
    entry.setUint32(16, crc32(raw), true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export async function fictionalDatedWord(value: string, modified?: string, created?: string): Promise<Uint8Array> {
  return makeOriginalDateZip({
    "word/document.xml": '<w:document xmlns:w="urn:fictional"><w:body><w:p><w:r><w:t>収穫祭の案内（架空）。2025年。返事の締切は' + value + '。' + (value === "10月3日" ? "抽選会はありません。変更しました。" : "抽選会があります。") + '</w:t></w:r></w:p></w:body></w:document>',
    "docProps/core.xml": '<cp:coreProperties xmlns:cp="urn:fictional" xmlns:dcterms="http://purl.org/dc/terms/">' + (modified ? '<dcterms:modified xsi:type="dcterms:W3CDTF">' + modified + '</dcterms:modified>' : '') + (created ? '<dcterms:created>' + created + '</dcterms:created>' : '') + '</cp:coreProperties>',
  }, true);
}
