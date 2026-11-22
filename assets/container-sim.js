/*!
 * Container simulation for the portfolio labs (requires lab.js and linux-sim.js).
 * - CS.yaml / CS.toYaml: a YAML subset parser and emitter (compose files, Kubernetes manifests)
 * - CS.dockerfile: Dockerfile parser (stages, instructions)
 * - CS.docker(lab, cfg): docker CLI (build, images, history, run, ps, logs, inspect, exec, rm, volume, network, compose)
 * - CS.kube(lab, cfg): kubectl against a virtual cluster (get, describe, logs, apply, delete, rollout, run, exec, label, create secret)
 */
(function (global) {
  'use strict';
  const { CmdError } = global.Lab;
  const CS = {};

  // ======================================================================= helpers
  CS.hash = (s, n) => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } let out = ''; let x = h >>> 0; while (out.length < (n || 12)) { out += (x % 36).toString(36).replace(/[^a-z0-9]/, 'a'); x = Math.floor(x / 36) || ((h = Math.imul(h ^ out.length, 2654435761)) >>> 0); } return out.slice(0, n || 12); };
  CS.hex = (s, n) => { let h = 5381; s = String(s); let out = ''; const fmix = x => { x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return x >>> 0; }; for (let r = 0; out.length < (n || 12); r++) { for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i) ^ r) >>> 0; h = fmix(h + r); out += h.toString(16).padStart(8, '0'); } return out.slice(0, n || 12); };
  CS.table = (cols, rows, gap) => {
    gap = gap || 3; const w = cols.map((c, i) => Math.max(c.length, ...rows.map(r => String(r[i] === undefined ? '' : r[i]).length)));
    const line = r => r.map((v, i) => (i === r.length - 1 ? String(v) : String(v).padEnd(w[i] + gap))).join('').replace(/\s+$/, '');
    return [line(cols)].concat(rows.map(line)).join('\n');
  };
  CS.mb = n => (n >= 1000 ? (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'GB' : (n < 10 ? n.toFixed(1) : Math.round(n)) + 'MB');
  const clone = o => JSON.parse(JSON.stringify(o));

  // ======================================================================= YAML subset
  function yamlErr(line, msg) { const e = new Error(`yaml: line ${line}: ${msg}`); e.yaml = true; return e; }
  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { if (i === 0 || /[\s:\[{,-]/.test(s[i - 1])) q = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
    }
    return s;
  }
  function splitKey(s) {
    let q = null, depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') depth--;
      if (c === ':' && depth === 0 && (i === s.length - 1 || s[i + 1] === ' ')) return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    }
    return null;
  }
  function scalar(v, line) {
    v = v.trim();
    if (v === '' || v === '~' || v === 'null') return null;
    if (v[0] === '"') { if (!/"$/.test(v) || v.length < 2) throw yamlErr(line, 'found unexpected end of stream'); try { return JSON.parse(v); } catch (e) { return v.slice(1, -1); } }
    if (v[0] === "'") { if (!/'$/.test(v) || v.length < 2) throw yamlErr(line, 'found unexpected end of stream'); return v.slice(1, -1).replace(/''/g, "'"); }
    if (v[0] === '[' || v[0] === '{') return flow(v, line);
    if (v === 'true' || v === 'True') return true;
    if (v === 'false' || v === 'False') return false;
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    if (/^[&*!]/.test(v)) return v;
    return v;
  }
  function flow(s, line) {
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    function val() {
      ws();
      if (s[i] === '[') { i++; const arr = []; ws(); if (s[i] === ']') { i++; return arr; } for (;;) { arr.push(val()); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return arr; } throw yamlErr(line, 'did not find expected \',\' or \']\''); } }
      if (s[i] === '{') { i++; const obj = {}; ws(); if (s[i] === '}') { i++; return obj; } for (;;) { ws(); let k = ''; if (s[i] === '"' || s[i] === "'") { const q = s[i++]; while (i < s.length && s[i] !== q) k += s[i++]; i++; } else { while (i < s.length && s[i] !== ':' ) k += s[i++]; k = k.trim(); } ws(); if (s[i] !== ':') throw yamlErr(line, 'did not find expected \':\''); i++; obj[k] = val(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return obj; } throw yamlErr(line, 'did not find expected \',\' or \'}\''); } }
      if (s[i] === '"' || s[i] === "'") { const q = s[i]; let j = i + 1; while (j < s.length && s[j] !== q) j++; const raw = s.slice(i, j + 1); i = j + 1; return scalar(raw, line); }
      let j = i; while (j < s.length && !/[,\]}]/.test(s[j])) j++; const raw = s.slice(i, j); i = j; return scalar(raw, line);
    }
    const r = val(); ws(); if (i < s.length) throw yamlErr(line, 'did not find expected <document start>');
    return r;
  }
  function parseDoc(text, lineOffset) {
    const lines = [];
    text.split('\n').forEach((raw, idx) => {
      if (/\t/.test(raw.match(/^\s*/)[0])) throw yamlErr(idx + 1 + lineOffset, 'found character that cannot start any token (tabs are not allowed for indentation)');
      const s = stripComment(raw).replace(/\s+$/, '');
      if (!s.trim()) { lines.push({ blank: true, n: idx + 1 + lineOffset, raw }); return; }
      lines.push({ ind: s.match(/^ */)[0].length, c: s.trim(), n: idx + 1 + lineOffset, raw });
    });
    let i = 0;
    const next = () => { while (i < lines.length && lines[i].blank) i++; return lines[i]; };
    function block(ind) {
      const l = next(); if (!l) return null;
      if (l.c === '-' || l.c.startsWith('- ')) return seq(l.ind);
      return map(l.ind);
    }
    function seq(ind) {
      const arr = [];
      for (;;) {
        const l = next(); if (!l || l.ind < ind) break;
        if (l.ind > ind) throw yamlErr(l.n, 'did not find expected \'-\' indicator');
        if (!(l.c === '-' || l.c.startsWith('- '))) break;
        const rest = l.c === '-' ? '' : l.c.slice(2);
        if (!rest.trim()) { i++; const n2 = next(); arr.push(n2 && n2.ind > ind ? block(n2.ind) : null); continue; }
        const kv = splitKey(rest);
        if (kv && !/^["'[{]/.test(rest.trim())) { const sub = ind + 2 + (rest.length - rest.trimStart().length); lines[i] = { ind: sub, c: rest.trim(), n: l.n, raw: l.raw }; arr.push(map(sub)); continue; }
        i++; arr.push(scalar(rest, l.n));
      }
      return arr;
    }
    function map(ind) {
      const obj = {};
      for (;;) {
        const l = next(); if (!l || l.ind < ind) break;
        if (l.ind > ind) throw yamlErr(l.n, 'mapping values are not allowed in this context');
        if (l.c === '-' || l.c.startsWith('- ')) { if (Object.keys(obj).length) throw yamlErr(l.n, 'did not find expected key'); break; }
        const kv = splitKey(l.c); if (!kv) throw yamlErr(l.n, 'could not find expected \':\'');
        let [k, v] = kv; k = String(scalar(k, l.n)); i++;
        if (Object.prototype.hasOwnProperty.call(obj, k)) throw yamlErr(l.n, `mapping key "${k}" already defined`);
        if (v === '|' || v === '|-' || v === '>' || v === '>-') {
          const buf = []; let bi = null;
          while (i < lines.length && (lines[i].blank || lines[i].ind > ind)) { const x = lines[i]; if (!x.blank) { if (bi === null) bi = x.raw.match(/^ */)[0].length; buf.push(x.raw.slice(bi)); } else buf.push(''); i++; }
          while (buf.length && buf[buf.length - 1] === '') buf.pop();
          obj[k] = v[0] === '>' ? buf.join(' ') : buf.join('\n') + (v === '|' ? '\n' : '');
          continue;
        }
        if (v === '') {
          const n2 = next();
          if (n2 && n2.ind > ind) obj[k] = block(n2.ind);
          else if (n2 && n2.ind === ind && (n2.c === '-' || n2.c.startsWith('- '))) obj[k] = seq(ind);
          else obj[k] = null;
          continue;
        }
        obj[k] = scalar(v, l.n);
      }
      return obj;
    }
    const first = next(); if (!first) return null;
    const r = block(first.ind);
    const left = next(); if (left) throw yamlErr(left.n, left.ind > 0 ? 'mapping values are not allowed in this context' : 'did not find expected key');
    return r;
  }
  CS.yaml = text => parseDoc(String(text || ''), 0);
  CS.yamlAll = text => {
    const docs = []; let buf = [], start = 0;
    String(text || '').split('\n').forEach((l, i) => { if (/^---\s*$/.test(l)) { docs.push({ t: buf.join('\n'), o: start }); buf = []; start = i + 1; } else buf.push(l); });
    docs.push({ t: buf.join('\n'), o: start });
    return docs.map(d => parseDoc(d.t, d.o)).filter(d => d !== null);
  };
  CS.toYaml = (v, ind) => {
    ind = ind || '';
    const sc = x => { if (x === null || x === undefined) return 'null'; if (typeof x !== 'string') return String(x); if (x === '' || /^[\s]|[\s]$|^[-?:,\[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|yes|no|~)$|^-?\d+(\.\d+)?$/i.test(x)) return JSON.stringify(x); return x; };
    if (Array.isArray(v)) {
      if (!v.length) return ind + '[]';
      return v.map(it => {
        if (it && typeof it === 'object' && !Array.isArray(it) && Object.keys(it).length) { const inner = CS.toYaml(it, ind + '  ').split('\n'); inner[0] = ind + '- ' + inner[0].trimStart(); return inner.join('\n'); }
        return ind + '- ' + (it && typeof it === 'object' ? (Array.isArray(it) ? '[]' : '{}') : sc(it));
      }).join('\n');
    }
    if (v && typeof v === 'object') {
      const ks = Object.keys(v); if (!ks.length) return ind + '{}';
      return ks.map(k => {
        const x = v[k]; const key = /^[\w./-]+$/.test(k) ? k : JSON.stringify(k);
        if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) return `${ind}${key}:\n${CS.toYaml(x, Array.isArray(x) ? ind : ind + '  ')}`;
        if (typeof x === 'string' && x.includes('\n')) return `${ind}${key}: |\n${x.replace(/\n$/, '').split('\n').map(l => ind + '  ' + l).join('\n')}`;
        return `${ind}${key}: ${x && typeof x === 'object' ? (Array.isArray(x) ? '[]' : '{}') : sc(x)}`;
      }).join('\n');
    }
    return ind + sc(v);
  };

  // ======================================================================= Dockerfile
  CS.dockerfile = text => {
    const out = { stages: [], errors: [] }; let cur = null;
    const logical = []; let acc = '', startLine = 0;
    String(text || '').split('\n').forEach((raw, i) => {
      const l = raw.replace(/\s+$/, '');
      if (!acc && (/^\s*#/.test(l) || !l.trim())) return;
      if (!acc) startLine = i + 1;
      if (/\\$/.test(l)) { acc += l.slice(0, -1) + ' '; return; }
      acc += l; logical.push({ text: acc.trim(), line: startLine }); acc = '';
    });
    if (acc) logical.push({ text: acc.trim(), line: startLine });
    const KNOWN = ['FROM', 'RUN', 'COPY', 'ADD', 'WORKDIR', 'USER', 'ENV', 'ARG', 'EXPOSE', 'CMD', 'ENTRYPOINT', 'LABEL', 'HEALTHCHECK', 'VOLUME', 'SHELL', 'STOPSIGNAL', 'ONBUILD'];
    logical.forEach(({ text: t, line }) => {
      const m = t.match(/^(\S+)\s*(.*)$/); const ins = m[1].toUpperCase(); const args = m[2];
      if (!KNOWN.includes(ins)) { out.errors.push(`dockerfile parse error on line ${line}: unknown instruction: ${m[1]}`); return; }
      if (ins === 'FROM') {
        const fm = args.match(/^(?:--platform=\S+\s+)?(\S+)(?:\s+(?:AS|as)\s+(\S+))?\s*$/);
        if (!fm) { out.errors.push(`dockerfile parse error on line ${line}: FROM requires either one or three arguments`); return; }
        cur = { base: fm[1].toLowerCase(), name: fm[2] ? fm[2].toLowerCase() : null, index: out.stages.length, ins: [], line };
        out.stages.push(cur); return;
      }
      if (!cur) { if (ins !== 'ARG') out.errors.push(`no build stage in current context (line ${line}: ${ins} before FROM)`); return; }
      const item = { ins, args, line };
      if (ins === 'COPY' || ins === 'ADD') {
        const toks = args.trim().startsWith('[') ? (() => { try { return JSON.parse(args); } catch (e) { return []; } })() : args.trim().split(/\s+/);
        const flags = {}; const rest = [];
        toks.forEach(x => { const fm = x.match(/^--(\w+)=(.*)$/); if (fm) flags[fm[1]] = fm[2]; else rest.push(x); });
        item.from = flags.from ? flags.from.toLowerCase() : null; item.chown = flags.chown || null; item.src = rest.slice(0, -1); item.dest = rest[rest.length - 1];
      }
      if (ins === 'CMD' || ins === 'ENTRYPOINT') { try { item.exec = args.trim().startsWith('[') ? JSON.parse(args) : null; } catch (e) { out.errors.push(`dockerfile parse error on line ${line}: ${ins} is not valid JSON`); } item.shell = item.exec ? null : args; }
      if (ins === 'ENV') { item.env = {}; const em = args.match(/^(\w+)\s+([^=]*)$/); if (em) item.env[em[1]] = em[2].trim(); else (args.match(/(\w+)=("[^"]*"|\S*)/g) || []).forEach(p => { const [k, ...v] = p.split('='); item.env[k] = v.join('=').replace(/^"|"$/g, ''); }); }
      if (ins === 'USER') item.user = args.trim();
      cur.ins.push(item);
    });
    if (!out.stages.length && !out.errors.length) out.errors.push('the Dockerfile cannot be empty');
    out.final = out.stages[out.stages.length - 1] || null;
    out.stageByRef = ref => { if (ref === undefined || ref === null) return null; const s = String(ref).toLowerCase(); return out.stages.find(x => x.name === s) || (/^\d+$/.test(s) ? out.stages[+s] : null); };
    out.copiesFrom = stage => stage.ins.filter(x => (x.ins === 'COPY') && x.from).map(x => x.from);
    return out;
  };
  /** .dockerignore: returns a predicate excluded(path) for top-level entries. */
  CS.ignore = text => {
    const pats = String(text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const rx = p => new RegExp('^' + p.replace(/^\.\//, '').replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '(.*/)?').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '(/.*)?$');
    const rules = pats.map(p => ({ neg: p.startsWith('!'), re: rx(p.replace(/^!/, '')) }));
    return path => { let ex = false; rules.forEach(r => { if (r.re.test(path)) ex = !r.neg; }); return ex; };
  };

  // ======================================================================= docker
  /**
   * cfg: { build(st, ctx) -> {ok, log:[...], steps:[...], image:{size, user, meta, layers}}, run(st, c) (mutates c: status, health, logs, exit),
   *        exec(st, c, toks) -> text, compose(st, sub, toks, lab) -> text, inspectImage(st, img) -> extra }
   * State: st.dk = { images: [], containers: [], volumes: [], networks: [] }
   */
  CS.dockerState = (images, extra) => Object.assign({ images: images || [], containers: [], volumes: [], networks: [{ name: 'bridge', driver: 'bridge' }, { name: 'host', driver: 'host' }, { name: 'none', driver: 'null' }], seq: 0 }, extra || {});
  CS.image = (ref, size, o) => { const [repo, tag] = CS.splitRef(ref); return Object.assign({ repo, tag, id: CS.hex(ref + size, 12), size, created: '3 weeks ago', user: '', layers: [], meta: {} }, o || {}); };
  CS.splitRef = ref => { const i = ref.lastIndexOf(':'); return i > ref.lastIndexOf('/') && i > 0 ? [ref.slice(0, i), ref.slice(i + 1)] : [ref, 'latest']; };
  CS.findImage = (st, ref) => { if (!ref) return null; const [r, t] = CS.splitRef(ref); return st.dk.images.find(i => (i.repo === r && i.tag === t) || i.id.startsWith(ref)); };
  CS.findContainer = (st, ref) => st.dk.containers.find(c => c.name === ref || c.id.startsWith(ref));
  const NAMES = ['eager_turing', 'brave_hopper', 'quirky_lovelace', 'sharp_noether', 'jolly_kilby', 'vigilant_shannon', 'elated_ritchie', 'nifty_hamilton'];
  CS.statusText = c => {
    if (c.status === 'running') return 'Up ' + (c.upFor || 'About a minute') + (c.health ? ` (${c.health})` : '');
    if (c.status === 'restarting') return `Restarting (${c.exit || 1}) ${c.restartAgo || '8 seconds ago'}`;
    if (c.status === 'created') return 'Created';
    return `Exited (${c.exit === undefined ? 0 : c.exit}) ${c.exitedAgo || 'About a minute ago'}`;
  };
  CS.portsText = c => (c.status !== 'running' && c.status !== 'restarting' ? [] : c.ports || []).map(p => `${p.ip || '0.0.0.0'}:${p.host}->${p.cont}/tcp`).join(', ') || (c.expose || []).map(x => `${x}/tcp`).join(', ');
  CS.inspectContainer = (st, c) => {
    const img = CS.findImage(st, c.image) || {};
    return {
      Id: c.id + CS.hex(c.id, 52), Created: '2026-11-22T16:40:12.4419Z', Path: (c.cmd || [])[0] || '', Args: (c.cmd || []).slice(1),
      State: Object.assign({ Status: c.status === 'restarting' ? 'restarting' : c.status, Running: c.status === 'running', Restarting: c.status === 'restarting', ExitCode: c.status === 'running' ? 0 : (c.exit || 0), Error: c.stateError || '' }, c.health ? { Health: { Status: c.health, FailingStreak: c.health === 'healthy' ? 0 : 3, Log: c.healthLog || [] } } : {}),
      Image: 'sha256:' + (img.id || CS.hex(c.image, 12)) + CS.hex(c.image, 52), Name: '/' + c.name, RestartCount: c.restarts || 0,
      HostConfig: { Binds: (c.mounts || []).filter(m => m.type === 'bind').map(m => `${m.src}:${m.dst}${m.ro ? ':ro' : ''}`), NetworkMode: c.network || 'bridge', RestartPolicy: { Name: c.restart || 'no', MaximumRetryCount: 0 }, Privileged: !!c.privileged, PortBindings: Object.fromEntries((c.ports || []).map(p => [`${p.cont}/tcp`, [{ HostIp: '', HostPort: String(p.host) }]])) },
      Mounts: (c.mounts || []).map(m => m.type === 'bind' ? { Type: 'bind', Source: m.src, Destination: m.dst, Mode: m.ro ? 'ro' : '', RW: !m.ro, Propagation: 'rprivate' } : { Type: 'volume', Name: m.src, Source: `/var/lib/docker/volumes/${m.src}/_data`, Destination: m.dst, Driver: 'local', Mode: 'z', RW: !m.ro, Propagation: '' }),
      Config: { Hostname: c.id.slice(0, 12), User: c.user !== undefined && c.user !== null ? c.user : (img.user || ''), Env: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).concat(['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']), Cmd: c.cmd || [], Image: c.image, WorkingDir: img.workdir || '/app', ExposedPorts: Object.fromEntries((img.expose || []).map(p => [`${p}/tcp`, {}])), Labels: c.labels || {} },
      NetworkSettings: { Networks: Object.fromEntries([c.network || 'bridge'].concat(c.extraNetworks || []).map(n => [n, { IPAddress: c.ip || '172.17.0.2', Gateway: '172.17.0.1', Aliases: c.aliases || null }])), Ports: Object.fromEntries((c.ports || []).map(p => [`${p.cont}/tcp`, [{ HostIp: '0.0.0.0', HostPort: String(p.host) }]])) }
    };
  };
  CS.inspectImage = (st, img) => ({
    Id: 'sha256:' + img.id + CS.hex(img.id, 52), RepoTags: [`${img.repo}:${img.tag}`], Created: '2026-11-22T16:31:07.1182Z', Size: Math.round(img.size * 1e6),
    Config: { User: img.user || '', ExposedPorts: Object.fromEntries((img.expose || []).map(p => [`${p}/tcp`, {}])), Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'].concat(img.env || []), Cmd: img.cmd || null, Entrypoint: img.entrypoint || null, WorkingDir: img.workdir || '', Volumes: img.volumes ? Object.fromEntries(img.volumes.map(v => [v, {}])) : null },
    RootFS: { Type: 'layers', Layers: (img.layers || []).map((l, i) => 'sha256:' + CS.hex(img.id + i, 64)) }
  });
  /** Tiny Go-template evaluator for --format. */
  CS.goTemplate = (fmt, obj) => fmt.replace(/\{\{\s*(json\s+)?\.([\w.]*)\s*\}\}/g, (m, js, path) => {
    let v = obj; if (path) for (const k of path.split('.')) { v = v && typeof v === 'object' ? v[k] : undefined; }
    if (js) return JSON.stringify(v === undefined ? null : v);
    if (v === undefined) return '<no value>';
    if (Array.isArray(v)) return '[' + v.map(x => (typeof x === 'object' ? JSON.stringify(x) : x)).join(' ') + ']';
    if (v && typeof v === 'object') return 'map[' + Object.keys(v).map(k => `${k}:${typeof v[k] === 'object' ? JSON.stringify(v[k]) : v[k]}`).join(' ') + ']';
    return String(v);
  });

  CS.docker = (lab, cfg) => {
    const S = () => lab.state;
    const needDaemon = () => { if (S().dk.down) throw CmdError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'); };
    const nextName = () => { const st = S(); for (const n of NAMES) if (!CS.findContainer(st, n)) return n; return 'container_' + (++st.dk.seq); };
    function parseRun(toks) {
      const o = { ports: [], mounts: [], env: {}, detach: false, rm: false, name: null, user: null, network: null, restart: null, privileged: false, labels: {} };
      let i = 0;
      const val = (t) => { const eq = t.indexOf('='); if (t.startsWith('--') && eq > 0) return t.slice(eq + 1); return toks[++i]; };
      for (; i < toks.length; i++) {
        const t = toks[i]; const base = t.split('=')[0];
        if (!t.startsWith('-')) break;
        if (/^-[dit]+$/.test(t)) { if (t.includes('d')) o.detach = true; continue; }
        if (base === '--detach') { o.detach = true; continue; }
        if (base === '--rm') { o.rm = true; continue; }
        if (base === '--privileged') { o.privileged = true; continue; }
        if (base === '--name') { o.name = val(t); continue; }
        if (base === '-p' || base === '--publish') { const v = val(t); const m = String(v).match(/^(?:([\d.]+):)?(\d+):(\d+)(?:\/tcp)?$/); if (!m) throw CmdError(`docker: invalid publish opts format (should be name=value but got '${v}')`); o.ports.push({ ip: m[1], host: +m[2], cont: +m[3] }); continue; }
        if (base === '-v' || base === '--volume') { const v = String(val(t)); const parts = v.split(':'); if (parts.length < 2) throw CmdError(`docker: Error response from daemon: invalid volume specification: '${v}'`); o.mounts.push({ type: parts[0].startsWith('/') || parts[0].startsWith('.') ? 'bind' : 'volume', src: parts[0], dst: parts[1], ro: parts[2] === 'ro' }); continue; }
        if (base === '--mount') { const v = String(val(t)); const kv = Object.fromEntries(v.split(',').map(p => p.split('='))); o.mounts.push({ type: kv.type || 'volume', src: kv.source || kv.src, dst: kv.target || kv.destination || kv.dst, ro: 'readonly' in kv }); continue; }
        if (base === '-e' || base === '--env') { const v = String(val(t)); const [k, ...r] = v.split('='); o.env[k] = r.join('='); continue; }
        if (base === '-u' || base === '--user') { o.user = String(val(t)); continue; }
        if (base === '--network' || base === '--net') { o.network = val(t); continue; }
        if (base === '--restart') { o.restart = val(t); continue; }
        if (base === '-l' || base === '--label') { const v = String(val(t)); const [k, ...r] = v.split('='); o.labels[k] = r.join('='); continue; }
        if (base === '--env-file' || base === '-w' || base === '--workdir' || base === '--entrypoint' || base === '--memory' || base === '-m' || base === '--cpus' || base === '--health-cmd') { val(t); continue; }
        throw CmdError(`unknown flag: ${base}\nSee 'docker run --help'.`);
      }
      o.image = toks[i]; o.cmd = toks.slice(i + 1);
      if (!o.image) throw CmdError('"docker run" requires at least 1 argument.\nSee \'docker run --help\'.\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]');
      return o;
    }
    function createContainer(o) {
      const st = S();
      const img = CS.findImage(st, o.image);
      if (!img) {
        if (cfg.pull && cfg.pull(st, o.image)) return createContainer(o);
        throw CmdError(`Unable to find image '${o.image.includes(':') ? o.image : o.image + ':latest'}' locally\ndocker: Error response from daemon: pull access denied for ${CS.splitRef(o.image)[0]}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied.`);
      }
      if (o.name && CS.findContainer(st, o.name)) { const ex = CS.findContainer(st, o.name); throw CmdError(`docker: Error response from daemon: Conflict. The container name "/${o.name}" is already in use by container "${ex.id}${CS.hex(ex.id, 52)}". You have to remove (or rename) that container to be able to reuse that name.\nSee 'docker run --help'.`); }
      for (const p of o.ports) {
        const clash = st.dk.containers.find(c => (c.status === 'running' || c.status === 'restarting') && (c.ports || []).some(q => q.host === p.host));
        if (clash || (cfg.hostPorts && cfg.hostPorts(st).includes(p.host))) throw CmdError(`docker: Error response from daemon: driver failed programming external connectivity on endpoint ${o.name || 'container'}: Bind for 0.0.0.0:${p.host} failed: port is already allocated.`);
      }
      for (const m of o.mounts) if (m.type === 'volume' && !st.dk.volumes.some(v => v.name === m.src)) st.dk.volumes.push({ name: m.src, driver: 'local', created: true, initFrom: img });
      const id = CS.hex(o.name + o.image + (++st.dk.seq), 12);
      const c = { id, name: o.name || nextName(), image: `${img.repo}:${img.tag}`, cmd: o.cmd.length ? o.cmd : (img.cmd || []), ports: o.ports, mounts: o.mounts, env: o.env, user: o.user, network: o.network || 'bridge', restart: o.restart || 'no', privileged: o.privileged, labels: o.labels, status: 'running', logs: [], restarts: 0, ip: '172.17.0.' + (2 + st.dk.containers.length), createdBy: 'run' };
      st.dk.containers.push(c);
      if (cfg.run) cfg.run(st, c, img);
      if (cfg.onCreate) cfg.onCreate(st, c, o);
      return c;
    }
    function ps(a) {
      const st = S(); const all = a.includes('-a') || a.includes('--all'); const quiet = a.includes('-q');
      const list = st.dk.containers.filter(c => all || c.status === 'running' || c.status === 'restarting');
      if (quiet) return list.map(c => c.id).join('\n');
      return CS.table(['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES'], list.map(c => [c.id, c.image, JSON.stringify(((c.cmd || []).join(' ')).slice(0, 18) + ((c.cmd || []).join(' ').length > 18 ? '…' : '')), c.createdAgo || 'About a minute ago', CS.statusText(c), CS.portsText(c), c.name]));
    }
    function images() {
      const st = S();
      return CS.table(['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE'], st.dk.images.map(i => [i.repo, i.tag, i.id, i.created, CS.mb(i.size)]));
    }
    function history(ref) {
      const st = S(); const img = CS.findImage(st, ref);
      if (!img) throw CmdError(`Error response from daemon: No such image: ${ref}`);
      if (cfg.onHistory) cfg.onHistory(st, img);
      const rows = (img.layers || []).slice().reverse().map((l, i) => [i === 0 ? img.id : '<missing>', l.ago || img.created, l.by.length > 46 ? l.by.slice(0, 45) + '…' : l.by, CS.mb(l.size).replace('MB', 'MB').replace(/^0\.0MB$/, '0B'), l.comment || (l.base ? '' : 'buildkit.dockerfile.v0')]);
      return CS.table(['IMAGE', 'CREATED', 'CREATED BY', 'SIZE', 'COMMENT'], rows);
    }
    function build(toks) {
      const st = S(); let tag = null, file = 'Dockerfile', ctx = null, noCache = false;
      for (let i = 0; i < toks.length; i++) { const t = toks[i]; if (t === '-t' || t === '--tag') tag = toks[++i]; else if (t.startsWith('--tag=')) tag = t.slice(6); else if (t === '-f' || t === '--file') file = toks[++i]; else if (t === '--no-cache') noCache = true; else if (t === '--progress' || t === '--target' || t === '--build-arg') i++; else if (t.startsWith('-')) continue; else ctx = t; }
      if (!ctx) throw CmdError('ERROR: "docker buildx build" requires exactly 1 argument.\nSee \'docker buildx build --help\'.\n\nUsage:  docker buildx build [OPTIONS] PATH | URL | -');
      const L = global.LinuxSim; const dir = L.norm(ctx, st.cwd, cfg.home || '/home/ruben');
      if (!L.get(st, dir)) throw CmdError(`ERROR: unable to prepare context: path "${ctx}" not found`);
      const dfPath = L.norm(file, file.startsWith('/') ? '/' : dir, cfg.home || '/home/ruben');
      const dfNode = L.get(st, dfPath);
      if (!dfNode) throw CmdError(`[+] Building 0.0s (1/1) FINISHED\n => [internal] load build definition from ${file}\n => => transferring dockerfile: 2B\nERROR: failed to solve: failed to read dockerfile: open ${file}: no such file or directory`);
      const df = CS.dockerfile(dfNode.c);
      if (df.errors.length) throw CmdError(`[+] Building 0.1s (1/1) FINISHED\n => [internal] load build definition from ${file}\nERROR: failed to solve: ${df.errors[0]}`);
      const ign = L.get(st, dir + '/.dockerignore');
      const r = cfg.build(st, { tag, df, dir, dockerignore: ign ? ign.c : null, excluded: CS.ignore(ign ? ign.c : ''), noCache, dockerfileText: dfNode.c });
      const head = ` => [internal] load build definition from ${file}${' '.repeat(Math.max(1, 30 - file.length))}0.0s\n => => transferring dockerfile: ${dfNode.c.length}B${' '.repeat(26)}0.0s\n` + df.stages.map(s => ` => [internal] load metadata for docker.io/${s.base.includes('/') ? s.base : 'library/' + s.base}      0.6s`).filter((x, i, a) => a.indexOf(x) === i).join('\n') + `\n => [internal] load .dockerignore${' '.repeat(28)}0.0s\n => => transferring context: ${ign ? ign.c.length + 'B' : '2B'}${' '.repeat(28)}0.0s`;
      const ctxLine = ` => [internal] load build context${' '.repeat(26)}${r.ctxSecs || '0.4'}s\n => => transferring context: ${r.ctxSize || '2.1kB'}${' '.repeat(22)}${r.ctxSecs || '0.3'}s`;
      if (!r.ok) throw CmdError(`[+] Building ${r.secs || '18.4'}s (${r.failAt || 6}/${r.total || 9}) FINISHED${' '.repeat(20)}docker:default\n${head}\n${ctxLine}\n${(r.steps || []).join('\n')}\n${(r.log || []).join('\n')}`);
      const img = r.image; const [repo, t2] = tag ? CS.splitRef(tag) : ['<none>', '<none>'];
      st.dk.images = st.dk.images.filter(i => !(i.repo === repo && i.tag === t2) || repo === '<none>');
      const prevSame = st.dk.images.find(i => i.id === img.id);
      Object.assign(img, { repo, tag: t2, id: img.id || CS.hex(dfNode.c + (ign ? ign.c : '') + tag, 12), created: 'Less than a second ago' });
      if (!prevSame) st.dk.images.unshift(img);
      if (cfg.onBuilt) cfg.onBuilt(st, img);
      return `[+] Building ${r.secs || '24.7'}s (${r.total || 12}/${r.total || 12}) FINISHED${' '.repeat(20)}docker:default\n${head}\n${ctxLine}\n${(r.steps || []).join('\n')}\n => exporting to image${' '.repeat(39)}1.2s\n => => exporting layers${' '.repeat(37)}1.0s\n => => writing image sha256:${img.id}${CS.hex(img.id, 20)}…  0.0s\n => => naming to docker.io/library/${repo}:${t2}${' '.repeat(10)}0.0s`;
    }
    function inspect(toks) {
      const st = S(); let fmt = null; const refs = []; let type = null;
      for (let i = 0; i < toks.length; i++) { const t = toks[i]; if (t === '-f' || t === '--format') fmt = toks[++i]; else if (t.startsWith('--format=')) fmt = t.slice(9); else if (t === '--type') type = toks[++i]; else refs.push(t); }
      if (!refs.length) throw CmdError('"docker inspect" requires at least 1 argument.');
      const objs = refs.map(ref => {
        const c = type !== 'image' && (CS.findContainer(st, ref)); if (c) { if (cfg.onInspect) cfg.onInspect(st, c); return CS.inspectContainer(st, c); }
        const im = type !== 'container' && CS.findImage(st, ref); if (im) { if (cfg.onInspect) cfg.onInspect(st, null, im); return CS.inspectImage(st, im); }
        const v = st.dk.volumes.find(x => x.name === ref); if (v) return { Name: v.name, Driver: 'local', Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, Scope: 'local', CreatedAt: '2026-11-22T16:42:00Z' };
        throw CmdError(`Error: No such object: ${ref}`);
      });
      if (fmt) return objs.map(o => CS.goTemplate(fmt, o)).join('\n');
      return JSON.stringify(objs, null, 4);
    }
    function logs(toks) {
      const st = S(); const ref = toks.filter(t => !t.startsWith('-') && !/^\d+$/.test(t)).pop();
      const c = CS.findContainer(st, ref); if (!c) throw CmdError(`Error response from daemon: No such container: ${ref}`);
      if (cfg.onLogs) cfg.onLogs(st, c);
      let lines = c.logs || []; const ti = toks.indexOf('--tail'); if (ti >= 0) lines = lines.slice(-(+toks[ti + 1] || 10));
      return lines.join('\n') || null;
    }
    function rm(toks) {
      const st = S(); const force = toks.some(t => /^-\w*f/.test(t) || t === '--force'); const out = [];
      toks.filter(t => !t.startsWith('-')).forEach(ref => {
        const c = CS.findContainer(st, ref); if (!c) throw CmdError(`Error response from daemon: No such container: ${ref}`);
        if ((c.status === 'running' || c.status === 'restarting') && !force) throw CmdError(`Error response from daemon: cannot remove container "/${c.name}": container is ${c.status}: stop the container before removing or force remove`);
        st.dk.containers = st.dk.containers.filter(x => x !== c); out.push(ref); if (cfg.onRemove) cfg.onRemove(st, c);
      });
      return out.join('\n');
    }
    function rmi(toks) {
      const st = S(); const out = [];
      toks.filter(t => !t.startsWith('-')).forEach(ref => {
        const im = CS.findImage(st, ref); if (!im) throw CmdError(`Error response from daemon: No such image: ${ref}`);
        const user = st.dk.containers.find(c => c.image === `${im.repo}:${im.tag}`);
        if (user && !toks.includes('-f')) throw CmdError(`Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container ${user.id} is using its referenced image ${im.id}`);
        st.dk.images = st.dk.images.filter(x => x !== im); out.push(`Untagged: ${im.repo}:${im.tag}`, `Deleted: sha256:${im.id}${CS.hex(im.id, 52)}`);
      });
      return out.join('\n');
    }
    function lifecycle(verb, toks) {
      const st = S(); const out = [];
      toks.filter(t => !t.startsWith('-')).forEach(ref => {
        const c = CS.findContainer(st, ref); if (!c) throw CmdError(`Error response from daemon: No such container: ${ref}`);
        if (verb === 'stop' || verb === 'kill') { c.status = 'exited'; c.exit = verb === 'kill' ? 137 : 0; c.health = c.health ? 'unhealthy' : c.health; }
        else { c.restarts = (c.restarts || 0) + (verb === 'restart' ? 1 : 0); c.status = 'running'; c.logs = (c.logs || []); const img = CS.findImage(st, c.image); if (cfg.run) cfg.run(st, c, img, verb); }
        out.push(ref);
      });
      return out.join('\n');
    }
    function volume(toks) {
      const st = S(); const sub = toks[0];
      if (sub === 'ls') return CS.table(['DRIVER', 'VOLUME NAME'], st.dk.volumes.map(v => ['local', v.name]));
      if (sub === 'create') { const n = toks.filter(t => !t.startsWith('-'))[1] || CS.hex('vol' + st.dk.volumes.length, 64); if (!st.dk.volumes.some(v => v.name === n)) st.dk.volumes.push({ name: n, driver: 'local' }); return n; }
      if (sub === 'inspect') return inspect(toks.slice(1));
      if (sub === 'rm') { const n = toks[1]; const v = st.dk.volumes.find(x => x.name === n); if (!v) throw CmdError(`Error response from daemon: get ${n}: no such volume`); const used = st.dk.containers.find(c => (c.mounts || []).some(m => m.type === 'volume' && m.src === n)); if (used) throw CmdError(`Error response from daemon: remove ${n}: volume is in use - [${used.id}${CS.hex(used.id, 52)}]`); st.dk.volumes = st.dk.volumes.filter(x => x !== v); return n; }
      throw CmdError('Usage:  docker volume COMMAND\n\nCommands: create, inspect, ls, rm');
    }
    function network(toks) {
      const st = S(); const sub = toks[0];
      if (sub === 'ls') return CS.table(['NETWORK ID', 'NAME', 'DRIVER', 'SCOPE'], st.dk.networks.map(n => [CS.hex(n.name, 12), n.name, n.driver || 'bridge', 'local']));
      if (sub === 'inspect') {
        const n = st.dk.networks.find(x => x.name === toks[1]); if (!n) throw CmdError(`Error response from daemon: network ${toks[1]} not found`);
        if (cfg.onNetInspect) cfg.onNetInspect(st, n);
        const members = st.dk.containers.filter(c => c.status === 'running' && ((c.networks || [c.network]).includes(n.name)));
        return JSON.stringify([{ Name: n.name, Id: CS.hex(n.name, 64), Scope: 'local', Driver: n.driver || 'bridge', IPAM: { Config: [{ Subnet: n.subnet || '172.18.0.0/16', Gateway: (n.subnet || '172.18.0.0/16').replace(/0\/16$/, '1') }] }, Containers: Object.fromEntries(members.map((c, i) => [c.id + CS.hex(c.id, 52), { Name: c.name, IPv4Address: (n.subnet || '172.18.0.0/16').replace(/0\.0\/16$/, '0.' + (i + 2)) + '/16' }])), Labels: n.labels || {} }], null, 4);
      }
      if (sub === 'create') { const nm = toks.filter(t => !t.startsWith('-'))[1]; st.dk.networks.push({ name: nm, driver: 'bridge' }); return CS.hex(nm, 64); }
      throw CmdError('Usage:  docker network COMMAND\n\nCommands: create, inspect, ls');
    }
    function exec(toks) {
      const st = S(); let i = 0; while (i < toks.length && toks[i].startsWith('-')) { if (toks[i] === '-u' || toks[i] === '--user' || toks[i] === '-w' || toks[i] === '-e') i++; i++; }
      const ref = toks[i]; const c = CS.findContainer(st, ref); if (!c) throw CmdError(`Error response from daemon: No such container: ${ref}`);
      if (c.status === 'restarting') throw CmdError(`Error response from daemon: Container ${c.id}${CS.hex(c.id, 52)} is restarting, wait until the container is running`);
      if (c.status !== 'running') throw CmdError(`Error response from daemon: container ${c.id}${CS.hex(c.id, 52)} is not running`);
      const cmd = toks.slice(i + 1);
      if (cfg.exec) { const r = cfg.exec(st, c, cmd); if (r !== undefined) return r; }
      if (cmd[0] === 'id') { const u = c.effectiveUser || 'root'; return u === 'root' || u === '0' ? 'uid=0(root) gid=0(root) groups=0(root)' : `uid=${c.uid || u}(${c.uname || u}) gid=${c.uid || u}(${c.uname || u}) groups=${c.uid || u}(${c.uname || u})`; }
      if (cmd[0] === 'whoami') return c.uname || c.effectiveUser || 'root';
      throw CmdError(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd[0]}": executable file not found in $PATH: unknown`);
    }
    const spec = {
      raw: true, desc: 'Docker CLI: build, images, history, run, ps, logs, inspect, exec, stop/start/restart, rm, rmi, volume, network, compose', run: a => {
        const toks = a._pos.slice(); let sub = toks.shift();
        if (S().flags) S().flags['dk_' + (sub === 'image' || sub === 'container' ? sub + '_' + toks[0] : sub)] = true;
        if (!sub || sub === '--help' || sub === 'help') return 'Usage:  docker [OPTIONS] COMMAND\n\nCommon Commands:\n  run         Create and run a new container from an image\n  exec        Execute a command in a running container\n  ps          List containers\n  build       Build an image from a Dockerfile\n  images      List images\n  logs        Fetch the logs of a container\n  inspect     Return low-level information on Docker objects\n  history     Show the history of an image\n  compose     Docker Compose\n  volume      Manage volumes\n  network     Manage networks';
        if (sub === '--version' || sub === '-v' || sub === 'version') return 'Docker version 27.3.1, build ce12230';
        needDaemon();
        if (sub === 'image') { const s2 = toks.shift(); sub = { ls: 'images', list: 'images', build: 'build', history: 'history', inspect: 'inspect', rm: 'rmi', prune: 'image-prune' }[s2] || s2; if (sub === 'inspect') toks.unshift('--type', 'image'); }
        if (sub === 'container') { const s2 = toks.shift(); sub = { ls: 'ps', list: 'ps', inspect: 'inspect' }[s2] || s2; }
        if (sub === 'buildx' && toks[0] === 'build') { toks.shift(); sub = 'build'; }
        const r = (() => {
          switch (sub) {
            case 'build': return build(toks);
            case 'images': return images();
            case 'history': return history(toks.filter(t => !t.startsWith('-'))[0]);
            case 'run': { const o = parseRun(toks); const c = createContainer(o); if (o.detach) return c.id + CS.hex(c.id, 52); return (c.logs || []).join('\n') || null; }
            case 'ps': return ps(toks);
            case 'logs': return logs(toks);
            case 'inspect': return inspect(toks);
            case 'exec': return exec(toks);
            case 'rm': return rm(toks);
            case 'rmi': return rmi(toks);
            case 'stop': case 'start': case 'restart': case 'kill': return lifecycle(sub, toks);
            case 'volume': return volume(toks);
            case 'network': return network(toks);
            case 'compose': if (!cfg.compose) throw CmdError('docker: \'compose\' is not available in this lab.'); return cfg.compose(S(), toks.shift(), toks, lab);
            case 'pull': { const ref = toks[0]; if (cfg.pull && cfg.pull(S(), ref)) return `${CS.splitRef(ref)[1]}: Pulling from library/${CS.splitRef(ref)[0]}\nDigest: sha256:${CS.hex(ref, 64)}\nStatus: Downloaded newer image for ${ref}\ndocker.io/library/${ref}`; if (CS.findImage(S(), ref)) return `Status: Image is up to date for ${ref}`; throw CmdError(`Error response from daemon: pull access denied for ${ref}, repository does not exist or may require 'docker login'`); }
            case 'system': if (toks[0] === 'df') return CS.table(['TYPE', 'TOTAL', 'ACTIVE', 'SIZE', 'RECLAIMABLE'], [['Images', S().dk.images.length, new Set(S().dk.containers.map(c => c.image)).size, CS.mb(S().dk.images.reduce((x, i) => x + i.size, 0)), '—'], ['Containers', S().dk.containers.length, S().dk.containers.filter(c => c.status === 'running').length, '12.3kB', '0B'], ['Local Volumes', S().dk.volumes.length, S().dk.volumes.length, '48.2MB', '0B']]); break;
            case 'info': return `Client: Docker Engine - Community\n Version:    27.3.1\n Context:    default\n\nServer:\n Containers: ${S().dk.containers.length}\n  Running: ${S().dk.containers.filter(c => c.status === 'running').length}\n Images: ${S().dk.images.length}\n Server Version: 27.3.1\n Storage Driver: overlay2\n Cgroup Driver: systemd\n Docker Root Dir: /var/lib/docker`;
          }
          throw CmdError(`docker: '${sub}' is not a docker command.\nSee 'docker --help'`);
        })();
        if (lab.refresh) setTimeout(() => lab.refresh && lab.refresh(), 0);
        return r;
      }
    };
    return { docker: spec };
  };

  // ======================================================================= compose model
  /** Normalize a compose service (environment list/map, depends_on list/map, ports, networks). */
  CS.composeService = (svc) => {
    svc = svc || {};
    const env = {};
    if (Array.isArray(svc.environment)) svc.environment.forEach(e => { const s = String(e); const i = s.indexOf('='); if (i > 0) env[s.slice(0, i)] = s.slice(i + 1); else env[s] = ''; });
    else if (svc.environment && typeof svc.environment === 'object') Object.entries(svc.environment).forEach(([k, v]) => { env[k] = v === null ? '' : String(v); });
    const deps = {};
    if (Array.isArray(svc.depends_on)) svc.depends_on.forEach(d => { deps[d] = 'service_started'; });
    else if (svc.depends_on && typeof svc.depends_on === 'object') Object.entries(svc.depends_on).forEach(([k, v]) => { deps[k] = (v && v.condition) || 'service_started'; });
    const ports = (svc.ports || []).map(p => { const m = String(p).match(/^(?:(\d+\.\d+\.\d+\.\d+):)?(?:(\d+):)?(\d+)(?:\/tcp)?$/); return m ? { host: m[2] ? +m[2] : null, cont: +m[3] } : null; }).filter(Boolean);
    const nets = Array.isArray(svc.networks) ? svc.networks.map(String) : svc.networks && typeof svc.networks === 'object' ? Object.keys(svc.networks) : null;
    const hc = svc.healthcheck || null;
    const hcTest = hc ? (Array.isArray(hc.test) ? hc.test.join(' ') : String(hc.test || '')) : '';
    return { image: svc.image, build: svc.build, env, deps, ports, networks: nets, healthcheck: hc, hcTest, restart: svc.restart || 'no', expose: svc.expose || [], volumes: svc.volumes || [], envFile: svc.env_file || null, secrets: svc.secrets || null };
  };
  /** ${VAR} / ${VAR:-default} interpolation from a .env map. Returns { text, missing }. */
  CS.interpolate = (text, vars) => {
    const missing = [];
    const out = String(text).replace(/\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g, (m, a, def, b) => { const k = a || b; if (vars[k] !== undefined) return vars[k]; if (def !== undefined) return def; missing.push(k); return ''; });
    return { text: out, missing };
  };
  CS.dotenv = text => { const o = {}; String(text || '').split('\n').forEach(l => { const m = l.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*)\s*$/); if (m && !l.trim().startsWith('#')) o[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); return o; };

  // ======================================================================= Kubernetes
  /**
   * State: st.k8s = { objs: [], images: {ref: {port, health, env:[], crash(envMap)->[lines], body}}, history: {key: [templates]}, goodHash: {key: hash},
   *                   deleted: {podName: true}, gen: {}, events: [], ctx: 'prod-mx', ns: 'default' }
   */
  CS.k8sState = (o) => Object.assign({ objs: [], history: {}, goodHash: {}, goodTpl: {}, gen: {}, events: [], ctx: 'prod-mx', ns: 'default', podIps: {} }, o || {});
  const KINDS = {
    pod: 'Pod', pods: 'Pod', po: 'Pod', deployment: 'Deployment', deployments: 'Deployment', deploy: 'Deployment', replicaset: 'ReplicaSet', replicasets: 'ReplicaSet', rs: 'ReplicaSet',
    service: 'Service', services: 'Service', svc: 'Service', endpoints: 'Endpoints', ep: 'Endpoints', configmap: 'ConfigMap', configmaps: 'ConfigMap', cm: 'ConfigMap', secret: 'Secret', secrets: 'Secret',
    networkpolicy: 'NetworkPolicy', networkpolicies: 'NetworkPolicy', netpol: 'NetworkPolicy', namespace: 'Namespace', namespaces: 'Namespace', ns: 'Namespace', event: 'Event', events: 'Event', ev: 'Event', all: 'all', node: 'Node', nodes: 'Node', no: 'Node'
  };
  const PLURAL = { Pod: 'pod', Deployment: 'deployment.apps', ReplicaSet: 'replicaset.apps', Service: 'service', ConfigMap: 'configmap', Secret: 'secret', NetworkPolicy: 'networkpolicy.networking.k8s.io', Namespace: 'namespace', Endpoints: 'endpoints' };
  CS.kGet = (st, kind, ns, name) => st.k8s.objs.find(o => o.kind === kind && o.metadata.name === name && (kind === 'Namespace' || (o.metadata.namespace || 'default') === ns));
  CS.kList = (st, kind, ns) => st.k8s.objs.filter(o => o.kind === kind && (kind === 'Namespace' || ns === null || (o.metadata.namespace || 'default') === ns));
  CS.nsLabels = (st, ns) => { const o = CS.kGet(st, 'Namespace', null, ns); return Object.assign({}, (o && o.metadata.labels) || {}, { 'kubernetes.io/metadata.name': ns }); };
  CS.matches = (sel, labels) => { if (!sel) return false; const ml = sel.matchLabels !== undefined || sel.matchExpressions !== undefined ? (sel.matchLabels || {}) : sel; const ok = Object.entries(ml).every(([k, v]) => labels && String(labels[k]) === String(v)); const ex = (sel.matchExpressions || []).every(e => { const v = labels ? labels[e.key] : undefined; if (e.operator === 'In') return (e.values || []).map(String).includes(String(v)); if (e.operator === 'NotIn') return !(e.values || []).map(String).includes(String(v)); if (e.operator === 'Exists') return v !== undefined; if (e.operator === 'DoesNotExist') return v === undefined; return false; }); return ok && ex; };
  const tplOf = d => (d.spec && d.spec.template) || {};
  const tplHash = t => CS.hash(JSON.stringify(t), 10).replace(/[^bcdfghjklmnpqrstvwxz2456789]/g, c => 'bcdfghjklmnpqrstvwxz2456789'[c.charCodeAt(0) % 27]);
  const sfx = (seed) => CS.hash(seed, 5).replace(/[^bcdfghjklmnpqrstvwxz2456789]/g, c => 'bcdfghjklmnpqrstvwxz2456789'[c.charCodeAt(0) % 27]);

  /** Evaluate a pod template now: what happens when a container from it starts. */
  CS.podEval = (st, ns, tpl) => {
    const c = ((tpl.spec || {}).containers || [])[0];
    if (!c) return { phase: 'Pending', reason: 'Invalid', ready: false, message: 'no containers' };
    const img = st.k8s.images[c.image];
    if (!img) return { phase: 'Pending', reason: 'ImagePullBackOff', ready: false, message: `Back-off pulling image "${c.image}"`, events: [['Warning', 'Failed', 'kubelet', `Failed to pull image "${c.image}": rpc error: code = NotFound desc = failed to pull and unpack image "${c.image}": not found`], ['Normal', 'BackOff', 'kubelet', `Back-off pulling image "${c.image}"`]] };
    const env = {};
    for (const ef of c.envFrom || []) {
      if (ef.configMapRef) { const cm = CS.kGet(st, 'ConfigMap', ns, ef.configMapRef.name); if (!cm) { if (ef.configMapRef.optional) continue; return cfgErr(`configmap "${ef.configMapRef.name}" not found`); } Object.assign(env, cm.data || {}); }
      if (ef.secretRef) { const s = CS.kGet(st, 'Secret', ns, ef.secretRef.name); if (!s) { if (ef.secretRef.optional) continue; return cfgErr(`secret "${ef.secretRef.name}" not found`); } Object.assign(env, CS.secretData(s)); }
    }
    for (const e of c.env || []) {
      if (e.value !== undefined) { env[e.name] = String(e.value); continue; }
      const vf = e.valueFrom || {};
      if (vf.configMapKeyRef) { const r = vf.configMapKeyRef; const cm = CS.kGet(st, 'ConfigMap', ns, r.name); if (!cm) { if (r.optional) continue; return cfgErr(`configmap "${r.name}" not found`); } if (!cm.data || cm.data[r.key] === undefined) { if (r.optional) continue; return cfgErr(`couldn't find key ${r.key} in ConfigMap ${ns}/${r.name}`); } env[e.name] = String(cm.data[r.key]); }
      if (vf.secretKeyRef) { const r = vf.secretKeyRef; const s = CS.kGet(st, 'Secret', ns, r.name); if (!s) { if (r.optional) continue; return cfgErr(`secret "${r.name}" not found`); } const d = CS.secretData(s); if (d[r.key] === undefined) { if (r.optional) continue; return cfgErr(`couldn't find key ${r.key} in Secret ${ns}/${r.name}`); } env[e.name] = d[r.key]; }
    }
    const missing = (img.env || []).filter(k => env[k] === undefined || env[k] === '');
    if (missing.length || (img.check && img.check(env))) {
      const lines = img.crash ? img.crash(env, missing) : [`Error: missing environment variable ${missing[0]}`];
      return { phase: 'Running', reason: 'CrashLoopBackOff', ready: false, restarts: 5, logs: lines, prev: lines, exitCode: 1, events: [['Normal', 'Pulled', 'kubelet', `Container image "${c.image}" already present on machine`], ['Normal', 'Created', 'kubelet', `Created container ${c.name}`], ['Normal', 'Started', 'kubelet', `Started container ${c.name}`], ['Warning', 'BackOff', 'kubelet', `Back-off restarting failed container ${c.name} in pod {pod}`]] };
    }
    const named = {}; (c.ports || []).forEach(p => { if (p.name) named[p.name] = p.containerPort; });
    const rp = c.readinessProbe && c.readinessProbe.httpGet;
    if (rp) {
      const port = typeof rp.port === 'string' && !/^\d+$/.test(rp.port) ? named[rp.port] : +rp.port;
      if (port === undefined) return { phase: 'Running', reason: 'Running', ready: false, logs: img.logs || [], events: [['Warning', 'Unhealthy', 'kubelet', `Readiness probe errored: port "${rp.port}" not found in container`]] };
      if (port !== img.port) return { phase: 'Running', reason: 'Running', ready: false, logs: img.logs || [], events: [['Warning', 'Unhealthy', 'kubelet', `Readiness probe failed: Get "http://{ip}:${port}${rp.path || '/'}": dial tcp {ip}:${port}: connect: connection refused`]] };
      if ((rp.path || '/') !== img.health) return { phase: 'Running', reason: 'Running', ready: false, logs: img.logs || [], events: [['Warning', 'Unhealthy', 'kubelet', `Readiness probe failed: HTTP probe failed with statuscode: 404`]] };
    }
    return { phase: 'Running', reason: 'Running', ready: true, logs: img.logs || [], env, events: [['Normal', 'Pulled', 'kubelet', `Container image "${c.image}" already present on machine`], ['Normal', 'Created', 'kubelet', `Created container ${c.name}`], ['Normal', 'Started', 'kubelet', `Started container ${c.name}`]] };
    function cfgErr(msg) { return { phase: 'Pending', reason: 'CreateContainerConfigError', ready: false, message: msg, events: [['Normal', 'Pulled', 'kubelet', `Container image "${c.image}" already present on machine`], ['Warning', 'Failed', 'kubelet', `Error: ${msg}`]] }; }
  };
  CS.secretData = s => { const o = {}; Object.entries(s.data || {}).forEach(([k, v]) => { try { o[k] = atob(String(v)); } catch (e) { o[k] = '\u0000'; } }); Object.entries(s.stringData || {}).forEach(([k, v]) => { o[k] = String(v); }); return o; };

  /** Derive pods from deployments. */
  CS.pods = st => {
    const out = [];
    CS.kList(st, 'Deployment', null).forEach(d => {
      const ns = d.metadata.namespace || 'default'; const key = ns + '/' + d.metadata.name; const tpl = tplOf(d); const h = tplHash(tpl);
      const n = d.spec.replicas === undefined ? 1 : d.spec.replicas; const ev = CS.podEval(st, ns, tpl);
      const good = st.k8s.goodHash[key];
      const mk = (hash, i, e, old) => {
        const g = st.k8s.gen[key + hash + i] || 0;
        const name = `${d.metadata.name}-${hash}-${sfx(key + hash + i + 'g' + g)}`;
        const ipKey = name; if (!st.k8s.podIps[ipKey]) st.k8s.podIps[ipKey] = '10.42.' + (1 + (CS.hash(name, 2).charCodeAt(0) % 3)) + '.' + (10 + Object.keys(st.k8s.podIps).length * 3 % 240);
        return { kind: 'Pod', name, ns, deploy: d.metadata.name, key, hash, idx: i, labels: Object.assign({}, (tpl.metadata || {}).labels, { 'pod-template-hash': hash }), tpl: old ? old.tpl : tpl, ev: old ? old.ev : e, ip: st.k8s.podIps[ipKey], age: g ? '12s' : (old ? '3d4h' : (hash === good ? '3d4h' : '6m12s')), old: !!old };
      };
      if (ev.ready || !good || good === h) {
        if (good === h && !ev.ready && st.k8s.goodTpl[key]) { for (let i = 0; i < n; i++) out.push(mk(h, i, null, { tpl: st.k8s.goodTpl[key].tpl, ev: st.k8s.goodTpl[key].ev })); return; }
        for (let i = 0; i < n; i++) out.push(mk(h, i, ev));
      } else {
        const gt = st.k8s.goodTpl[key];
        for (let i = 0; i < n; i++) out.push(mk(good, i, null, { tpl: gt.tpl, ev: gt.ev }));
        out.push(mk(h, 0, ev));
      }
    });
    return out;
  };
  CS.rollout = (st, d) => {
    const ns = d.metadata.namespace || 'default'; const key = ns + '/' + d.metadata.name; const h = tplHash(tplOf(d));
    const pods = CS.pods(st).filter(p => p.key === key); const n = d.spec.replicas === undefined ? 1 : d.spec.replicas;
    const updated = pods.filter(p => p.hash === h); const ready = pods.filter(p => p.ev.ready);
    return { complete: updated.length === n && updated.every(p => p.ev.ready) && pods.length === n, updated: updated.length, ready: ready.length, total: n, avail: ready.length, pods };
  };
  /** Call after any change: when a template is healthy and fully rolled out it becomes the "good" revision. */
  CS.settle = st => {
    st.k8s.goodTpl = st.k8s.goodTpl || {};
    CS.kList(st, 'Deployment', null).forEach(d => {
      const ns = d.metadata.namespace || 'default'; const key = ns + '/' + d.metadata.name; const tpl = tplOf(d); const h = tplHash(tpl);
      const ev = CS.podEval(st, ns, tpl);
      if (ev.ready) { st.k8s.goodHash[key] = h; st.k8s.goodTpl[key] = { tpl: clone(tpl), ev }; }
    });
  };
  CS.endpoints = (st, svc) => {
    const ns = svc.metadata.namespace || 'default'; const sel = (svc.spec || {}).selector;
    if (!sel) return [];
    const port = ((svc.spec.ports || [])[0]) || {};
    return CS.pods(st).filter(p => p.ns === ns && p.ev.ready && CS.matches(sel, p.labels)).map(p => {
      let tp = port.targetPort === undefined ? port.port : port.targetPort;
      if (typeof tp === 'string' && !/^\d+$/.test(tp)) { const cp = ((((p.tpl.spec || {}).containers || [])[0] || {}).ports || []).find(x => x.name === tp); tp = cp ? cp.containerPort : null; }
      return { ip: p.ip, port: tp === null ? null : +tp, pod: p };
    }).filter(e => e.port !== null);
  };
  /** Would traffic from (srcNs, srcLabels) to pod on port be allowed by NetworkPolicies? */
  CS.netAllowed = (st, srcNs, srcLabels, pod, port) => {
    const pols = CS.kList(st, 'NetworkPolicy', pod.ns).filter(np => { const s = np.spec || {}; const types = s.policyTypes || ['Ingress']; return types.includes('Ingress') && CS.matches(s.podSelector || {}, pod.labels) || (types.includes('Ingress') && s.podSelector && !Object.keys(s.podSelector.matchLabels || {}).length && !(s.podSelector.matchExpressions || []).length); });
    if (!pols.length) return true;
    const nsl = CS.nsLabels(st, srcNs);
    return pols.some(np => (np.spec.ingress || []).some(rule => {
      const fromOk = !rule.from || !rule.from.length || rule.from.some(f => {
        const nsOk = f.namespaceSelector ? CS.matches(f.namespaceSelector, nsl) || (!Object.keys(f.namespaceSelector.matchLabels || {}).length && !(f.namespaceSelector.matchExpressions || []).length) : srcNs === pod.ns;
        const podOk = f.podSelector ? CS.matches(f.podSelector, srcLabels) || (!Object.keys(f.podSelector.matchLabels || {}).length && !(f.podSelector.matchExpressions || []).length) : true;
        if (f.ipBlock) return false;
        return nsOk && podOk;
      });
      const portOk = !rule.ports || !rule.ports.length || rule.ports.some(p => { if (p.port === undefined) return true; if (typeof p.port === 'string' && !/^\d+$/.test(p.port)) { const cp = ((((pod.tpl.spec || {}).containers || [])[0] || {}).ports || []).find(x => x.name === p.port); return cp && cp.containerPort === port; } return +p.port === port; });
      return fromOk && portOk;
    }));
  };
  /** HTTP request from a pod in srcNs to a URL. Returns { ok, code?, body?, err } */
  CS.kHttp = (st, srcNs, srcLabels, url, timeout) => {
    const m = String(url).match(/^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/); if (!m) return { err: `curl: (3) URL rejected: Malformed input to a URL function` };
    const host = m[1]; const path = m[3] || '/';
    const parts = host.replace(/\.svc\.cluster\.local$|\.svc$/, '').split('.');
    const svcName = parts[0]; const ns = parts[1] || srcNs;
    const svc = CS.kGet(st, 'Service', ns, svcName);
    if (!svc || parts.length > 2) return { err: `curl: (6) Could not resolve host: ${host}` };
    const sp = (svc.spec.ports || []).find(p => +p.port === +(m[2] || 80));
    if (!sp) return { err: `curl: (28) Connection timed out after ${timeout || 3001} milliseconds` };
    const eps = CS.endpoints(st, svc);
    if (!eps.length) return { err: `curl: (7) Failed to connect to ${host} port ${m[2] || 80} after 2 ms: Couldn't connect to server`, noEndpoints: true };
    const ep = eps[0];
    if (!CS.netAllowed(st, srcNs, srcLabels, ep.pod, ep.port)) return { err: `curl: (28) Connection timed out after ${timeout || 3001} milliseconds`, blocked: true };
    const img = st.k8s.images[(((ep.pod.tpl.spec || {}).containers || [])[0] || {}).image] || {};
    if (img.port !== ep.port) return { err: `curl: (7) Failed to connect to ${host} port ${m[2] || 80} after 1 ms: Couldn't connect to server`, refused: true };
    const body = img.routes && img.routes[path] !== undefined ? img.routes[path] : (path === img.health ? '{"status":"ok"}' : null);
    if (body === null) return { ok: true, code: 404, body: '{"error":"not found"}' };
    return { ok: true, code: 200, body };
  };

  CS.kube = (lab, cfg) => {
    const S = () => lab.state;
    const L = global.LinuxSim;
    const nsOf = a => { const i = a.findIndex(t => t === '-n' || t === '--namespace'); if (i >= 0) return a[i + 1]; const e = a.find(t => t.startsWith('--namespace=') || /^-n=/.test(t)); if (e) return e.split('=')[1]; return S().k8s.ns; };
    const allNs = a => a.includes('-A') || a.includes('--all-namespaces');
    const outOf = a => { const i = a.indexOf('-o'); if (i >= 0) return a[i + 1]; const e = a.find(t => t.startsWith('-o=') || t.startsWith('--output=')); return e ? e.split('=')[1] : (a.find(t => /^-o(wide|yaml|json|name)$/.test(t)) || '').slice(2) || null; };
    const lblOf = a => { const i = a.findIndex(t => t === '-l' || t === '--selector'); if (i < 0) return null; const sel = {}; String(a[i + 1] || '').split(',').forEach(p => { const [k, v] = p.split('='); sel[k] = v; }); return sel; };
    const positional = a => { const out = []; const withVal = ['-n', '--namespace', '-o', '-l', '--selector', '-f', '--filename', '-c', '--container', '--image', '--sort-by', '--field-selector', '--revision', '--to-revision', '--timeout', '--restart', '--type']; for (let i = 0; i < a.length; i++) { const t = a[i]; if (t === '--') break; if (withVal.includes(t)) { i++; continue; } if (t.startsWith('-')) continue; out.push(t); } return out; };
    const ensureNs = ns => { if (ns && !CS.kGet(S(), 'Namespace', null, ns)) throw CmdError(`Error from server (NotFound): namespaces "${ns}" not found`); };
    const notFound = (kind, name) => CmdError(`Error from server (NotFound): ${(PLURAL[kind] || kind.toLowerCase()).split('.')[0]}s${kind === 'Endpoints' ? '' : ''} "${name}" not found`.replace('endpointss', 'endpoints').replace('networkpolicys', 'networkpolicies.networking.k8s.io').replace('deployments', 'deployments.apps').replace('replicasets', 'replicasets.apps'));
    const findPod = (ns, name) => { const st = S(); if (name.startsWith('deploy/') || name.startsWith('deployment/')) { const dn = name.split('/')[1]; const ps = CS.pods(st).filter(p => p.ns === ns && p.deploy === dn); if (!ps.length) throw notFound('Deployment', dn); return ps.find(p => !p.ev.ready) && cfg.preferFailing ? ps.find(p => !p.ev.ready) : ps[0]; } const p = CS.pods(st).find(x => x.ns === ns && x.name === name.replace(/^pods?\//, '')); if (!p) throw notFound('Pod', name.replace(/^pods?\//, '')); return p; };
    const status = p => { const e = p.ev; if (e.reason === 'CrashLoopBackOff') return { st: (S().k8s.tick || 0) % 2 ? 'Error' : 'CrashLoopBackOff', ready: '0/1', restarts: `${e.restarts + (S().k8s.tick || 0)} (${20 + (S().k8s.tick || 0) * 7}s ago)` }; if (e.reason === 'CreateContainerConfigError' || e.reason === 'ImagePullBackOff') return { st: e.reason, ready: '0/1', restarts: '0' }; return { st: 'Running', ready: e.ready ? '1/1' : '0/1', restarts: '0' }; };
    const ageOf = o => (o.metadata && o.metadata.age) || '3d4h';

    function getCmd(a) {
      const st = S(); const pos = positional(a); let [res, name] = pos;
      if (!res) throw CmdError('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.');
      if (res.includes('/')) [res, name] = res.split('/');
      const resList = res.split(',');
      if (resList.length > 1) return resList.map(r => getCmd([r].concat(a.filter(t => t !== res)))).join('\n\n');
      const kind = KINDS[res.toLowerCase()]; if (!kind) throw CmdError(`error: the server doesn't have a resource type "${res}"`);
      const all = allNs(a); const ns = all ? null : nsOf(a); if (ns) ensureNs(ns); const out = outOf(a); const labels = a.includes('--show-labels'); const sel = lblOf(a);
      if (cfg.onGet) cfg.onGet(st, kind, ns, name, a);
      st.k8s.tick = (st.k8s.tick || 0) + 1;
      const lbl = o => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>';
      const nsCol = all ? ['NAMESPACE'] : [];
      if (kind === 'all') return ['pods', 'services', 'deployments', 'replicasets'].map(k => getCmd([k].concat(a.filter(t => t !== res)))).filter(x => x && !/^No resources/.test(x)).join('\n\n');
      if (kind === 'Pod') {
        let ps = CS.pods(st).filter(p => !ns || p.ns === ns); if (name) { ps = ps.filter(p => p.name === name); if (!ps.length) throw notFound('Pod', name); }
        if (sel) ps = ps.filter(p => CS.matches(sel, p.labels));
        if (!ps.length) return `No resources found in ${ns} namespace.`;
        if (out === 'yaml' || out === 'json') return dump(ps.map(podObj), out);
        if (out === 'name') return ps.map(p => 'pod/' + p.name).join('\n');
        const cols = nsCol.concat(['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE']).concat(out === 'wide' ? ['IP', 'NODE'] : []).concat(labels ? ['LABELS'] : []);
        return CS.table(cols, ps.map(p => { const s = status(p); return (all ? [p.ns] : []).concat([p.name, s.ready, s.st, s.restarts, p.age]).concat(out === 'wide' ? [p.ev.reason === 'CreateContainerConfigError' || p.ev.reason === 'ImagePullBackOff' ? p.ip : p.ip, 'node-' + (1 + CS.hash(p.name, 1).charCodeAt(0) % 3)] : []).concat(labels ? [lbl(p.labels)] : []); }));
      }
      if (kind === 'Event') {
        const evs = eventsFor(ns);
        if (!evs.length) return `No resources found in ${ns} namespace.`;
        return CS.table(nsCol.concat(['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE']), evs.map(e => (all ? [e.ns] : []).concat([e.age, e.type, e.reason, e.obj, e.msg])));
      }
      if (kind === 'Endpoints') {
        let svcs = CS.kList(st, 'Service', ns); if (name) { svcs = svcs.filter(s => s.metadata.name === name); if (!svcs.length) throw notFound('Endpoints', name); }
        if (cfg.onEndpoints) cfg.onEndpoints(st, svcs);
        if (out === 'yaml' || out === 'json') return dump(svcs.map(s => ({ apiVersion: 'v1', kind: 'Endpoints', metadata: { name: s.metadata.name, namespace: s.metadata.namespace }, subsets: CS.endpoints(st, s).length ? [{ addresses: CS.endpoints(st, s).map(e => ({ ip: e.ip, targetRef: { kind: 'Pod', name: e.pod.name } })), ports: [{ port: CS.endpoints(st, s)[0].port, protocol: 'TCP' }] }] : null })), out);
        return CS.table(nsCol.concat(['NAME', 'ENDPOINTS', 'AGE']), svcs.map(s => { const e = CS.endpoints(st, s); return (all ? [s.metadata.namespace] : []).concat([s.metadata.name, e.length ? e.slice(0, 3).map(x => `${x.ip}:${x.port}`).join(',') + (e.length > 3 ? ` + ${e.length - 3} more...` : '') : '<none>', ageOf(s)]); }));
      }
      if (kind === 'ReplicaSet') {
        const rows = []; CS.kList(st, 'Deployment', ns).forEach(d => { const r = CS.rollout(st, d); const hs = [...new Set(r.pods.map(p => p.hash))]; hs.forEach(h => { const ps = r.pods.filter(p => p.hash === h); rows.push((all ? [d.metadata.namespace] : []).concat([`${d.metadata.name}-${h}`, ps.length, ps.length, ps.filter(p => p.ev.ready).length, ps[0].age])); }); });
        return rows.length ? CS.table(nsCol.concat(['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE']), rows) : `No resources found in ${ns} namespace.`;
      }
      if (kind === 'Node') return CS.table(['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'], [['node-1', 'Ready', '<none>', '41d', 'v1.31.2'], ['node-2', 'Ready', '<none>', '41d', 'v1.31.2'], ['node-3', 'Ready', '<none>', '41d', 'v1.31.2']]);
      let objs = CS.kList(st, kind, ns);
      if (name) { objs = objs.filter(o => o.metadata.name === name); if (!objs.length) throw notFound(kind, name); }
      if (sel) objs = objs.filter(o => CS.matches(sel, o.metadata.labels || {}));
      if (!objs.length) return kind === 'Namespace' ? 'No resources found' : `No resources found in ${ns} namespace.`;
      if (out === 'yaml' || out === 'json') return dump(objs, out);
      if (out === 'name') return objs.map(o => (PLURAL[kind] || kind.toLowerCase()) + '/' + o.metadata.name).join('\n');
      const L2 = o => labels ? [lbl(o.metadata.labels)] : [];
      const lc = labels ? ['LABELS'] : [];
      const pre = o => (all ? [o.metadata.namespace || 'default'] : []);
      if (kind === 'Deployment') return CS.table(nsCol.concat(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE']).concat(out === 'wide' ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []).concat(lc), objs.map(d => { const r = CS.rollout(st, d); const c = ((tplOf(d).spec || {}).containers || [])[0] || {}; return pre(d).concat([d.metadata.name, `${r.ready}/${r.total}`, r.updated, r.avail, ageOf(d)]).concat(out === 'wide' ? [c.name, c.image, lbl((d.spec.selector || {}).matchLabels)] : []).concat(L2(d)); }));
      if (kind === 'Service') return CS.table(nsCol.concat(['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE']).concat(out === 'wide' ? ['SELECTOR'] : []).concat(lc), objs.map(s => pre(s).concat([s.metadata.name, s.spec.type || 'ClusterIP', s.spec.clusterIP || '10.43.' + (CS.hash(s.metadata.name, 1).charCodeAt(0) % 200) + '.' + (CS.hash(s.metadata.name + 'x', 1).charCodeAt(0) % 250), '<none>', (s.spec.ports || []).map(p => `${p.port}/${p.protocol || 'TCP'}`).join(','), ageOf(s)]).concat(out === 'wide' ? [lbl(s.spec.selector)] : []).concat(L2(s))));
      if (kind === 'ConfigMap') return CS.table(nsCol.concat(['NAME', 'DATA', 'AGE']).concat(lc), objs.map(o => pre(o).concat([o.metadata.name, Object.keys(o.data || {}).length, ageOf(o)]).concat(L2(o))));
      if (kind === 'Secret') return CS.table(nsCol.concat(['NAME', 'TYPE', 'DATA', 'AGE']).concat(lc), objs.map(o => pre(o).concat([o.metadata.name, o.type || 'Opaque', Object.keys(CS.secretData(o)).length, ageOf(o)]).concat(L2(o))));
      if (kind === 'NetworkPolicy') return CS.table(nsCol.concat(['NAME', 'POD-SELECTOR', 'AGE']).concat(lc), objs.map(o => pre(o).concat([o.metadata.name, lbl(((o.spec || {}).podSelector || {}).matchLabels), ageOf(o)]).concat(L2(o))));
      if (kind === 'Namespace') return CS.table(['NAME', 'STATUS', 'AGE'].concat(lc), objs.map(o => [o.metadata.name, 'Active', ageOf(o)].concat(labels ? [lbl(CS.nsLabels(st, o.metadata.name))] : [])));
      return '';
    }
    function podObj(p) {
      const s = status(p);
      return { apiVersion: 'v1', kind: 'Pod', metadata: { name: p.name, namespace: p.ns, labels: p.labels, ownerReferences: [{ kind: 'ReplicaSet', name: `${p.deploy}-${p.hash}` }] }, spec: p.tpl.spec, status: { phase: p.ev.phase, podIP: p.ip, containerStatuses: [{ name: ((p.tpl.spec.containers || [])[0] || {}).name, ready: !!p.ev.ready, restartCount: parseInt(s.restarts, 10) || 0, state: p.ev.reason === 'Running' ? { running: { startedAt: '2026-11-22T16:40:00Z' } } : { waiting: { reason: p.ev.reason, message: p.ev.message } } }] } };
    }
    function dump(objs, out) {
      const clean = objs.map(o => { const c = clone(o); if (c.metadata) delete c.metadata.age; return c; });
      const doc = clean.length === 1 ? clean[0] : { apiVersion: 'v1', kind: 'List', items: clean };
      return out === 'json' ? JSON.stringify(doc, null, 4) : CS.toYaml(doc);
    }
    function eventsFor(ns) {
      const st = S(); const evs = [];
      CS.pods(st).filter(p => (!ns || p.ns === ns) && !p.old).forEach(p => { (p.ev.events || []).forEach((e, i) => { evs.push({ ns: p.ns, age: p.ev.ready ? (p.age === '12s' ? '12s' : '6m') : ['6m', '6m', '6m', '2m'][i] || '45s', type: e[0], reason: e[1], obj: 'pod/' + p.name, msg: e[3].replace('{pod}', `${p.name}_${p.ns}(${CS.hex(p.name, 8)}-…)`).replace(/\{ip\}/g, p.ip) }); }); });
      CS.kList(st, 'Deployment', ns).forEach(d => { const r = CS.rollout(st, d); const h = tplHash(tplOf(d)); const nsd = d.metadata.namespace || 'default'; if (!r.pods.every(p => p.hash === h) || !r.complete) evs.push({ ns: nsd, age: '6m', type: 'Normal', reason: 'ScalingReplicaSet', obj: 'deployment/' + d.metadata.name, msg: `Scaled up replica set ${d.metadata.name}-${h} to 1` }); });
      (st.k8s.events || []).filter(e => !ns || e.ns === ns).forEach(e => evs.push(e));
      return evs;
    }
    function describe(a) {
      const st = S(); const pos = positional(a); let [res, name] = pos; if (!res) throw CmdError('error: You must specify the type of resource to describe.');
      if (res.includes('/')) [res, name] = res.split('/');
      const kind = KINDS[res.toLowerCase()]; if (!kind) throw CmdError(`error: the server doesn't have a resource type "${res}"`);
      const ns = nsOf(a); ensureNs(ns);
      if (cfg.onDescribe) cfg.onDescribe(st, kind, ns, name);
      const lbl = (o, pad) => { const e = Object.entries(o || {}); return e.length ? e.map(([k, v], i) => (i ? ' '.repeat(pad) : '') + `${k}=${v}`).join('\n') : '<none>'; };
      const evTable = list => list.length ? 'Events:\n  Type     Reason     Age   From     Message\n  ----     ------     ----  ----     -------\n' + list.map(e => `  ${e.type.padEnd(8)} ${e.reason.padEnd(10)} ${e.age.padEnd(5)} ${(e.from || 'kubelet').padEnd(8)} ${e.msg}`).join('\n') : 'Events:  <none>';
      if (kind === 'Pod') {
        const list = name ? [findPod(ns, name)] : CS.pods(st).filter(p => p.ns === ns);
        return list.map(p => {
          const c = (p.tpl.spec.containers || [])[0] || {}; const s = status(p); const e = p.ev;
          const envLines = (c.env || []).map(x => `      ${x.name}:  ${x.value !== undefined ? x.value : x.valueFrom.configMapKeyRef ? `<set to the key '${x.valueFrom.configMapKeyRef.key}' of config map '${x.valueFrom.configMapKeyRef.name}'>` : x.valueFrom.secretKeyRef ? `<set to the key '${x.valueFrom.secretKeyRef.key}' in secret '${x.valueFrom.secretKeyRef.name}'>` : ''}  Optional: false`).join('\n');
          const envFrom = (c.envFrom || []).map(x => x.configMapRef ? `      ${x.configMapRef.name}  ConfigMap  Optional: ${!!x.configMapRef.optional}` : `      ${x.secretRef.name}  Secret  Optional: ${!!x.secretRef.optional}`).join('\n');
          const rp = c.readinessProbe && c.readinessProbe.httpGet;
          const state = e.reason === 'CrashLoopBackOff' ? `    State:          Waiting\n      Reason:       CrashLoopBackOff\n    Last State:     Terminated\n      Reason:       Error\n      Exit Code:    ${e.exitCode || 1}` : e.reason === 'Running' ? `    State:          Running\n      Started:      Sun, 22 Nov 2026 10:34:12 -0600` : `    State:          Waiting\n      Reason:       ${e.reason}`;
          const evs = eventsFor(ns).filter(x => x.obj === 'pod/' + p.name);
          return `Name:             ${p.name}\nNamespace:        ${p.ns}\nNode:             node-2/10.0.0.12\nLabels:           ${lbl(p.labels, 18)}\nStatus:           ${e.phase}\nIP:               ${p.ip}\nControlled By:    ReplicaSet/${p.deploy}-${p.hash}\nContainers:\n  ${c.name}:\n    Image:          ${c.image}\n    Port:           ${(c.ports || []).map(x => x.containerPort + '/TCP').join(', ') || '<none>'}\n${state}\n    Ready:          ${e.ready ? 'True' : 'False'}\n    Restart Count:  ${parseInt(s.restarts, 10) || 0}\n${rp ? `    Readiness:      http-get http://:${rp.port}${rp.path || '/'} delay=${(c.readinessProbe.initialDelaySeconds || 0)}s timeout=1s period=${c.readinessProbe.periodSeconds || 10}s #success=1 #failure=3\n` : ''}${envFrom ? `    Environment Variables from:\n${envFrom}\n` : ''}    Environment:${envLines ? '\n' + envLines : '    <none>'}\nConditions:\n  Type              Status\n  Initialized       True\n  Ready             ${e.ready ? 'True' : 'False'}\n  ContainersReady   ${e.ready ? 'True' : 'False'}\n  PodScheduled      True\n${evTable(evs)}`;
        }).join('\n\n\n');
      }
      const objs = name ? [CS.kGet(st, kind, ns, name)] : CS.kList(st, kind, ns);
      if (name && !objs[0]) throw notFound(kind, name);
      return objs.map(o => {
        const head = `Name:         ${o.metadata.name}\n${kind !== 'Namespace' ? `Namespace:    ${o.metadata.namespace || 'default'}\n` : ''}Labels:       ${lbl(kind === 'Namespace' ? CS.nsLabels(st, o.metadata.name) : o.metadata.labels, 14)}\nAnnotations:  <none>\n`;
        if (kind === 'Deployment') {
          const r = CS.rollout(st, o); const c = ((tplOf(o).spec || {}).containers || [])[0] || {};
          const rev = (st.k8s.history[(o.metadata.namespace || 'default') + '/' + o.metadata.name] || []).length;
          return head.replace('Annotations:  <none>', `Annotations:  deployment.kubernetes.io/revision: ${rev}`) + `Selector:               ${lbl((o.spec.selector || {}).matchLabels, 24)}\nReplicas:               ${r.total} desired | ${r.updated} updated | ${r.pods.length} total | ${r.avail} available | ${r.pods.length - r.avail} unavailable\nStrategyType:           RollingUpdate\nRollingUpdateStrategy:  25% max unavailable, 25% max surge\nPod Template:\n  Labels:  ${lbl((tplOf(o).metadata || {}).labels, 11)}\n  Containers:\n   ${c.name}:\n    Image:      ${c.image}\n    Port:       ${(c.ports || []).map(x => x.containerPort + '/TCP').join(', ') || '<none>'}\n${(c.envFrom || []).length ? `    Environment Variables from:\n${c.envFrom.map(x => x.configMapRef ? `      ${x.configMapRef.name}  ConfigMap  Optional: false` : `      ${x.secretRef.name}  Secret  Optional: false`).join('\n')}\n` : ''}Conditions:\n  Type           Status  Reason\n  ----           ------  ------\n  Available      ${r.avail >= r.total ? 'True ' : 'False'}   ${r.avail >= r.total ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable'}\n  Progressing    ${r.complete ? 'True ' : 'False'}   ${r.complete ? 'NewReplicaSetAvailable' : 'ProgressDeadlineExceeded'}\nNewReplicaSet:   ${o.metadata.name}-${tplHash(tplOf(o))} (${r.updated}/${r.updated} replicas created)\n${evTable(eventsFor(ns).filter(x => x.obj === 'deployment/' + o.metadata.name).map(x => Object.assign({ from: 'deployment-controller' }, x)))}`;
        }
        if (kind === 'Service') {
          const eps = CS.endpoints(st, o); const p = (o.spec.ports || [])[0] || {};
          if (cfg.onEndpoints) cfg.onEndpoints(st, [o]);
          return head + `Selector:          ${Object.entries(o.spec.selector || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>'}\nType:              ${o.spec.type || 'ClusterIP'}\nIP:                10.43.${CS.hash(o.metadata.name, 1).charCodeAt(0) % 200}.${CS.hash(o.metadata.name + 'x', 1).charCodeAt(0) % 250}\nPort:              ${p.name || '<unset>'}  ${p.port}/TCP\nTargetPort:        ${p.targetPort === undefined ? p.port : p.targetPort}/TCP\nEndpoints:         ${eps.length ? eps.map(e => `${e.ip}:${e.port}`).join(',') : '<none>'}\nSession Affinity:  None\nEvents:            <none>`;
        }
        if (kind === 'ConfigMap') return head + `\nData\n====\n${Object.entries(o.data || {}).map(([k, v]) => `${k}:\n----\n${v}\n`).join('\n')}\nBinaryData\n====\n\nEvents:  <none>`;
        if (kind === 'Secret') return head + `\nType:  ${o.type || 'Opaque'}\n\nData\n====\n${Object.entries(CS.secretData(o)).map(([k, v]) => `${k}:  ${v.length} bytes`).join('\n')}`;
        if (kind === 'NetworkPolicy') {
          const s = o.spec || {};
          const fromTxt = r => !r.from || !r.from.length ? '    From: <any> (traffic not restricted by source)' : r.from.map(f => f.namespaceSelector && f.podSelector ? `    From:\n      NamespaceSelector: ${lbl(f.namespaceSelector.matchLabels, 0)}\n      PodSelector: ${lbl(f.podSelector.matchLabels, 0)}` : f.namespaceSelector ? `    From:\n      NamespaceSelector: ${lbl(f.namespaceSelector.matchLabels, 0) || '<none>'}` : f.podSelector ? `    From:\n      PodSelector: ${lbl(f.podSelector.matchLabels, 0)}` : '    From: ' + JSON.stringify(f)).join('\n');
          return head + `Spec:\n  PodSelector:     ${lbl((s.podSelector || {}).matchLabels, 0) === '<none>' ? '<none> (Allowing the specific traffic to all pods in this namespace)' : lbl((s.podSelector || {}).matchLabels, 0)}\n  Allowing ingress traffic:\n${(s.ingress || []).map(r => `    To Port: ${(r.ports || []).map(p => `${p.port}/${p.protocol || 'TCP'}`).join(', ') || '<any> (traffic allowed to all ports)'}\n${fromTxt(r)}`).join('\n    ----------\n') || '    <none> (Selected pods are isolated for ingress connectivity)'}\n  Not affecting egress traffic\n  Policy Types: ${(s.policyTypes || ['Ingress']).join(', ')}`;
        }
        if (kind === 'Namespace') return head + 'Status:       Active\n\nNo resource quota.\n\nNo LimitRange resource.';
        return head;
      }).join('\n\n');
    }
    function logsCmd(a) {
      const st = S(); const ns = nsOf(a); ensureNs(ns); const pos = positional(a); if (!pos[0]) throw CmdError('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.');
      const p = findPod(ns, pos[0]); const prev = a.includes('--previous') || a.includes('-p');
      if (cfg.onLogs) cfg.onLogs(st, p, prev);
      const e = p.ev;
      if (e.reason === 'CreateContainerConfigError') throw CmdError(`Error from server (BadRequest): container "${(p.tpl.spec.containers[0] || {}).name}" in pod "${p.name}" is waiting to start: CreateContainerConfigError`);
      if (e.reason === 'ImagePullBackOff') throw CmdError(`Error from server (BadRequest): container "${(p.tpl.spec.containers[0] || {}).name}" in pod "${p.name}" is waiting to start: trying and failing to pull image`);
      if (prev) { if (e.reason !== 'CrashLoopBackOff') throw CmdError(`Error from server (BadRequest): previous terminated container "${(p.tpl.spec.containers[0] || {}).name}" in pod "${p.name}" not found`); return e.prev.join('\n'); }
      if (e.reason === 'CrashLoopBackOff') return (st.k8s.tick || 0) % 2 ? e.logs.join('\n') : e.logs.slice(0, Math.max(1, e.logs.length - 2)).join('\n');
      return (e.logs || []).join('\n') || null;
    }
    function applyCmd(a) {
      const st = S(); const fi = a.findIndex(t => t === '-f' || t === '--filename'); const f = fi >= 0 ? a[fi + 1] : (a.find(t => t.startsWith('-f=')) || '').slice(3);
      if (!f) throw CmdError('error: must specify one of -f and -k');
      const p = L.norm(f, st.cwd, cfg.home || '/home/ruben'); const n = L.get(st, p);
      if (!n) throw CmdError(`error: the path "${f}" does not exist`);
      const files = n.t === 'd' ? L.children(st, p).filter(x => /\.ya?ml$/.test(x)).sort() : [p];
      const out = [];
      for (const file of files) {
        let docs; try { docs = CS.yamlAll(L.get(st, file).c); } catch (e) { throw CmdError(`error: error parsing ${file.replace(cfg.home + '/', '')}: error converting YAML to JSON: ${e.message}`); }
        for (const d of docs) {
          if (!d || typeof d !== 'object' || !d.kind || !d.metadata || !d.metadata.name) throw CmdError(`error: error validating "${file.replace(cfg.home + '/', '')}": error validating data: [apiVersion not set, kind not set]; if you choose to ignore these errors, turn validation off with --validate=false`);
          const nsArg = a.includes('-n') ? nsOf(a) : null;
          const ns = d.kind === 'Namespace' ? null : (d.metadata.namespace || nsArg || st.k8s.ns);
          if (nsArg && d.metadata.namespace && nsArg !== d.metadata.namespace) throw CmdError(`error: the namespace from the provided object "${d.metadata.namespace}" does not match the namespace "${nsArg}". You must pass '--namespace=${d.metadata.namespace}' to perform this operation.`);
          if (ns) { ensureNs(ns); d.metadata.namespace = ns; }
          if (cfg.validate) { const v = cfg.validate(st, d); if (v) throw CmdError(v); }
          const ex = CS.kGet(st, d.kind, ns, d.metadata.name);
          const label = `${(PLURAL[d.kind] || d.kind.toLowerCase())}/${d.metadata.name}`;
          if (d.kind === 'Deployment') { const sel = (d.spec || {}).selector; const tl = ((tplOf(d).metadata) || {}).labels; if (!sel || !CS.matches(sel, tl)) throw CmdError(`The Deployment "${d.metadata.name}" is invalid: spec.template.metadata.labels: Invalid value: ${JSON.stringify(tl || {})}: \`selector\` does not match template \`labels\``); if (ex && JSON.stringify(ex.spec.selector) !== JSON.stringify(sel)) throw CmdError(`The Deployment "${d.metadata.name}" is invalid: spec.selector: Invalid value: ${JSON.stringify(sel)}: field is immutable`); }
          if (ex) {
            const cmp = o => JSON.stringify(Object.assign({}, o, { metadata: Object.assign({}, o.metadata, { age: undefined }) }));
            if (cmp(ex) === cmp(d)) { out.push(`${label} unchanged`); continue; }
            d.metadata.age = ex.metadata.age; st.k8s.objs[st.k8s.objs.indexOf(ex)] = d; out.push(`${label} configured`);
          } else { d.metadata.age = '0s'; st.k8s.objs.push(d); out.push(`${label} created`); }
          if (d.kind === 'Deployment') { const key = ns + '/' + d.metadata.name; const h = st.k8s.history[key] = st.k8s.history[key] || []; const last = h[h.length - 1]; if (!last || JSON.stringify(last.tpl) !== JSON.stringify(tplOf(d))) h.push({ tpl: clone(tplOf(d)), cause: ((d.metadata.annotations || {})['kubernetes.io/change-cause']) || '<none>' }); }
        }
      }
      CS.settle(st); if (cfg.onApply) cfg.onApply(st, out);
      return out.join('\n');
    }
    function deleteCmd(a) {
      const st = S(); const ns = nsOf(a); const pos = positional(a); let [res, ...names] = pos;
      if (a.includes('-f')) { const p = L.norm(a[a.indexOf('-f') + 1], st.cwd, cfg.home); const n = L.get(st, p); if (!n) throw CmdError('error: the path does not exist'); const docs = CS.yamlAll(n.c); return docs.map(d => { const o = CS.kGet(st, d.kind, d.metadata.namespace || ns, d.metadata.name); if (!o) return `Error from server (NotFound): ${d.kind.toLowerCase()} "${d.metadata.name}" not found`; st.k8s.objs.splice(st.k8s.objs.indexOf(o), 1); if (cfg.onDelete) cfg.onDelete(st, o); return `${PLURAL[d.kind] || d.kind.toLowerCase()} "${d.metadata.name}" deleted`; }).join('\n'); }
      if (!res) throw CmdError('error: You must provide one or more resources by argument or filename.');
      if (res.includes('/')) { names = [res.split('/')[1]].concat(names); res = res.split('/')[0]; }
      const kind = KINDS[res.toLowerCase()]; if (!kind) throw CmdError(`error: the server doesn't have a resource type "${res}"`);
      ensureNs(ns);
      return names.map(nm => {
        if (kind === 'Pod') { const p = findPod(ns, nm); st.k8s.gen[p.key + p.hash + p.idx] = (st.k8s.gen[p.key + p.hash + p.idx] || 0) + 1; if (cfg.onDelete) cfg.onDelete(st, { kind: 'Pod', pod: p }); return `pod "${p.name}" deleted`; }
        const o = CS.kGet(st, kind, ns, nm); if (!o) throw notFound(kind, nm);
        st.k8s.objs.splice(st.k8s.objs.indexOf(o), 1); if (cfg.onDelete) cfg.onDelete(st, o);
        return `${(PLURAL[kind] || kind.toLowerCase()).split('.')[0]} "${nm}" deleted`;
      }).join('\n');
    }
    function rolloutCmd(a) {
      const st = S(); const ns = nsOf(a); const pos = positional(a); const verb = pos[0]; let target = pos[1]; if (pos[2] && !target.includes('/')) target = pos[1] + '/' + pos[2];
      if (!verb || !target) throw CmdError('error: required resource not specified\nUsage: kubectl rollout status|history|undo|restart deployment/NAME');
      const dn = target.split('/').pop(); const d = CS.kGet(st, 'Deployment', ns, dn); if (!d) throw notFound('Deployment', dn);
      const key = ns + '/' + dn; const hist = st.k8s.history[key] = st.k8s.history[key] || [];
      if (cfg.onRollout) cfg.onRollout(st, verb, d, a);
      if (verb === 'status') {
        const r = CS.rollout(st, d);
        if (r.complete) return `deployment "${dn}" successfully rolled out`;
        return { text: `Waiting for deployment "${dn}" rollout to finish: ${r.updated} out of ${r.total} new replicas have been updated...\nerror: deployment "${dn}" exceeded its progress deadline`, cls: 'err' };
      }
      if (verb === 'history') {
        const ri = a.findIndex(t => t === '--revision' || t.startsWith('--revision=')); const rev = ri >= 0 ? +(a[ri].includes('=') ? a[ri].split('=')[1] : a[ri + 1]) : null;
        if (rev) { const h = hist[rev - 1]; if (!h) throw CmdError(`error: unable to find the specified revision`); const c = (h.tpl.spec.containers || [])[0] || {}; return `deployment.apps/${dn} with revision #${rev}\nPod Template:\n  Labels:\t${Object.entries((h.tpl.metadata || {}).labels || {}).map(([k, v]) => `${k}=${v}`).join('\n\t\t')}\n${h.tpl.metadata && h.tpl.metadata.annotations ? `  Annotations:\t${Object.entries(h.tpl.metadata.annotations).map(([k, v]) => `${k}: ${v}`).join('\n\t\t')}\n` : ''}  Containers:\n   ${c.name}:\n    Image:\t${c.image}\n${(c.ports || []).length ? `    Port:\t${c.ports.map(p => p.containerPort + '/TCP').join(', ')}\n` : ''}${c.readinessProbe ? `    Readiness:\thttp-get http://:${c.readinessProbe.httpGet.port}${c.readinessProbe.httpGet.path || '/'} delay=${c.readinessProbe.initialDelaySeconds || 0}s timeout=1s period=10s #success=1 #failure=3\n` : ''}${(c.envFrom || []).length ? `    Environment Variables from:\n${c.envFrom.map(x => x.configMapRef ? `      ${x.configMapRef.name}\tConfigMap\tOptional: false` : `      ${x.secretRef.name}\tSecret\tOptional: false`).join('\n')}\n` : ''}    Environment:${(c.env || []).length ? '\n' + c.env.map(e => `      ${e.name}:\t${e.value !== undefined ? e.value : e.valueFrom.secretKeyRef ? `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>` : `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>`}`).join('\n') : '\t<none>'}`; }
        return `deployment.apps/${dn}\nREVISION  CHANGE-CAUSE\n` + hist.map((h, i) => `${String(i + 1).padEnd(10)}${h.cause || '<none>'}`).join('\n');
      }
      if (verb === 'undo') {
        const ti = a.findIndex(t => t.startsWith('--to-revision')); const to = ti >= 0 ? +(a[ti].includes('=') ? a[ti].split('=')[1] : a[ti + 1]) : hist.length - 1;
        const h = hist[to - 1]; if (!h || to === hist.length) throw CmdError(`error: no rollout history found for deployment "${dn}"`);
        d.spec.template = clone(h.tpl); hist.push({ tpl: clone(h.tpl), cause: h.cause }); CS.settle(st); if (cfg.onUndo) cfg.onUndo(st, d);
        return `deployment.apps/${dn} rolled back`;
      }
      if (verb === 'restart') {
        const t = tplOf(d); t.metadata = t.metadata || {}; t.metadata.annotations = Object.assign({}, t.metadata.annotations, { 'kubectl.kubernetes.io/restartedAt': '2026-11-22T10:' + String(30 + hist.length).padStart(2, '0') + ':00-06:00' });
        hist.push({ tpl: clone(t), cause: '<none>' }); CS.settle(st); return `deployment.apps/${dn} restarted`;
      }
      if (verb === 'pause' || verb === 'resume') return `deployment.apps/${dn} ${verb}d`;
      throw CmdError(`error: unknown command "${verb}" for "kubectl rollout"`);
    }
    function inPod(ns, labels, cmd, who) {
      const st = S(); const c0 = cmd[0];
      if (c0 === 'curl' || c0 === 'wget') {
        const url = cmd.slice(1).find(t => !t.startsWith('-') && !/^\d+$/.test(t) && t !== '-O' && t !== '-');
        if (!url) return { text: c0 === 'curl' ? 'curl: try \'curl --help\' for more information' : 'BusyBox wget: missing URL', cls: 'err' };
        const r = CS.kHttp(st, ns, labels, url);
        if (cfg.onHttp) cfg.onHttp(st, ns, url, r, who);
        if (r.err) return { text: c0 === 'wget' ? r.err.replace(/^curl: \(\d+\) /, 'wget: ') : r.err, cls: 'err' };
        const showHead = cmd.includes('-i') || cmd.includes('-I') || cmd.includes('-v');
        return (showHead ? `HTTP/1.1 ${r.code} ${r.code === 200 ? 'OK' : 'Not Found'}\ncontent-type: application/json\n\n` : '') + r.body;
      }
      if (c0 === 'nslookup' || c0 === 'getent' || c0 === 'dig') {
        const host = cmd[cmd.length - 1]; const parts = host.replace(/\.svc\.cluster\.local$|\.svc$/, '').split('.');
        const svc = CS.kGet(st, 'Service', parts[1] || ns, parts[0]);
        if (!svc) return { text: `** server can't find ${host}.${ns}.svc.cluster.local: NXDOMAIN`, cls: 'err' };
        return `Server:\t\t10.43.0.10\nAddress:\t10.43.0.10:53\n\nName:\t${parts[0]}.${parts[1] || ns}.svc.cluster.local\nAddress: 10.43.${CS.hash(svc.metadata.name, 1).charCodeAt(0) % 200}.${CS.hash(svc.metadata.name + 'x', 1).charCodeAt(0) % 250}`;
      }
      if (c0 === 'env' || c0 === 'printenv') return Object.entries(who && who.ev && who.ev.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
      if (c0 === 'sh' || c0 === 'bash' || c0 === 'ash') return { text: '(Interactive shells aren\'t simulated: pass the command directly, e.g. -- curl -s -m 3 http://SERVICE.NAMESPACE)', cls: 'muted' };
      return { text: `${c0}: not found in this image (available: curl, wget, nslookup, env)`, cls: 'err' };
    }
    function runCmd(a) {
      const st = S(); const di = a.indexOf('--'); const cmd = di >= 0 ? a.slice(di + 1) : []; const opts = di >= 0 ? a.slice(0, di) : a;
      const name = positional(opts)[0]; const imgArg = (opts.find(t => t.startsWith('--image=')) || '').slice(8) || opts[opts.indexOf('--image') + 1];
      const ns = nsOf(opts); ensureNs(ns);
      if (!name) throw CmdError('error: NAME is required for run');
      if (!imgArg || imgArg.startsWith('-')) throw CmdError('error: required flag(s) "image" not set');
      if (!(opts.includes('--rm'))) return { text: `pod/${name} created\n(This lab only keeps throwaway test pods: use --rm -it so it's removed after the command.)`, cls: 'muted' };
      if (!cmd.length) return { text: `If you don't see a command prompt, try pressing enter.\n(Interactive shells aren't simulated: add the command after --, e.g. kubectl run tmp --rm -it --image=curlimages/curl -n ${ns} -- curl -s -m 3 http://SERVICE.NAMESPACE)`, cls: 'muted' };
      if (!/curl|busybox|alpine|netshoot|nicolaka/.test(imgArg)) return { text: `pod "${name}" deleted\n(${imgArg} has no network tools: use --image=curlimages/curl or busybox.)`, cls: 'err' };
      const labelArg = (opts.find(t => t.startsWith('--labels=')) || '').slice(9) || opts[opts.indexOf('--labels') + 1] || '';
      const labels = { run: name }; if (labelArg && !labelArg.startsWith('-')) labelArg.split(',').forEach(p => { const [k, v] = p.split('='); labels[k] = v; });
      const r = inPod(ns, labels, cmd[0] === 'sh' && cmd[1] === '-c' ? cmd[2].split(/\s+/) : cmd, null);
      const tail = `\npod "${name}" deleted`;
      if (r && typeof r === 'object') return { text: r.text + tail, cls: r.cls };
      return r + tail;
    }
    function execCmd(a) {
      const st = S(); const di = a.indexOf('--'); if (di < 0) throw CmdError('error: you must specify at least one command for the container (use -- COMMAND)');
      const opts = a.slice(0, di); const cmd = a.slice(di + 1); const ns = nsOf(opts); ensureNs(ns);
      const target = positional(opts)[0]; if (!target) throw CmdError('error: expected \'exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]\'');
      const p = findPod(ns, target);
      if (!p.ev.ready && p.ev.reason !== 'Running') throw CmdError(`error: unable to upgrade connection: container not found ("${(p.tpl.spec.containers[0] || {}).name}")`);
      return inPod(ns, p.labels, cmd, p);
    }
    function labelCmd(a) {
      const st = S(); const ns = nsOf(a); const pos = positional(a); let [res, name, ...kvs] = pos; if (res && res.includes('/')) { kvs = [name].concat(kvs).filter(Boolean); [res, name] = res.split('/'); }
      const kind = KINDS[(res || '').toLowerCase()]; if (!kind) throw CmdError(`error: the server doesn't have a resource type "${res}"`);
      if (kind === 'Pod') throw CmdError('error: pods in this lab are owned by Deployments: change the labels in the Deployment template (manifest) instead.');
      const o = CS.kGet(st, kind, ns, name); if (!o) throw notFound(kind, name);
      o.metadata.labels = o.metadata.labels || {};
      for (const kv of kvs) {
        if (kv.endsWith('-')) { delete o.metadata.labels[kv.slice(0, -1)]; continue; }
        const [k, v] = kv.split('='); if (v === undefined) throw CmdError(`error: at least one label update is required`);
        if (o.metadata.labels[k] !== undefined && o.metadata.labels[k] !== v && !a.includes('--overwrite')) throw CmdError(`error: '${k}' already has a value (${o.metadata.labels[k]}), and --overwrite is false`);
        o.metadata.labels[k] = v;
      }
      if (cfg.onLabel) cfg.onLabel(st, o);
      return `${(PLURAL[kind] || kind.toLowerCase()).split('.')[0]}/${name} labeled`;
    }
    function createCmd(a) {
      const st = S(); const pos = positional(a); const ns = nsOf(a);
      if (pos[0] === 'secret' && pos[1] === 'generic') {
        const name = pos[2]; if (!name) throw CmdError('error: exactly one NAME is required, got 0'); ensureNs(ns);
        if (CS.kGet(st, 'Secret', ns, name)) throw CmdError(`error: failed to create secret secrets "${name}" already exists`);
        const data = {}; a.filter(t => t.startsWith('--from-literal=')).forEach(t => { const kv = t.slice(15); const i = kv.indexOf('='); data[kv.slice(0, i)] = btoa(kv.slice(i + 1).replace(/^['"]|['"]$/g, '')); });
        a.forEach((t, i) => { if (t === '--from-literal') { const kv = a[i + 1]; const j = kv.indexOf('='); data[kv.slice(0, j)] = btoa(kv.slice(j + 1)); } });
        st.k8s.objs.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: ns, age: '0s' }, type: 'Opaque', data }); CS.settle(st); if (cfg.onApply) cfg.onApply(st, []);
        return `secret/${name} created`;
      }
      if (pos[0] === 'namespace' || pos[0] === 'ns') { st.k8s.objs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: pos[1], age: '0s' } }); return `namespace/${pos[1]} created`; }
      throw CmdError('This lab supports: kubectl create secret generic NAME -n NS --from-literal=KEY=VALUE');
    }
    const spec = {
      raw: true, desc: 'Kubernetes CLI: get, describe, logs, apply -f, delete, rollout, run, exec, label, create secret, config', run: a0 => {
        const toks = a0._pos.slice(); const sub = toks.shift(); const st = S();
        if (st.flags) st.flags['k_' + sub] = true;
        const r = (() => {
          switch (sub) {
            case undefined: case 'help': case '--help': return 'kubectl controls the Kubernetes cluster manager.\n\nBasic Commands:\n  get          Display one or many resources\n  describe     Show details of a specific resource\n  logs         Print the logs for a container in a pod (--previous for the last crash)\n  apply        Apply a configuration to a resource by file name (-f)\n  delete       Delete resources\n  rollout      Manage the rollout of a resource (status, history, undo, restart)\n  run          Run a throwaway pod (--rm -it --image=... -- CMD)\n  exec         Execute a command in a container\n  label        Update the labels on a resource\n  create       Create a secret (create secret generic)\n  config       current-context, get-contexts';
            case 'version': return 'Client Version: v1.31.2\nKustomize Version: v5.4.2\nServer Version: v1.31.2';
            case 'config': if (toks[0] === 'current-context') return st.k8s.ctx; if (toks[0] === 'get-contexts') return CS.table(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], [['*', st.k8s.ctx, st.k8s.ctx, 'ruben', st.k8s.ns]]); if (toks[0] === 'set-context') { const nsT = toks.find(t => t.startsWith('--namespace=')); if (nsT) { st.k8s.ns = nsT.split('=')[1]; return `Context "${st.k8s.ctx}" modified.`; } } throw CmdError('This lab supports: kubectl config current-context | get-contexts | set-context --current --namespace=NS');
            case 'cluster-info': return `Kubernetes control plane is running at https://10.0.0.5:6443\nCoreDNS is running at https://10.0.0.5:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy`;
            case 'get': return getCmd(toks);
            case 'describe': return describe(toks);
            case 'logs': return logsCmd(toks);
            case 'apply': return applyCmd(toks);
            case 'delete': return deleteCmd(toks);
            case 'rollout': return rolloutCmd(toks);
            case 'run': return runCmd(toks);
            case 'exec': return execCmd(toks);
            case 'label': return labelCmd(toks);
            case 'create': return createCmd(toks);
            case 'edit': case 'patch': case 'set': case 'scale': return { text: `This team changes the cluster only through the manifests in ~/k8s (they're in git): edit the file with nano, then kubectl apply -f.`, cls: 'warn' };
            case 'api-resources': return CS.table(['NAME', 'SHORTNAMES', 'KIND'], [['configmaps', 'cm', 'ConfigMap'], ['endpoints', 'ep', 'Endpoints'], ['events', 'ev', 'Event'], ['namespaces', 'ns', 'Namespace'], ['pods', 'po', 'Pod'], ['secrets', '', 'Secret'], ['services', 'svc', 'Service'], ['deployments', 'deploy', 'Deployment'], ['replicasets', 'rs', 'ReplicaSet'], ['networkpolicies', 'netpol', 'NetworkPolicy']]);
          }
          throw CmdError(`error: unknown command "${sub}" for "kubectl"\nRun 'kubectl --help' for usage.`);
        })();
        if (lab.refresh) setTimeout(() => lab.refresh && lab.refresh(), 0);
        return r;
      }
    };
    return { kubectl: spec, k: Object.assign({}, spec, { desc: 'Alias for kubectl' }) };
  };

  // ======================================================================= side panels
  const esc = s => global.Lab.util.esc(String(s));
  CS.dockerPanel = st => {
    const cs = st.dk.containers; const ims = st.dk.images;
    const dot = c => c.status === 'running' ? (c.health === 'unhealthy' || c.health === 'starting' ? 'warn' : 'ok') : c.status === 'restarting' ? 'bad' : 'off';
    return `<table class="brief"><tr><th>Container</th><th>Image</th><th>Status</th></tr>${cs.length ? cs.map(c => `<tr><td><span class="cs-dot ${dot(c)}"></span>${esc(c.name)}</td><td>${esc(c.image)}</td><td>${esc(CS.statusText(c))}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">No containers</td></tr>'}</table>
      <table class="brief" style="margin-top:12px"><tr><th>Image</th><th>Size</th></tr>${ims.map(i => `<tr><td>${esc(i.repo + ':' + i.tag)}</td><td>${CS.mb(i.size)}</td></tr>`).join('')}</table>`;
  };
  CS.k8sPanel = (st, ns, svcName) => {
    const svc = CS.kGet(st, 'Service', ns, svcName);
    const pods = CS.pods(st).filter(p => p.ns === ns);
    const eps = svc ? CS.endpoints(st, svc) : [];
    const sel = svc ? Object.entries(svc.spec.selector || {}).map(([k, v]) => `${k}=${v}`).join(',') : '';
    const pst = p => p.ev.ready ? 'ok' : p.ev.reason === 'Running' ? 'warn' : 'bad';
    return `<div class="k8s-flow">
      ${svc ? `<div class="k8s-box ${eps.length ? 'ok' : 'bad'}"><b>svc/${esc(svcName)}</b><span>selector: ${esc(sel || '<none>')}</span><span>port ${esc((svc.spec.ports || [{}])[0].port)} → ${esc((svc.spec.ports || [{}])[0].targetPort === undefined ? (svc.spec.ports || [{}])[0].port : svc.spec.ports[0].targetPort)}</span></div>
      <div class="k8s-arrow ${eps.length ? '' : 'bad'}">↓ endpoints: ${eps.length ? eps.map(e => esc(e.ip + ':' + e.port)).join(', ') : '&lt;none&gt;'}</div>` : ''}
      <div class="k8s-pods">${pods.map(p => `<div class="k8s-pod ${pst(p)}" title="${esc(Object.entries(p.labels).map(([k, v]) => k + '=' + v).join(', '))}"><b>${esc(p.name.replace(p.deploy + '-', ''))}</b><span>${esc(p.deploy)}</span><span>${esc(p.ev.ready ? 'Ready' : p.ev.reason === 'Running' ? 'Not ready' : p.ev.reason)}</span></div>`).join('') || '<span class="muted">No pods</span>'}</div>
    </div>`;
  };

  global.ContainerSim = CS;
})(window);
