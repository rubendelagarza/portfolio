/*!
 * Portfolio lab engine
 * Simulated terminals, objectives that check environment state, a hint ladder,
 * scoring, solution autoplay and a debrief. No dependencies, no backend.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- basics
  function CmdError(message) { const e = new Error(message); e.isCmdError = true; return e; }
  const $ = (sel, root) => (typeof sel === 'string' ? (root || document).querySelector(sel) : sel);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Playback speed for Watch solution (1 = normal). Persisted per browser.
  const SPEEDS = [0.5, 1, 2];
  let speed = 1;
  try { const v = parseFloat(localStorage.getItem('lab:speed')); if (SPEEDS.includes(v)) speed = v; } catch (e) { /* storage unavailable */ }
  const pace = ms => sleep(ms / speed);
  const speedLabel = () => speed + '×';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k) { try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  // ---------------------------------------------------------------- networking helpers
  const net = {
    ipToInt(ip) {
      const p = String(ip).trim().split('.');
      if (p.length !== 4) return null;
      let n = 0;
      for (const x of p) { if (!/^\d{1,3}$/.test(x) || +x > 255) return null; n = n * 256 + (+x); }
      return n;
    },
    intToIp(n) { return [24, 16, 8, 0].map(s => Math.floor(n / Math.pow(2, s)) % 256).join('.'); },
    parseCidr(c) {
      const s = String(c).trim(); const parts = s.split('/');
      const n = net.ipToInt(parts[0]); if (n === null) return null;
      let l = 32;
      if (parts.length > 1) { if (!/^\d{1,2}$/.test(parts[1])) return null; l = +parts[1]; if (l > 32) return null; }
      const size = Math.pow(2, 32 - l); const base = Math.floor(n / size) * size;
      return { base, len: l, size, exact: base === n };
    },
    isIp(ip) { return net.ipToInt(ip) !== null; },
    isCidr(c) { return String(c).includes('/') && !!net.parseCidr(c); },
    contains(cidr, ip) { const c = net.parseCidr(cidr), n = net.ipToInt(ip); return !!c && n !== null && n >= c.base && n < c.base + c.size; },
    within(inner, outer) { const a = net.parseCidr(inner), b = net.parseCidr(outer); return !!a && !!b && a.base >= b.base && a.base + a.size <= b.base + b.size; },
    maskToLen(mask) { const n = net.ipToInt(mask); if (n === null) return null; const bin = n.toString(2).padStart(32, '0'); if (!/^1*0*$/.test(bin)) return null; return bin.indexOf('0') === -1 ? 32 : bin.indexOf('0'); },
    lenToMask(len) { return net.intToIp(len === 0 ? 0 : (Math.pow(2, 32) - Math.pow(2, 32 - len))); },
    sameSubnet(a, b, len) { const x = net.ipToInt(a), y = net.ipToInt(b); if (x === null || y === null) return false; const size = Math.pow(2, 32 - len); return Math.floor(x / size) === Math.floor(y / size); }
  };

  // ---------------------------------------------------------------- formatting
  const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  function parseSize(v) {
    const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i);
    if (!m) return null;
    return parseFloat(m[1]) * (m[2] ? UNITS[m[2].toUpperCase()] : 1);
  }
  function fmtBytes(b) {
    const gb = b / UNITS.GB;
    const unit = gb >= 1 ? [gb, 'GB'] : [b / UNITS.MB, 'MB'];
    return `${unit[0].toFixed(2)} ${unit[1]} (${Math.round(b).toLocaleString('en-US')} bytes)`;
  }
  function fmtVal(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return '{' + v.join(', ') + '}';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    return String(v);
  }
  function cellText(o, c, fmt) { const f = fmt && fmt[c]; return f ? String(f(o[c], o)) : fmtVal(o[c]); }
  function visibleKeys(o) { return Object.keys(o).filter(k => !k.startsWith('_')); }

  function renderTable(objs, cols, fmt, style) {
    if (!objs || !objs.length) return '';
    cols = cols && cols.length ? cols : visibleKeys(objs[0]);
    const rows = objs.map(o => cols.map(c => cellText(o, c, fmt)));
    const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
    const sep = style === 'gcloud' ? '  ' : ' ';
    const line = cells => cells.map((s, i) => (i === cells.length - 1 ? s : s.padEnd(widths[i]))).join(sep).replace(/\s+$/, '');
    const out = [line(cols)];
    if (style !== 'gcloud') out.push(line(cols.map(c => '-'.repeat(c.length))));
    rows.forEach(r => out.push(line(r)));
    return out.join('\n');
  }
  function renderList(objs, cols, fmt) {
    if (!objs || !objs.length) return '';
    return objs.map(o => {
      const keys = cols && cols.length ? cols : visibleKeys(o);
      const w = Math.max(...keys.map(k => k.length));
      return keys.map(k => `${k.padEnd(w)} : ${cellText(o, k, fmt)}`).join('\n');
    }).join('\n\n');
  }
  function toYaml(v, indent) {
    indent = indent || '';
    const scalar = x => {
      if (x === null || x === undefined) return 'null';
      if (typeof x === 'boolean' || typeof x === 'number') return String(x);
      const s = String(x);
      return (/^[\w./:@-][\w ./:@,=#*-]*$/.test(s) && !/^\d+$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s)) ? s : `'${s.replace(/'/g, "''")}'`;
    };
    if (Array.isArray(v)) {
      if (!v.length) return indent + '[]';
      return v.map(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const inner = toYaml(item, indent + '  ').split('\n');
          inner[0] = indent + '- ' + inner[0].trimStart();
          return inner.join('\n');
        }
        return indent + '- ' + scalar(item);
      }).join('\n');
    }
    if (v && typeof v === 'object') {
      return Object.keys(v).filter(k => v[k] !== undefined).map(k => {
        const x = v[k];
        if (Array.isArray(x)) return x.length ? `${indent}${k}:\n${toYaml(x, indent)}` : `${indent}${k}: []`;
        if (x && typeof x === 'object') return `${indent}${k}:\n${toYaml(x, indent + '  ')}`;
        return `${indent}${k}: ${scalar(x)}`;
      }).join('\n');
    }
    return indent + scalar(v);
  }

  // ---------------------------------------------------------------- parsing
  function splitOutsideQuotes(line, ch) {
    const parts = []; let cur = '', q = null;
    for (const c of line) {
      if (q) { if (c === q) q = null; cur += c; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === ch) { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts.map(s => s.trim());
  }
  function tokenize(line) {
    const out = []; let cur = '', q = null, had = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; else cur += c; continue; }
      // (subexpression) and {scriptblock} at the start of a token stay together
      if ((c === '(' || c === '{') && cur === '' && !had) {
        const close = c === '(' ? ')' : '}'; let depth = 0, j = i, iq = null;
        for (; j < line.length; j++) {
          const d = line[j];
          if (iq) { if (d === iq) iq = null; continue; }
          if (d === '"' || d === "'") { iq = d; continue; }
          if (d === c) depth++;
          else if (d === close) { depth--; if (depth === 0) break; }
        }
        if (depth !== 0) throw new Error('unterminated');
        out.push(line.slice(i, j + 1)); i = j; continue;
      }
      if (c === '"' || c === "'") { q = c; had = true; continue; }
      if (/\s/.test(c)) { if (cur.length || had) { out.push(cur); cur = ''; had = false; } continue; }
      cur += c;
    }
    if (q) throw new Error('unterminated');
    if (cur.length || had) out.push(cur);
    return out;
  }

  const GNU_GLOBAL = { quiet: 'switch', q: 'switch', format: 'value', project: 'value', verbosity: 'value', 'account': 'value', output: 'value', o: 'value', query: 'value', 'only-show-errors': 'switch', 'no-wait': 'switch', yes: 'switch', y: 'switch', subscription: 'value' };
  const PS_COMMON = { confirm: 'switchish', whatif: 'switchish', verbose: 'switchish', force: 'switchish', erroraction: 'value', ea: 'value', debug: 'switchish' };

  function errLabel(spec, style) { return style === 'gnu' && spec.name.toLowerCase().startsWith('gcloud') ? '(' + spec.name.toLowerCase().split(' ').join('.') + ') ' : ''; }

  function argError(spec, style, kind, name, extra) {
    const L = errLabel(spec, style);
    if (style === 'ps') {
      const cmd = spec.name;
      switch (kind) {
        case 'unknown': return CmdError(`${cmd} : A parameter cannot be found that matches parameter name '${name}'.`);
        case 'novalue': return CmdError(`${cmd} : Missing an argument for parameter '${name}'. Specify a parameter of type '${extra}' and try again.`);
        case 'required': return CmdError(`${cmd} : Cannot process command because of one or more missing mandatory parameters: ${name}.`);
        case 'bool': return CmdError(`${cmd} : Cannot process argument transformation on parameter '${name}'. Cannot convert value "System.String" to type "System.Boolean". Boolean parameters accept only Boolean values and numbers, such as $True, $False, 1 or 0.`);
        case 'int': return CmdError(`${cmd} : Cannot bind parameter '${name}'. Cannot convert value "${extra}" to type "System.Int32". Error: "Input string was not in a correct format."`);
        case 'enum': return CmdError(`${cmd} : Cannot validate argument on parameter '${name}'. The argument "${extra.value}" does not belong to the set "${extra.values.join(',')}" specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again.`);
        case 'positional': return CmdError(`${cmd} : A positional parameter cannot be found that accepts argument '${name}'.`);
      }
    }
    if (style === 'gnu' && spec.name.toLowerCase().startsWith('az ')) {
      switch (kind) {
        case 'unknown': return CmdError(`ERROR: unrecognized arguments: --${name}\n\nExamples from AI knowledge base:\n  ${spec.name} --help`);
        case 'novalue': return CmdError(`ERROR: argument --${name}: expected one argument`);
        case 'required': return CmdError(`ERROR: the following arguments are required: ${/^[A-Z_]+$/.test(name) ? name : '--' + name}`);
        case 'bool': return CmdError(`ERROR: argument --${name}: invalid boolean value: '${extra}'`);
        case 'int': return CmdError(`ERROR: argument --${name}: invalid int value: '${extra}'`);
        case 'enum': return CmdError(`ERROR: argument --${name}: invalid choice: '${extra.value}' (choose from ${extra.values.map(v => "'" + v + "'").join(', ')})`);
        case 'positional': return CmdError(`ERROR: unrecognized arguments: ${name}`);
      }
    }
    if (style === 'gnu') {
      switch (kind) {
        case 'unknown': return CmdError(`ERROR: ${L}unrecognized arguments: --${name}\n\nTo search the help text of gcloud commands, run:\n  ${spec.name} --help`);
        case 'novalue': return CmdError(`ERROR: ${L}argument --${name}: expected one argument`);
        case 'required': return CmdError(`ERROR: ${L}argument ${/^[A-Z_]+$/.test(name) ? name : '--' + name}: Must be specified.`);
        case 'bool': return CmdError(`ERROR: ${L}argument --${name}: invalid boolean value: '${extra}'`);
        case 'int': return CmdError(`ERROR: ${L}argument --${name}: invalid int value: '${extra}'`);
        case 'enum': return CmdError(`ERROR: ${L}argument --${name}: Invalid choice: '${extra.value}'.\n\nValid choices are [${extra.values.join(', ')}].`);
        case 'positional': return CmdError(`ERROR: ${L}unrecognized arguments: ${name}`);
      }
    }
    return CmdError(`${spec.name}: invalid argument ${name || ''}`);
  }

  function coerce(spec, ps, raw, style, shown) {
    const t = ps.type || 'string';
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      if (t === 'secure' || t === 'any') return raw;
      if (raw.secure) throw CmdError(`${spec.name} : Cannot bind parameter '${shown}'. Cannot convert the "System.Security.SecureString" value to type "System.String".`);
      if (t === 'list' || t === 'multi') return [raw.Name || raw.name || raw.SamAccountName || raw.DistinguishedName || raw.value || ''];
      raw = raw.Name || raw.name || raw.SamAccountName || (raw.value !== undefined ? String(raw.value) : String(raw));
    }
    if (Array.isArray(raw)) {
      if (t === 'any') return raw;
      const names = raw.map(x => (x && typeof x === 'object' ? (x.Name || x.name || x.SamAccountName || x.DistinguishedName || x.value || '') : x));
      if (t === 'list' || t === 'multi') return names;
      if (t === 'enumlist') return names.map(v => coerce(spec, { type: 'enum', values: ps.values }, v, style, shown));
      raw = raw.map(x => (x && typeof x === 'object' ? (x.Name || x.name || x.value || '') : x)).join(',');
    }
    if (t === 'secure') throw CmdError(`${spec.name} : Cannot bind parameter '${shown}'. Cannot convert the "${raw}" value of type "System.String" to type "System.Security.SecureString".`);
    if (t === 'string' || t === 'any') return raw;
    if (t === 'multi') return [raw];
    if (t === 'int') { if (!/^-?\d+$/.test(String(raw))) throw argError(spec, style, 'int', shown, raw); return parseInt(raw, 10); }
    if (t === 'bool') {
      const s = String(raw).toLowerCase();
      if (style === 'ps') { if (['$true', '1'].includes(s)) return true; if (['$false', '0'].includes(s)) return false; throw argError(spec, style, 'bool', shown, raw); }
      if (['true', 'yes', '1', 'on'].includes(s)) return true; if (['false', 'no', '0', 'off'].includes(s)) return false;
      throw argError(spec, style, 'bool', shown, raw);
    }
    if (t === 'enum') {
      const hit = ps.values.find(v => v.toLowerCase() === String(raw).toLowerCase());
      if (!hit) throw argError(spec, style, 'enum', shown, { value: raw, values: ps.values });
      return hit;
    }
    if (t === 'list') return String(raw).split(',').map(s => s.trim()).filter(Boolean);
    if (t === 'enumlist') {
      return String(raw).split(',').map(s => s.trim()).filter(Boolean).map(v => {
        const hit = ps.values.find(x => x.toLowerCase() === v.toLowerCase());
        if (!hit) throw argError(spec, style, 'enum', shown, { value: v, values: ps.values });
        return hit;
      });
    }
    return raw;
  }

  function parseArgs(spec, toks, style, ctx) {
    const args = { _pos: [], _g: {}, _c: {} };
    if (spec.raw) { args._pos = toks.slice(); return args; }
    const P = spec._params;
    // PowerShell: resolve $variables and (subexpressions) in values
    const resolve = v => {
      if (style !== 'ps' || !ctx || typeof v !== 'string') return v;
      const m = v.match(/^\$(\w+)$/);
      if (m && !/^(true|false|null)$/i.test(m[1])) { if (!(m[1].toLowerCase() in ctx.vars)) throw CmdError(`The variable '$${m[1]}' cannot be retrieved because it has not been set.`); return ctx.vars[m[1].toLowerCase()]; }
      if (/^\(.*\)$/s.test(v) && ctx.evalSub) return ctx.evalSub(v.slice(1, -1));
      return v;
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let name = null, val;
      if (style === 'ps' && /^-[A-Za-z]/.test(t)) {
        const body = t.slice(1); const ci = body.indexOf(':');
        if (ci > 0) { name = body.slice(0, ci); val = body.slice(ci + 1); } else name = body;
      } else if (style === 'gnu' && /^--?[A-Za-z]/.test(t)) {
        const body = t.replace(/^--?/, ''); const ei = body.indexOf('=');
        if (ei > 0) { name = body.slice(0, ei); val = body.slice(ei + 1); } else name = body;
      }
      if (name === null) { args._pos.push(resolve(t)); continue; }
      const lname = name.toLowerCase();
      const ps = P[lname];
      if (!ps) {
        if (style === 'gnu' && GNU_GLOBAL[lname]) {
          if (GNU_GLOBAL[lname] === 'value' && val === undefined) val = toks[++i];
          args._g[lname] = val === undefined ? true : val; continue;
        }
        if (style === 'ps' && PS_COMMON[lname]) {
          if (PS_COMMON[lname] === 'value' && val === undefined) val = toks[++i];
          args._c[lname] = val === undefined ? true : val; continue;
        }
        if (style === 'gnu' && lname.startsWith('no-') && P[lname.slice(3)] && P[lname.slice(3)].type === 'switch') { args[P[lname.slice(3)].key] = false; continue; }
        throw argError(spec, style, 'unknown', name);
      }
      if (ps.type === 'switch') {
        args[ps.key] = val === undefined ? true : coerce(spec, { type: 'bool' }, val, style, ps.key);
        continue;
      }
      if (ps.type === 'multi' && style === 'gnu') {
        const vals = val !== undefined ? [val] : [];
        while (i + 1 < toks.length && !/^--?[A-Za-z]/.test(toks[i + 1])) vals.push(toks[++i]);
        if (!vals.length) throw argError(spec, style, 'novalue', ps.key);
        args[ps.key] = vals; continue;
      }
      if (val === undefined) {
        if (i + 1 >= toks.length || (style === 'gnu' && /^--[A-Za-z]/.test(toks[i + 1])) || (style === 'ps' && /^-[A-Za-z]/.test(toks[i + 1]) && ps.type !== 'int')) {
          throw argError(spec, style, 'novalue', style === 'gnu' ? ps.key : ps.key, ps.type === 'bool' ? 'System.Boolean' : 'System.String');
        }
        val = toks[++i];
      }
      args[ps.key] = coerce(spec, ps, resolve(val), style, ps.key);
    }
    (spec.positional || []).forEach((k, ix) => {
      if (args[k] === undefined && args._pos[ix] !== undefined) {
        const ps = (spec.params || {})[k] || { type: 'string' };
        args[k] = coerce(spec, ps, args._pos[ix], style, k);
      }
    });
    const maxPos = spec.maxPositional !== undefined ? spec.maxPositional : (spec.positional || []).length;
    if (args._pos.length > maxPos) throw argError(spec, style, 'positional', args._pos[maxPos]);
    for (const [k, ps] of Object.entries(spec.params || {})) {
      if (ps.required && (args[k] === undefined || args[k] === '')) throw argError(spec, style, 'required', k);
      if (ps.default !== undefined && args[k] === undefined) args[k] = ps.default;
    }
    return args;
  }

  function buildRegistry(cmds) {
    const reg = {}, display = {};
    for (const [name, spec] of Object.entries(cmds)) {
      spec.name = name;
      spec._params = {};
      const cloned = {};
      for (const [p, raw] of Object.entries(spec.params || {})) cloned[p] = Object.assign({}, raw, { key: p });
      spec.params = cloned;
      for (const [p, ps] of Object.entries(spec.params)) {
        if (ps.posOnly) continue;
        spec._params[p.toLowerCase()] = ps;
        (ps.aliases || []).forEach(a => { spec._params[a.toLowerCase()] = ps; });
      }
      reg[name.toLowerCase()] = spec; display[name.toLowerCase()] = name;
      (spec.aliases || []).forEach(a => { reg[a.toLowerCase()] = spec; display[a.toLowerCase()] = a; });
    }
    return { reg, display };
  }

  // ---------------------------------------------------------------- the Lab
  const HINT_COST = [2, 5, 10];
  const LETTERS = 'ABCDEFGH';

  function Lab(opts) {
    if (!(this instanceof Lab)) return new Lab(opts);
    this.o = opts;
    this.id = opts.id;
    this.dialect = opts.dialect || 'bash';
    this.variantCount = opts.variants || 1;
    this.variant = Math.floor(Math.random() * this.variantCount);
    this.el = {
      term: $(opts.terminal || '#lab-terminal'),
      objectives: $(opts.objectivesEl || '#lab-objectives'),
      status: $(opts.statusEl || '#lab-status'),
      debrief: $(opts.debriefEl || '#lab-debrief'),
      narration: $(opts.narrationEl || '#lab-narration')
    };
    this.history = []; this.histIdx = 0; this.playing = false;
    this._buildStatus();
    if (this.el.term) this._buildTerminal();
    if (this.el.objectives) this.el.objectives.addEventListener('click', e => this._onObjectiveClick(e));
    this.reset(this.variant);
    setInterval(() => this._renderStatus(), 1000);
    global.__lab = this;
  }

  Lab.prototype = {
    // ---------- lifecycle
    reset(v) {
      this.variant = v === undefined ? this._nextVariant() : v;
      this.state = this.o.createState(this.variant, this);
      this.state.flags = this.state.flags || {};
      this.hints = {}; this.hintCost = 0; this.hintCount = 0; this.vars = {}; this.subshell = null;
      this.solutionViewed = false; this.startTime = null; this.endTime = null; this.completed = false; this.feedback = {};
      const cmds = typeof this.o.commands === 'function' ? this.o.commands(this) : (this.o.commands || {});
      const built = buildRegistry(Object.assign({}, this._builtins(), cmds));
      this.registry = built.reg; this.displayNames = built.display;
      if (this.el.term) {
        this.out.innerHTML = '';
        const banner = typeof this.o.banner === 'function' ? this.o.banner(this.state, this) : this.o.banner;
        if (banner) this.print(banner, 'muted');
        this._renderPrompt(); this._buildPalette();
        this.input.value = '';
      }
      if (this.el.debrief) { this.el.debrief.hidden = true; this.el.debrief.innerHTML = ''; }
      this.narrate('');
      if (this.o.onReset) this.o.onReset(this.state, this);
      this.refresh();
    },
    _nextVariant() {
      if (this.variantCount < 2) return 0;
      let v; do { v = Math.floor(Math.random() * this.variantCount); } while (v === this.variant);
      return v;
    },
    touch() { if (!this.startTime) this.startTime = Date.now(); },
    flag(name, value) { this.state.flags[name] = value === undefined ? true : value; },

    refresh() {
      const st = this.state;
      if (this.o.update) { try { this.o.update(st, this); } catch (e) { console.error(e); } }
      this.results = this.o.objectives.map(ob => {
        let r; try { r = ob.check(st, this); } catch (e) { console.error(e); r = false; }
        return r === true ? { ok: true } : { ok: false, msg: typeof r === 'string' ? r : '' };
      });
      this._renderObjectives();
      if (this.o.render) { try { this.o.render(st, this); } catch (e) { console.error(e); } }
      const done = this.o.objectives.every((ob, i) => ob.optional || this.results[i].ok);
      if (done && !this.completed) this._complete();
      this._renderStatus();
    },
    score() {
      if (this.solutionViewed) return 0;
      const base = this.o.score ? this.o.score(this.state, this) : 100;
      return Math.max(0, Math.round(base - this.hintCost));
    },
    _elapsed() { if (!this.startTime) return 0; return Math.floor(((this.endTime || Date.now()) - this.startTime) / 1000); },

    // ---------- status bar
    _buildStatus() {
      const s = this.el.status; if (!s) return;
      s.classList.add('lab-status');
      s.innerHTML = `
        <div class="lab-status-items">
          <span>Score <b data-s="score">100</b></span>
          <span>Time <b data-s="time">00:00</b></span>
          <span>Hints used <b data-s="hints">0</b></span>
          <span>Environment <b data-s="variant">A</b><span data-s="of"></span></span>
          <span data-s="done" class="badge ok" hidden>Complete</span>
        </div>
        <div class="lab-status-actions">
          <button type="button" class="ghost sm" data-a="check">Check my work</button>
          <button type="button" class="ghost sm" data-a="speed" title="Watch solution playback speed">${speedLabel()}</button>
          <button type="button" class="sm" data-a="watch">&#9654; Watch solution</button>
          <button type="button" class="ghost sm" data-a="stop" hidden>Stop</button>
          <button type="button" class="ghost sm" data-a="reset">Reset (new environment)</button>
        </div>`;
      s.addEventListener('click', e => {
        const b = e.target.closest('button[data-a]'); if (!b) return;
        const a = b.dataset.a;
        if (a === 'check') this.checkWork();
        if (a === 'watch') this.watch();
        if (a === 'speed') { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; try { localStorage.setItem('lab:speed', String(speed)); } catch (e) { /* ignore */ } this._renderStatus(); }
        if (a === 'stop') this._abort = true;
        if (a === 'reset' && !this.playing) this.reset();
      });
    },
    _renderStatus() {
      const s = this.el.status; if (!s) return;
      const set = (k, v) => { const el = s.querySelector(`[data-s="${k}"]`); if (el) el.textContent = v; };
      set('score', this.solutionViewed ? '—' : this.score());
      const t = this._elapsed(); set('time', String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'));
      set('hints', this.hintCount);
      set('variant', LETTERS[this.variant] || this.variant + 1);
      set('of', this.variantCount > 1 ? ` of ${this.variantCount}` : '');
      const d = s.querySelector('[data-s="done"]'); if (d) d.hidden = !this.completed;
      s.querySelector('[data-a="stop"]').hidden = !this.playing;
      s.querySelector('[data-a="watch"]').hidden = this.playing;
      const sp = s.querySelector('[data-a="speed"]'); if (sp) sp.textContent = speedLabel();
      s.querySelectorAll('[data-a="check"],[data-a="reset"]').forEach(b => { b.disabled = this.playing; });
    },
    narrate(text) {
      const n = this.el.narration; if (!n) return;
      n.textContent = text || '';
      n.classList.toggle('show', !!text);
    },

    // ---------- objectives
    _renderObjectives() {
      const ul = this.el.objectives; if (!ul) return;
      const firstOpen = this.o.sequential ? this.o.objectives.findIndex((ob, i) => !ob.optional && !this.results[i].ok) : -1;
      ul.innerHTML = this.o.objectives.map((ob, i) => {
        const r = this.results[i];
        if (firstOpen >= 0 && i > firstOpen && !r.ok) {
          return `<li class="obj locked"><span class="obj-check" aria-hidden="true"></span><div class="obj-body"><div class="obj-text">${ob.text}</div><div class="muted" style="font-size:12px">Locked: finish step ${firstOpen + 1} first.</div></div></li>`;
        }
        const level = this.hints[i] || 0;
        const hints = (ob.hints || []).slice(0, level).map((h, k) => `<div class="obj-hint"><strong>Hint ${k + 1}.</strong> ${h}</div>`).join('');
        const more = (ob.hints || []).length > level && !r.ok && !this.playing
          ? `<button type="button" class="ghost sm" data-hint="${i}">Hint ${level + 1}/${ob.hints.length} (${this._hintPrice(level) ? '−' + this._hintPrice(level) : 'free'})</button>` : '';
        const fb = !r.ok && this.feedback[i] ? `<div class="obj-fb">${esc(this.feedback[i])}</div>` : '';
        return `<li class="obj${r.ok ? ' ok' : ''}">
          <span class="obj-check" aria-hidden="true"></span>
          <div class="obj-body">
            <div class="obj-text">${ob.text}${ob.optional ? ' <span class="pill">Bonus</span>' : ''}</div>
            ${hints}${fb}
            ${more ? `<div class="obj-actions">${more}</div>` : ''}
          </div></li>`;
      }).join('');
    },
    _hintPrice(level) { return this.o.hintPrice ? this.o.hintPrice(level, this.state) : (HINT_COST[level] || 10); },
    _onObjectiveClick(e) {
      const b = e.target.closest('button[data-hint]'); if (!b) return;
      const i = +b.dataset.hint; const level = this.hints[i] || 0;
      this.hintCost += this._hintPrice(level); this.hintCount++;
      this.hints[i] = level + 1;
      this.touch(); this.refresh();
    },
    checkWork() {
      this.feedback = {};
      let done = 0;
      this.o.objectives.forEach((ob, i) => {
        const r = this.results[i];
        if (r.ok) done++; else this.feedback[i] = r.msg || 'Not done yet.';
      });
      this._renderObjectives();
      const req = this.o.objectives.filter(o => !o.optional).length;
      const reqDone = this.o.objectives.filter((o, i) => !o.optional && this.results[i].ok).length;
      this.narrate(`${reqDone} of ${req} required objectives complete.` + (reqDone < req ? ' Feedback is shown under each open objective.' : ''));
    },

    // ---------- completion
    _complete() {
      this.completed = true; this.endTime = Date.now();
      const score = this.score(); const secs = this._elapsed();
      const prev = store.get('lab:' + this.id) || {};
      store.set('lab:' + this.id, {
        completed: !!prev.completed || !this.solutionViewed,
        best: Math.max(prev.best || 0, this.solutionViewed ? 0 : score),
        last: this.solutionViewed ? null : score,
        time: secs,
        watched: !!prev.watched || this.solutionViewed,
        at: Date.now()
      });
      this._renderDebrief(score, secs);
    },
    _renderDebrief(score, secs) {
      const d = this.el.debrief; if (!d) return;
      const mm = `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
      const head = this.solutionViewed
        ? `<h2>Walkthrough complete</h2><p class="muted">You watched the solution. Reset for a new environment and try it yourself to earn a score.</p>`
        : `<h2>Lab complete</h2><div class="row"><span class="kpi-inline">Score <b>${score}</b>/100</span><span class="kpi-inline">Time <b>${mm}</b></span><span class="kpi-inline">Hints <b>${this.hintCount}</b></span></div>`;
      const points = (this.o.debrief || []).map(p => `<li><strong>${p.title}.</strong> ${p.text}</li>`).join('');
      d.innerHTML = `${head}<h3 class="mt-16">Why each step matters</h3><ul class="points">${points}</ul>
        <div class="row mt-16"><button type="button" class="sm" data-d="again">Try a new environment</button><a class="btn ghost sm" href="../../index.html">Back to portfolio</a></div>`;
      d.hidden = false;
      d.querySelector('[data-d="again"]').addEventListener('click', () => { this.reset(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      if (!this.playing) d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    // ---------- terminal
    _buildTerminal() {
      const t = this.el.term; t.classList.add('term');
      t.innerHTML = `
        <div class="term-bar"><span class="term-dots"><i></i><i></i><i></i></span><span class="term-title"></span></div>
        <div class="term-screen"><div class="term-out" aria-live="polite"></div>
          <div class="term-inline"><span class="term-prompt"></span><input class="term-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Terminal input"></div>
        </div>
        <details class="term-palette"><summary>Command palette</summary><div class="term-chips"></div></details>`;
      this.screen = t.querySelector('.term-screen');
      this.out = t.querySelector('.term-out');
      this.input = t.querySelector('.term-input');
      this.promptEl = t.querySelector('.term-prompt');
      t.querySelector('.term-title').textContent = this.o.termTitle || '';
      this.screen.addEventListener('click', () => { if (!window.getSelection().toString()) this.input.focus(); });
      this.input.addEventListener('keydown', e => this._onKey(e));
      t.querySelector('.term-chips').addEventListener('click', e => {
        const b = e.target.closest('button[data-cmd]'); if (!b || this.playing) return;
        this.input.value = b.dataset.cmd + ' '; this.input.focus();
      });
      if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) t.querySelector('.term-palette').open = true;
    },
    _buildPalette() {
      const box = this.el.term && this.el.term.querySelector('.term-chips'); if (!box) return;
      const names = [...new Set(Object.values(this.registry).filter(s => !s.builtin && !s.hidden).map(s => s.name))].sort();
      box.innerHTML = names.map(n => `<button type="button" data-cmd="${esc(n)}">${esc(n)}</button>`).join('') +
        `<button type="button" data-cmd="help">help</button>`;
    },
    _promptText() { if (this.subshell) return this.subshell.prompt; const p = this.o.prompt; return typeof p === 'function' ? p(this.state, this) : (p || '$ '); },
    enterSubshell(sh) { this.subshell = sh; this._renderPrompt(); },
    _renderPrompt() { if (this.promptEl) this.promptEl.textContent = this._promptText(); },
    print(text, cls) {
      if (!this.out || text === undefined || text === null || text === '') return;
      const d = document.createElement('div');
      d.className = 'term-line' + (cls ? ' ' + cls : '');
      d.textContent = text;
      this.out.appendChild(d);
    },
    _echo(line) {
      const d = document.createElement('div'); d.className = 'term-line';
      const p = document.createElement('span'); p.className = 'p'; p.textContent = this._promptText();
      d.appendChild(p); d.appendChild(document.createTextNode(line));
      this.out.appendChild(d);
    },
    _scroll() { if (this.screen) this.screen.scrollTop = this.screen.scrollHeight; },
    _onKey(e) {
      if (this.playing) { e.preventDefault(); return; }
      if (e.key === 'Enter') { const v = this.input.value; this.input.value = ''; this.exec(v); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (this.histIdx > 0) { this.histIdx--; this.input.value = this.history[this.histIdx]; } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (this.histIdx < this.history.length - 1) { this.histIdx++; this.input.value = this.history[this.histIdx]; } else { this.histIdx = this.history.length; this.input.value = ''; } }
      else if (e.key === 'Tab') { e.preventDefault(); this._complete_(); }
      else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); this.out.innerHTML = ''; }
      else if (e.key === 'c' && e.ctrlKey && !window.getSelection().toString()) { this._echo(this.input.value + '^C'); this.input.value = ''; }
    },
    _complete_() {
      const v = this.input.value; if (!v.trim()) return;
      const words = v.split(/\s+/); const partial = words.pop().toLowerCase(); const prefix = words.map(w => w.toLowerCase());
      const cands = new Set();
      Object.keys(this.registry).forEach(k => {
        const kw = k.split(' ');
        if (kw.length <= prefix.length) return;
        if (prefix.every((w, i) => kw[i] === w) && kw[prefix.length].startsWith(partial)) {
          const disp = this.displayNames[k].split(' ')[prefix.length];
          cands.add(disp);
        }
      });
      const list = [...cands];
      if (list.length === 1) { this.input.value = words.concat(list[0]).join(' ') + ' '; return; }
      if (list.length > 1) {
        let common = list[0];
        list.forEach(c => { while (!c.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1); });
        if (common.length > partial.length) this.input.value = words.concat(common).join(' ');
        else { this._echo(v); this.print(list.sort().join('   '), 'muted'); this._scroll(); }
      }
    },

    exec(line) {
      if (!this.out) return;
      this._echo(line);
      const trimmed = line.trim();
      if (trimmed && this.subshell) {
        this.history.push(trimmed); this.histIdx = this.history.length; this.touch();
        try { const r = this.subshell.run(trimmed, this); if (r && r.exit) this.subshell = null; this._emit(r); }
        catch (e) { if (e && e.isCmdError) this.print(e.message, 'err'); else { console.error(e); this.print('Simulator error: ' + (e && e.message), 'err'); } }
        this.refresh(); this._renderPrompt(); this._scroll(); return;
      }
      if (trimmed) {
        this.history.push(trimmed); this.histIdx = this.history.length;
        this.touch();
        const statements = (this.dialect === 'ps' || this.dialect === 'bash') ? splitOutsideQuotes(trimmed, ';').filter(Boolean) : [trimmed];
        for (const stmt of statements) {
          try {
            const asg = this.dialect === 'ps' && stmt.match(/^\$(\w+)\s*=\s*(.+)$/s);
            if (asg) { this.vars[asg[1].toLowerCase()] = this._value(asg[2].trim()); continue; }
            const bare = this.dialect === 'ps' && stmt.match(/^\$(\w+)$/);
            if (bare && !/^(true|false|null)$/i.test(bare[1])) { const v = this.vars[bare[1].toLowerCase()]; this.print(v === undefined ? '' : (v && v.secure ? 'System.Security.SecureString' : Array.isArray(v) ? v.map(x => x.Name || x.SamAccountName || JSON.stringify(x)).join('\n') : String(v && v.value !== undefined ? v.value : v))); continue; }
            this._emit(this._run(stmt));
          }
          catch (e) {
            if (e && e.isCmdError) this.print(e.message, 'err');
            else { console.error(e); this.print('Simulator error: ' + (e && e.message), 'err'); }
            break;
          }
        }
        this.refresh();
      }
      this._renderPrompt();
      this._scroll();
    },
    _style(spec) {
      if (spec.style) return spec.style;
      if (spec.raw) return 'raw';
      if (/^(gcloud|az) /i.test(spec.name + ' ')) return 'gnu';
      return this.dialect === 'ps' ? 'ps' : 'gnu';
    },
    _find(toks) {
      for (let n = Math.min(toks.length, 8); n >= 1; n--) {
        const key = toks.slice(0, n).join(' ').toLowerCase();
        if (this.registry[key]) return { spec: this.registry[key], used: n };
      }
      return null;
    },
    _unknown(toks) {
      const first = toks[0]; const lower = toks.map(t => t.toLowerCase());
      const keys = Object.keys(this.registry);
      if (lower[0] === 'gcloud') {
        let n = 1;
        while (n < toks.length && keys.some(k => (k + ' ').startsWith(lower.slice(0, n + 1).join(' ') + ' '))) n++;
        const group = lower.slice(0, n).join(' ');
        const subs = [...new Set(keys.filter(k => k.startsWith(group + ' ')).map(k => this.displayNames[k].split(' ')[n]))].sort();
        const label = '(' + lower.slice(0, n).join('.') + ')';
        if (toks[n] === undefined || toks[n].startsWith('-')) return CmdError(`ERROR: ${label} Command name argument expected.\n\nAvailable in this simulation: ${subs.join(', ')}`);
        return CmdError(`ERROR: ${label} Invalid choice: '${toks[n]}'.` + (subs.length ? `\n\nAvailable in this simulation: ${subs.join(', ')}` : ''));
      }
      if (lower[0] === 'az') {
        let n = 1;
        while (n < toks.length && keys.some(k => (k + ' ').startsWith(lower.slice(0, n + 1).join(' ') + ' '))) n++;
        const group = lower.slice(0, n).join(' ');
        const subs = [...new Set(keys.filter(k => k.startsWith(group + ' ')).map(k => this.displayNames[k].split(' ')[n]))].sort();
        if (toks[n] === undefined || toks[n].startsWith('-')) return CmdError(`ERROR: '${group}' is a command group. Available in this simulation: ${subs.join(', ')}`);
        return CmdError(`ERROR: '${toks[n]}' is misspelled or not recognized by the system.\n\n${group}: '${toks[n]}' is not in the '${group}' command group. Available in this simulation: ${subs.join(', ')}`);
      }
      const groupKeys = keys.filter(k => k.startsWith(lower[0] + ' '));
      if (groupKeys.length) return CmdError(`${first}: that sub-command isn't supported in this simulation. Supported:\n  ` + [...new Set(groupKeys.map(k => this.displayNames[k]))].sort().join('\n  '));
      if (this.dialect === 'ps') return CmdError(`${first} : The term '${first}' is not recognized as the name of a cmdlet, function, script file, or operable program.\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.\n(Type 'help' to list the cmdlets available in this simulation.)`);
      if (this.dialect === 'cmd') return CmdError(`'${first}' is not recognized as an internal or external command,\noperable program or batch file.  (Type 'help' to list available commands.)`);
      return CmdError(`bash: ${first}: command not found  (type 'help' to list available commands)`);
    },
    _isHelpReq(spec, rest) {
      if (spec.builtin) return false;
      return rest.some(t => t === '--help' || t === '-?' || t === '/?' || (this.dialect !== 'ps' && t === '-h' && !spec.raw));
    },
    _run(line) {
      const segs = this.dialect === 'ps' ? splitOutsideQuotes(line, '|') : [line];
      if (this.dialect !== 'ps' && splitOutsideQuotes(line, '|').length > 1) { const hp = this.o.bashPipe ? this.o.bashPipe(line, this) : undefined; if (hp !== undefined) return hp; throw CmdError('Pipes aren\'t supported in this simulation — run each command on its own.'); }
      let prev = null;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (!seg) throw CmdError(this.dialect === 'ps' ? 'An empty pipe element is not allowed.' : 'syntax error near unexpected token');
        let toks;
        try { toks = tokenize(seg); } catch (e) { throw CmdError(this.dialect === 'ps' ? 'The string is missing the terminator: ".' : 'unexpected EOF while looking for matching quote'); }
        const found = this._find(toks);
        if (!found) throw this._unknown(toks);
        const { spec, used } = found; const rest = toks.slice(used);
        if (this._isHelpReq(spec, rest)) { prev = { text: this.helpFor(spec) }; continue; }
        const args = parseArgs(spec, rest, this._style(spec), { vars: this.vars, evalSub: inner => this._value(inner) });
        prev = spec.run(args, { lab: this, state: this.state, input: prev && prev.objects ? prev.objects : null, prevRes: prev, raw: seg, first: i === 0 }) || null;
      }
      return prev;
    },
    // Evaluate a PowerShell value: string/number literal, $variable, or a command whose result becomes the value.
    _value(expr) {
      expr = expr.trim();
      if (/^(['"]).*\1$/s.test(expr)) return expr.slice(1, -1);
      if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
      if (/^\$(true|false)$/i.test(expr)) return /true/i.test(expr);
      const vm = expr.match(/^\$(\w+)$/); if (vm) return this.vars[vm[1].toLowerCase()];
      if (/^\(.*\)$/s.test(expr)) return this._value(expr.slice(1, -1));
      if (this.o.psValue) { const pv = this.o.psValue(expr, this); if (pv !== undefined) return pv; }
      const r = this._run(expr);
      if (r && r.value !== undefined) return r.value;
      if (r && r.objects) return r.objects.length === 1 ? r.objects[0] : r.objects;
      return r && r.text !== undefined ? r.text : r;
    },
    _emit(res) {
      if (res === null || res === undefined) return;
      if (typeof res === 'string') { this.print(res); return; }
      if (res.pre) this.print(res.pre, res.preCls || 'muted');
      if (res.objects) {
        const txt = res.view === 'list' ? renderList(res.objects, res.cols, res.fmt) : renderTable(res.objects, res.cols, res.fmt, res.style);
        this.print(txt, res.cls);
        if (res.text) this.print(res.text, res.textCls || 'muted');
        if (res.post) this.print(res.post, 'warn');
        return;
      }
      if (res.text !== undefined) this.print(res.text, res.cls);
    },
    helpAll() {
      const specs = [...new Set(Object.values(this.registry))];
      const main = specs.filter(s => !s.builtin && !s.hidden).sort((a, b) => a.name.localeCompare(b.name));
      const util = specs.filter(s => s.builtin).sort((a, b) => a.name.localeCompare(b.name));
      const w = Math.min(46, Math.max(...main.concat(util).map(s => s.name.length)));
      const fmt = s => `  ${s.name.padEnd(w)}  ${s.desc || ''}`;
      const how = this.dialect === 'ps' ? 'Get-Help <cmdlet>' : this.dialect === 'cmd' ? '<command> /?' : '<command> --help';
      return `Commands available in this simulation:\n\n${main.map(fmt).join('\n')}\n\nUtilities:\n${util.map(fmt).join('\n')}\n\nType ${how} for parameters. Tab completes command names; ↑/↓ recalls history.`;
    },
    helpFor(spec) {
      if (!spec) return 'No help found for that command.';
      const style = this._style(spec);
      const lines = ['NAME', `    ${spec.name}${spec.desc ? ' — ' + spec.desc : ''}`, '', 'SYNTAX', `    ${spec.usage || this._autoUsage(spec, style)}`];
      const ps = Object.values(spec.params || {});
      if (ps.length) {
        lines.push('', 'PARAMETERS');
        ps.forEach(p => {
          const flag = style === 'ps' ? `-${p.key}` : p.posOnly ? p.key : `--${p.key}`;
          const type = p.type === 'switch' ? '' : p.type === 'enum' || p.type === 'enumlist' ? ` <${p.values.join(' | ')}>` : p.type === 'bool' ? (style === 'ps' ? ' <$true | $false>' : ' <true | false>') : p.type === 'int' ? ' <int>' : p.type === 'list' ? ' <value,value,...>' : ' <string>';
          lines.push(`    ${flag}${type}${p.required ? '   (required)' : ''}`);
          if (p.desc) lines.push(`        ${p.desc}`);
        });
      }
      if (spec.notes) lines.push('', 'NOTES', ...spec.notes.split('\n').map(l => '    ' + l));
      return lines.join('\n');
    },
    _autoUsage(spec, style) {
      const pos = (spec.positional || []).map(p => (style === 'ps' ? `[-${p}] <${p}>` : p));
      const ps = Object.values(spec.params || {}).filter(p => !(spec.positional || []).includes(p.key)).map(p => {
        const f = style === 'ps' ? `-${p.key}` : `--${p.key}`;
        const v = p.type === 'switch' ? '' : style === 'ps' ? ` <${p.type === 'bool' ? 'bool' : p.key}>` : `=${p.key.toUpperCase().replace(/-/g, '_')}`;
        return p.required ? f + v : `[${f}${v}]`;
      });
      return [spec.name].concat(pos, ps).join(' ');
    },
    _builtins() {
      const self = this;
      const b = {
        help: { builtin: true, raw: true, desc: 'List commands (help <command> for details)', run: a => {
          if (!a._pos.length) return { text: self.helpAll() };
          const f = self._find(a._pos); return { text: f ? self.helpFor(f.spec) : `No help topic for '${a._pos.join(' ')}'.` };
        } },
        clear: { builtin: true, raw: true, aliases: ['cls'], desc: 'Clear the screen', run: () => { self.out.innerHTML = ''; return null; } },
        history: { builtin: true, raw: true, desc: 'Show command history', run: () => ({ text: self.history.map((h, i) => `  ${String(i + 1).padStart(3)}  ${h}`).join('\n') }) }
      };
      if (this.dialect === 'ps') {
        const canon = (objs, props) => {
          const keys = objs.length ? Object.keys(objs[0]).filter(k => !k.startsWith('_')) : [];
          const out = [];
          props.forEach(p => {
            if (p.includes('*')) { const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'); keys.filter(k => re.test(k)).forEach(k => out.push(k)); }
            else out.push(keys.find(k => k.toLowerCase() === p.toLowerCase()) || p);
          });
          return out;
        };
        const propsOf = pos => pos.filter(t => !t.startsWith('-')).join(',').split(',').map(s => s.trim()).filter(Boolean);
        Object.assign(b, {
          'Get-Help': { builtin: true, raw: true, desc: 'Show parameters for a cmdlet', run: a => {
            const names = a._pos.filter(t => !t.startsWith('-'));
            if (!names.length) return { text: self.helpAll() };
            const f = self._find(names); return { text: f ? self.helpFor(f.spec) : `Get-Help : Get-Help could not find ${names[0]} in a help file in this session.` };
          } },
          'Format-Table': { builtin: true, raw: true, aliases: ['ft'], desc: 'Format pipeline output as a table', run: (a, c) => {
            const p = c.prevRes; if (!p || !p.objects) return p; const props = propsOf(a._pos);
            return Object.assign({}, p, { view: 'table', cols: props.length ? canon(p.objects, props) : p.cols });
          } },
          'Format-List': { builtin: true, raw: true, aliases: ['fl'], desc: 'Format pipeline output as a list (all properties)', run: (a, c) => {
            const p = c.prevRes; if (!p || !p.objects) return p; const props = propsOf(a._pos);
            return Object.assign({}, p, { view: 'list', cols: props.length && props[0] !== '*' ? canon(p.objects, props) : null });
          } },
          'Select-Object': { builtin: true, raw: true, aliases: ['select'], desc: 'Pick properties or the first/last N objects', run: (a, c) => {
            const p = c.prevRes; if (!p || !p.objects) return p;
            let objs = p.objects.slice(), first = null, last = null, expand = null; const props = [];
            for (let i = 0; i < a._pos.length; i++) {
              const t = a._pos[i], tl = t.toLowerCase();
              if (tl === '-first') first = parseInt(a._pos[++i], 10);
              else if (tl === '-last') last = parseInt(a._pos[++i], 10);
              else if (tl === '-expandproperty') expand = a._pos[++i];
              else if (tl === '-property') continue;
              else if (t.startsWith('-')) throw CmdError(`Select-Object : A parameter cannot be found that matches parameter name '${t.slice(1)}'.`);
              else props.push(...t.split(',').map(s => s.trim()).filter(Boolean));
            }
            if (first !== null) objs = objs.slice(0, first);
            if (last !== null) objs = objs.slice(-last);
            if (expand) { const k = canon(objs, [expand])[0]; return { text: objs.map(o => cellText(o, k, p.fmt)).join('\n') }; }
            return Object.assign({}, p, { objects: objs, cols: props.length ? canon(objs, props) : p.cols });
          } },
          'Sort-Object': { builtin: true, raw: true, aliases: ['sort'], desc: 'Sort pipeline objects by a property', run: (a, c) => {
            const p = c.prevRes; if (!p || !p.objects) return p;
            const desc = a._pos.some(t => /^-desc/i.test(t)); const props = propsOf(a._pos);
            const k = props.length ? canon(p.objects, props)[0] : null;
            const objs = p.objects.slice().sort((x, y) => {
              const A = k ? x[k] : JSON.stringify(x), B = k ? y[k] : JSON.stringify(y);
              const r = (typeof A === 'number' && typeof B === 'number') ? A - B : String(A).localeCompare(String(B));
              return desc ? -r : r;
            });
            return Object.assign({}, p, { objects: objs });
          } },
          'Where-Object': { builtin: true, raw: true, aliases: ['where', '?'], desc: 'Filter objects:  Where-Object Prop -eq Value', run: (a, c) => {
            const p = c.prevRes; if (!p || !p.objects) return p;
            const t = a._pos.join(' ').trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '').replace(/\$_\./g, '');
            const m = t.match(/^([\w]+)\s+-(eq|ne|gt|lt|ge|le|like|notlike)\s+(.+)$/i);
            if (!m) throw CmdError("Where-Object : this simulation supports  Where-Object Property -eq Value  or  Where-Object { $_.Property -gt 90GB }");
            const k = canon(p.objects, [m[1]])[0]; const op = m[2].toLowerCase(); let v = m[3].trim();
            const num = parseSize(v); const boolV = /^\$true$/i.test(v) ? true : /^\$false$/i.test(v) ? false : undefined;
            const objs = p.objects.filter(o => {
              const x = o[k];
              if (op === 'like' || op === 'notlike') { const re = new RegExp('^' + v.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'); const r = re.test(fmtVal(x)); return op === 'like' ? r : !r; }
              if (typeof x === 'number' && num !== null) return { eq: x === num, ne: x !== num, gt: x > num, lt: x < num, ge: x >= num, le: x <= num }[op];
              if (typeof x === 'boolean' && boolV !== undefined) return op === 'eq' ? x === boolV : x !== boolV;
              const sx = fmtVal(x).toLowerCase(), sv = v.toLowerCase();
              return { eq: sx === sv, ne: sx !== sv, gt: sx > sv, lt: sx < sv, ge: sx >= sv, le: sx <= sv }[op];
            });
            return Object.assign({}, p, { objects: objs });
          } }
        });
      }
      return b;
    },

    // ---------- autoplay
    async watch() {
      if (this.playing) return;
      this.reset(this.variant);
      this.solutionViewed = true; this.playing = true; this._abort = false; this.touch();
      document.body.classList.add('lab-playing');
      if (this.input) this.input.disabled = true;
      this._renderStatus(); this._renderObjectives();
      const steps = this.o.solution(this.state, this);
      const api = this._api();
      try {
        for (const step of steps) {
          if (this._abort) break;
          const s = typeof step === 'string' ? { cmd: step } : step;
          if (s.note) this.narrate(s.note);
          if (s.cmd !== undefined) {
            await this._typeCmd(s.cmd); if (this._abort) break;
            this.input.value = ''; this.exec(s.cmd);
            await pace(s.wait !== undefined ? s.wait : (s.note ? 1900 : 800));
          }
          if (s.run) { await s.run(api); if (this._abort) break; this.refresh(); await pace(s.wait !== undefined ? Math.max(s.wait, s.note ? 1500 : 0) : (s.note ? 1500 : 400)); }
        }
      } catch (e) { console.error(e); }
      this.playing = false;
      document.body.classList.remove('lab-playing');
      if (this.input) { this.input.disabled = false; this.input.value = ''; }
      this.narrate(this._abort ? 'Walkthrough stopped. Reset for a new environment when you are ready.' : 'Walkthrough complete. Reset for a new environment and try it yourself.');
      this._renderObjectives(); this._renderStatus();
    },
    async _typeCmd(cmd) {
      this.input.value = '';
      const per = Math.max(5, Math.min(24, 1200 / cmd.length));
      for (const ch of cmd) { if (this._abort) return; this.input.value += ch; this.input.scrollLeft = this.input.scrollWidth; await pace(per); }
      await pace(220);
    },
    _flash(el) { el.classList.add('lab-flash'); setTimeout(() => el.classList.remove('lab-flash'), 750); },
    _api() {
      const self = this;
      return {
        lab: self, sleep: pace,
        get state() { return self.state; },
        exec(cmd) { self.exec(cmd); },
        async fill(sel, value, opt) {
          const el = $(sel); if (!el) { console.warn('autoplay: missing', sel); return; }
          el.scrollIntoView({ block: 'nearest' }); self._flash(el); el.focus();
          if (el.tagName === 'SELECT') { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); await pace(260); return; }
          if ((opt && opt.instant) || String(value).length > 120) el.value = value;
          else { el.value = ''; for (const ch of String(value)) { if (self._abort) return; el.value += ch; await pace(12); } }
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          await pace(200);
        },
        async click(sel) {
          const el = $(sel); if (!el) { console.warn('autoplay: missing', sel); return; }
          el.scrollIntoView({ block: 'nearest' }); self._flash(el); await pace(280); el.click(); await pace(220);
        },
        async check(sel, on) {
          const el = $(sel); if (!el) { console.warn('autoplay: missing', sel); return; }
          on = on === undefined ? true : on; self._flash(el);
          if (el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
          await pace(180);
        }
      };
    }
  };

  Lab.CmdError = CmdError;
  Lab.net = net;
  Lab.util = { esc, sleep, store, renderTable, renderList, toYaml, parseSize, fmtBytes, fmtVal, tokenize };
  Lab.progress = id => store.get('lab:' + id);
  global.Lab = Lab;
})(window);
