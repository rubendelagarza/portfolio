/*!
 * Linux server simulation for the portfolio labs (requires lab.js).
 * Virtual filesystem with owners/permissions, bash basics, sudo, apt, systemd, ufw,
 * an nginx config parser/router, a small SQLite engine, a file editor and a browser panel.
 */
(function (global) {
  'use strict';
  const { CmdError, net } = global.Lab;
  const esc = global.Lab.util.esc;
  const L = {};
  const NOW = 'Nov 20 19:05';

  // ======================================================================= filesystem
  L.f = (c, o, g, m) => ({ t: 'f', c: c || '', o: o || 'root', g: g || o || 'root', m: m === undefined ? 0o644 : m });
  L.d = (o, g, m) => ({ t: 'd', o: o || 'root', g: g || o || 'root', m: m === undefined ? 0o755 : m });
  L.l = (target) => ({ t: 'l', target, o: 'root', g: 'root', m: 0o777 });

  L.norm = (p, cwd, home) => {
    p = String(p || '');
    if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
    if (!p.startsWith('/')) p = (cwd === '/' ? '' : cwd) + '/' + p;
    const out = [];
    p.split('/').forEach(seg => { if (!seg || seg === '.') return; if (seg === '..') out.pop(); else out.push(seg); });
    return '/' + out.join('/');
  };
  L.parent = p => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/');
  L.base = p => p.slice(p.lastIndexOf('/') + 1);
  L.resolve = (st, p, depth) => {
    depth = depth || 0;
    const n = st.fs[p];
    if (n && n.t === 'l' && depth < 8) return L.resolve(st, n.target.startsWith('/') ? n.target : L.norm(n.target, L.parent(p), '/'), depth + 1);
    return { path: p, node: n };
  };
  L.get = (st, p) => L.resolve(st, p).node;
  L.children = (st, dir) => Object.keys(st.fs).filter(k => k !== dir && L.parent(k) === dir).sort();
  L.inGroup = (st, user, g) => user === 'root' || ((st.users[user] || {}).groups || []).includes(g);
  L.can = (st, user, node, bit) => {
    if (!node) return false;
    if (user === 'root') return bit !== 'x' || node.t === 'd' || (node.m & 0o111);
    const shift = node.o === user ? 6 : L.inGroup(st, user, node.g) ? 3 : 0;
    const v = (node.m >> shift) & 7;
    return !!(v & { r: 4, w: 2, x: 1 }[bit]);
  };
  L.canEnter = (st, user, p) => {
    let cur = '';
    for (const seg of p.split('/').filter(Boolean).slice(0, -1)) { cur += '/' + seg; const n = L.get(st, cur); if (n && !L.can(st, user, n, 'x')) return false; }
    return true;
  };
  L.writeFile = (st, user, p, content, opts) => {
    opts = opts || {};
    const r = L.resolve(st, p); const parent = L.get(st, L.parent(r.path));
    if (!parent || parent.t !== 'd') return { err: 'No such file or directory' };
    if (!L.canEnter(st, user, r.path)) return { err: 'Permission denied' };
    if (r.node) {
      if (r.node.t === 'd') return { err: 'Is a directory' };
      if (!L.can(st, user, r.node, 'w')) return { err: 'Permission denied' };
      r.node.c = opts.append ? r.node.c + content : content; return { ok: true };
    }
    if (!L.can(st, user, parent, 'w')) return { err: 'Permission denied' };
    const u = st.users[user] || {}; st.fs[r.path] = L.f(content, user, (u.groups || [user])[0], 0o644 & ~0o022);
    return { ok: true, created: true };
  };
  L.modeStr = n => (n.t === 'd' ? 'd' : n.t === 'l' ? 'l' : '-') + [6, 3, 0].map(s => { const v = (n.m >> s) & 7; return (v & 4 ? 'r' : '-') + (v & 2 ? 'w' : '-') + (v & 1 ? 'x' : '-'); }).join('');
  L.size = n => (n.t === 'd' ? 4096 : n.db ? 8192 + 4096 * Object.keys(n.db.tables).length : (n.c || '').length);

  // ======================================================================= nginx config
  const NGX_DIRECTIVES = new Set(['server', 'listen', 'server_name', 'root', 'index', 'location', 'proxy_pass', 'proxy_set_header', 'proxy_http_version', 'proxy_read_timeout', 'proxy_redirect', 'proxy_buffering', 'return', 'rewrite', 'ssl_certificate', 'ssl_certificate_key', 'ssl_protocols', 'ssl_ciphers', 'ssl_prefer_server_ciphers', 'ssl_session_cache', 'ssl_session_timeout', 'ssl_client_certificate', 'ssl_verify_client', 'add_header', 'access_log', 'error_log', 'try_files', 'client_max_body_size', 'include', 'gzip', 'allow', 'deny', 'set_real_ip_from', 'real_ip_header', 'error_page', 'autoindex', 'charset', 'expires', 'if', 'limit_req', 'keepalive_timeout']);
  L.parseNginx = (st, files) => {
    const errors = [], servers = [];
    files.forEach(({ path, text }) => {
      const toks = []; let line = 1;
      for (let i = 0; i < text.length;) {
        const c = text[i];
        if (c === '\n') { line++; i++; continue; }
        if (/\s/.test(c)) { i++; continue; }
        if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if ('{};'.includes(c)) { toks.push({ v: c, line }); i++; continue; }
        if (c === '"' || c === "'") { let j = i + 1; while (j < text.length && text[j] !== c) j++; toks.push({ v: text.slice(i + 1, j), line, q: true }); i = j + 1; continue; }
        let j = i; while (j < text.length && !/[\s{};#]/.test(text[j])) j++; toks.push({ v: text.slice(i, j), line }); i = j;
      }
      let k = 0;
      const err = (msg, ln) => { errors.push(`nginx: [emerg] ${msg} in ${path}:${ln}`); };
      function block(depth) {
        const items = [];
        while (k < toks.length) {
          const t = toks[k];
          if (t.v === '}' && !t.q) { if (depth === 0) { err('unexpected "}"', t.line); k++; continue; } k++; return items; }
          if ((t.v === ';' || t.v === '{') && !t.q) { err(`unexpected "${t.v}"`, t.line); k++; continue; }
          const words = []; const ln = t.line;
          while (k < toks.length && !(['{', ';', '}'].includes(toks[k].v) && !toks[k].q)) words.push(toks[k++].v);
          const name = words[0];
          if (k >= toks.length) { err('unexpected end of file, expecting ";" or "}"', ln); return items; }
          const end = toks[k];
          if (!NGX_DIRECTIVES.has(name)) { err(`unknown directive "${name}"`, ln); }
          if (end.v === '}') { err(`directive "${name}" is not terminated by ";"`, ln); continue; }
          k++;
          if (end.v === '{') { const children = block(depth + 1); items.push({ name, args: words.slice(1), line: ln, children }); if (k > toks.length) break; }
          else items.push({ name, args: words.slice(1), line: ln });
        }
        if (depth > 0) err('unexpected end of file, expecting "}"', line);
        return items;
      }
      const tree = block(0);
      tree.forEach(d => {
        if (d.name !== 'server') { if (NGX_DIRECTIVES.has(d.name)) err(`"${d.name}" directive is not allowed here`, d.line); return; }
        const s = { file: path, line: d.line, listen: [], names: [], locations: [], ret: null, cert: null, key: null, root: null };
        (d.children || []).forEach(c => {
          if (c.name === 'listen') { const a = c.args.join(' '); const pm = a.match(/(?:\[::\]:|[\d.]+:)?(\d+)/); s.listen.push({ port: pm ? +pm[1] : 80, ssl: /\bssl\b/.test(a), def: /default_server/.test(a), v6: /\[::\]/.test(a) }); }
          if (c.name === 'server_name') s.names.push(...c.args.map(x => x.toLowerCase()));
          if (c.name === 'return') s.ret = { code: +c.args[0], url: c.args[1] || '' };
          if (c.name === 'root') s.root = c.args[0];
          if (c.name === 'ssl_certificate') s.cert = c.args[0];
          if (c.name === 'ssl_certificate_key') s.key = c.args[0];
          if (c.name === 'location') {
            const loc = { path: c.args[c.args.length - 1], proxy: null, ret: null, root: null, line: c.line };
            (c.children || []).forEach(x => {
              if (x.name === 'proxy_pass') { loc.proxy = x.args[0]; if (!/^https?:\/\//.test(x.args[0] || '')) err('invalid URL prefix', x.line); }
              if (x.name === 'return') loc.ret = { code: +x.args[0], url: x.args[1] || '' };
              if (x.name === 'root') loc.root = x.args[0];
            });
            s.locations.push(loc);
          }
        });
        if (!s.listen.length) s.listen.push({ port: 80, ssl: false, def: false });
        servers.push(s);
      });
    });
    // cross-checks
    const defaults = {};
    servers.forEach(s => s.listen.filter(l => !l.v6).forEach(l => { if (l.def) { if (defaults[l.port]) errors.push(`nginx: [emerg] a duplicate default server for 0.0.0.0:${l.port} in ${s.file}:${s.line}`); defaults[l.port] = true; } }));
    servers.forEach(s => {
      if (s.listen.some(l => l.ssl) && !s.cert) errors.push(`nginx: [emerg] no "ssl_certificate" is defined for the "listen ... ssl" directive in ${s.file}:${s.line}`);
      [['cert', s.cert], ['key', s.key]].forEach(([kind, p]) => {
        if (!p) return; const n = L.get(st, p);
        if (!n) { errors.push(`nginx: [emerg] cannot load certificate${kind === 'key' ? ' key' : ''} "${p}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory:calling fopen(${p}, r) error:10000080:BIO routines::no such file)`); return; }
        const body = n.c || '';
        if (kind === 'cert' && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(body)) errors.push(`nginx: [emerg] cannot load certificate "${p}": PEM_read_bio_X509_AUX() failed (SSL: error:0480006C:PEM routines::no start line:Expecting: TRUSTED CERTIFICATE)`);
        if (kind === 'key' && !/-----BEGIN (RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (RSA |EC )?PRIVATE KEY-----/.test(body)) errors.push(`nginx: [emerg] cannot load certificate key "${p}": PEM_read_bio_PrivateKey() failed (SSL: error:1E08010C:DECODER routines::unsupported:No supported data to decode. Input type: PEM)`);
      });
      if (s.cert && s.key && st.certPairs) {
        const c = L.get(st, s.cert), k = L.get(st, s.key);
        if (c && k && /BEGIN CERTIFICATE/.test(c.c) && /PRIVATE KEY/.test(k.c)) {
          const pc = st.certPairs.find(p => L.pemEq(p.cert, c.c)), pk = st.certPairs.find(p => L.pemEq(p.key, k.c));
          if (!pc || !pk || pc !== pk) errors.push(`nginx: [emerg] SSL_CTX_use_PrivateKey("${s.key}") failed (SSL: error:05800074:x509 certificate routines::key values mismatch)`);
        }
      }
    });
    return { servers, errors };
  };
  L.pemEq = (a, b) => String(a || '').replace(/\s+/g, '') === String(b || '').replace(/\s+/g, '');
  L.nginxFiles = st => L.children(st, '/etc/nginx/sites-enabled').map(p => { const r = L.resolve(st, p); return r.node && r.node.t === 'f' ? { path: p, text: r.node.c } : null; }).filter(Boolean);
  L.nginxTest = st => L.parseNginx(st, L.nginxFiles(st));
  /** Pick the server block nginx would use (from the live/loaded config). */
  L.nginxRoute = (cfgParsed, port, host) => {
    const cands = cfgParsed.servers.filter(s => s.listen.some(l => l.port === port && !l.v6));
    if (!cands.length) return null;
    return cands.find(s => s.names.includes(String(host).toLowerCase())) || cands.find(s => s.listen.some(l => l.port === port && l.def)) || cands[0];
  };
  L.nginxLocation = (server, path) => server.locations.filter(l => path.startsWith(l.path.replace(/^=\s*/, ''))).sort((a, b) => b.path.length - a.path.length)[0] || null;

  // ======================================================================= SQLite (tiny subset)
  const SQL = {};
  SQL.stripComments = text => text.split('\n').map(l => { let q = null; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === q) q = null; continue; } if (c === "'" || c === '"') { q = c; continue; } if (c === '-' && l[i + 1] === '-') return l.slice(0, i); } return l; }).join('\n');
  SQL.split = text => { text = SQL.stripComments(text); const out = []; let cur = '', q = null; for (const c of text) { if (q) { if (c === q) q = null; cur += c; continue; } if (c === "'" || c === '"') { q = c; cur += c; continue; } if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; } cur += c; } if (cur.trim()) out.push(cur.trim()); return out; };
  SQL.err = m => { const e = new Error(m); e.sql = true; return e; };
  SQL.now = () => '2026-11-20 ' + String(19 + Math.floor(Math.random() * 1)).padStart(2, '0') + ':' + String(10 + Math.floor(Math.random() * 49)).padStart(2, '0') + ':' + String(10 + Math.floor(Math.random() * 49)).padStart(2, '0');
  SQL.literal = (v, params) => {
    v = v.trim();
    if (v === '?') return params.shift();
    if (/^'.*'$/s.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (/^null$/i.test(v)) return null;
    if (/^(current_timestamp|datetime\('now'\))$/i.test(v)) return SQL.now();
    if (/^date\('now'\)$/i.test(v)) return '2026-11-20';
    { const dm = v.match(/^date\(\s*'now'\s*,\s*'([+-]?\d+) days?'\s*\)$/i); if (dm) { const d = new Date(Date.UTC(2026, 10, 20) + (+dm[1]) * 86400000); return d.toISOString().slice(0, 10); } }
    throw SQL.err(`near "${v.split(/\s/)[0]}": syntax error`);
  };
  SQL.splitTop = s => { const out = []; let depth = 0, cur = '', q = null; for (const c of s) { if (q) { if (c === q) q = null; cur += c; continue; } if (c === "'") { q = c; cur += c; continue; } if (c === '(') depth++; if (c === ')') depth--; if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; } cur += c; } if (cur.trim()) out.push(cur.trim()); return out; };
  SQL.table = (db, name) => { const t = db.tables[name.toLowerCase()]; if (!t) throw SQL.err(`no such table: ${name}`); return t; };
  SQL.where = (t, clause, params) => {
    if (!clause) return () => true;
    clause = clause.replace(/(\w+|date\(\s*\w+\s*\))\s+between\s+(.+?)\s+and\s+((?:date\([^)]*\))|'[^']*'|[\w.-]+)/gi, '$1 >= $2 and $1 <= $3');
    const conds = clause.split(/\s+and\s+/i).map(c => {
      const m = c.trim().match(/^(date\(\s*(\w+)\s*\)|(\w+))\s*(=|!=|<>|>=|<=|>|<|like)\s*(.+)$/i);
      if (!m) throw SQL.err(`near "${c.trim().split(/\s/)[0]}": syntax error`);
      const col = (m[2] || m[3]).toLowerCase(); const isDate = !!m[2];
      if (!t.cols.some(x => x.name === col)) throw SQL.err(`no such column: ${col}`);
      const val = SQL.literal(m[5], params); const op = m[4].toLowerCase();
      return r => { let x = r[col]; if (isDate && x) x = String(x).slice(0, 10); switch (op) { case '=': return x == val; case '!=': case '<>': return x != val; case '>': return x > val; case '<': return x < val; case '>=': return x >= val; case '<=': return x <= val; case 'like': return new RegExp('^' + String(val).replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(String(x)); } };
    });
    return r => conds.every(f => f(r));
  };
  SQL.exec = (db, stmt, params) => {
    params = (params || []).slice();
    const s = stmt.trim().replace(/\s+/g, ' ');
    let m;
    if ((m = s.match(/^create table (if not exists )?(\w+) ?\((.*)\)$/i))) {
      const name = m[2].toLowerCase();
      if (db.tables[name]) { if (m[1]) return { changes: 0 }; throw SQL.err(`table ${name} already exists`); }
      const cols = [];
      SQL.splitTop(m[3]).forEach(def => {
        if (/^(primary key|unique|foreign key|check|constraint)\b/i.test(def)) return;
        const p = def.match(/^(\w+)\s*(\w+)?(.*)$/); if (!p) throw SQL.err(`near "${def}": syntax error`);
        const rest = p[3] || '';
        const dm = rest.match(/default\s+(\((?:[^()]|\([^()]*\))*\)|'[^']*'|\S+)/i);
        cols.push({ name: p[1].toLowerCase(), type: (p[2] || '').toUpperCase(), pk: /primary key/i.test(rest), auto: /autoincrement/i.test(rest), notnull: /not null/i.test(rest), unique: /unique/i.test(rest), def: dm ? dm[1].replace(/^\((.*)\)$/, '$1') : undefined });
      });
      db.tables[name] = { name, cols, rows: [], seq: 0, sql: 'CREATE TABLE ' + m[2] + ' (' + m[3] + ')' };
      return { changes: 0 };
    }
    if ((m = s.match(/^create (unique )?index (if not exists )?(\w+) on (\w+) ?\((.*)\)$/i))) { SQL.table(db, m[4]); db.indexes = db.indexes || []; if (!db.indexes.some(i => i.name === m[3])) db.indexes.push({ name: m[3], table: m[4], sql: s }); return { changes: 0 }; }
    if ((m = s.match(/^drop table (if exists )?(\w+)$/i))) { if (!db.tables[m[2].toLowerCase()]) { if (m[1]) return { changes: 0 }; throw SQL.err(`no such table: ${m[2]}`); } delete db.tables[m[2].toLowerCase()]; return { changes: 0 }; }
    if ((m = s.match(/^insert into (\w+) ?(?:\(([^)]*)\))? ?values ?(.*)$/i))) {
      const t = SQL.table(db, m[1]);
      const cols = m[2] ? m[2].split(',').map(x => x.trim().toLowerCase()) : t.cols.map(c => c.name);
      cols.forEach(c => { if (!t.cols.some(x => x.name === c)) throw SQL.err(`table ${t.name} has no column named ${c}`); });
      const groups = SQL.splitTop(m[3]).map(g => g.replace(/^\(|\)$/g, ''));
      groups.forEach(g => {
        const vals = SQL.splitTop(g).map(v => SQL.literal(v, params));
        if (vals.length !== cols.length) throw SQL.err(`${vals.length} values for ${cols.length} columns`);
        const row = {}; cols.forEach((c, i) => { row[c] = vals[i]; });
        t.cols.forEach(c => {
          if (row[c.name] === undefined || (c.pk && row[c.name] === null)) {
            if (c.pk && /INT/.test(c.type)) row[c.name] = ++t.seq;
            else if (c.def !== undefined) row[c.name] = SQL.literal(c.def, []);
            else row[c.name] = null;
          } else if (c.pk && typeof row[c.name] === 'number') t.seq = Math.max(t.seq, row[c.name]);
          if (c.notnull && row[c.name] === null) throw SQL.err(`NOT NULL constraint failed: ${t.name}.${c.name} (19)`);
          if ((c.unique || c.pk) && row[c.name] !== null && t.rows.some(r => r[c.name] === row[c.name])) throw SQL.err(`UNIQUE constraint failed: ${t.name}.${c.name} (19)`);
        });
        t.rows.push(row);
      });
      return { changes: groups.length };
    }
    if ((m = s.match(/^select (.+?) from (\w+)(?: where (.+?))?(?: order by (\w+)( asc| desc)?)?(?: limit (\d+))?$/i))) {
      const t = SQL.table(db, m[2]); const f = SQL.where(t, m[3], params);
      let rows = t.rows.filter(f);
      if (m[4]) { const c = m[4].toLowerCase(); rows = rows.slice().sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (/desc/i.test(m[5] || '') ? -1 : 1)); }
      if (m[6]) rows = rows.slice(0, +m[6]);
      const sel = m[1].trim();
      if (/^count\(\*\)$/i.test(sel)) return { cols: ['count(*)'], rows: [[rows.length]] };
      const cols = sel === '*' ? t.cols.map(c => c.name) : sel.split(',').map(x => x.trim().toLowerCase());
      cols.forEach(c => { if (!t.cols.some(x => x.name === c)) throw SQL.err(`no such column: ${c}`); });
      return { cols, rows: rows.map(r => cols.map(c => r[c])) };
    }
    if ((m = s.match(/^update (\w+) set (.+?)(?: where (.+))?$/i))) {
      const t = SQL.table(db, m[1]); const sets = SQL.splitTop(m[2]).map(x => { const p = x.split('='); return [p[0].trim().toLowerCase(), p.slice(1).join('=')]; });
      const f = SQL.where(t, m[3], params.slice(sets.length)); let n = 0;
      t.rows.forEach(r => { if (f(r)) { sets.forEach(([c, v]) => { r[c] = SQL.literal(v, params); }); n++; } });
      return { changes: n };
    }
    if ((m = s.match(/^delete from (\w+)(?: where (.+))?$/i))) { const t = SQL.table(db, m[1]); const f = SQL.where(t, m[2], params); const before = t.rows.length; t.rows = t.rows.filter(r => !f(r)); return { changes: before - t.rows.length }; }
    if (/^(begin|commit|pragma|vacuum)/i.test(s)) return { changes: 0 };
    throw SQL.err(`near "${s.split(' ')[0]}": syntax error`);
  };
  SQL.isWrite = s => !/^\s*(select|pragma)/i.test(s);
  L.sql = SQL;
  L.newDb = () => ({ tables: {}, indexes: [] });

  // ======================================================================= services
  const BUILTIN_UNITS = {
    nginx: { desc: 'A high performance web server and a reverse proxy server', path: '/usr/lib/systemd/system/nginx.service', docs: 'man:nginx(8)' },
    apache2: { desc: 'The Apache HTTP Server', path: '/usr/lib/systemd/system/apache2.service', docs: 'https://httpd.apache.org/docs/2.4/' },
    ssh: { desc: 'OpenBSD Secure Shell server', path: '/usr/lib/systemd/system/ssh.service', docs: 'man:sshd(8)' },
    ufw: { desc: 'Uncomplicated firewall', path: '/usr/lib/systemd/system/ufw.service', docs: 'man:ufw(8)' },
    cron: { desc: 'Regular background program processing daemon', path: '/usr/lib/systemd/system/cron.service', docs: 'man:cron(8)' }
  };
  L.parseUnit = text => {
    const u = { env: {}, envFiles: [] }; let sec = '';
    String(text).split('\n').forEach(raw => {
      const line = raw.trim(); if (!line || line.startsWith('#') || line.startsWith(';')) return;
      const sm = line.match(/^\[(\w+)\]$/); if (sm) { sec = sm[1]; return; }
      const kv = line.match(/^(\w+)\s*=\s*(.*)$/); if (!kv) return;
      const [, k, v] = kv;
      if (sec === 'Service') {
        if (k === 'Environment') v.split(/\s+(?=\w+=)/).forEach(p => { const e = p.replace(/^"|"$/g, '').match(/^(\w+)=(.*)$/); if (e) u.env[e[1]] = e[2]; });
        else if (k === 'EnvironmentFile') u.envFiles.push(v.trim());
        else u[k] = v.trim();
      } else if (sec === 'Unit' && k === 'Description') u.Description = v.trim();
      else if (sec === 'Install' && k === 'WantedBy') u.WantedBy = v.trim();
    });
    return u;
  };
  L.readEnvFile = text => { const env = {}; String(text || '').split('\n').forEach(l => { const m = l.trim().match(/^(?:export\s+)?(\w+)\s*=\s*(.*)$/); if (m && !l.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); return env; };

  // ======================================================================= ufw
  const UFW_APPS = { OpenSSH: [{ port: 22, proto: 'tcp' }], 'Nginx HTTP': [{ port: 80, proto: 'tcp' }], 'Nginx HTTPS': [{ port: 443, proto: 'tcp' }], 'Nginx Full': [{ port: 80, proto: 'tcp' }, { port: 443, proto: 'tcp' }] };
  L.ufwAllows = (st, srcIp, port) => {
    if (!st.ufw.enabled) return true;
    for (const r of st.ufw.rules) {
      const ports = r.app ? (UFW_APPS[r.app] || []).map(x => x.port) : r.port === null ? null : [].concat(r.port);
      if (ports && !ports.includes(port)) continue;
      if (r.from !== 'Anywhere' && !net.contains(r.from, srcIp)) continue;
      return r.action === 'ALLOW';
    }
    return st.ufw.defaultIn === 'allow';
  };
  function ufwRuleText(r) { return r.app ? r.app : r.port === null ? 'Anywhere' : `${r.port}${r.proto ? '/' + r.proto : ''}`; }

  // ======================================================================= commands
  /**
   * cfg: { user, home, host, ip, adminIp, packages: {name: installFn(st)}, start(st,name,unit,env) -> {ok,log,listen},
   *        curl(st,url,flags,lab) -> text|{text,cls}, extra: {cmdName: spec}, onWrite(st,path) }
   */
  L.commands = (lab, cfg) => {
    const S = () => lab.state;
    const who = () => { const st = S(); return st.__asUser || (st.rootShell ? 'root' : cfg.user); };
    const P = p => L.norm(p, S().cwd, cfg.home);
    const deny = (cmd, p, what) => CmdError(`${cmd}: ${what ? what + ' ' : ''}'${p}': Permission denied`);
    const needRoot = (msg) => { if (who() !== 'root') throw CmdError(msg); };
    const flagsOf = toks => { const f = new Set(); const rest = []; toks.forEach(t => { if (/^-[A-Za-z]+$/.test(t)) t.slice(1).split('').forEach(c => f.add(c)); else if (/^--[\w-]+$/.test(t)) f.add(t.slice(2)); else rest.push(t); }); return { f, rest }; };
    const lockedGuard = () => { if (S().lockedOut) throw CmdError(`ssh: connect to host ${cfg.ip} port 22: Connection timed out\n(You locked yourself out with the firewall. Type "console" to use the provider's serial console.)`); };
    const wrap = specs => { Object.values(specs).forEach(sp => { const run = sp.run; sp.run = (a, c) => { if (sp.name !== 'console') lockedGuard(); return run(a, c); }; }); return specs; };

    function readText(cmd, p) {
      const st = S(); const r = L.resolve(st, p);
      if (!r.node) throw CmdError(`${cmd}: ${p}: No such file or directory`);
      if (r.node.t === 'd') throw CmdError(`${cmd}: ${p}: Is a directory`);
      if (!L.canEnter(st, who(), r.path) || !L.can(st, who(), r.node, 'r')) throw CmdError(`${cmd}: ${p}: Permission denied`);
      if (r.node.db) return '(binary SQLite database: use sqlite3)';
      return r.node.c;
    }
    function svc(name) { const st = S(); name = name.replace(/\.service$/, ''); return { name, s: st.services[name] }; }
    function unitText(name) { const n = L.get(S(), `/etc/systemd/system/${name}.service`); return n ? n.c : null; }
    function startService(name) {
      const st = S(); const sv = st.services[name];
      if (!sv) return { ok: false, notfound: true };
      let unit = null, env = {};
      if (sv.custom) {
        if (!st.units[name]) st.units[name] = unitText(name);
        if (st.units[name] === null) return { ok: false, notfound: true };
        unit = L.parseUnit(st.units[name]);
        if (unit.User && !st.users[unit.User]) return { ok: false, log: [`${name}.service: Failed to determine user credentials: No such process`, `${name}.service: Failed at step USER spawning ${unit.ExecStart}: No such process`, `${name}.service: Main process exited, code=exited, status=217/USER`] };
        const exe = (unit.ExecStart || '').split(/\s+/)[0];
        const en = exe && L.get(st, exe);
        if (!exe || !en) return { ok: false, log: [`${name}.service: Failed to locate executable ${exe || '(none)'}: No such file or directory`, `${name}.service: Main process exited, code=exited, status=203/EXEC`] };
        for (const ef of unit.envFiles) {
          const optional = ef.startsWith('-'); const efp = ef.replace(/^-/, ''); const n = L.get(st, efp);
          if (!n) { if (optional) continue; return { ok: false, log: [`${name}.service: Failed to load environment files: No such file or directory`, `${name}.service: Failed to run 'start' task: No such file or directory`] }; }
          Object.assign(env, L.readEnvFile(n.c));
        }
        Object.assign(env, unit.env);
      }
      const r = cfg.start ? cfg.start(st, name, unit, env) : { ok: true };
      if (r && r.ok) { sv.active = true; sv.failed = null; sv.env = env; sv.unit = unit; sv.since = new Date().toTimeString().slice(0, 8); if (r.listen) sv.listen = r.listen; }
      else { sv.active = false; sv.failed = r.log || ['failed']; }
      return r;
    }
    L._startService = startService;

    const c = {
      whoami: { raw: true, desc: 'Show the current user', run: () => who() },
      id: { raw: true, desc: 'Show user and group IDs', run: a => { const u = a._pos[0] || who(); const x = S().users[u]; if (!x) throw CmdError(`id: '${u}': no such user`); return `uid=${x.uid}(${u}) gid=${x.uid}(${x.groups[0]}) groups=${x.groups.map((g, i) => `${i === 0 ? x.uid : 27 + i}(${g})`).join(',')}`; } },
      groups: { raw: true, desc: 'Show group memberships', run: a => { const u = a._pos[0] || who(); return (S().users[u] || { groups: [] }).groups.join(' '); } },
      hostname: { raw: true, desc: 'Show the host name', run: () => cfg.host },
      uname: { raw: true, desc: 'Show kernel information', run: () => `Linux ${cfg.host} 6.8.0-49-generic #49-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux` },
      pwd: { raw: true, desc: 'Print working directory', run: () => S().cwd },
      cd: { raw: true, desc: 'Change directory', run: a => { const st = S(); const p = P(a._pos[0] || '~'); const n = L.get(st, p); if (!n) throw CmdError(`bash: cd: ${a._pos[0]}: No such file or directory`); if (n.t !== 'd') throw CmdError(`bash: cd: ${a._pos[0]}: Not a directory`); if (!L.can(st, who(), n, 'x') || !L.canEnter(st, who(), p)) throw CmdError(`bash: cd: ${a._pos[0]}: Permission denied`); st.cwd = p; return null; } },
      ls: {
        raw: true, desc: 'List files (-l, -a)', run: a => {
          const st = S(); const { f, rest } = flagsOf(a._pos); const paths = rest.length ? rest : ['.'];
          const out = [];
          paths.forEach(raw => {
            const p = P(raw); const r = L.resolve(st, p); const n = st.fs[p];
            if (!n) { out.push(`ls: cannot access '${raw}': No such file or directory`); return; }
            const fmt = (path, node) => {
              const name = L.base(path) + (node.t === 'l' ? ' -> ' + node.target : '');
              const own = x => (f.has('n') ? String(st.users[x] ? st.users[x].uid : x) : x);
              return (f.has('l') || f.has('n')) ? `${L.modeStr(node)} 1 ${own(node.o).padEnd(8)} ${own(node.g).padEnd(8)} ${String(L.size(r.node && path === p ? r.node : node)).padStart(6)} ${NOW} ${name}` : L.base(path);
            };
            if (r.node && r.node.t === 'd' && !(n.t === 'l' && f.has('l') && !raw.endsWith('/'))) {
              if (!L.can(st, who(), r.node, 'r') || !L.canEnter(st, who(), r.path + '/x')) { out.push(`ls: cannot open directory '${raw}': Permission denied`); return; }
              let kids = L.children(st, r.path);
              if (!f.has('a')) kids = kids.filter(k => !L.base(k).startsWith('.'));
              if (paths.length > 1) out.push(raw + ':');
              if (f.has('l') || f.has('n')) { out.push(`total ${kids.length * 4}`); kids.forEach(k => out.push(fmt(k, st.fs[k]))); }
              else out.push(kids.map(k => L.base(k) + (st.fs[k].t === 'd' ? '/' : '')).join('  '));
            } else out.push(fmt(p, n));
          });
          return out.join('\n');
        }
      },
      cat: { raw: true, aliases: ['less', 'more'], desc: 'Print files', run: a => { if (a._pos.includes('>') || a._pos.includes('<')) throw CmdError('Redirection with cat isn\'t supported here: use nano to edit files (echo "text" > file also works).'); if (!a._pos.length) throw CmdError('cat: missing file operand'); return a._pos.map(x => readText('cat', P(x))).join('\n').replace(/\n$/, ''); } },
      head: { raw: true, desc: 'First lines of a file', run: a => { const { rest } = flagsOf(a._pos.filter(t => !/^\d+$/.test(t))); const n = +(a._pos.find(t => /^\d+$/.test(t)) || 10); return readText('head', P(rest[0])).split('\n').slice(0, n).join('\n'); } },
      tail: { raw: true, desc: 'Last lines of a file', run: a => { const { rest } = flagsOf(a._pos.filter(t => !/^\d+$/.test(t))); const n = +(a._pos.find(t => /^\d+$/.test(t)) || 10); return readText('tail', P(rest[0])).replace(/\n$/, '').split('\n').slice(-n).join('\n'); } },
      grep: { raw: true, desc: 'Search a file for a pattern', run: a => { const { f, rest } = flagsOf(a._pos); const [pat, file] = rest; if (!pat || !file) throw CmdError('Usage: grep [-i] [-n] PATTERN FILE'); const re = new RegExp(pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), f.has('i') ? 'i' : ''); return readText('grep', P(file)).split('\n').map((l, i) => [l, i + 1]).filter(([l]) => re.test(l)).map(([l, i]) => (f.has('n') ? i + ':' : '') + l).join('\n'); } },
      echo: {
        raw: true, desc: 'Print text (supports > and >> into a file)', run: a => {
          const st = S(); const toks = a._pos; const ri = toks.findIndex(t => t === '>' || t === '>>');
          const text = (ri >= 0 ? toks.slice(0, ri) : toks).filter(t => t !== '-e' && t !== '-n').join(' ');
          if (ri < 0) return text;
          const target = toks[ri + 1]; if (!target) throw CmdError('bash: syntax error near unexpected token `newline\'');
          const p = P(target); const r = L.writeFile(st, who(), p, text + '\n', { append: toks[ri] === '>>' });
          if (r.err) throw CmdError(`bash: ${target}: ${r.err}${r.err === 'Permission denied' ? '\n(Redirection runs as you, not root, even with sudo. Use: sudo nano ' + target + ')' : ''}`);
          if (cfg.onWrite) cfg.onWrite(st, p);
          return null;
        }
      },
      mkdir: {
        raw: true, desc: 'Create directories (-p)', run: a => {
          const st = S(); const { f, rest } = flagsOf(a._pos);
          rest.forEach(raw => {
            const p = P(raw);
            if (st.fs[p]) { if (f.has('p')) return; throw CmdError(`mkdir: cannot create directory '${raw}': File exists`); }
            const chain = []; let cur = p; while (!st.fs[cur]) { chain.unshift(cur); cur = L.parent(cur); }
            if (chain.length > 1 && !f.has('p')) throw CmdError(`mkdir: cannot create directory '${raw}': No such file or directory`);
            chain.forEach(d => { const par = L.get(st, L.parent(d)); if (!L.can(st, who(), par, 'w')) throw CmdError(`mkdir: cannot create directory '${raw}': Permission denied`); const u = st.users[who()]; st.fs[d] = L.d(who(), u.groups[0], 0o755); });
          });
          return null;
        }
      },
      touch: { raw: true, desc: 'Create an empty file', run: a => { const st = S(); a._pos.forEach(raw => { const p = P(raw); if (st.fs[p]) return; const r = L.writeFile(st, who(), p, ''); if (r.err) throw CmdError(`touch: cannot touch '${raw}': ${r.err}`); }); return null; } },
      rm: {
        raw: true, desc: 'Remove files (-r, -f)', run: a => {
          const st = S(); const { f, rest } = flagsOf(a._pos);
          rest.forEach(raw => {
            const p = P(raw); const n = st.fs[p];
            if (!n) { if (f.has('f')) return; throw CmdError(`rm: cannot remove '${raw}': No such file or directory`); }
            if (n.t === 'd' && !f.has('r') && !f.has('R')) throw CmdError(`rm: cannot remove '${raw}': Is a directory`);
            if (!L.can(st, who(), L.get(st, L.parent(p)), 'w')) throw CmdError(`rm: cannot remove '${raw}': Permission denied`);
            Object.keys(st.fs).forEach(k => { if (k === p || k.startsWith(p + '/')) delete st.fs[k]; });
          });
          return null;
        }
      },
      cp: {
        raw: true, desc: 'Copy a file', run: a => {
          const st = S(); const { rest } = flagsOf(a._pos); if (rest.length < 2) throw CmdError('cp: missing destination file operand');
          const src = P(rest[0]); const content = readText('cp', src); let dst = P(rest[1]);
          if (L.get(st, dst) && L.get(st, dst).t === 'd') dst = dst + '/' + L.base(src);
          const srcNode = L.get(st, src);
          const r = L.writeFile(st, who(), dst, content); if (r.err) throw CmdError(`cp: cannot create regular file '${rest[1]}': ${r.err}`);
          if (srcNode.db) st.fs[dst].db = JSON.parse(JSON.stringify(srcNode.db));
          if (cfg.onWrite) cfg.onWrite(st, dst);
          return null;
        }
      },
      mv: {
        raw: true, desc: 'Move or rename', run: a => {
          const st = S(); const { rest } = flagsOf(a._pos); if (rest.length < 2) throw CmdError('mv: missing destination file operand');
          const src = P(rest[0]); let dst = P(rest[1]);
          if (!st.fs[src]) throw CmdError(`mv: cannot stat '${rest[0]}': No such file or directory`);
          if (st.fs[dst] && L.get(st, dst).t === 'd') dst = dst + '/' + L.base(src);
          if (!L.can(st, who(), L.get(st, L.parent(src)), 'w') || !L.can(st, who(), L.get(st, L.parent(dst)), 'w')) throw CmdError(`mv: cannot move '${rest[0]}' to '${rest[1]}': Permission denied`);
          Object.keys(st.fs).forEach(k => { if (k === src || k.startsWith(src + '/')) { st.fs[dst + k.slice(src.length)] = st.fs[k]; delete st.fs[k]; } });
          return null;
        }
      },
      ln: {
        raw: true, desc: 'Create a link (ln -s TARGET LINK)', run: a => {
          const st = S(); const { f, rest } = flagsOf(a._pos); if (!f.has('s')) throw CmdError('Only symbolic links (ln -s) are supported in this simulation.');
          const target = P(rest[0]); let link = P(rest[1] || '.');
          if (st.fs[link] && st.fs[link].t === 'd') link = link + '/' + L.base(target);
          if (st.fs[link]) { if (f.has('f')) delete st.fs[link]; else throw CmdError(`ln: failed to create symbolic link '${link}': File exists`); }
          if (!L.can(st, who(), L.get(st, L.parent(link)), 'w')) throw CmdError(`ln: failed to create symbolic link '${link}': Permission denied`);
          st.fs[link] = L.l(target); st.fs[link].o = who(); st.fs[link].g = who() === 'root' ? 'root' : who();
          return null;
        }
      },
      chmod: {
        raw: true, desc: 'Change permissions (octal like 600, or u+x / go-rwx)', run: a => {
          const st = S(); const { f, rest } = flagsOf(a._pos.filter(t => !/^[ugoa]*[+=-][rwx]+$/.test(t)));
          const modeTok = a._pos.find(t => /^[0-7]{3,4}$/.test(t) || /^[ugoa]*[+=-][rwx]+(,[ugoa]*[+=-][rwx]+)*$/.test(t));
          if (!modeTok) throw CmdError('chmod: missing operand');
          const files = rest.filter(t => t !== modeTok);
          files.forEach(raw => {
            const p = P(raw); const r = L.resolve(st, p);
            if (!r.node) throw CmdError(`chmod: cannot access '${raw}': No such file or directory`);
            const targets = f.has('R') ? Object.keys(st.fs).filter(k => k === r.path || k.startsWith(r.path + '/')) : [r.path];
            targets.forEach(tp => {
              const n = st.fs[tp];
              if (who() !== 'root' && n.o !== who()) throw CmdError(`chmod: changing permissions of '${raw}': Operation not permitted`);
              if (/^[0-7]+$/.test(modeTok)) n.m = parseInt(modeTok.slice(-3), 8);
              else modeTok.split(',').forEach(part => {
                const m = part.match(/^([ugoa]*)([+=-])([rwx]+)$/); const whoS = m[1] || 'a';
                const bits = m[3].split('').reduce((acc, ch) => acc | { r: 4, w: 2, x: 1 }[ch], 0);
                const shifts = { u: [6], g: [3], o: [0], a: [6, 3, 0] };
                whoS.split('').flatMap(ch => shifts[ch]).forEach(s => {
                  if (m[2] === '+') n.m |= bits << s; else if (m[2] === '-') n.m &= ~(bits << s); else { n.m &= ~(7 << s); n.m |= bits << s; }
                });
              });
            });
          });
          return null;
        }
      },
      chown: {
        raw: true, desc: 'Change owner (chown [-R] user[:group] path)', run: a => {
          const st = S(); const { f, rest } = flagsOf(a._pos); const [spec, ...files] = rest;
          if (!spec || !files.length) throw CmdError('chown: missing operand');
          const [u, g] = spec.split(':');
          if (u && !st.users[u] && !/^\d+$/.test(u)) throw CmdError(`chown: invalid user: '${spec}'`);
          if (g && !/^\d+$/.test(g) && !Object.values(st.users).some(x => x.groups.includes(g))) throw CmdError(`chown: invalid group: '${spec}'`);
          if (who() !== 'root') throw CmdError(`chown: changing ownership of '${files[0]}': Operation not permitted`);
          files.forEach(raw => {
            const p = P(raw); const r = L.resolve(st, p); if (!r.node) throw CmdError(`chown: cannot access '${raw}': No such file or directory`);
            const targets = f.has('R') ? Object.keys(st.fs).filter(k => k === r.path || k.startsWith(r.path + '/')) : [r.path];
            targets.forEach(tp => { if (u) st.fs[tp].o = u; if (g !== undefined) st.fs[tp].g = g || (st.users[u] ? st.users[u].groups[0] : st.fs[tp].g); });
          });
          return null;
        }
      },
      stat: { raw: true, desc: 'Show file details', run: a => { const st = S(); const p = P(a._pos[0] || ''); const r = L.resolve(st, p); if (!r.node) throw CmdError(`stat: cannot statx '${a._pos[0]}': No such file or directory`); const n = r.node; return `  File: ${p}\n  Size: ${L.size(n)}\t\tBlocks: 8\tIO Block: 4096   ${n.t === 'd' ? 'directory' : 'regular file'}\nAccess: (0${n.m.toString(8)}/${L.modeStr(n)})  Uid: (    0/${n.o.padStart(8)})   Gid: (    0/${n.g.padStart(8)})`; } },
      which: { raw: true, desc: 'Locate a command', run: a => { const bins = { nginx: '/usr/sbin/nginx', sqlite3: '/usr/bin/sqlite3', python3: '/usr/bin/python3', ufw: '/usr/sbin/ufw', curl: '/usr/bin/curl' }; const n = a._pos[0]; if (!bins[n]) return ''; if (n === 'nginx' && !S().packages.includes('nginx')) return ''; if (n === 'sqlite3' && !S().packages.includes('sqlite3')) return ''; return bins[n]; } },
      useradd: {
        raw: true, desc: 'Create a user (useradd --system --no-create-home --shell /usr/sbin/nologin NAME)', run: a => {
          const st = S(); const toks = a._pos.slice(); let name = null, shell = '/bin/sh', home = null, system = false, create = false;
          for (let i = 0; i < toks.length; i++) { const t = toks[i]; if (['-s', '--shell'].includes(t)) shell = toks[++i]; else if (['-d', '--home-dir'].includes(t)) home = toks[++i]; else if (['-r', '--system'].includes(t)) system = true; else if (['-m', '--create-home'].includes(t)) create = true; else if (['-M', '--no-create-home', '-U', '--user-group'].includes(t)) continue; else if (['-g', '-G', '-c', '--comment', '--gid', '--groups'].includes(t)) i++; else if (t.startsWith('-')) throw CmdError(`useradd: unrecognized option '${t}'`); else name = t; }
          if (!name) throw CmdError('Usage: useradd [options] LOGIN');
          if (who() !== 'root') throw CmdError('useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.');
          if (st.users[name]) throw CmdError(`useradd: user '${name}' already exists`);
          st.users[name] = { uid: system ? 998 - Object.keys(st.users).filter(u => st.users[u].uid < 1000 && st.users[u].uid > 100).length : 1001 + Object.keys(st.users).length, groups: [name], shell, home: home || '/home/' + name, system };
          if (create) st.fs[home || '/home/' + name] = L.d(name, name, 0o750);
          return null;
        }
      },
      usermod: { raw: true, desc: 'Modify a user (usermod -aG group user)', run: a => { const st = S(); needRoot('usermod: Permission denied.'); const gi = a._pos.findIndex(t => /^-a?G$/.test(t) || t === '-aG'); const g = a._pos[gi + 1]; const u = a._pos[a._pos.length - 1]; if (!st.users[u]) throw CmdError(`usermod: user '${u}' does not exist`); g.split(',').forEach(x => { if (!st.users[u].groups.includes(x)) st.users[u].groups.push(x); }); return null; } },
      getent: { raw: true, desc: 'Look up a user (getent passwd NAME)', run: a => { const st = S(); if (a._pos[0] !== 'passwd') throw CmdError('Only "getent passwd NAME" is supported here.'); const u = a._pos[1]; const x = st.users[u]; if (!x) return ''; return `${u}:x:${x.uid}:${x.uid}::${x.home || '/home/' + u}:${x.shell || '/bin/bash'}`; } },
      nano: {
        raw: true, aliases: ['vim', 'vi', 'edit'], desc: 'Edit a file in the editor panel', run: a => {
          const st = S(); const raw = a._pos.filter(t => !t.startsWith('-'))[0]; if (!raw) throw CmdError('Usage: nano FILE');
          const p = P(raw); const r = L.resolve(st, p);
          if (r.node && r.node.t === 'd') throw CmdError(`"${raw}" is a directory`);
          if (r.node && (!L.can(st, who(), r.node, 'r') || !L.canEnter(st, who(), r.path))) throw CmdError(`[ Error reading ${raw}: Permission denied ]`);
          if (r.node && r.node.db) throw CmdError(`${raw} is a binary SQLite database. Use sqlite3.`);
          const writable = r.node ? L.can(st, who(), r.node, 'w') : L.can(st, who(), L.get(st, L.parent(r.path)), 'w');
          L.openEditor(lab, r.path, r.node ? r.node.c : '', who(), writable);
          return { text: `Opened ${r.path} in the editor panel${writable ? '' : ' (read-only: you don\'t have write permission; try sudo nano)'}.`, cls: 'muted' };
        }
      },
      apt: aptSpec('apt'), 'apt-get': aptSpec('apt-get'),
      systemctl: {
        raw: true, desc: 'Control services (status/start/stop/restart/reload/enable/disable/daemon-reload)', run: a => {
          const st = S(); const toks = a._pos.filter(t => t !== '--no-pager' && t !== '-l'); const verb = toks[0];
          const now = toks.includes('--now'); const names = toks.slice(1).filter(t => t !== '--now');
          const authErr = v => CmdError(`Failed to ${v} ${names[0] || ''}: Interactive authentication required.\nSee system logs and 'systemctl status ${names[0] || ''}' for details.`);
          if (verb === 'daemon-reload') { if (who() !== 'root') throw authErr('reload daemon'); Object.keys(st.services).filter(n => st.services[n].custom).forEach(n => { st.units[n] = unitText(n); }); L.syncCustom(st); return null; }
          if (!verb) return Object.keys(st.services).filter(n => st.services[n].installed).map(n => `  ${(n + '.service').padEnd(28)} loaded ${st.services[n].active ? 'active   running' : st.services[n].failed ? 'failed   failed ' : 'inactive dead   '} ${(BUILTIN_UNITS[n] || {}).desc || n}`).join('\n');
          if (!names.length) throw CmdError(`Too few arguments.`);
          L.syncCustom(st);
          const out = [];
          for (const raw of names) {
            const { name, s } = svc(raw);
            if (!s || !s.installed) { if (verb === 'status') { out.push(`Unit ${name}.service could not be found.`); continue; } throw CmdError(`Failed to ${verb} ${name}.service: Unit ${name}.service not found.`); }
            if (verb === 'status' || verb === 'is-active' || verb === 'is-enabled') {
              if (verb === 'is-active') { out.push(s.active ? 'active' : s.failed ? 'failed' : 'inactive'); continue; }
              if (verb === 'is-enabled') { out.push(s.enabled ? 'enabled' : 'disabled'); continue; }
              const info = BUILTIN_UNITS[name] || { desc: (s.custom && st.units[name] && L.parseUnit(st.units[name]).Description) || name, path: `/etc/systemd/system/${name}.service` };
              const changed = s.custom && st.units[name] !== undefined && st.units[name] !== unitText(name);
              const lines = [`${s.active ? '●' : s.failed ? '×' : '○'} ${name}.service - ${info.desc}`, `     Loaded: loaded (${info.path}; ${s.enabled ? 'enabled' : 'disabled'}; preset: enabled)`];
              if (changed) lines.push(`    Warning: The unit file, source configuration file or drop-ins of ${name}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`);
              if (s.active) lines.push(`     Active: active (running) since Fri 2026-11-20 ${s.since || '19:02:11'} CST`, `   Main PID: ${s.pid || 2000 + name.length * 37} (${name})`);
              else if (s.failed) lines.push(`     Active: failed (Result: exit-code) since Fri 2026-11-20 19:07:44 CST`, '', ...s.failed.map(l => `Nov 20 19:07:44 ${cfg.host} ${l}`));
              else lines.push('     Active: inactive (dead)');
              if (s.active && s.unit && s.unit.User) lines.push(`      User: ${s.unit.User}`);
              out.push(lines.join('\n'));
              continue;
            }
            if (who() !== 'root') throw authErr(verb);
            if (verb === 'enable' || verb === 'disable') {
              s.enabled = verb === 'enable';
              out.push(verb === 'enable' ? `Created symlink /etc/systemd/system/multi-user.target.wants/${name}.service → ${s.custom ? '/etc/systemd/system' : '/usr/lib/systemd/system'}/${name}.service.` : `Removed "/etc/systemd/system/multi-user.target.wants/${name}.service".`);
              if (now) { if (verb === 'enable') { const r = startService(name); if (!r.ok) throw CmdError(`Job for ${name}.service failed because the control process exited with error code.\nSee "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`); } else { s.active = false; } }
              continue;
            }
            if (verb === 'stop') { s.active = false; s.failed = null; if (cfg.onStop) cfg.onStop(st, name); continue; }
            if (verb === 'start' || verb === 'restart') {
              if (s.custom && st.units[name] !== undefined && st.units[name] !== null && st.units[name] !== unitText(name)) out.push(`Warning: The unit file, source configuration file or drop-ins of ${name}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`);
              if (verb === 'start' && s.active) continue;
              const r = startService(name);
              if (!r.ok) throw CmdError((out.length ? out.join('\n') + '\n' : '') + `Job for ${name}.service failed because the control process exited with error code.\nSee "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`);
              continue;
            }
            if (verb === 'reload') {
              if (!s.active) throw CmdError(`${name}.service is not active, cannot reload.`);
              const r = cfg.reload ? cfg.reload(st, name) : { ok: true };
              if (!r.ok) throw CmdError(`Job for ${name}.service failed because the control process exited with error code.\nSee "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`);
              continue;
            }
            throw CmdError(`Unknown command verb '${verb}'.`);
          }
          return out.join('\n') || null;
        }
      },
      journalctl: { raw: true, desc: 'Show service logs (journalctl -u NAME)', run: a => { const st = S(); const ui = a._pos.indexOf('-u'); const name = (ui >= 0 ? a._pos[ui + 1] : a._pos.find(t => !t.startsWith('-')) || '').replace(/\.service$/, ''); const s = st.services[name]; if (!s) return '-- No entries --'; const lines = (s.failed || []).concat(s.active ? [`Started ${name}.service.`].concat(s.log || []) : []); return lines.length ? lines.map(l => `Nov 20 19:07:44 ${cfg.host} ${l}`).join('\n') : '-- No entries --'; } },
      ufw: { raw: true, desc: 'Firewall (status, allow, deny, delete, enable, default)', run: a => ufwCmd(a._pos) },
      ss: { raw: true, aliases: ['netstat'], desc: 'Listening sockets (ss -tlnp)', run: () => { const st = S(); const rows = (cfg.listeners ? cfg.listeners(st) : []).concat([{ addr: '0.0.0.0', port: 22, proc: 'sshd' }]).sort((x, y) => x.port - y.port); return 'State   Recv-Q  Send-Q   Local Address:Port    Peer Address:Port  Process\n' + rows.map(r => `LISTEN  0       511      ${(r.addr + ':' + r.port).padEnd(20)}  0.0.0.0:*          users:(("${r.proc}"))`).join('\n'); } },
      nginx: {
        raw: true, desc: 'nginx -t (test config), nginx -s reload', run: a => {
          const st = S(); if (!st.packages.includes('nginx')) throw CmdError('Command \'nginx\' not found, but can be installed with:\nsudo apt install nginx');
          if (a._pos.includes('-v') || a._pos.includes('-V')) return 'nginx version: nginx/1.24.0 (Ubuntu)';
          if (a._pos.includes('-t') || a._pos.includes('-T')) {
            const pre = who() !== 'root' ? 'nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)\n' : '';
            if (who() !== 'root') return { text: pre + '2026/11/20 19:05:12 [emerg] 4312#4312: open() "/run/nginx.pid" failed (13: Permission denied)\nnginx: configuration file /etc/nginx/nginx.conf test failed\n(Run it with sudo.)', cls: 'err' };
            const t = L.nginxTest(st);
            if (t.errors.length) return { text: t.errors[0] + '\nnginx: configuration file /etc/nginx/nginx.conf test failed', cls: 'err' };
            st.flags.nginxTested = true;
            return { text: 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful', cls: 'ok' };
          }
          if (a._pos[0] === '-s' && a._pos[1] === 'reload') { needRoot('nginx: [alert] kill(2241, 1) failed (1: Operation not permitted)'); const r = cfg.reload ? cfg.reload(st, 'nginx') : { ok: true }; if (!r.ok) throw CmdError(r.log ? r.log[0] : 'reload failed'); return null; }
          throw CmdError('Usage: nginx -t | nginx -s reload | nginx -v');
        }
      },
      curl: { raw: true, desc: 'Make an HTTP request (curl [-I] [-k] [-L] [-H "Host: x"] URL)', run: a => (cfg.curl ? cfg.curl(S(), a._pos, lab) : 'curl: (6) Could not resolve host') },
      sqlite3: { raw: true, desc: 'SQLite shell: sqlite3 DB ["SQL"] or sqlite3 DB < file.sql', run: a => sqlite3Cmd(a._pos) },
      sudo: {
        raw: true, desc: 'Run a command as root (sudo -u USER CMD, sudo -i for a root shell)', run: a => {
          const st = S(); let toks = a._pos.slice(); let user = 'root';
          if (!toks.length) throw CmdError('usage: sudo -h | -K | -k | -V\nusage: sudo [-u user] command');
          if (toks[0] === '-u') { user = toks[1]; toks = toks.slice(2); if (!st.users[user]) throw CmdError(`sudo: unknown user ${user}`); }
          if (!((st.users[cfg.user] || {}).groups || []).includes('sudo') && who() !== 'root') throw CmdError(`${cfg.user} is not in the sudoers file.`);
          const pre = st.sudoAsked ? '' : `[sudo] password for ${cfg.user}: ********\n`; st.sudoAsked = true;
          if (toks[0] === '-i' || (toks[0] === 'su' && (toks.length === 1 || toks[1] === '-'))) { st.rootShell = true; st.cwd = '/root'; return pre ? { text: pre.trim(), cls: 'muted' } : null; }
          const line = toks.map(t => (/[\s;|]/.test(t) || t === '' ? `"${t.replace(/"/g, '\\"')}"` : t)).join(' ');
          const prev = st.__asUser; st.__asUser = user;
          try { const r = lab._run(line); if (pre) { if (r && typeof r === 'object') r.pre = pre.trim() + (r.pre ? '\n' + r.pre : ''); else return { pre: pre.trim(), text: r === null || r === undefined ? '' : String(r) }; } return r; }
          finally { st.__asUser = prev; }
        }
      },
      exit: { raw: true, aliases: ['logout'], desc: 'Leave the root shell', run: () => { const st = S(); if (st.rootShell) { st.rootShell = false; st.cwd = cfg.home; return 'logout'; } return { text: '(The SSH session stays open in this simulation.)', cls: 'muted' }; } },
      console: { raw: true, desc: 'Open the provider\'s serial console (recovery)', run: () => { const st = S(); if (!st.lockedOut) return { text: 'You still have SSH access, so the serial console isn\'t needed.', cls: 'muted' }; st.lockedOut = false; st.ufw.enabled = false; return { text: `Connected to serial console of ${cfg.host} as root.\n# ufw disable\nFirewall stopped and disabled on system startup\nSSH access restored. (This counts as an outage in the objectives: reset the lab to try again cleanly.)`, cls: 'warn' }; } }
    };
    if (cfg.patch) cfg.patch(c, { S, who, P });
    if (cfg.extra) Object.assign(c, typeof cfg.extra === 'function' ? cfg.extra(lab, who) : cfg.extra);
    return wrap(c);

    // ---------------------------------------------------------- apt
    function aptSpec(nm) {
      return {
        raw: true, desc: 'Package manager (update, install, remove)', run: a => {
          const st = S(); const { f, rest } = flagsOf(a._pos); const verb = rest[0]; const pkgs = rest.slice(1);
          const lock = 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?';
          if (verb === 'update') { if (who() !== 'root') throw CmdError('Reading package lists... Done\nE: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/'); st.aptUpdated = true; return 'Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nGet:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]\nGet:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]\nFetched 252 kB in 1s (310 kB/s)\nReading package lists... Done\nBuilding dependency tree... Done\nAll packages are up to date.'; }
          if (verb === 'install') {
            if (!pkgs.length) throw CmdError('E: No packages specified');
            if (who() !== 'root') throw CmdError(lock);
            const out = ['Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done'];
            const fresh = [];
            pkgs.forEach(p => {
              if (st.packages.includes(p)) { out.push(`${p} is already the newest version.`); return; }
              if (!cfg.packages || !cfg.packages[p]) throw CmdError(out.join('\n') + `\nE: Unable to locate package ${p}`);
              fresh.push(p);
            });
            if (fresh.length) {
              out.push('The following NEW packages will be installed:', '  ' + fresh.join(' '), `0 upgraded, ${fresh.length} newly installed, 0 to remove and 0 not upgraded.`);
              if (!f.has('y') && !f.has('yes')) out.push('Do you want to continue? [Y/n] Y   (auto-answered in this simulation)');
              fresh.forEach(p => { st.packages.push(p); const msg = cfg.packages[p](st); out.push(`Setting up ${p} ...`); if (msg) out.push(msg); });
              out.push('Processing triggers for man-db (2.12.0-4build2) ...');
            }
            return out.join('\n');
          }
          if (verb === 'remove' || verb === 'purge') {
            if (who() !== 'root') throw CmdError(lock);
            pkgs.forEach(p => { st.packages = st.packages.filter(x => x !== p); if (st.services[p]) { st.services[p].installed = false; st.services[p].active = false; st.services[p].enabled = false; } });
            return `Removing ${pkgs.join(', ')} ...\n0 upgraded, 0 newly installed, ${pkgs.length} to remove and 0 not upgraded.`;
          }
          if (verb === 'list') return st.packages.map(p => `${p}/noble,now installed`).join('\n');
          throw CmdError(`E: Invalid operation ${verb || ''}`);
        }
      };
    }

    // ---------------------------------------------------------- ufw
    function ufwCmd(toks) {
      const st = S(); const u = st.ufw;
      if (toks[0] !== 'status' && toks[0] !== 'app' && who() !== 'root') throw CmdError('ERROR: You need to be root to run this script');
      const parseRule = (t, action) => {
        if (t[0] === 'from') {
          const from = t[1] === 'any' ? 'Anywhere' : t[1];
          if (from !== 'Anywhere' && !net.parseCidr(from)) throw CmdError(`ERROR: Bad source address`);
          const pi = t.indexOf('port'); const pr = t.indexOf('proto');
          return { action, from: from.includes('/') || from === 'Anywhere' ? from : from, port: pi >= 0 ? +t[pi + 1] : null, proto: pr >= 0 ? t[pr + 1] : (pi >= 0 ? null : null) };
        }
        const spec = t.join(' ');
        if (UFW_APPS[spec]) { if (spec.startsWith('Nginx') && !st.packages.includes('nginx')) throw CmdError(`ERROR: Could not find a profile matching '${spec}'`); return { action, from: 'Anywhere', app: spec }; }
        const m = spec.match(/^(\d+)(?:\/(tcp|udp))?$/);
        if (!m) throw CmdError(`ERROR: Could not find a profile matching '${spec}'`);
        return { action, from: 'Anywhere', port: +m[1], proto: m[2] || null };
      };
      const same = (x, y) => x.action === y.action && x.from === y.from && x.app === y.app && x.port === y.port && (x.proto || null) === (y.proto || null);
      const checkLock = () => { if (u.enabled && !L.ufwAllows(st, cfg.adminIp, 22)) { st.lockedOut = true; st.flags.lockout = true; return `\nclient_loop: send disconnect: Broken pipe\nConnection to ${cfg.ip} closed.`; } return ''; };
      const v = toks[0];
      if (v === 'status') {
        if (!u.enabled) return 'Status: inactive';
        const numbered = toks[1] === 'numbered';
        const head = `Status: active${toks[1] === 'verbose' ? `\nLogging: on (low)\nDefault: ${u.defaultIn} (incoming), allow (outgoing), deny (routed)\nNew profiles: skip` : ''}\n\n${numbered ? '     ' : ''}To                         Action      From\n${numbered ? '     ' : ''}--                         ------      ----`;
        return head + '\n' + u.rules.map((r, i) => `${numbered ? `[${String(i + 1).padStart(2)}] ` : ''}${ufwRuleText(r).padEnd(27)}${(r.action + (numbered ? ' IN' : '')).padEnd(12)}${r.from}`).join('\n');
      }
      if (v === 'enable') { u.enabled = true; return 'Command may disrupt existing ssh connections. Proceed with operation (y|n)? y\nFirewall is active and enabled on system startup' + checkLock(); }
      if (v === 'disable') { u.enabled = false; return 'Firewall stopped and disabled on system startup'; }
      if (v === 'default') { if (toks[2] !== 'incoming' && toks[2] !== 'outgoing') throw CmdError('ERROR: Invalid syntax'); if (toks[2] === 'incoming') u.defaultIn = toks[1]; return `Default ${toks[2]} policy changed to '${toks[1]}'\n(be sure to update your rules accordingly)` + checkLock(); }
      if (v === 'app' && toks[1] === 'list') return 'Available applications:\n' + Object.keys(UFW_APPS).filter(k => k === 'OpenSSH' || st.packages.includes('nginx')).map(k => '  ' + k).join('\n');
      if (v === 'allow' || v === 'deny' || v === 'limit') {
        const r = parseRule(toks.slice(1), v === 'deny' ? 'DENY' : 'ALLOW');
        if (u.rules.some(x => same(x, r))) return 'Skipping adding existing rule';
        u.rules.push(r); return 'Rule added' + checkLock();
      }
      if (v === 'delete') {
        if (/^\d+$/.test(toks[1] || '')) { const i = +toks[1] - 1; if (!u.rules[i]) throw CmdError('ERROR: Could not find rule \'' + toks[1] + '\''); u.rules.splice(i, 1); return 'Rule deleted' + checkLock(); }
        const r = parseRule(toks.slice(2), toks[1] === 'deny' ? 'DENY' : 'ALLOW');
        const i = u.rules.findIndex(x => same(x, r)); if (i < 0) return 'Could not delete non-existent rule';
        u.rules.splice(i, 1); return 'Rule deleted' + checkLock();
      }
      if (v === 'reset') { u.enabled = false; u.rules = []; return 'Resetting all rules to installed defaults. Proceed with operation (y|n)? y'; }
      throw CmdError('ERROR: Invalid syntax\n\nUsage: ufw COMMAND (status | enable | disable | default deny incoming | allow PORT[/tcp] | allow APP | allow from CIDR to any port N proto tcp | delete N)');
    }

    // ---------------------------------------------------------- sqlite3
    function sqlite3Cmd(toks) {
      const st = S(); if (!st.packages.includes('sqlite3')) throw CmdError('Command \'sqlite3\' not found, but can be installed with:\nsudo apt install sqlite3');
      const lt = toks.indexOf('<'); let input = null;
      if (lt >= 0) { const f = toks[lt + 1]; if (!f) throw CmdError('bash: syntax error near unexpected token `newline\''); input = readText('bash', P(f)); toks = toks.slice(0, lt); }
      const dbArg = toks.find(t => !t.startsWith('-')); const sqlArg = toks.filter(t => !t.startsWith('-'))[1];
      if (!dbArg) throw CmdError('Usage: sqlite3 DATABASE ["SQL"]  (an in-memory database isn\'t useful here)');
      const sess = { path: P(dbArg), headers: false, mode: 'list', user: who() };
      if (input !== null) return runSql(sess, input);
      if (sqlArg !== undefined) return runSql(sess, sqlArg);
      lab.enterSubshell({ prompt: 'sqlite> ', run: line => sqlShell(sess, line) });
      return { text: 'SQLite version 3.45.1 2024-01-30 16:01:20\nEnter ".help" for usage hints.', cls: 'muted' };
    }
    function openDb(sess, write) {
      const st = S(); const r = L.resolve(st, sess.path); const user = sess.user;
      if (!r.node) {
        if (!write) return { db: L.newDb(), virtual: true };
        const dir = L.get(st, L.parent(r.path));
        if (!dir || !L.canEnter(st, user, r.path) || !L.can(st, user, dir, 'w')) throw L.sql.err(`unable to open database "${sess.path}": unable to open database file`);
        st.fs[r.path] = L.f('', user, (st.users[user] || { groups: [user] }).groups[0], 0o644); st.fs[r.path].db = L.newDb();
        return { db: st.fs[r.path].db, node: st.fs[r.path] };
      }
      if (!L.canEnter(st, user, r.path) || !L.can(st, user, r.node, 'r')) throw L.sql.err(`unable to open database "${sess.path}": unable to open database file`);
      if (!r.node.db) { if ((r.node.c || '').length) throw L.sql.err('file is not a database (26)'); r.node.db = L.newDb(); }
      if (write && (!L.can(st, user, r.node, 'w') || !L.can(st, user, L.get(st, L.parent(r.path)), 'w'))) throw L.sql.err('attempt to write a readonly database (8)');
      return { db: r.node.db, node: r.node };
    }
    function fmtRows(sess, res) {
      if (!res.cols) return '';
      const rows = res.rows.map(r => r.map(v => (v === null ? '' : String(v))));
      if (sess.mode === 'column' || sess.mode === 'table' || sess.mode === 'box') {
        const w = res.cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
        const line = r => r.map((v, i) => v.padEnd(w[i])).join('  ');
        if (sess.mode === 'column') return [line(res.cols), w.map(x => '-'.repeat(x)).join('  ')].concat(rows.map(line)).join('\n');
        const bar = '+' + w.map(x => '-'.repeat(x + 2)).join('+') + '+';
        const row = r => '| ' + r.map((v, i) => v.padEnd(w[i])).join(' | ') + ' |';
        return [bar, row(res.cols), bar].concat(rows.map(row), [bar]).join('\n');
      }
      return (sess.headers ? [res.cols.join('|')] : []).concat(rows.map(r => r.join('|'))).join('\n');
    }
    function runSql(sess, text) {
      const out = [];
      for (const stmt of L.sql.split(text)) {
        if (stmt.startsWith('.')) { out.push(dot(sess, stmt) || ''); continue; }
        try {
          const write = L.sql.isWrite(stmt); const h = openDb(sess, write);
          const res = L.sql.exec(h.db, stmt, []);
          if (res.cols) out.push(fmtRows(sess, res));
        } catch (e) { if (e.sql) return { text: out.filter(Boolean).concat([(/^(UNIQUE|NOT NULL|attempt|unable|file is)/.test(e.message) ? 'Runtime error: ' : 'Parse error: ') + e.message]).join('\n'), cls: 'err' }; throw e; }
      }
      if (cfg.onWrite) cfg.onWrite(S(), sess.path);
      return out.filter(x => x !== '').join('\n') || null;
    }
    function dot(sess, cmd) {
      const st = S(); const parts = cmd.trim().split(/\s+/); const c0 = parts[0].toLowerCase();
      if (c0 === '.tables') { const h = openDb(sess, false); return Object.keys(h.db.tables).sort().join('  '); }
      if (c0 === '.schema') { const h = openDb(sess, false); const ts = Object.values(h.db.tables).filter(t => !parts[1] || t.name === parts[1].toLowerCase()); return ts.map(t => t.sql + ';').concat((h.db.indexes || []).filter(i => !parts[1] || i.table.toLowerCase() === parts[1].toLowerCase()).map(i => i.sql + ';')).join('\n'); }
      if (c0 === '.headers') { sess.headers = parts[1] === 'on'; return ''; }
      if (c0 === '.mode') { sess.mode = (parts[1] || 'list').toLowerCase(); return ''; }
      if (c0 === '.read') { const t = readText('.read', P(parts[1] || '')); const r = runSql(sess, t); return r && r.text ? r.text : (r || ''); }
      if (c0 === '.backup') {
        const target = P(parts[parts.length - 1]); const h = openDb(sess, false);
        const wr = L.writeFile(st, sess.user, target, ''); if (wr.err) throw L.sql.err(`unable to open database file "${target}"`);
        st.fs[target].db = JSON.parse(JSON.stringify(h.db)); st.flags.backup = target; return '';
      }
      if (c0 === '.databases') return `main: ${sess.path} r/w`;
      if (c0 === '.help') return '.backup FILE     Back up the database to FILE (safe while the app is writing)\n.headers on|off  Show column names\n.mode MODE       list | column | table | box\n.read FILE       Run SQL from FILE\n.schema [TABLE]  Show CREATE statements\n.tables          List tables\n.quit            Exit';
      throw L.sql.err(`unknown command or invalid arguments:  "${parts[0].slice(1)}". Enter ".help" for help`);
    }
    function sqlShell(sess, line) {
      if (/^\.(quit|exit)$/i.test(line.trim())) return { exit: true };
      const r = runSql(sess, line);
      return r;
    }
  };
  /** Keep custom (unit-file) services registered as soon as their unit file exists. */
  L.syncCustom = st => {
    L.children(st, '/etc/systemd/system').filter(p => p.endsWith('.service') && st.fs[p].t === 'f').forEach(p => {
      const name = L.base(p).replace(/\.service$/, '');
      if (!st.services[name]) st.services[name] = { installed: true, custom: true, active: false, enabled: false };
    });
  };

  // ======================================================================= editor panel
  L.openEditor = (lab, path, content, user, writable) => {
    const st = lab.state; st.editor = { path, user, writable };
    const $ = s => document.querySelector(s);
    if (!$('#ed-text')) return;
    $('#ed-name').textContent = path; $('#ed-text').value = content; $('#ed-text').readOnly = !writable;
    $('#ed-mode').textContent = writable ? (user === 'root' ? 'editing as root' : 'editing as ' + user) : 'read-only';
    $('#ed-mode').className = 'pill' + (writable ? '' : ' warn');
    $('#ed-save').disabled = !writable; $('#ed-msg').textContent = '';
    $('#ed-panel').hidden = false; $('#ed-text').focus();
  };
  L.attachEditor = (lab, onSave) => {
    const $ = s => document.querySelector(s);
    $('#ed-save').addEventListener('click', () => {
      const st = lab.state; const e = st.editor; if (!e) return;
      const r = L.writeFile(st, e.user, e.path, $('#ed-text').value);
      if (r.err) { $('#ed-msg').textContent = `[ Error writing ${e.path}: ${r.err} ]`; $('#ed-msg').className = 'inline-msg err'; return; }
      const lines = $('#ed-text').value.split('\n').length;
      $('#ed-msg').textContent = `[ Wrote ${lines} line${lines === 1 ? '' : 's'} ]`; $('#ed-msg').className = 'inline-msg ok';
      if (onSave) onSave(st, e.path);
      lab.touch(); lab.refresh();
    });
    $('#ed-close').addEventListener('click', () => { lab.state.editor = null; $('#ed-panel').hidden = true; });
    $('#ed-text').addEventListener('keydown', ev => { if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'o')) { ev.preventDefault(); $('#ed-save').click(); } if (ev.key === 'Tab') { ev.preventDefault(); const t = ev.target; const s = t.selectionStart; t.value = t.value.slice(0, s) + '    ' + t.value.slice(t.selectionEnd); t.selectionStart = t.selectionEnd = s + 4; } });
  };
  L.editorHtml = () => `
    <div class="panel" id="ed-panel" hidden>
      <div class="row space-between mb-8"><h3 style="margin:0">nano · <span id="ed-name" class="mono" style="font-size:13px"></span></h3><span id="ed-mode" class="pill"></span></div>
      <textarea class="editor" id="ed-text" spellcheck="false" aria-label="File editor"></textarea>
      <div class="row mt-16"><button type="button" class="sm" id="ed-save">Save (Ctrl+S)</button><button type="button" class="ghost sm" id="ed-close">Close</button><span id="ed-msg" class="inline-msg" style="margin:0"></span></div>
    </div>`;

  // ======================================================================= browser panel
  L.browserHtml = (title) => `
    <div class="panel lab-gui" id="br-panel">
      <h3 class="mb-8">${title || 'Your laptop · browser'}</h3>
      <div class="browser">
        <div class="br-bar"><span id="br-lock" class="br-lock">○</span><input type="text" id="br-url" spellcheck="false" aria-label="Address bar" /><button type="button" class="sm" id="br-go">Go</button></div>
        <div class="br-view" id="br-view"><div class="muted" style="padding:20px">Enter a URL and press Go.</div></div>
      </div>
    </div>`;
  L.attachBrowser = (lab, browse, action) => {
    const $ = s => document.querySelector(s);
    const go = () => { const st = lab.state; const page = browse(st, $('#br-url').value.trim()); L.showPage(st, page); lab.touch(); lab.refresh(); };
    $('#br-go').addEventListener('click', go);
    $('#br-url').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    $('#br-view').addEventListener('click', e => {
      const b = e.target.closest('[data-br]'); if (!b) return; e.preventDefault();
      const st = lab.state; const page = action(st, b.dataset.br); if (page) L.showPage(st, page); lab.touch(); lab.refresh();
    });
  };
  L.showPage = (st, page) => {
    const $ = s => document.querySelector(s);
    st.page = page;
    $('#br-url').value = page.url || $('#br-url').value;
    const lock = $('#br-lock');
    lock.textContent = page.secure === true ? '🔒' : page.secure === 'bad' ? '⚠' : 'ⓘ';
    lock.title = page.secure === true ? 'Connection is secure' : page.secure === 'bad' ? 'Not secure: certificate error' : 'Not secure';
    lock.className = 'br-lock ' + (page.secure === true ? 'ok' : page.secure === 'bad' ? 'bad' : '');
    $('#br-view').innerHTML = page.html;
  };
  L.errorPage = (title, detail, code) => `<div class="br-err"><div class="br-err-icon">!</div><h4>${esc(title)}</h4><p>${detail}</p>${code ? `<p class="mono muted" style="font-size:12px">${esc(code)}</p>` : ''}</div>`;
  L.cfErrorPage = (code, title, detail) => `<div class="br-cf"><div class="mono muted" style="font-size:12px">Error ${code}</div><h4>${esc(title)}</h4><div class="br-cf-row"><span>You · Browser <b class="ok-t">Working</b></span><span>Cloudflare · Edge <b class="ok-t">Working</b></span><span>Host · origin <b class="bad-t">Error</b></span></div><p style="font-size:13px">${detail}</p></div>`;


  // ======================================================================= shared server model
  L.baseFs = (user) => {
    const fs = {};
    ['/', '/etc', '/etc/ssl', '/etc/ssl/certs', '/etc/ssl/private', '/etc/systemd', '/etc/systemd/system', '/home', '/opt', '/usr', '/usr/sbin', '/usr/bin', '/var', '/var/lib', '/var/log', '/var/www', '/run', '/srv'].forEach(d => { fs[d] = L.d('root', 'root', 0o755); });
    fs['/etc/ssl/private'].m = 0o710; fs['/tmp'] = L.d('root', 'root', 0o777); fs['/root'] = L.d('root', 'root', 0o700);
    fs['/home/' + user] = L.d(user, user, 0o750);
    fs['/home/' + user + '/.bashrc'] = L.f('# ~/.bashrc\n', user, user, 0o644);
    fs['/etc/hostname'] = L.f('web01\n'); fs['/etc/os-release'] = L.f('PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\n');
    fs['/usr/sbin/nologin'] = L.f('', 'root', 'root', 0o755); fs['/usr/bin/python3'] = L.f('', 'root', 'root', 0o755);
    return fs;
  };
  L.baseUsers = (user) => ({ root: { uid: 0, groups: ['root'], shell: '/bin/bash' }, [user]: { uid: 1000, groups: [user, 'sudo', 'adm'], shell: '/bin/bash' }, 'www-data': { uid: 33, groups: ['www-data'], shell: '/usr/sbin/nologin', system: true } });
  L.NGINX_DEFAULT = 'server {\n\tlisten 80 default_server;\n\tlisten [::]:80 default_server;\n\n\troot /var/www/html;\n\tindex index.html index.htm index.nginx-debian.html;\n\n\tserver_name _;\n\n\tlocation / {\n\t\ttry_files $uri $uri/ =404;\n\t}\n}\n';
  L.installNginx = st => {
    ['/etc/nginx', '/etc/nginx/sites-available', '/etc/nginx/sites-enabled', '/etc/nginx/conf.d', '/var/www/html', '/var/log/nginx'].forEach(d => { st.fs[d] = L.d('root', 'root', 0o755); });
    st.fs['/etc/nginx/nginx.conf'] = L.f('user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\nevents { worker_connections 768; }\n\nhttp {\n\tinclude /etc/nginx/mime.types;\n\tssl_protocols TLSv1.2 TLSv1.3;\n\taccess_log /var/log/nginx/access.log;\n\terror_log /var/log/nginx/error.log;\n\tinclude /etc/nginx/conf.d/*.conf;\n\tinclude /etc/nginx/sites-enabled/*;\n}\n');
    st.fs['/etc/nginx/sites-available/default'] = L.f(L.NGINX_DEFAULT);
    st.fs['/etc/nginx/sites-enabled/default'] = L.l('/etc/nginx/sites-available/default');
    st.fs['/var/www/html/index.nginx-debian.html'] = L.f('<!DOCTYPE html><html><head><title>Welcome to nginx!</title></head><body><h1>Welcome to nginx!</h1></body></html>\n');
    st.services.nginx = { installed: true, active: false, enabled: true };
    const r = L.nginxStart(st);
    if (r.ok) { st.services.nginx.active = true; st.services.nginx.since = '19:04:51'; return null; }
    st.services.nginx.failed = r.log;
    return 'Job for nginx.service failed because the control process exited with error code.\nSee "systemctl status nginx.service" and "journalctl -xeu nginx.service" for details.\ninvoke-rc.d: initscript nginx, action "start" failed.';
  };
  L.nginxStart = st => {
    const t = L.nginxTest(st);
    if (t.errors.length) return { ok: false, log: [t.errors[0], 'nginx.service: Control process exited, code=exited, status=1/FAILURE', 'nginx.service: Failed with result \'exit-code\'.', 'Failed to start nginx.service - A high performance web server and a reverse proxy server.'] };
    const ports = [...new Set(t.servers.flatMap(s => s.listen.filter(l => !l.v6).map(l => l.port)))];
    if (st.services.apache2 && st.services.apache2.active && ports.some(p => [80, 443].includes(p))) return { ok: false, log: ['nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)', 'nginx: [emerg] still could not bind()', 'nginx.service: Control process exited, code=exited, status=1/FAILURE', 'Failed to start nginx.service - A high performance web server and a reverse proxy server.'] };
    st.nginxLive = t; return { ok: true };
  };
  L.nginxReload = st => { const t = L.nginxTest(st); if (t.errors.length) { st.services.nginx.log = [t.errors[0], 'nginx.service: Control process exited, code=exited, status=1/FAILURE (reload failed; still running the previous configuration)']; return { ok: false, log: [t.errors[0]] }; } st.nginxLive = t; return { ok: true }; };
  L.nginxListeners = st => (st.services.nginx && st.services.nginx.active && st.nginxLive ? [...new Set(st.nginxLive.servers.flatMap(s => s.listen.filter(l => !l.v6).map(l => l.port)))].map(p => ({ addr: '0.0.0.0', port: p, proc: 'nginx' })) : []);
  L.nginxErrBody = (code, text) => `<html>\n<head><title>${code} ${text}</title></head>\n<body>\n<center><h1>${code} ${text}</h1></center>\n<hr><center>nginx/1.24.0 (Ubuntu)</center>\n</body>\n</html>`;
  /**
   * Serve an HTTP(S) request arriving at the server.
   * req: { scheme, host, port, path, from, local }; upstream(st, host, port, req) -> {status, body, title, headers} | null
   */
  L.http = (st, req, upstream) => {
    const port = req.port || (req.scheme === 'https' ? 443 : 80);
    if (!req.local && !L.ufwAllows(st, req.from, port)) return { err: 'timeout', port };
    const ng = st.services.nginx;
    if (ng && ng.active && st.nginxLive) {
      const srv = L.nginxRoute(st.nginxLive, port, req.host);
      if (srv) {
        const ssl = srv.listen.some(l => l.port === port && l.ssl);
        if (req.scheme === 'https' && !ssl) return { err: 'tlsproto', port };
        if (req.scheme === 'http' && ssl) return { status: 400, server: 'nginx/1.24.0 (Ubuntu)', title: '400 The plain HTTP request was sent to HTTPS port', body: L.nginxErrBody(400, 'Bad Request') };
        const loc = L.nginxLocation(srv, req.path);
        const ret = srv.ret || (loc && loc.ret);
        if (ret) { const url = ret.url.replace(/\$host/g, req.host).replace(/\$server_name/g, srv.names[0] || req.host).replace(/\$request_uri/g, req.path); return { status: ret.code, server: 'nginx/1.24.0 (Ubuntu)', headers: url ? { Location: url } : {}, title: `${ret.code}`, body: L.nginxErrBody(ret.code, ret.code === 301 ? 'Moved Permanently' : 'Found'), srv, ssl }; }
        if (loc && loc.proxy) {
          const m = loc.proxy.match(/^https?:\/\/([^:/]+)(?::(\d+))?/); const r = m && upstream(st, m[1], +(m[2] || 80), req);
          if (!r) return { status: 502, server: 'nginx/1.24.0 (Ubuntu)', title: '502 Bad Gateway', body: L.nginxErrBody(502, 'Bad Gateway'), srv, ssl };
          return Object.assign({ server: 'nginx/1.24.0 (Ubuntu)', srv, ssl }, r);
        }
        const root = (loc && loc.root) || srv.root;
        if (root === '/var/www/html' && L.get(st, '/var/www/html/index.nginx-debian.html')) return { status: 200, server: 'nginx/1.24.0 (Ubuntu)', title: 'Welcome to nginx!', body: '<h1>Welcome to nginx!</h1><p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>', srv, ssl, welcome: true };
        return { status: 404, server: 'nginx/1.24.0 (Ubuntu)', title: '404 Not Found', body: L.nginxErrBody(404, 'Not Found'), srv, ssl };
      }
    }
    const ap = st.services.apache2;
    if (ap && ap.active && port === 80) return { status: 200, server: 'Apache/2.4.58 (Ubuntu)', title: 'Apache2 Ubuntu Default Page: It works', body: '<h1>Apache2 Default Page</h1><p>It works! This is the default welcome page used to test the correct operation of the Apache2 server after installation on Ubuntu systems.</p>', apache: true };
    if (req.local) { const r = upstream(st, '127.0.0.1', port, req); if (r) return Object.assign({ server: 'shopapp' }, r); }
    return { err: 'refused', port };
  };
  /** Format a curl call made from the server itself. hosts: name -> ip. tls(st,res,req,insecure) -> error string or null */
  L.curl = (st, toks, cfg) => {
    let headOnly = false, incl = false, insecure = false, follow = false, hostHdr = null, url = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-H' || t === '--header') { const h = toks[++i] || ''; const m = h.match(/^host:\s*(.+)$/i); if (m) hostHdr = m[1].trim(); continue; }
      if (/^-[a-zA-Z]+$/.test(t)) { if (t.includes('I')) headOnly = true; if (/[iv]/.test(t)) incl = true; if (t.includes('k')) insecure = true; if (t.includes('L')) follow = true; continue; }
      if (t === '--head') { headOnly = true; continue; } if (t === '--insecure') { insecure = true; continue; } if (t.startsWith('--')) continue;
      url = t;
    }
    if (!url) throw CmdError('curl: try \'curl --help\' for more information');
    if (!/^https?:\/\//.test(url)) url = 'http://' + url;
    const m = url.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/[^\s]*)?$/i);
    if (!m) throw CmdError('curl: (3) URL rejected: Malformed input to a URL function');
    const scheme = m[1].toLowerCase(), host = m[2].toLowerCase(), port = m[3] ? +m[3] : (scheme === 'https' ? 443 : 80), path = m[4] || '/';
    const ip = host === 'localhost' ? '127.0.0.1' : net.isIp(host) ? host : cfg.hosts[host];
    if (!ip) return { text: `curl: (6) Could not resolve host: ${host}`, cls: 'err' };
    const local = ip === '127.0.0.1' || ip === cfg.ip;
    if (!local && cfg.remote) return cfg.remote(st, { scheme, host, port, path, headOnly, incl, insecure, follow });
    const req = { scheme, host: hostHdr || host, port, path, from: cfg.ip, local: true };
    let r = L.http(st, req, cfg.upstream);
    if (r.err === 'refused') return { text: `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`, cls: 'err' };
    if (r.err === 'timeout') return { text: `curl: (28) Failed to connect to ${host} port ${port} after 130000 ms: Connection timed out`, cls: 'err' };
    if (r.err === 'tlsproto') return { text: `curl: (35) OpenSSL/3.0.13: error:0A00010B:SSL routines::wrong version number`, cls: 'err' };
    if (scheme === 'https' && cfg.tls) { const e = cfg.tls(st, r, req, insecure); if (e) return { text: e, cls: 'err' }; }
    if (follow && (r.status === 301 || r.status === 302) && r.headers && r.headers.Location) return L.curl(st, toks.filter(x => x !== url && !/^-[a-zA-Z]*L/.test(x)).concat([r.headers.Location]), cfg);
    const reason = { 200: 'OK', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway' }[r.status] || '';
    const hdrs = [`HTTP/1.1 ${r.status} ${reason}`, `Server: ${r.server || 'nginx'}`, 'Date: Fri, 20 Nov 2026 19:22:31 GMT', `Content-Type: ${r.type || 'text/html; charset=utf-8'}`].concat(Object.entries(r.headers || {}).map(([k, v]) => `${k}: ${v}`));
    const body = r.raw || r.body || '';
    return { text: (incl || headOnly ? hdrs.join('\n') + '\n' + (headOnly ? '' : '\n') : '') + (headOnly ? '' : body), cls: r.status >= 500 ? 'warn' : '' };
  };
  L.shopPage = (extra) => `<div class="br-page"><div class="row space-between" style="border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:12px"><strong>🛍️ Contoso Shop</strong><span class="muted" style="font-size:12px">Home · Deals · Cart</span></div>${extra || '<h4>Spring sale is live</h4><p>Free shipping on orders over $50.</p>'}</div>`;
  global.LinuxSim = L;
})(window);
