/**
 * 极简 xlsx 生成器（M5）—— **零三方依赖**，产出 Excel/WPS 可直接打开的 .xlsx。
 *
 * 为什么手写而不引 exceljs/xlsx：
 *   本工程一贯「能自己写就不引三方」（见 providers/http.ts 手写 HTTP 客户端）。
 *   导出场景只是「几张表 → 单元格文本」，用不到 exceljs 的样式/公式/流式能力，
 *   为此把一个几百 KB 的库打进 Electron 包不划算。
 *
 * xlsx 本质 = 一个 ZIP 容器 + 若干 XML。这里：
 *   - ZIP 用 **STORED（不压缩）**，条目头/中央目录手写，CRC32 取 node:zlib.crc32（Node≥20.15）；
 *     不压缩体积换实现简单与零风险（xlsx 文本本身压不大，报告通常几百 KB）。
 *   - 单元格一律用 **inlineStr**（内联字符串），免去 sharedStrings 部件与索引对齐。
 *
 * 边界（刻意不做，避免假功能）：不支持样式/公式/合并单元格/多 sheet 样式。
 * 单元格值支持 number / string / boolean / null；日期一律由调用方格式化成字符串。
 */
import { crc32 } from 'node:zlib';

/** 一张表：名字 + 二维数据（首行通常是表头） */
export interface XlsxSheet {
  name: string; // ≤31 字符，且不能含 : \ / ? * [ ]
  rows: (string | number | boolean | null)[][];
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // 去掉 XML 1.0 非法控制字符，否则 Excel 报「文件损坏」
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/** sheet 名清洗：去非法字符、截断 31、去首尾单引号（Excel 规则） */
function safeSheetName(name: string, used: Set<string>): string {
  let n = (name || 'Sheet').replace(/[:\\/?*[\]]/g, '_').slice(0, 31).replace(/^'+|'+$/g, '');
  if (n === '') n = 'Sheet';
  let out = n;
  let i = 2;
  while (used.has(out)) {
    const suffix = `_${i}`;
    out = `${n.slice(0, 31 - suffix.length)}${suffix}`;
    i++;
  }
  used.add(out);
  return out;
}

/** 列号 → 字母（0→A, 25→Z, 26→AA） */
function colName(idx: number): string {
  let s = '';
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function cellXml(rowIdx: number, colIdx: number, v: string | number | boolean | null): string {
  const ref = `${colName(colIdx)}${rowIdx + 1}`;
  if (v === null || v === undefined || v === '') return `<c r="${ref}"/>`;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return `<c r="${ref}" t="inlineStr"><is><t>${escXml(String(v))}</t></is></c>`;
    return `<c r="${ref}"><v>${v}</v></c>`;
  }
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(String(v))}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const rows = sheet.rows
    .map((row, r) => {
      if (row.length === 0) return '';
      const cells = row.map((v, c) => cellXml(r, c, v)).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

// ---------------------------------------------------------------------------
// 极简 ZIP（STORED）
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  offset: number;
}

function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const entries: ZipEntry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    entries.push({ name: f.name, data: f.data, crc, offset });
    // local file header：PK\x03\x04, version=20, flags=0x0800(UTF-8), method=0(STORED)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (固定值，保证可复现)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18); // compressed size
    local.writeUInt32LE(f.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, f.data);
    offset += local.length + nameBuf.length + f.data.length;
  }

  const centralStart = offset;
  const central: Buffer[] = [];
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10); // stored
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(e.offset, 42);
    central.push(cd, nameBuf);
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/**
 * 生成 xlsx 二进制。
 * @param sheets 各表；sheet 名自动去重/截断到 31 字符
 */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [['空']] }];
  const used = new Set<string>();
  const named = list.map((s) => ({ ...s, name: safeSheetName(s.name, used) }));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`;

  const files: { name: string; data: Buffer }[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s), 'utf8') })),
  ];

  return zipStore(files);
}
