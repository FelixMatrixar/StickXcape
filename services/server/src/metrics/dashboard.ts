/** The monitoring dashboard: one page that polls /admin/stats.json every 5 seconds. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SticXcape services</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f2; --card: #ffffff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e2e0da; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161614; --card: #22221f; --ink: #ecebe6; --muted: #a09f98; --line: #34342f; --bad: #ff6b5b; } }
  body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 16px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 24px 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .tile b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
  .tile span { color: var(--muted); font-size: 13px; }
  .bad b { color: var(--bad); }
  #alert { display: none; background: var(--bad); color: #fff; border-radius: 10px; padding: 10px 14px; }
</style>
</head>
<body>
<main>
  <h1>SticXcape services</h1>
  <p class="sub" id="sub">Loading…</p>
  <div id="alert" role="alert"></div>
  <h2>Matches</h2><div class="grid" id="matches"></div>
  <h2>Rooms and relay</h2><div class="grid" id="relay"></div>
  <h2>Meta AI</h2><div class="grid" id="ai"></div>
</main>
<script>
  const pct = (v) => (v == null ? '–' : (v * 100).toFixed(1) + '%');
  const ms = (v) => (v == null ? '–' : Math.round(v) + ' ms');
  const tile = (label, value, bad) => '<div class="tile' + (bad ? ' bad' : '') + '"><b>' + value + '</b><span>' + label + '</span></div>';
  async function refresh() {
    try {
      const res = await fetch('/admin/stats.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const s = await res.json();
      const m = s.matches, r = s.relay, a = s.ai, al = a.alert;
      document.getElementById('sub').textContent = 'Version ' + s.serverVersion + ' · up ' + Math.round(s.uptimeSeconds / 60) + ' min · AI ' + a.mode + ' · updated ' + new Date().toLocaleTimeString();
      document.getElementById('matches').innerHTML =
        tile('started', m.started) + tile('finished', m.finished) + tile('finish rate', pct(m.finishRate)) +
        tile('desyncs', m.desyncs, m.desyncs > 0) + tile('desync rate', pct(m.desyncRate), m.desyncRate > 0) +
        tile('disconnects', m.disconnects) + tile('playing now', m.active);
      document.getElementById('relay').innerHTML =
        tile('rooms open', s.rooms.active) + tile('rooms created', s.rooms.created) + tile('phones connected', s.players) +
        tile('round trip p50', ms(r.rttMs.p50)) + tile('round trip p95', ms(r.rttMs.p95)) +
        tile('relay hold p99', r.forwardMs.p99 == null ? '–' : r.forwardMs.p99.toFixed(2) + ' ms') + tile('dropped messages', r.dropped);
      document.getElementById('ai').innerHTML =
        tile('error rate, last 15 min', pct(al.ratio), al.firing) +
        tile('names ok / failed', a.moveName.ok + ' / ' + a.moveName.errors, a.moveName.errors > 0) +
        tile('name time p50 / p95', ms(a.moveName.p50Ms) + ' / ' + ms(a.moveName.p95Ms)) +
        tile('tips ok / failed', a.matchTips.ok + ' / ' + a.matchTips.errors, a.matchTips.errors > 0) +
        tile('tips time p50 / p95', ms(a.matchTips.p50Ms) + ' / ' + ms(a.matchTips.p95Ms)) +
        tile('cache hits', a.moveName.cacheHits + a.matchTips.cacheHits) +
        tile('over daily limit', a.moveName.rateLimited + a.matchTips.rateLimited);
      const alert = document.getElementById('alert');
      alert.style.display = al.firing ? 'block' : 'none';
      alert.textContent = 'AI errors are at ' + pct(al.ratio) + ' (' + al.errors + ' of ' + al.calls + ' calls), above the ' + pct(al.threshold) + ' alert line.';
    } catch (err) {
      document.getElementById('sub').textContent = 'Could not load stats: ' + err.message;
    }
  }
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>
`;
