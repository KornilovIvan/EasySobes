// Syntax highlighting for fenced code and the context editor.
// Uses the global escapeHtml from renderer.js. Loaded first; calls happen later.

function codeWords(list) {
  return new Set(list.trim().split(/\s+/));
}

const CODE_SPECS = (() => {
  const cLike = {
    lines: ['//'],
    block: true,
    template: false,
    keywords: codeWords(
      'if else for while return break continue switch case default do struct enum const static sizeof typedef true false null'
    ),
  };
  const jsWords = codeWords(
    'if else for while return break continue switch case default do function class extends new try catch finally throw const let var async await import export from of in typeof instanceof void delete yield this super static true false null undefined'
  );
  const javaWords = codeWords(
    'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while true false null'
  );
  return {
    plain: { lines: ['//'], block: true, keywords: codeWords('') },
    python: {
      lines: ['#'],
      triples: true,
      prefixes: true,
      keywords: codeWords(
        'if elif else for while return break continue class def try except finally raise with as import from pass lambda yield global nonlocal assert del in is not and or None True False async await'
      ),
    },
    javascript: { lines: ['//'], block: true, template: true, keywords: jsWords },
    typescript: {
      lines: ['//'],
      block: true,
      template: true,
      keywords: codeWords(
        `${[...jsWords].join(' ')} type interface implements public private protected readonly declare namespace abstract enum as`
      ),
    },
    java: { lines: ['//'], block: true, keywords: javaWords },
    kotlin: {
      lines: ['//'],
      block: true,
      keywords: codeWords(
        'if else for while return break continue when class object fun val var try catch finally throw import package is in as true false null override open abstract interface data companion suspend'
      ),
    },
    go: {
      lines: ['//'],
      block: true,
      template: true,
      keywords: codeWords(
        'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil'
      ),
    },
    rust: {
      lines: ['//'],
      block: true,
      keywords: codeWords(
        'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'
      ),
    },
    cpp: {
      lines: ['//'],
      block: true,
      keywords: codeWords(
        `${[...cLike.keywords].join(' ')} class namespace template typename public private protected virtual using new delete try catch throw bool nullptr this auto`
      ),
    },
    csharp: {
      lines: ['//'],
      block: true,
      keywords: codeWords(
        `${[...javaWords].join(' ')} var string bool namespace using async await lock params ref out`
      ),
    },
    sql: {
      lines: ['--'],
      block: true,
      ignoreCase: true,
      keywords: codeWords(
        'select from where group by order having join left right inner outer on as insert into values update set delete create table drop alter and or not null is in like between distinct limit offset union all exists case when then else end primary key foreign references int integer text varchar boolean true false'
      ),
    },
    bash: {
      lines: ['#'],
      keywords: codeWords('if then fi else elif for while do done case esac function return echo export local'),
    },
    json: { keywords: codeWords('true false null') },
    yaml: { lines: ['#'] },
    markup: { html: true, keywords: codeWords('') },
  };
})();

function codeSpec(lang) {
  const id = String(lang || '').toLowerCase().replace(/^\./, '');
  const alias = {
    py: 'python',
    python3: 'python',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    node: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    kt: 'kotlin',
    'c++': 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    h: 'cpp',
    cxx: 'cpp',
    c: 'cpp',
    cs: 'csharp',
    'c#': 'csharp',
    rs: 'rust',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    html: 'markup',
    xml: 'markup',
    svg: 'markup',
    md: 'plain',
    markdown: 'plain',
  }[id] || id;
  return CODE_SPECS[alias] || CODE_SPECS.plain;
}

function isCodeWord(ch) {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function readCodeString(code, i, spec) {
  if (spec.triples && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
    const quote = code.slice(i, i + 3);
    const end = code.indexOf(quote, i + 3);
    return end === -1 ? code.length : end + 3;
  }
  const quote = code[i];
  if (quote !== '"' && quote !== "'" && !(quote === '`' && spec.template)) return i;
  let j = i + 1;
  while (j < code.length) {
    if (code[j] === '\\') {
      j += 2;
      continue;
    }
    if (code[j] === '\n' && quote !== '`') return i;
    if (code[j] === quote) return j + 1;
    j++;
  }
  return code.length;
}

function highlightCode(code, lang) {
  const spec = codeSpec(lang);
  const lines = spec.lines || [];
  let i = 0;
  let html = '';
  let plain = '';
  const flush = () => {
    if (!plain) return;
    html += escapeHtml(plain);
    plain = '';
  };
  const take = (cls, end) => {
    flush();
    html += `<span class="${cls}">${escapeHtml(code.slice(i, end))}</span>`;
    i = end;
  };
  while (i < code.length) {
    if (spec.block && code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      take('syn-cmt', end === -1 ? code.length : end + 2);
      continue;
    }
    if (spec.html && code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4);
      take('syn-cmt', end === -1 ? code.length : end + 3);
      continue;
    }
    const mark = lines.find((item) => code.startsWith(item, i));
    if (mark) {
      const end = code.indexOf('\n', i);
      take('syn-cmt', end === -1 ? code.length : end);
      continue;
    }
    if (spec.html && code[i] === '<') {
      const end = code.indexOf('>', i + 1);
      take('syn-fn', end === -1 ? Math.min(code.length, i + 1) : end + 1);
      continue;
    }
    const strEnd = readCodeString(code, i, spec);
    if (strEnd > i) {
      take('syn-str', strEnd);
      continue;
    }
    const ch = code[i];
    if ((ch === '+' || ch === '-' || (ch >= '0' && ch <= '9')) && !isCodeWord(code[i - 1])) {
      const num = /^[+-]?(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(code.slice(i));
      if (num && /\d/.test(num[0])) {
        take('syn-num', i + num[0].length);
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_]\w*/.exec(code.slice(i))[0];
      const after = i + word.length;
      if (spec.prefixes && /^(?:fr|rf|rb|br|[rRuUbBfF])$/.test(word) && (code[after] === '"' || code[after] === "'")) {
        const end = readCodeString(code, after, spec);
        if (end > after) {
          take('syn-str', end);
          continue;
        }
      }
      const key = spec.ignoreCase ? word.toLowerCase() : word;
      if (spec.keywords && spec.keywords.has(key)) take('syn-kw', after);
      else if (/^\s*\(/.test(code.slice(after))) take('syn-fn', after);
      else {
        plain += word;
        i = after;
      }
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return html;
}

function paintProseLine(line) {
  if (/^\s{0,3}#{1,6}\s+\S/.test(line)) return `<span class="syn-kw">${escapeHtml(line)}</span>`;
  let html = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i) {
        html += `<span class="syn-str">${escapeHtml(line.slice(i, end + 1))}</span>`;
        i = end + 1;
        continue;
      }
    }
    const next = line.indexOf('`', i);
    const stop = next === -1 ? line.length : next;
    html += escapeHtml(line.slice(i, stop));
    i = stop;
  }
  return html;
}

function paintSource(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let inFence = false;
  let lang = '';
  let buf = [];
  for (const line of lines) {
    const open = !inFence && /^\s*```[ \t]*([\w+#.-]*)\s*$/.exec(line);
    const close = inFence && /^\s*```\s*$/.test(line);
    if (open) {
      inFence = true;
      lang = open[1];
      out.push(`<span class="syn-fence">${escapeHtml(line)}</span>`);
      continue;
    }
    if (close) {
      if (buf.length) out.push(highlightCode(buf.join('\n'), lang));
      buf = [];
      inFence = false;
      lang = '';
      out.push(`<span class="syn-fence">${escapeHtml(line)}</span>`);
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    out.push(paintProseLine(line));
  }
  if (buf.length) out.push(highlightCode(buf.join('\n'), lang));
  return out.join('\n');
}
