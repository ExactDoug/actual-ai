import { ClassificationRecord, ClassificationFilter, RunSummary, DashboardStats } from '../classification-store';

function layout(title: string, content: string, activeNav: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - actual-ai</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1b1d2a; color: #e0e0e0; }
    a { color: #8b7cf6; text-decoration: none; }
    a:hover { text-decoration: underline; }

    nav { background: #252839; padding: 0.8rem 1.5rem; display: flex; align-items: center; gap: 2rem; border-bottom: 1px solid #3a3d52; }
    nav .brand { font-weight: 700; font-size: 1.1rem; color: #8b7cf6; }
    nav a { color: #999; font-size: 0.9rem; padding: 0.3rem 0; }
    nav a.active { color: #e0e0e0; border-bottom: 2px solid #8b7cf6; }
    nav .spacer { flex: 1; }
    nav .logout { color: #777; font-size: 0.85rem; }

    .container { max-width: 1400px; margin: 0 auto; padding: 1.5rem; }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { background: #252839; padding: 1.2rem; border-radius: 8px; }
    .stat-card .label { font-size: 0.8rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-card .value { font-size: 1.8rem; font-weight: 700; margin-top: 0.3rem; }
    .stat-card .value.pending { color: #fbbf24; }
    .stat-card .value.approved { color: #34d399; }
    .stat-card .value.applied { color: #60a5fa; }
    .stat-card .value.rejected { color: #f87171; }

    .card { background: #252839; border-radius: 8px; padding: 1.2rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 1rem; margin-bottom: 1rem; color: #ccc; }

    .filters { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-end; margin-bottom: 1rem; }
    .filters label { font-size: 0.75rem; color: #888; display: block; margin-bottom: 0.2rem; }
    .filters select, .filters input { padding: 0.4rem 0.5rem; border: 1px solid #3a3d52; border-radius: 4px; background: #1b1d2a; color: #e0e0e0; font-size: 0.85rem; }
    .filters button { padding: 0.4rem 0.8rem; background: #8b7cf6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
    .filters button:hover { background: #7a6be0; }

    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 0.6rem 0.5rem; border-bottom: 2px solid #3a3d52; color: #888; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; user-select: none; }
    th:hover { color: #ccc; }
    td { padding: 0.5rem; border-bottom: 1px solid #2a2d40; }
    tr:hover { background: #2a2d40; }

    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
    .badge.pending { background: #78350f; color: #fbbf24; }
    .badge.approved { background: #064e3b; color: #34d399; }
    .badge.applied { background: #1e3a5f; color: #60a5fa; }
    .badge.rejected { background: #7f1d1d; color: #f87171; }
    .badge.existing { background: #1e3a5f; color: #60a5fa; }
    .badge.rule { background: #3b0764; color: #c084fc; }
    .badge.new { background: #064e3b; color: #34d399; }

    .amount { font-family: 'SF Mono', 'Fira Code', monospace; }
    .amount.positive { color: #34d399; }
    .amount.negative { color: #f87171; }

    .btn { display: inline-block; padding: 0.3rem 0.6rem; border-radius: 4px; border: none; cursor: pointer; font-size: 0.8rem; font-weight: 500; }
    .btn-approve { background: #064e3b; color: #34d399; }
    .btn-approve:hover { background: #065f46; }
    .btn-reject { background: #7f1d1d; color: #f87171; }
    .btn-reject:hover { background: #991b1b; }
    .btn-apply { background: #1e3a5f; color: #60a5fa; }
    .btn-apply:hover { background: #1e4976; }
    .btn-primary { background: #8b7cf6; color: white; }
    .btn-primary:hover { background: #7a6be0; }

    .actions-bar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; padding: 0.8rem; background: #2a2d40; border-radius: 6px; }
    .actions-bar .selected-count { font-size: 0.85rem; color: #888; margin-right: auto; }

    .pagination { display: flex; gap: 0.5rem; justify-content: center; margin-top: 1rem; align-items: center; }
    .pagination a, .pagination span { padding: 0.3rem 0.6rem; border-radius: 4px; font-size: 0.85rem; }
    .pagination span.current { background: #8b7cf6; color: white; }

    input[type="checkbox"] { accent-color: #8b7cf6; }

    .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; background: #252839; border: 1px solid #3a3d52; padding: 0.8rem 1.2rem; border-radius: 6px; font-size: 0.85rem; display: none; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .toast.success { border-color: #34d399; }
    .toast.error { border-color: #f87171; }
  </style>
</head>
<body>
  <nav>
    <span class="brand">actual-ai</span>
    <a href="/" class="${activeNav === 'dashboard' ? 'active' : ''}">Dashboard</a>
    <a href="/classifications" class="${activeNav === 'classifications' ? 'active' : ''}">Classifications</a>
    <a href="/history" class="${activeNav === 'history' ? 'active' : ''}">History</a>
    <span style="color:#3a3d52;">|</span>
    <a href="/receipts/dashboard">Receipts</a>
    <a href="/receipts">Queue</a>
    <span class="spacer"></span>
    <a href="/logout" class="logout">Logout</a>
  </nav>
  <div class="container">
    ${content}
  </div>
  <div class="toast" id="toast"></div>
</body>
</html>`;
}

export function renderDashboard(stats: DashboardStats, runs: RunSummary[]): string {
  const content = `
    <h1 style="font-size: 1.3rem; margin-bottom: 1.5rem;">Dashboard</h1>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Pending Review</div>
        <div class="value pending">${stats.totalPending ?? 0}</div>
      </div>
      <div class="stat-card">
        <div class="label">Approved</div>
        <div class="value approved">${stats.totalApproved ?? 0}</div>
      </div>
      <div class="stat-card">
        <div class="label">Applied</div>
        <div class="value applied">${stats.totalApplied ?? 0}</div>
      </div>
      <div class="stat-card">
        <div class="label">Rejected</div>
        <div class="value rejected">${stats.totalRejected ?? 0}</div>
      </div>
    </div>

    ${(stats.totalApproved ?? 0) > 0 ? `
    <div class="card">
      <button class="btn btn-apply" onclick="applyAll()">Apply All Approved (${stats.totalApproved})</button>
    </div>` : ''}

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h2>Recent Runs</h2>
        <button class="btn btn-primary" onclick="triggerClassify()">Run Classification Now</button>
      </div>
      ${runs.length === 0 ? '<p style="color: #666; margin-top: 0.5rem;">No classification runs yet.</p>' : `
      <table>
        <thead><tr>
          <th>Run Time</th><th>Total</th><th>Pending</th><th>Approved</th><th>Rejected</th><th>Applied</th>
        </tr></thead>
        <tbody>
          ${runs.map((r) => `<tr>
            <td><a href="/classifications?runId=${r.runId}">${formatDate(r.classifiedAt)}</a></td>
            <td>${r.total}</td>
            <td>${r.pending}</td>
            <td>${r.approved}</td>
            <td>${r.rejected}</td>
            <td>${r.applied}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>

    ${stats.lastRunAt ? `<p style="font-size: 0.8rem; color: #666;">Last run: ${formatDate(stats.lastRunAt)}</p>` : ''}

    <script>
      async function applyAll() {
        if (!confirm('Apply all approved classifications to Actual Budget?')) return;
        const res = await fetch('/api/classifications/apply', { method: 'POST' });
        const data = await res.json();
        showToast(res.ok ? 'success' : 'error', res.ok ? 'Applied ' + data.applied + ' classifications' : data.error);
        if (res.ok) setTimeout(() => location.reload(), 1000);
      }
      async function triggerClassify() {
        const res = await fetch('/api/classify', { method: 'POST' });
        const data = await res.json();
        showToast(res.ok ? 'success' : 'error', data.message || data.error);
      }
      function showToast(type, msg) {
        const t = document.getElementById('toast');
        t.className = 'toast ' + type;
        t.textContent = msg;
        t.style.display = 'block';
        setTimeout(() => { t.style.display = 'none'; }, 3000);
      }
    </script>
  `;
  return layout('Dashboard', content, 'dashboard');
}

export function renderClassifications(
  rows: ClassificationRecord[],
  total: number,
  filter: ClassificationFilter,
  accounts: string[],
  categoryGroups: string[],
): string {
  const page = filter.page ?? 1;
  const limit = filter.limit ?? 50;
  const totalPages = Math.ceil(total / limit);

  const qs = (overrides: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { ...filter, ...overrides };
    for (const [k, v] of Object.entries(merged)) {
      if (v != null && v !== '' && k !== 'page') p.set(k, String(v));
    }
    if (overrides.page && overrides.page !== 1) p.set('page', String(overrides.page));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  const content = `
    <h1 style="font-size: 1.3rem; margin-bottom: 1rem;">Classifications</h1>

    <form class="filters" method="GET" action="/classifications">
      <div>
        <label>Status</label>
        <select name="status">
          <option value="">All</option>
          ${['pending', 'approved', 'rejected', 'applied'].map((s) => `<option value="${s}" ${filter.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Account</label>
        <select name="accountName">
          <option value="">All</option>
          ${accounts.map((a) => `<option value="${esc(a)}" ${filter.accountName === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Category Group</label>
        <select name="categoryGroup">
          <option value="">All</option>
          ${categoryGroups.map((g) => `<option value="${esc(g)}" ${filter.suggestedCategoryGroup === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Type</label>
        <select name="type">
          <option value="">All</option>
          ${['existing', 'new', 'rule'].map((t) => `<option value="${t}" ${filter.classificationType === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Payee</label>
        <input type="text" name="payee" value="${esc(filter.payeeSearch ?? '')}" placeholder="Search...">
      </div>
      <div>
        <label>Date From</label>
        <input type="date" name="dateFrom" value="${filter.dateFrom ?? ''}">
      </div>
      <div>
        <label>Date To</label>
        <input type="date" name="dateTo" value="${filter.dateTo ?? ''}">
      </div>
      ${filter.runId ? `<input type="hidden" name="runId" value="${esc(filter.runId)}">` : ''}
      <button type="submit">Filter</button>
      <a href="/classifications" style="font-size: 0.85rem; padding: 0.4rem;">Clear</a>
    </form>

    <div class="actions-bar">
      <span class="selected-count"><span id="selectedCount">0</span> selected of ${total} total</span>
      <button class="btn btn-approve" onclick="batchAction('approved')">Approve Selected</button>
      <button class="btn btn-reject" onclick="batchAction('rejected')">Reject Selected</button>
      <button class="btn btn-approve" onclick="batchFilterAction('approved')">Approve All Filtered</button>
      <button class="btn btn-reject" onclick="batchFilterAction('rejected')">Reject All Filtered</button>
    </div>

    <div class="card" style="padding: 0; overflow-x: auto;">
      <table>
        <thead><tr>
          <th style="width: 30px;"><input type="checkbox" id="selectAll" onchange="toggleAll(this)"></th>
          <th><a href="/classifications${qs({ sortBy: 'date', sortDir: filter.sortBy === 'date' && filter.sortDir === 'desc' ? 'asc' : 'desc' })}">Date</a></th>
          <th><a href="/classifications${qs({ sortBy: 'payee', sortDir: filter.sortBy === 'payee' && filter.sortDir === 'asc' ? 'desc' : 'asc' })}">Payee</a></th>
          <th><a href="/classifications${qs({ sortBy: 'amount', sortDir: filter.sortBy === 'amount' && filter.sortDir === 'desc' ? 'asc' : 'desc' })}">Amount</a></th>
          <th><a href="/classifications${qs({ sortBy: 'accountName', sortDir: filter.sortBy === 'accountName' && filter.sortDir === 'asc' ? 'desc' : 'asc' })}">Account</a></th>
          <th><a href="/classifications${qs({ sortBy: 'suggestedCategoryName', sortDir: filter.sortBy === 'suggestedCategoryName' && filter.sortDir === 'asc' ? 'desc' : 'asc' })}">Category</a></th>
          <th>Type</th>
          <th><a href="/classifications${qs({ sortBy: 'status', sortDir: filter.sortBy === 'status' && filter.sortDir === 'asc' ? 'desc' : 'asc' })}">Status</a></th>
          <th>Actions</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `<tr data-id="${r.id}">
            <td><input type="checkbox" class="row-check" value="${r.id}" onchange="updateCount()"></td>
            <td>${r.date || ''}</td>
            <td title="${esc(r.importedPayee || '')}">${esc(truncate(r.payee || r.importedPayee || '', 40))}</td>
            <td class="amount ${r.amount >= 0 ? 'positive' : 'negative'}">${formatAmount(r.amount)}</td>
            <td>${esc(r.accountName || '')}</td>
            <td><span title="${esc(r.suggestedCategoryGroup || '')}">${esc(r.suggestedCategoryName || r.newCategoryName || '')}</span></td>
            <td><span class="badge ${r.classificationType}">${r.classificationType}</span></td>
            <td><span class="badge ${r.status}">${r.status}</span></td>
            <td>
              ${r.status !== 'applied' ? `
                <button class="btn btn-approve" onclick="setStatus('${r.id}','approved')">Approve</button>
                <button class="btn btn-reject" onclick="setStatus('${r.id}','rejected')">Reject</button>
              ` : ''}
            </td>
          </tr>`).join('')}
          ${rows.length === 0 ? '<tr><td colspan="9" style="text-align: center; padding: 2rem; color: #666;">No classifications found</td></tr>' : ''}
        </tbody>
      </table>
    </div>

    ${totalPages > 1 ? `
    <div class="pagination">
      ${page > 1 ? `<a href="/classifications${qs({ page: page - 1 })}">&laquo; Prev</a>` : ''}
      ${Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
    const p = i + 1;
    return p === page ? `<span class="current">${p}</span>` : `<a href="/classifications${qs({ page: p })}">${p}</a>`;
  }).join('')}
      ${totalPages > 10 ? '<span>...</span>' : ''}
      ${page < totalPages ? `<a href="/classifications${qs({ page: page + 1 })}">Next &raquo;</a>` : ''}
    </div>` : ''}

    <script>
      function updateCount() {
        document.getElementById('selectedCount').textContent = document.querySelectorAll('.row-check:checked').length;
      }
      function toggleAll(el) {
        document.querySelectorAll('.row-check').forEach(cb => { cb.checked = el.checked; });
        updateCount();
      }
      async function setStatus(id, status) {
        const res = await fetch('/api/classifications/' + id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        if (res.ok) {
          const badge = document.querySelector('tr[data-id="' + id + '"] .badge.' + ['pending','approved','rejected','applied'].find(s =>
            document.querySelector('tr[data-id="' + id + '"] .badge.' + s)
          ));
          if (badge) { badge.className = 'badge ' + status; badge.textContent = status; }
          showToast('success', status === 'approved' ? 'Approved' : 'Rejected');
        }
      }
      async function batchAction(status) {
        const ids = [...document.querySelectorAll('.row-check:checked')].map(cb => cb.value);
        if (ids.length === 0) { showToast('error', 'No items selected'); return; }
        if (!confirm(status + ' ' + ids.length + ' classifications?')) return;
        const res = await fetch('/api/classifications/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, status })
        });
        const data = await res.json();
        showToast(res.ok ? 'success' : 'error', res.ok ? 'Updated ' + data.changed + ' classifications' : data.error);
        if (res.ok) setTimeout(() => location.reload(), 800);
      }
      async function batchFilterAction(status) {
        const params = new URLSearchParams(location.search);
        const filter = {};
        for (const [k, v] of params) { if (v) filter[k] = v; }
        const total = ${total};
        if (!confirm(status + ' all ' + total + ' filtered classifications?')) return;
        const res = await fetch('/api/classifications/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter, status })
        });
        const data = await res.json();
        showToast(res.ok ? 'success' : 'error', res.ok ? 'Updated ' + data.changed + ' classifications' : data.error);
        if (res.ok) setTimeout(() => location.reload(), 800);
      }
      function showToast(type, msg) {
        const t = document.getElementById('toast');
        t.className = 'toast ' + type;
        t.textContent = msg;
        t.style.display = 'block';
        setTimeout(() => { t.style.display = 'none'; }, 3000);
      }
    </script>
  `;
  return layout('Classifications', content, 'classifications');
}

export function renderHistory(runs: RunSummary[]): string {
  const content = `
    <h1 style="font-size: 1.3rem; margin-bottom: 1.5rem;">Classification History</h1>
    <div class="card" style="padding: 0; overflow-x: auto;">
      <table>
        <thead><tr>
          <th>Run Time</th><th>Total</th><th>Pending</th><th>Approved</th><th>Rejected</th><th>Applied</th><th>Accuracy</th>
        </tr></thead>
        <tbody>
          ${runs.map((r) => {
    const reviewed = r.approved + r.rejected + r.applied;
    const accuracy = reviewed > 0 ? ((r.approved + r.applied) / reviewed * 100).toFixed(0) : '-';
    return `<tr>
              <td><a href="/classifications?runId=${r.runId}">${formatDate(r.classifiedAt)}</a></td>
              <td>${r.total}</td>
              <td>${r.pending}</td>
              <td>${r.approved}</td>
              <td>${r.rejected}</td>
              <td>${r.applied}</td>
              <td>${accuracy}${accuracy !== '-' ? '%' : ''}</td>
            </tr>`;
  }).join('')}
          ${runs.length === 0 ? '<tr><td colspan="7" style="text-align: center; padding: 2rem; color: #666;">No classification runs yet</td></tr>' : ''}
        </tbody>
      </table>
    </div>
  `;
  return layout('History', content, 'history');
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatAmount(cents: number): string {
  if (cents == null) return '';
  const val = Math.abs(cents) / 100;
  return (cents < 0 ? '-' : '') + '$' + val.toFixed(2);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + '...' : s;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
