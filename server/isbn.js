'use strict';

/* ISBN 校验与转换（支持扫码得到的 EAN-13 / ISBN-10，含 978/979 前缀） */

function digitsOf(input) {
  return String(input == null ? '' : input)
    .toUpperCase()
    .replace(/[^0-9X]/g, '');
}

function isValidIsbn10(raw) {
  const s = digitsOf(raw);
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = s[i];
    const v = ch === 'X' ? 10 : Number(ch);
    sum += v * (10 - i);
  }
  return sum % 11 === 0;
}

function isValidIsbn13(raw) {
  const s = digitsOf(raw);
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

function isbn10to13(raw) {
  const s = digitsOf(raw);
  if (!/^\d{9}[\dX]$/.test(s)) return '';
  const core = `978${s.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return core + String((10 - (sum % 10)) % 10);
}

function isbn13to10(raw) {
  const s = digitsOf(raw);
  if (!/^978\d{10}$/.test(s)) return '';
  const core = s.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(core[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : String(check));
}

/**
 * 归一化任意输入（扫码结果 / 手输 / 带横杠）
 * @returns {{ok:boolean, isbn13:string, isbn10:string, reason?:string}}
 */
function normalize(input) {
  const s = digitsOf(input);
  if (!s) return { ok: false, isbn13: '', isbn10: '', reason: '内容为空' };
  if (s.length === 13) {
    if (!/^(978|979)/.test(s)) return { ok: false, isbn13: '', isbn10: '', reason: '不是图书 EAN（非 978/979 开头）' };
    if (!isValidIsbn13(s)) return { ok: false, isbn13: '', isbn10: '', reason: 'ISBN-13 校验位不正确' };
    return { ok: true, isbn13: s, isbn10: isbn13to10(s) };
  }
  if (s.length === 10) {
    if (!isValidIsbn10(s)) return { ok: false, isbn13: '', isbn10: '', reason: 'ISBN-10 校验位不正确' };
    return { ok: true, isbn13: isbn10to13(s), isbn10: s };
  }
  return { ok: false, isbn13: '', isbn10: '', reason: `长度 ${s.length} 不是有效 ISBN` };
}

/** 从任意文本里"抠"出 ISBN（用于 OCR/粘贴的整段文字） */
function findIsbnInText(text) {
  const candidates = String(text || '').match(/(?:97[89][\d\-\s]{9,17}|[\d\-\s]{9,16}[\dXx])/g) || [];
  for (const c of candidates) {
    const r = normalize(c);
    if (r.ok) return r;
  }
  return { ok: false, isbn13: '', isbn10: '' };
}

module.exports = { normalize, isValidIsbn10, isValidIsbn13, isbn10to13, isbn13to10, findIsbnInText, digitsOf };
