/* Shared Google Cloud simulation helpers: resource URLs, errors, firewall rules. Requires lab.js. */
(function (global) {
  'use strict';
  const { CmdError, net } = global.Lab;
  const { renderTable, toYaml } = global.Lab.util;

  const G = {};
  G.url = (project, path) => `https://www.googleapis.com/compute/v1/projects/${project}/${path}`;
  G.label = cmd => '(' + cmd.split(' ').join('.') + ')';
  G.notFound = (cmd, project, path) => CmdError(`ERROR: ${G.label(cmd)} Could not fetch resource:\n - The resource 'projects/${project}/${path}' was not found`);
  G.exists = (cmd, project, path) => CmdError(`ERROR: ${G.label(cmd)} Could not fetch resource:\n - The resource 'projects/${project}/${path}' already exists`);
  G.invalid = (cmd, msg) => CmdError(`ERROR: ${G.label(cmd)} ${msg}`);
  G.ts = () => '2026-11-20T09:' + String(10 + Math.floor(Math.random() * 49)).padStart(2, '0') + ':00.000-08:00';
  G.wantsYaml = a => a._g && typeof a._g.format === 'string' && /yaml|json/i.test(a._g.format);
  G.table = (rows, extra) => ({ text: renderTable(rows, null, null, 'gcloud') + (extra ? '\n' + extra : '') });
  G.yaml = obj => ({ text: toYaml(obj) });
  G.randIp = (prefix) => prefix + (2 + Math.floor(Math.random() * 250));

  // ---------- firewall rules
  const PROTOS = ['tcp', 'udp', 'icmp', 'esp', 'ah', 'sctp', 'ipip', 'all'];
  G.parseRules = (str, cmd, flag) => {
    const out = [];
    String(str).split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
      const [proto, ports] = part.toLowerCase().split(':');
      if (!PROTOS.includes(proto) && !/^\d+$/.test(proto)) throw G.invalid(cmd, `Invalid value for [${flag}]: '${part}' — protocol must be one of tcp, udp, icmp, esp, ah, sctp, ipip, all.`);
      if (proto === 'all') { if (ports) throw G.invalid(cmd, `Invalid value for [${flag}]: ports can't be specified for 'all'.`); out.push({ proto: 'all', ports: null }); return; }
      if (!ports) { out.push({ proto, ports: null }); return; }
      if (!['tcp', 'udp', 'sctp'].includes(proto)) throw G.invalid(cmd, `Invalid value for [${flag}]: ports are only valid for tcp, udp and sctp.`);
      const m = ports.match(/^(\d+)(?:-(\d+))?$/);
      if (!m || +m[1] < 1 || +(m[2] || m[1]) > 65535 || +(m[2] || m[1]) < +m[1]) throw G.invalid(cmd, `Invalid value for [${flag}]: '${part}' — invalid port or port range.`);
      const existing = out.find(r => r.proto === proto && r.ports);
      const range = [+m[1], +(m[2] || m[1])];
      if (existing) existing.ports.push(range); else out.push({ proto, ports: [range] });
    });
    if (!out.length) throw G.invalid(cmd, `Invalid value for [${flag}]: at least one protocol is required.`);
    return out;
  };
  G.rulesStr = rules => rules.map(r => r.proto + (r.ports ? ':' + r.ports.map(([a, b]) => (a === b ? a : a + '-' + b)).join(',') : '')).join(',');
  G.ruleMatches = (rules, proto, port) => rules.some(r => r.proto === 'all' || (r.proto === proto && (!r.ports || port === undefined || r.ports.some(([a, b]) => port >= a && port <= b))));
  G.onlyPort = (rules, proto, port) => rules.length > 0 && rules.every(r => r.proto === proto && r.ports && r.ports.every(([a, b]) => a === port && b === port));

  /**
   * Evaluate ingress firewall rules for a packet arriving at an instance.
   * Lower priority number wins; at equal priority DENY beats ALLOW; implied deny-all ingress last.
   */
  G.evalIngress = (firewalls, p) => {
    const cands = firewalls.filter(f =>
      f.network === p.network && f.direction === 'INGRESS' && !f.disabled &&
      (!f.targetTags.length || f.targetTags.some(t => (p.tags || []).includes(t))) &&
      (f.sourceRanges.some(r => net.contains(r, p.srcIp)) ||
        (p.srcNetwork === p.network && (f.sourceTags || []).some(t => (p.srcTags || []).includes(t)))) &&
      G.ruleMatches(f.rules, p.proto, p.port));
    cands.sort((a, b) => a.priority - b.priority || (a.action === 'DENY' ? -1 : 1) - (b.action === 'DENY' ? -1 : 1));
    const rule = cands[0] || null;
    return { allowed: !!rule && rule.action === 'ALLOW', rule };
  };

  G.fwRow = f => ({
    NAME: f.name, NETWORK: f.network, DIRECTION: f.direction, PRIORITY: String(f.priority),
    ALLOW: f.action === 'ALLOW' ? G.rulesStr(f.rules) : '', DENY: f.action === 'DENY' ? G.rulesStr(f.rules) : '',
    DISABLED: f.disabled ? 'True' : 'False'
  });
  G.fwYaml = (project, f) => {
    const key = f.action === 'ALLOW' ? 'allowed' : 'denied';
    const o = {};
    o[key] = f.rules.map(r => (r.ports ? { IPProtocol: r.proto, ports: r.ports.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)) } : { IPProtocol: r.proto }));
    Object.assign(o, {
      creationTimestamp: f.created || '2026-11-19T14:02:11.000-08:00', description: f.description || '',
      direction: f.direction, disabled: !!f.disabled, kind: 'compute#firewall', logConfig: { enable: !!f.logging },
      name: f.name, network: G.url(project, 'global/networks/' + f.network), priority: f.priority,
      selfLink: G.url(project, 'global/firewalls/' + f.name)
    });
    if (f.sourceRanges.length) o.sourceRanges = f.sourceRanges;
    if ((f.sourceTags || []).length) o.sourceTags = f.sourceTags;
    if (f.targetTags.length) o.targetTags = f.targetTags;
    return toYaml(o);
  };

  /** Firewall command specs. opts: { project: () => string, state: () => state } (state.firewalls, state.networks). */
  G.firewallCommands = opts => {
    const P = () => opts.project();
    const S = () => opts.state();
    const find = name => S().firewalls.find(f => f.name === name);
    const cidrList = (list, cmd, flag) => { list.forEach(c => { if (!net.parseCidr(c)) throw G.invalid(cmd, `Invalid value for [${flag}]: '${c}' is not a valid IP range.`); }); return list.map(c => (c.includes('/') ? c : c + '/32')); };
    return {
      'gcloud compute firewall-rules list': {
        desc: 'List VPC firewall rules',
        params: { filter: { desc: 'Ignored in this simulation — all rules are shown' }, 'sort-by': { desc: 'Ignored' } },
        run: a => {
          const rows = S().firewalls.slice().sort((x, y) => x.network.localeCompare(y.network) || x.priority - y.priority);
          if (G.wantsYaml(a)) return { text: rows.map(f => G.fwYaml(P(), f)).join('\n---\n') };
          if (!rows.length) return { text: 'Listed 0 items.' };
          return G.table(rows.map(G.fwRow), '\nTo show all fields of the firewall, please show in JSON format: --format=json\nTo show all fields in table format, please see the examples in --help.');
        }
      },
      'gcloud compute firewall-rules describe': {
        desc: 'Show every field of one firewall rule',
        positional: ['NAME'], params: { NAME: { posOnly: true, required: true } },
        run: a => { const f = find(a.NAME); if (!f) throw G.notFound('gcloud compute firewall-rules describe', P(), 'global/firewalls/' + a.NAME); return { text: G.fwYaml(P(), f) }; }
      },
      'gcloud compute firewall-rules create': {
        desc: 'Create a VPC firewall rule',
        positional: ['NAME'],
        params: {
          NAME: { posOnly: true, required: true },
          network: { desc: 'VPC network (default: "default")' },
          direction: { type: 'enum', values: ['INGRESS', 'EGRESS', 'IN', 'OUT'], desc: 'Default INGRESS' },
          action: { type: 'enum', values: ['ALLOW', 'DENY'], desc: 'Use with --rules' },
          rules: { desc: 'e.g. tcp:443 or tcp:80,tcp:443 or all' },
          allow: { desc: 'Legacy form: --allow=tcp:443 (implies --action=ALLOW)' },
          'source-ranges': { type: 'list', desc: 'Ingress sources (CIDRs). Defaults to 0.0.0.0/0 when no sources are given' },
          'source-tags': { type: 'list' },
          'target-tags': { type: 'list', desc: 'Apply only to instances with these network tags' },
          'destination-ranges': { type: 'list' },
          priority: { type: 'int', desc: '0–65535, lower wins. Default 1000' },
          description: {}, disabled: { type: 'switch' }, 'enable-logging': { type: 'switch' }
        },
        run: a => {
          const cmd = 'gcloud compute firewall-rules create';
          if (find(a.NAME)) throw G.exists(cmd, P(), 'global/firewalls/' + a.NAME);
          if (!/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(a.NAME)) throw G.invalid(cmd, `Invalid value for field 'resource.name': '${a.NAME}'. Must be a match of regex '(?:[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?)'`);
          const network = a.network || 'default';
          if (!S().networks.some(n => n.name === network)) throw G.notFound(cmd, P(), 'global/networks/' + network);
          if (a.allow && a.action) throw G.invalid(cmd, 'argument --allow: At most one of --action | --allow may be specified.');
          if (!a.allow && !a.action) throw G.invalid(cmd, 'Exactly one of (--action | --allow) must be specified.');
          if (a.action && !a.rules) throw G.invalid(cmd, 'argument --rules: Must be specified.');
          const action = a.allow ? 'ALLOW' : a.action;
          const rules = G.parseRules(a.allow || a.rules, cmd, a.allow ? '--allow' : '--rules');
          const dir = { IN: 'INGRESS', OUT: 'EGRESS' }[a.direction] || a.direction || 'INGRESS';
          let src = a['source-ranges'] ? cidrList(a['source-ranges'], cmd, '--source-ranges') : [];
          if (dir === 'INGRESS' && !src.length && !(a['source-tags'] || []).length) src = ['0.0.0.0/0'];
          const pr = a.priority === undefined ? 1000 : a.priority;
          if (pr < 0 || pr > 65535) throw G.invalid(cmd, `Invalid value for field 'resource.priority': '${pr}'. Must be between 0 and 65535.`);
          const f = { name: a.NAME, network, direction: dir, action, rules, sourceRanges: dir === 'INGRESS' ? src : [], sourceTags: a['source-tags'] || [], targetTags: a['target-tags'] || [], destinationRanges: a['destination-ranges'] || [], priority: pr, disabled: !!a.disabled, description: a.description || '', logging: !!a['enable-logging'], created: G.ts() };
          S().firewalls.push(f);
          return { pre: `Creating firewall...⠼Created [${G.url(P(), 'global/firewalls/' + f.name)}].\nCreating firewall...done.`, objects: [G.fwRow(f)], style: 'gcloud' };
        }
      },
      'gcloud compute firewall-rules update': {
        desc: 'Change an existing firewall rule',
        positional: ['NAME'],
        params: {
          NAME: { posOnly: true, required: true }, rules: {}, allow: {}, 'source-ranges': { type: 'list' }, 'source-tags': { type: 'list' },
          'target-tags': { type: 'list' }, 'destination-ranges': { type: 'list' }, priority: { type: 'int' }, description: {},
          disabled: { type: 'switch', desc: 'Use --no-disabled to enable' }, 'enable-logging': { type: 'switch' }
        },
        run: a => {
          const cmd = 'gcloud compute firewall-rules update';
          const f = find(a.NAME); if (!f) throw G.notFound(cmd, P(), 'global/firewalls/' + a.NAME);
          const keys = ['rules', 'allow', 'source-ranges', 'source-tags', 'target-tags', 'destination-ranges', 'priority', 'description', 'disabled', 'enable-logging'];
          if (!keys.some(k => a[k] !== undefined)) throw G.invalid(cmd, 'At least one property must be modified.');
          if (a.rules) f.rules = G.parseRules(a.rules, cmd, '--rules');
          if (a.allow) { if (f.action !== 'ALLOW') throw G.invalid(cmd, '--allow can only be used with ALLOW rules; use --rules.'); f.rules = G.parseRules(a.allow, cmd, '--allow'); }
          if (a['source-ranges']) f.sourceRanges = cidrList(a['source-ranges'], cmd, '--source-ranges');
          if (a['source-tags']) f.sourceTags = a['source-tags'];
          if (a['target-tags']) f.targetTags = a['target-tags'];
          if (a['destination-ranges']) f.destinationRanges = a['destination-ranges'];
          if (a.priority !== undefined) { if (a.priority < 0 || a.priority > 65535) throw G.invalid(cmd, `Invalid value for field 'resource.priority': '${a.priority}'.`); f.priority = a.priority; }
          if (a.description !== undefined) f.description = a.description;
          if (a.disabled !== undefined) f.disabled = a.disabled;
          if (a['enable-logging'] !== undefined) f.logging = a['enable-logging'];
          return { text: `Updating firewall...⠼Updated [${G.url(P(), 'global/firewalls/' + f.name)}].\nUpdating firewall...done.` };
        }
      },
      'gcloud compute firewall-rules delete': {
        desc: 'Delete firewall rules',
        positional: ['NAME'], maxPositional: 10, params: { NAME: { posOnly: true, required: true } },
        run: a => {
          const cmd = 'gcloud compute firewall-rules delete';
          const names = a._pos;
          names.forEach(n => { if (!find(n)) throw G.notFound(cmd, P(), 'global/firewalls/' + n); });
          const confirm = a._g.quiet || a._g.q ? '' : `The following firewalls will be deleted:\n${names.map(n => ' - [' + n + ']').join('\n')}\n\nDo you want to continue (Y/n)?  Y   (auto-confirmed in this simulation)\n\n`;
          S().firewalls = S().firewalls.filter(f => !names.includes(f.name));
          return { text: confirm + names.map(n => `Deleted [${G.url(P(), 'global/firewalls/' + n)}].`).join('\n') };
        }
      }
    };
  };

  global.GcpSim = G;
})(window);
