/* Tự sinh bởi tools/build-web.js từ renderer/csharp-editor.js — đừng sửa tay */
/* GoPro — tô màu cú pháp & trình soạn code nhẹ cho phần học C# */
'use strict';

// ===== Tô màu cú pháp =====
const CS_KEYWORDS = new Set(
  ('abstract as base break case catch checked class const continue default delegate do else enum event explicit extern ' +
    'false finally fixed for foreach goto if implicit in interface internal is lock namespace new null operator out override ' +
    'params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw true try ' +
    'typeof unchecked unsafe using virtual volatile while async await var get set init value yield when where record required ' +
    'with and or not global partial file scoped nameof let from select group by orderby ascending descending join on equals into')
    .split(' ')
);
const CS_TYPES = new Set(
  'bool byte sbyte char decimal double float int uint long ulong short ushort object string void dynamic nint nuint'.split(' ')
);
const SQL_KEYWORDS = new Set(
  ('select from where insert into values update set delete create table alter drop primary key foreign references join inner ' +
    'left right outer on group by order having as and or not null is in between like distinct count sum avg min max limit offset ' +
    'fetch next rows only top index unique default constraint begin commit rollback transaction asc desc case when then else end ' +
    'int integer varchar nvarchar text decimal datetime date bit identity autoincrement exists union all cascade view')
    .split(' ')
);

function hlEsc(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function highlightCs(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  const push = (cls, text) => {
    out += cls ? `<span class="tk-${cls}">${hlEsc(text)}</span>` : hlEsc(text);
  };
  let lineStart = true;
  while (i < n) {
    const c = code[i];
    const rest2 = code.substr(i, 2);
    // Comment
    if (rest2 === '//') {
      let j = code.indexOf('\n', i);
      if (j < 0) j = n;
      push('com', code.slice(i, j));
      i = j;
      continue;
    }
    if (rest2 === '/*') {
      let j = code.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      push('com', code.slice(i, j));
      i = j;
      continue;
    }
    // Preprocessor
    if (c === '#' && lineStart) {
      let j = code.indexOf('\n', i);
      if (j < 0) j = n;
      push('pre', code.slice(i, j));
      i = j;
      continue;
    }
    // String literals: raw """, verbatim @"", interpolated $"", $@"", @$""
    const m = code.slice(i, i + 4).match(/^(\$+@?|@\$+|@)?"/);
    if (m) {
      const prefix = m[1] || '';
      let j = i + prefix.length;
      if (code.substr(j, 3) === '"""') {
        let q = j;
        while (code[q] === '"') q++;
        const quotes = code.slice(j, q);
        const end = code.indexOf(quotes, q);
        j = end < 0 ? n : end + quotes.length;
      } else if (prefix.includes('@')) {
        j++;
        while (j < n) {
          if (code[j] === '"') {
            if (code[j + 1] === '"') { j += 2; continue; }
            j++;
            break;
          }
          j++;
        }
      } else {
        j++;
        let depth = 0;
        while (j < n && code[j] !== '\n') {
          if (code[j] === '\\') { j += 2; continue; }
          if (prefix && code[j] === '{') depth++;
          if (prefix && code[j] === '}') depth = Math.max(0, depth - 1);
          if (code[j] === '"' && depth === 0) { j++; break; }
          j++;
        }
      }
      const str = code.slice(i, j);
      if (prefix.includes('$')) {
        // Tô phần {biểu thức} bên trong chuỗi nội suy
        out += str
          .split(/(\{[^{}]*\})/)
          .map((part, k) => (k % 2 ? `<span class="tk-interp">${hlEsc(part)}</span>` : `<span class="tk-str">${hlEsc(part)}</span>`))
          .join('');
      } else push('str', str);
      i = j;
      lineStart = false;
      continue;
    }
    // Char literal
    if (c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== "'" && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      j = Math.min(n, j + 1);
      push('str', code.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    // Number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] || ''))) {
      const nm = code.slice(i).match(/^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?|\.[0-9_]+)([uU]?[lL]?|[mMfFdD])?/);
      push('num', nm[0]);
      i += nm[0].length;
      lineStart = false;
      continue;
    }
    // Identifier / keyword
    if (/[A-Za-z_@]/.test(c)) {
      const im = code.slice(i).match(/^@?[A-Za-z_][A-Za-z0-9_]*/);
      if (im) {
        const w = im[0];
        const after = code.slice(i + w.length).match(/^\s*(\(|<[A-Za-z0-9_,\s<>?]*>\s*\()/);
        if (CS_TYPES.has(w)) push('type', w);
        else if (CS_KEYWORDS.has(w)) push('kw', w);
        else if (after) push('fn', w);
        else if (/^[A-Z]/.test(w)) push('cls', w);
        else push('', w);
        i += w.length;
        lineStart = false;
        continue;
      }
    }
    if (c === '\n') lineStart = true;
    else if (!/\s/.test(c)) lineStart = false;
    push('', c);
    i++;
  }
  return out;
}

// Tô màu đơn giản cho các ngôn ngữ khác (sql, bash, json, xml, yaml...)
function highlightGeneric(code, lang) {
  const commentRe = lang === 'sql' ? /--[^\n]*/ : lang === 'xml' ? /<!--[\s\S]*?-->/ : lang === 'json' ? /(?!)/ : /#[^\n]*/;
  const re = new RegExp(
    `(${commentRe.source})|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')|(\\b\\d+(?:\\.\\d+)?\\b)|(</?[A-Za-z][\\w.:-]*|/?>)|([A-Za-z_][\\w-]*)`,
    'g'
  );
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += hlEsc(code.slice(last, m.index));
    const [t] = m;
    if (m[1]) out += `<span class="tk-com">${hlEsc(t)}</span>`;
    else if (m[2]) out += `<span class="tk-str">${hlEsc(t)}</span>`;
    else if (m[3]) out += `<span class="tk-num">${hlEsc(t)}</span>`;
    else if (m[4]) out += lang === 'xml' ? `<span class="tk-kw">${hlEsc(t)}</span>` : hlEsc(t);
    else if (m[5]) {
      const lw = t.toLowerCase();
      if (lang === 'sql' && SQL_KEYWORDS.has(lw)) out += `<span class="tk-kw">${hlEsc(t)}</span>`;
      else if ((lang === 'bash' || lang === 'dockerfile') && /^(dotnet|git|cd|mkdir|docker|npm|ls|cat|echo|FROM|WORKDIR|COPY|RUN|EXPOSE|ENTRYPOINT|ENV|ARG|AS|USER|CMD)$/.test(t))
        out += `<span class="tk-kw">${hlEsc(t)}</span>`;
      else if (lang === 'http' && /^(GET|POST|PUT|PATCH|DELETE|HTTP)$/.test(t)) out += `<span class="tk-kw">${hlEsc(t)}</span>`;
      else if (lang === 'json' && /^(true|false|null)$/.test(t)) out += `<span class="tk-kw">${hlEsc(t)}</span>`;
      else out += hlEsc(t);
    }
    last = m.index + t.length;
  }
  return out + hlEsc(code.slice(last));
}

function highlightCode(code, lang = 'cs') {
  if (lang === 'cs' || lang === 'csharp') return highlightCs(code);
  if (lang === 'text' || lang === 'output') return hlEsc(code);
  return highlightGeneric(code, lang);
}
