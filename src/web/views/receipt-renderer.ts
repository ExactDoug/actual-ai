// Receipt view renderers for the Review UI

export interface MatchQueueFilter {
  status?: string;
  confidence?: string;
  overridesExisting?: string;
  vendor?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export function renderReceiptQueue(
  rows: Record<string, unknown>[],
  total: number,
  filter: MatchQueueFilter,
): string {
  const page = filter.page ?? 1;
  const limit = filter.limit ?? 50;
  const totalPages = Math.ceil(total / limit);

  const qs = (overrides: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged: Record<string, unknown> = { ...filter, ...overrides };
    Object.entries(merged).forEach(([k, val]) => {
      if (val != null && val !== '' && k !== 'page') {
        p.set(k, String(val));
      }
    });
    if (overrides.page && overrides.page !== 1) p.set('page', String(overrides.page));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  const content = `
    <h1 style="font-size: 1.3rem; margin-bottom: 1rem;">Receipt Match Queue</h1>

    <form class="filters" method="GET" action="/receipts">
      <div>
        <label>Status</label>
        <select name="status">
          <option value="">All</option>
          ${['pending', 'classified', 'approved', 'applied', 'rejected'].map((s) => `<option value="${s}" ${filter.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Confidence</label>
        <select name="confidence">
          <option value="">All</option>
          ${['exact', 'probable', 'possible', 'manual'].map((c) => `<option value="${c}" ${filter.confidence === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Override</label>
        <select name="overridesExisting">
          <option value="">All</option>
          <option value="1" ${filter.overridesExisting === '1' ? 'selected' : ''}>Overrides</option>
          <option value="0" ${filter.overridesExisting === '0' ? 'selected' : ''}>New only</option>
        </select>
      </div>
      <div>
        <label>Vendor</label>
        <input type="text" name="vendor" value="${esc(filter.vendor ?? '')}" placeholder="Search...">
      </div>
      <div>
        <label>Date From</label>
        <input type="date" name="dateFrom" value="${filter.dateFrom ?? ''}">
      </div>
      <div>
        <label>Date To</label>
        <input type="date" name="dateTo" value="${filter.dateTo ?? ''}">
      </div>
      <button type="submit">Filter</button>
      <a href="/receipts" style="font-size: 0.85rem; padding: 0.4rem;">Clear</a>
    </form>

    <div class="actions-bar">
      <span class="selected-count"><span id="selectedCount">0</span> selected of ${total} total</span>
      <button class="btn btn-primary" onclick="batchAction('classify')">Classify</button>
      <button class="btn btn-approve" onclick="batchAction('approve')">Approve</button>
      <button class="btn" style="background:#6b5b2d;color:#fde68a;" onclick="batchAction('keep-category')">Keep Category</button>
      <button class="btn btn-apply" onclick="batchAction('apply')">Apply</button>
      <button class="btn btn-reject" onclick="batchAction('reject')">Reject</button>
      <button class="btn" style="background:#3a3d52;color:#ccc;" onclick="batchAction('unmatch')">Unmatch</button>
    </div>

    <div class="card" style="padding: 0; overflow-x: auto;">
      <table>
        <thead><tr>
          <th style="width: 30px;"><input type="checkbox" id="selectAll" onchange="toggleAll(this)"></th>
          <th><a href="/receipts${qs({ sortBy: 'status', sortDir: filter.sortBy === 'status' && filter.sortDir === 'asc' ? 'desc' : 'asc' })}">Status</a></th>
          <th><a href="/receipts${qs({ sortBy: 'confidence', sortDir: filter.sortBy === 'confidence' && filter.sortDir === 'asc' ? 'desc' : 'asc' })}">Confidence</a></th>
          <th>Override</th>
          <th><span class="col-source src-receipt">Receipt</span><a href="/receipts${qs({ sortBy: 'vendor', sortDir: filter.sortBy === 'vendor' && filter.sortDir === 'asc' ? 'desc' : 'asc' })}">Vendor</a></th>
          <th><span class="col-source src-budget">Budget</span>Payee</th>
          <th><span class="col-source src-receipt">Receipt</span><a href="/receipts${qs({ sortBy: 'date', sortDir: filter.sortBy === 'date' && filter.sortDir === 'desc' ? 'asc' : 'desc' })}">Date</a></th>
          <th><span class="col-source src-budget">Budget</span>Tx Date</th>
          <th><span class="col-source src-receipt">Receipt</span><a href="/receipts${qs({ sortBy: 'amount', sortDir: filter.sortBy === 'amount' && filter.sortDir === 'desc' ? 'asc' : 'desc' })}">Amount</a></th>
          <th><span class="col-source src-budget">Budget</span>Category</th>
          <th><span class="col-source src-receipt">Receipt</span>Items</th>
          <th><a href="/receipts${qs({ sortBy: 'matchedAt', sortDir: filter.sortBy === 'matchedAt' && filter.sortDir === 'desc' ? 'asc' : 'desc' })}">Matched</a></th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `<tr data-id="${r.id}" data-tx-id="${r.transactionId}" onclick="if(event.target.type!=='checkbox')location.href='/receipts/${r.id}'" style="cursor:pointer;">
            <td><input type="checkbox" class="row-check" value="${r.id}" onchange="updateCount()"></td>
            <td><span class="badge ${r.status}">${r.status}</span></td>
            <td><span class="badge confidence-${r.matchConfidence}">${r.matchConfidence}</span></td>
            <td>${r.overridesExisting ? '<span title="Will replace existing category" style="color:#fbbf24;">&#9888;</span>' : ''}</td>
            <td>${esc(truncate(String(r.vendorName ?? ''), 30))}</td>
            <td class="tx-payee"><span class="loading-dots">···</span></td>
            <td>${r.receiptDate ?? ''}</td>
            <td class="tx-date"><span class="loading-dots">···</span></td>
            <td class="amount negative">${formatAmount(r.totalAmount as number)}</td>
            <td class="tx-category"><span class="loading-dots">···</span></td>
            <td>${r.lineItemCount ?? 0}</td>
            <td>${formatDate(String(r.matchedAt ?? ''))}</td>
          </tr>`).join('')}
          ${rows.length === 0 ? '<tr><td colspan="12" style="text-align: center; padding: 2rem; color: #666;">No receipt matches found</td></tr>' : ''}
        </tbody>
      </table>
    </div>

    ${renderPagination('/receipts', page, totalPages, qs)}

    <script>
      function updateCount() {
        document.getElementById('selectedCount').textContent = document.querySelectorAll('.row-check:checked').length;
      }
      function toggleAll(el) {
        document.querySelectorAll('.row-check').forEach(cb => { cb.checked = el.checked; });
        updateCount();
      }
      async function batchAction(action) {
        const ids = [...document.querySelectorAll('.row-check:checked')].map(cb => cb.value);
        if (ids.length === 0) { showToast('error', 'No items selected'); return; }
        const destructive = ['unmatch', 'reject'];
        if (destructive.includes(action) && !confirm(action + ' ' + ids.length + ' matches?')) return;
        try {
          const res = await fetch('/api/batch/' + action, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchIds: ids })
          });
          const data = await res.json();
          if (res.ok) {
            showToast('success', 'Processed: ' + data.succeeded + ' succeeded, ' + data.failed + ' failed');
            setTimeout(() => location.reload(), 800);
          } else {
            showToast('error', data.error || 'Request failed');
          }
        } catch (err) { showToast('error', String(err)); }
      }
      function showToast(type, msg) {
        const t = document.getElementById('toast');
        t.className = 'toast ' + type;
        t.textContent = msg;
        t.style.display = 'block';
        setTimeout(() => { t.style.display = 'none'; }, 3000);
      }

      // Lazy-load transaction details from Actual Budget
      (async function() {
        var rows = document.querySelectorAll('tr[data-tx-id]');
        if (rows.length === 0) return;
        var ids = [...new Set([...rows].map(function(r) { return r.dataset.txId; }))];
        function clearDots(row) {
          row.querySelectorAll('.loading-dots').forEach(function(d) { d.textContent = '\\u2014'; d.className = ''; d.style.color = '#555'; });
        }
        try {
          var res = await fetch('/api/transactions/bulk-details', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactionIds: ids })
          });
          if (!res.ok) { rows.forEach(clearDots); return; }
          var data = await res.json();
          rows.forEach(function(row) {
            var info = data[row.dataset.txId];
            if (!info) { clearDots(row); return; }
            var payeeCell = row.querySelector('.tx-payee');
            var dateCell = row.querySelector('.tx-date');
            var catCell = row.querySelector('.tx-category');
            if (payeeCell) {
              payeeCell.textContent = info.payeeName || info.importedPayee || '';
              payeeCell.style.color = '#ccc';
              payeeCell.style.fontSize = '0.85rem';
            }
            if (dateCell) {
              dateCell.textContent = info.date || '';
              dateCell.style.color = '#ccc';
              dateCell.style.fontSize = '0.85rem';
            }
            if (catCell) {
              catCell.style.fontSize = '0.85rem';
              if (info.isParent && info.subtransactions && info.subtransactions.length > 0) {
                var cats = info.subtransactions.map(function(s) { return s.categoryName || '?'; });
                var unique = [...new Set(cats)];
                catCell.innerHTML = '<span style="color:#60a5fa;">Split:</span> ' + unique.join(', ');
                catCell.style.color = '#ccc';
              } else if (info.categoryName) {
                catCell.textContent = info.categoryName;
                catCell.style.color = '#fbbf24';
              } else {
                catCell.textContent = '(none)';
                catCell.style.color = '#666';
              }
            }
          });
        } catch (e) {
          console.error('Failed to load transaction details', e);
          rows.forEach(clearDots);
        }
      })();
    </script>
  `;
  return receiptLayout('Receipt Queue', content, 'queue');
}

export function renderReceiptDetail(
  match: Record<string, unknown>,
  receipt: Record<string, unknown>,
  classifications: Record<string, unknown>[],
  history: Record<string, unknown>[],
): string {
  const receiptData = receipt.receiptData ? JSON.parse(String(receipt.receiptData)) : {};
  const lineItems: Record<string, unknown>[] = receiptData.lineItems ?? receiptData.line_items ?? [];
  const allApproved = classifications.length > 0 && classifications.every((c) => c.status === 'approved');
  const allClassified = classifications.length > 0;

  const content = `
    <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem;">
      <a href="/receipts" style="font-size: 0.85rem;">&laquo; Back to queue</a>
      <h1 style="font-size: 1.3rem; margin-left: 0.5rem;">${esc(String(receipt.vendorName ?? 'Receipt'))}</h1>
      <span class="badge ${match.status}" style="margin-left: 0.5rem;">${match.status}</span>
      <span class="badge confidence-${match.matchConfidence}">${match.matchConfidence}</span>
      ${match.overridesExisting ? '<span class="badge" style="background:#78350f;color:#fbbf24;">Override</span>' : ''}
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
      <!-- Left: Receipt -->
      <div>
        <div class="card">
          <h2>Receipt Details</h2>
          <div class="detail-grid">
            <div class="detail-row"><span class="detail-label">Vendor</span><span>${esc(String(receipt.vendorName ?? ''))}</span></div>
            <div class="detail-row"><span class="detail-label">Date</span><span>${receipt.date ?? ''}</span></div>
            <div class="detail-row"><span class="detail-label">Total</span><span class="amount negative">${formatAmount(receipt.totalAmount as number)}</span></div>
            <div class="detail-row"><span class="detail-label">Tax</span><span class="amount">${formatAmount(receipt.taxAmount as number ?? 0)}</span></div>
            <div class="detail-row"><span class="detail-label">Currency</span><span>${receipt.currency ?? 'USD'}</span></div>
            <div class="detail-row"><span class="detail-label">Items</span><span>${receipt.lineItemCount ?? 0}</span></div>
            <div class="detail-row"><span class="detail-label">Provider</span><span>${receipt.providerId ?? ''}</span></div>
          </div>
        </div>

        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2>Line Items</h2>
            <div style="display: flex; gap: 0.3rem;">
              ${match.status === 'pending' ? `<button class="btn btn-primary" onclick="classifyReceipt()">Classify</button>` : ''}
              ${allClassified ? `
                <button class="btn btn-approve" onclick="approveAll()">Approve All</button>
                <button class="btn btn-reject" onclick="rejectAll()">Reject All</button>
              ` : ''}
            </div>
          </div>
          ${classifications.length > 0 ? `
          <table style="margin-top: 0.5rem;">
            <thead><tr>
              <th>#</th>
              <th>Description</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Tax</th>
              <th>Total</th>
              <th>Category</th>
              <th>Status</th>
              <th>Actions</th>
            </tr></thead>
            <tbody>
              ${classifications.map((c) => `<tr data-item-id="${c.id}" data-match-id="${c.receiptMatchId}">
                <td>${(c.lineItemIndex as number) + 1}</td>
                <td title="${esc(String(c.description ?? ''))}">${esc(truncate(String(c.description ?? ''), 25))}</td>
                <td>${c.quantity ?? 1}</td>
                <td class="amount" data-field="totalPrice">${formatAmount(c.totalPrice as number, true)}</td>
                <td class="amount" data-field="allocatedTax">${formatAmount(c.allocatedTax as number, true)}</td>
                <td class="amount" data-field="amountWithTax">${formatAmount(c.amountWithTax as number)}</td>
                <td class="category-cell">
                  <span class="cat-label" data-item-id="${c.id}" data-category-id="${esc(String(c.suggestedCategoryId ?? ''))}" onclick="showCategoryDropdown(this)" title="Click to change category&#10;Type: ${esc(String(c.classificationType ?? ''))}" style="cursor:pointer;border-bottom:1px dashed #666;">${esc(String(c.suggestedCategoryName ?? '-'))}</span>
                  <select class="cat-select" data-item-id="${c.id}" style="display:none;background:#1b1d2a;color:#e0e0e0;border:1px solid #8b7cf6;border-radius:4px;font-size:0.8rem;max-width:160px;" onchange="onCategoryChange(this)" onblur="hideCategoryDropdown(this)"></select>
                  ${c.confidence ? `<span class="badge confidence-${c.confidence}" style="margin-left:0.3rem;font-size:0.65rem;">${c.confidence}</span>` : ''}
                  ${c.taxable === 0 ? '<span title="Tax exempt" style="margin-left:0.2rem;font-size:0.7rem;color:#34d399;">&#9679;</span>' : ''}
                </td>
                <td><span class="badge ${c.status}">${c.status}</span></td>
                <td>
                  ${c.status !== 'approved' ? `<button class="btn btn-approve" onclick="setItemStatus('${c.id}','approved')">&#10003;</button>` : ''}
                  ${c.status !== 'rejected' ? `<button class="btn btn-reject" onclick="setItemStatus('${c.id}','rejected')">&#10007;</button>` : ''}
                </td>
              </tr>`).join('')}
            </tbody>
          </table>` : `
          <p style="color: #666; margin-top: 0.5rem;">No classifications yet. ${match.status === 'pending' ? 'Click "Classify" to run line-item classification.' : ''}</p>
          `}
        </div>

        ${lineItems.length > 0 && classifications.length === 0 ? `
        <div class="card">
          <h2>Raw Line Items (from OCR)</h2>
          <table style="margin-top: 0.5rem;">
            <thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>
              ${lineItems.map((li, i) => `<tr>
                <td>${i + 1}</td>
                <td>${esc(String(li.description ?? ''))}</td>
                <td>${li.quantity ?? 1}</td>
                <td class="amount">${formatAmount(li.price as number ?? li.unit_price as number ?? 0, true)}</td>
                <td class="amount">${formatAmount(li.total as number ?? 0, true)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
      </div>

      <!-- Right: Transaction + Actions -->
      <div>
        <div class="card">
          <h2>Matched Transaction</h2>
          <div class="detail-grid">
            <div class="detail-row"><span class="detail-label">Transaction ID</span><span style="font-family:monospace;font-size:0.8rem;">${truncate(String(match.transactionId ?? ''), 20)}</span></div>
            <div class="detail-row"><span class="detail-label">Payee</span><span id="txPayee" style="color:#888;font-size:0.85rem;">loading...</span></div>
            <div class="detail-row"><span class="detail-label">Transaction Date</span><span id="txDate" style="color:#888;font-size:0.85rem;">loading...</span></div>
            <div class="detail-row"><span class="detail-label">Account</span><span id="txAccount" style="color:#888;font-size:0.85rem;">loading...</span></div>
            <div class="detail-row"><span class="detail-label">Match Confidence</span><span class="badge confidence-${match.matchConfidence}">${match.matchConfidence}</span></div>
            <div class="detail-row"><span class="detail-label">Matched At</span><span>${formatDate(String(match.matchedAt ?? ''))}</span></div>
            <div class="detail-row"><span class="detail-label">Current Category</span><span id="txCategoryInfo" style="color:#888;font-size:0.8rem;">loading...</span></div>
          </div>
          ${match.overridesExisting ? `
          <div style="margin-top: 0.8rem; padding: 0.6rem; background: #78350f22; border: 1px solid #78350f; border-radius: 4px; font-size: 0.85rem;">
            <strong style="color:#fbbf24;">Warning:</strong> This transaction already has a category assigned.
            Applying this split will replace the existing categorization.
          </div>` : ''}
        </div>

        ${allClassified ? `
        <div class="card">
          <h2>Split Preview</h2>
          <table id="splitPreview" style="margin-top: 0.5rem;">
            <thead><tr><th>Category</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              ${classifications.map((c) => `<tr data-split-id="${c.id}">
                <td data-field="splitCategory">${esc(String(c.suggestedCategoryName ?? 'Uncategorized'))}</td>
                <td class="amount" data-field="splitAmount">${formatAmount(c.amountWithTax as number)}</td>
                <td><span class="badge ${c.status}">${c.status}</span></td>
              </tr>`).join('')}
              <tr style="border-top: 2px solid #3a3d52; font-weight: 700;">
                <td>Total</td>
                <td class="amount" id="splitTotal">${formatAmount(classifications.reduce((s, c) => s + (c.amountWithTax as number ?? 0), 0))}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
          <div style="margin-top: 0.8rem; display: flex; gap: 0.5rem;">
            <button id="applyBtn" class="btn btn-apply" onclick="applySplit()" ${!allApproved ? 'disabled title="All line items must be approved first"' : ''}>${classifications.length === 1 ? 'Apply Category' : 'Apply Split'}</button>
          </div>
        </div>` : ''}

        <div class="card">
          <h2>Actions</h2>
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            ${match.status === 'pending' ? `<button class="btn btn-primary" onclick="classifyReceipt()">Classify</button>` : ''}
            ${['classified', 'rejected'].includes(String(match.status)) ? `<button class="btn btn-primary" onclick="reclassify()">Re-classify</button>` : ''}
            ${match.status !== 'applied' ? `<button class="btn" style="background:#3a3d52;color:#ccc;" onclick="unmatchReceipt()">Unmatch</button>` : ''}
            ${match.status === 'applied' ? `<button class="btn btn-reject" onclick="rollbackSplit()">Rollback</button>` : ''}
          </div>
        </div>

        ${history.length > 0 ? `
        <div class="card">
          <details>
            <summary style="cursor:pointer;font-size:0.9rem;color:#888;">Match History (${history.length})</summary>
            <table style="margin-top: 0.5rem;">
              <thead><tr><th>Action</th><th>Time</th><th>By</th></tr></thead>
              <tbody>
                ${history.map((h) => `<tr>
                  <td>${h.action}</td>
                  <td>${formatDate(String(h.performedAt ?? ''))}</td>
                  <td>${h.performedBy ?? 'system'}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </details>
        </div>` : ''}
      </div>
    </div>

    <script>
      const matchId = '${match.id}';
      const receiptId = '${receipt.id}';

      // Category cache (loaded once)
      let categoryCache = null;
      async function loadCategories() {
        if (categoryCache) return categoryCache;
        try {
          const res = await fetch('/api/categories');
          if (res.ok) categoryCache = await res.json();
        } catch (e) { console.error('Failed to load categories', e); }
        return categoryCache || [];
      }

      // Fetch current transaction details from Actual Budget (live lookup)
      (async function() {
        const el = document.getElementById('txCategoryInfo');
        const payeeEl = document.getElementById('txPayee');
        const dateEl = document.getElementById('txDate');
        const accountEl = document.getElementById('txAccount');
        try {
          const txId = '${esc(String(match.transactionId ?? ''))}';
          const res = await fetch('/api/transactions/' + txId + '/details');
          if (!res.ok) {
            if (el) el.textContent = '(unavailable)';
            if (payeeEl) payeeEl.textContent = '(unavailable)';
            if (dateEl) dateEl.textContent = '(unavailable)';
            if (accountEl) accountEl.textContent = '(unavailable)';
            return;
          }
          const data = await res.json();
          // Populate payee, date, account
          if (payeeEl) {
            payeeEl.textContent = data.payeeName || data.importedPayee || '(unknown)';
            payeeEl.style.color = '#ccc';
          }
          if (dateEl) {
            dateEl.textContent = data.date || '(unknown)';
            dateEl.style.color = '#ccc';
          }
          if (accountEl) {
            accountEl.textContent = data.accountName || '(unknown)';
            accountEl.style.color = '#ccc';
          }
          // Populate category
          if (el) {
            if (data.isParent && data.subtransactions && data.subtransactions.length > 0) {
              var parts = data.subtransactions.map(function(s) {
                var amt = Math.abs(s.amount) / 100;
                return (s.categoryName || 'Uncategorized') + ' ($' + amt.toFixed(2) + ')';
              });
              el.innerHTML = '<span style="color:#60a5fa;">Split:</span> ' + parts.join(', ');
            } else if (data.categoryName) {
              el.textContent = data.categoryName;
              el.style.color = '#fbbf24';
            } else {
              el.textContent = '(uncategorized)';
            }
          }
        } catch (e) {
          if (el) el.textContent = '(error)';
          if (payeeEl) payeeEl.textContent = '(error)';
        }
      })();

      // --- Category dropdown ---
      async function showCategoryDropdown(label) {
        const itemId = label.dataset.itemId;
        const select = label.parentElement.querySelector('.cat-select');
        const cats = await loadCategories();
        if (select.options.length <= 1) {
          select.innerHTML = '';
          const groups = {};
          cats.forEach(c => {
            const g = c.group || 'Other';
            if (!groups[g]) groups[g] = [];
            groups[g].push(c);
          });
          Object.keys(groups).sort().forEach(g => {
            const og = document.createElement('optgroup');
            og.label = g;
            groups[g].forEach(c => {
              const opt = document.createElement('option');
              opt.value = c.id;
              opt.textContent = c.name;
              opt.dataset.name = c.name;
              if (c.id === label.dataset.categoryId) opt.selected = true;
              og.appendChild(opt);
            });
            select.appendChild(og);
          });
        }
        label.style.display = 'none';
        select.style.display = 'inline-block';
        select.focus();
      }

      function hideCategoryDropdown(select) {
        setTimeout(() => {
          if (document.activeElement === select) return;
          select.style.display = 'none';
          select.parentElement.querySelector('.cat-label').style.display = '';
        }, 150);
      }

      async function onCategoryChange(select) {
        const itemId = select.dataset.itemId;
        const option = select.options[select.selectedIndex];
        const categoryId = option.value;
        const categoryName = option.dataset.name || option.textContent;

        try {
          const res = await fetch('/api/line-items/' + itemId, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ categoryId, categoryName })
          });
          if (res.ok) {
            const data = await res.json();
            if (data.classifications) updateAllRows(data.classifications);
            showToast('success', 'Category updated');
          } else {
            const d = await res.json();
            showToast('error', d.error || 'Failed to update');
          }
        } catch (err) { showToast('error', String(err)); }

        select.style.display = 'none';
        select.parentElement.querySelector('.cat-label').style.display = '';
      }

      // --- Live row updates ---
      function fmtAmount(cents, dashIfZero) {
        if (cents == null) return '';
        if (dashIfZero && cents === 0) return '\\u2014';
        const val = Math.abs(cents) / 100;
        return (cents < 0 ? '-' : '') + '$' + val.toFixed(2);
      }

      function updateAllRows(classifications) {
        let splitTotal = 0;
        classifications.forEach(c => {
          const row = document.querySelector('tr[data-item-id="' + c.id + '"]');
          if (row) {
            const taxCell = row.querySelector('[data-field="allocatedTax"]');
            const totalCell = row.querySelector('[data-field="amountWithTax"]');
            if (taxCell) taxCell.textContent = fmtAmount(c.allocatedTax, true);
            if (totalCell) totalCell.textContent = fmtAmount(c.amountWithTax);

            // Update category label
            const label = row.querySelector('.cat-label');
            if (label) {
              label.textContent = c.suggestedCategoryName || '-';
              label.dataset.categoryId = c.suggestedCategoryId || '';
            }
            // Update tax-exempt indicator
            const existingDot = row.querySelector('.category-cell span[title="Tax exempt"]');
            if (existingDot) existingDot.remove();
            if (c.taxable === 0) {
              const dot = document.createElement('span');
              dot.title = 'Tax exempt';
              dot.style.cssText = 'margin-left:0.2rem;font-size:0.7rem;color:#34d399;';
              dot.innerHTML = '&#9679;';
              row.querySelector('.category-cell').appendChild(dot);
            }

            // Update status badge
            const statusBadge = row.querySelector('td:nth-last-child(2) .badge');
            if (statusBadge && c.status) {
              statusBadge.className = 'badge ' + c.status;
              statusBadge.textContent = c.status;
            }
          }

          // Update split preview
          const splitRow = document.querySelector('tr[data-split-id="' + c.id + '"]');
          if (splitRow) {
            const catCell = splitRow.querySelector('[data-field="splitCategory"]');
            const amtCell = splitRow.querySelector('[data-field="splitAmount"]');
            if (catCell) catCell.textContent = c.suggestedCategoryName || 'Uncategorized';
            if (amtCell) amtCell.textContent = fmtAmount(c.amountWithTax);
          }
          splitTotal += (c.amountWithTax || 0);
        });

        const totalEl = document.getElementById('splitTotal');
        if (totalEl) totalEl.textContent = fmtAmount(splitTotal);
      }

      // --- Existing actions ---
      async function classifyReceipt() {
        showToast('success', 'Classification started...');
        try {
          const res = await fetch('/api/receipts/' + receiptId + '/classify', { method: 'POST' });
          const data = await res.json();
          showToast(res.ok ? 'success' : 'error', res.ok ? 'Classification complete' : data.error);
          if (res.ok) setTimeout(() => location.reload(), 800);
        } catch (err) { showToast('error', String(err)); }
      }

      async function reclassify() {
        if (!confirm('Re-classify this receipt? Existing classifications will be replaced.')) return;
        try {
          const res = await fetch('/api/batch/reclassify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchIds: [matchId] })
          });
          const data = await res.json();
          showToast(res.ok ? 'success' : 'error', res.ok ? 'Re-classification complete' : data.error);
          if (res.ok) setTimeout(() => location.reload(), 800);
        } catch (err) { showToast('error', String(err)); }
      }

      async function setItemStatus(itemId, status) {
        try {
          const res = await fetch('/api/line-items/' + itemId, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
          });
          if (res.ok) {
            const data = await res.json();
            if (data.classifications) updateAllRows(data.classifications);
            showToast('success', status === 'approved' ? 'Approved' : 'Rejected');
            nudgeApplyButton();
          }
        } catch (err) { showToast('error', String(err)); }
      }

      function nudgeApplyButton() {
        const btn = document.getElementById('applyBtn');
        if (!btn) return;
        const badges = document.querySelectorAll('tr[data-item-id] td:nth-last-child(2) .badge');
        const allApproved = [...badges].every(b => b.classList.contains('approved'));
        if (allApproved) { btn.disabled = false; btn.removeAttribute('title'); }
        btn.classList.remove('btn-attention');
        void btn.offsetWidth;
        btn.classList.add('btn-attention');
      }

      async function approveAll() {
        try {
          const res = await fetch('/api/batch/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchIds: [matchId] })
          });
          if (res.ok) {
            showToast('success', 'All items approved');
            document.querySelectorAll('tr[data-item-id] td:nth-last-child(2) .badge').forEach(function(b) {
              b.className = 'badge approved'; b.textContent = 'approved';
            });
            nudgeApplyButton();
          }
          else { const d = await res.json(); showToast('error', d.error); }
        } catch (err) { showToast('error', String(err)); }
      }

      async function rejectAll() {
        if (!confirm('Reject all line items?')) return;
        try {
          const res = await fetch('/api/batch/reject', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchIds: [matchId] })
          });
          if (res.ok) {
            showToast('success', 'All items rejected');
            document.querySelectorAll('tr[data-item-id] td:nth-last-child(2) .badge').forEach(function(b) {
              b.className = 'badge rejected'; b.textContent = 'rejected';
            });
          }
          else { const d = await res.json(); showToast('error', d.error); }
        } catch (err) { showToast('error', String(err)); }
      }

      async function applySplit() {
        ${match.overridesExisting ? "if (!confirm('This will REPLACE the existing category on this transaction. Continue?')) return;" : ''}
        try {
          const res = await fetch('/api/receipts/' + receiptId + '/apply', { method: 'POST' });
          const data = await res.json();
          showToast(res.ok ? 'success' : 'error', res.ok ? 'Split applied!' : data.error);
          if (res.ok) setTimeout(() => location.reload(), 800);
        } catch (err) { showToast('error', String(err)); }
      }

      async function unmatchReceipt() {
        if (!confirm('Unmatch this receipt from its transaction?')) return;
        try {
          const res = await fetch('/api/matches/' + matchId + '/unmatch', { method: 'POST' });
          if (res.ok) { showToast('success', 'Unmatched'); setTimeout(() => location.href = '/receipts', 800); }
          else { const d = await res.json(); showToast('error', d.error); }
        } catch (err) { showToast('error', String(err)); }
      }

      async function rollbackSplit() {
        if (!confirm('Rollback the applied split? This will restore the original transaction.')) return;
        try {
          const res = await fetch('/api/matches/' + matchId + '/unmatch', { method: 'POST' });
          if (res.ok) { showToast('success', 'Rollback complete'); setTimeout(() => location.reload(), 800); }
          else { const d = await res.json(); showToast('error', d.error); }
        } catch (err) { showToast('error', String(err)); }
      }

      function showToast(type, msg) {
        const t = document.getElementById('toast');
        t.className = 'toast ' + type;
        t.textContent = msg;
        t.style.display = 'block';
        setTimeout(() => { t.style.display = 'none'; }, 3000);
      }

      // Auto-pulse Apply button on page load if all items already approved
      (function() {
        const btn = document.getElementById('applyBtn');
        if (!btn || btn.disabled) return;
        const badges = document.querySelectorAll('tr[data-item-id] td:nth-last-child(2) .badge');
        if (badges.length > 0 && [...badges].every(b => b.classList.contains('approved'))) {
          btn.classList.add('btn-attention');
        }
      })();
    </script>
  `;
  return receiptLayout(`${receipt.vendorName ?? 'Receipt'} - Detail`, content, 'queue');
}

export function renderUnmatchedReceipts(
  rows: Record<string, unknown>[],
): string {
  const content = `
    <h1 style="font-size: 1.3rem; margin-bottom: 1rem;">Unmatched Receipts</h1>
    <p style="font-size: 0.85rem; color: #888; margin-bottom: 1rem;">${rows.length} receipt(s) without a transaction match</p>

    <div class="card" style="padding: 0; overflow-x: auto;">
      <table>
        <thead><tr>
          <th>Vendor</th>
          <th>Date</th>
          <th>Amount</th>
          <th>Items</th>
          <th>Provider</th>
          <th>Fetched</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td>${esc(String(r.vendorName ?? ''))}</td>
            <td>${r.date ?? ''}</td>
            <td class="amount negative">${formatAmount(r.totalAmount as number)}</td>
            <td>${r.lineItemCount ?? 0}</td>
            <td>${r.providerId ?? ''}</td>
            <td>${formatDate(String(r.fetchedAt ?? ''))}</td>
          </tr>`).join('')}
          ${rows.length === 0 ? '<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #666;">All receipts are matched</td></tr>' : ''}
        </tbody>
      </table>
    </div>
  `;
  return receiptLayout('Unmatched Receipts', content, 'unmatched');
}

export function renderReceiptDashboard(stats: {
  totalReceipts: number;
  totalMatched: number;
  pending: number;
  classified: number;
  approved: number;
  applied: number;
  rejected: number;
  totalUnmatched: number;
}): string {
  const content = `
    <h1 style="font-size: 1.3rem; margin-bottom: 1.5rem;">Receipt Dashboard</h1>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Total Receipts</div>
        <div class="value" style="color:#8b7cf6;">${stats.totalReceipts}</div>
      </div>
      <div class="stat-card">
        <div class="label">Matched</div>
        <div class="value" style="color:#60a5fa;">${stats.totalMatched}</div>
      </div>
      <div class="stat-card">
        <div class="label">Unmatched</div>
        <div class="value" style="color:#888;">${stats.totalUnmatched}</div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Pending</div>
        <div class="value pending">${stats.pending}</div>
      </div>
      <div class="stat-card">
        <div class="label">Classified</div>
        <div class="value" style="color:#c084fc;">${stats.classified}</div>
      </div>
      <div class="stat-card">
        <div class="label">Approved</div>
        <div class="value approved">${stats.approved}</div>
      </div>
      <div class="stat-card">
        <div class="label">Applied</div>
        <div class="value applied">${stats.applied}</div>
      </div>
      <div class="stat-card">
        <div class="label">Rejected</div>
        <div class="value rejected">${stats.rejected}</div>
      </div>
    </div>

    <div class="card" style="margin-top: 1rem;">
      <h2>Quick Actions</h2>
      <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
        <button class="btn btn-primary" onclick="fetchReceipts()">Fetch Receipts</button>
        <a href="/receipts" class="btn btn-primary" style="text-decoration:none;">View Queue</a>
        <a href="/receipts/unmatched" class="btn" style="background:#3a3d52;color:#ccc;text-decoration:none;">View Unmatched</a>
      </div>
    </div>

    <script>
      async function fetchReceipts() {
        showToast('success', 'Fetching receipts...');
        try {
          const res = await fetch('/api/receipts/fetch', { method: 'POST' });
          const data = await res.json();
          showToast(res.ok ? 'success' : 'error', res.ok ? 'Fetched ' + data.fetched + ' receipts' : data.error);
          if (res.ok) setTimeout(() => location.reload(), 1000);
        } catch (err) { showToast('error', String(err)); }
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
  return receiptLayout('Receipt Dashboard', content, 'dashboard');
}

// ---------------------------------------------------------------------------
// Shared layout and helpers
// ---------------------------------------------------------------------------

function receiptLayout(title: string, content: string, activeNav: string): string {
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
    nav .sep { color: #3a3d52; }

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
    .badge.classified { background: #3b0764; color: #c084fc; }
    .badge.approved { background: #064e3b; color: #34d399; }
    .badge.applied { background: #1e3a5f; color: #60a5fa; }
    .badge.rejected { background: #7f1d1d; color: #f87171; }
    .badge.confidence-exact { background: #064e3b; color: #34d399; }
    .badge.confidence-probable { background: #1e3a5f; color: #60a5fa; }
    .badge.confidence-possible { background: #78350f; color: #fbbf24; }
    .badge.confidence-manual { background: #3a3d52; color: #ccc; }
    .badge.confidence-high { background: #064e3b; color: #34d399; }
    .badge.confidence-medium { background: #1e3a5f; color: #60a5fa; }
    .badge.confidence-low { background: #78350f; color: #fbbf24; }

    .amount { font-family: 'SF Mono', 'Fira Code', monospace; }
    .amount.positive { color: #34d399; }
    .amount.negative { color: #f87171; }

    .btn { display: inline-block; padding: 0.3rem 0.6rem; border-radius: 4px; border: none; cursor: pointer; font-size: 0.8rem; font-weight: 500; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-approve { background: #064e3b; color: #34d399; }
    .btn-approve:hover:not(:disabled) { background: #065f46; }
    .btn-reject { background: #7f1d1d; color: #f87171; }
    .btn-reject:hover:not(:disabled) { background: #991b1b; }
    .btn-apply { background: #1e3a5f; color: #60a5fa; }
    .btn-apply:hover:not(:disabled) { background: #1e4976; }
    .btn-primary { background: #8b7cf6; color: white; }
    .btn-primary:hover:not(:disabled) { background: #7a6be0; }

    .actions-bar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; padding: 0.8rem; background: #2a2d40; border-radius: 6px; }
    .actions-bar .selected-count { font-size: 0.85rem; color: #888; margin-right: auto; }

    .pagination { display: flex; gap: 0.5rem; justify-content: center; margin-top: 1rem; align-items: center; }
    .pagination a, .pagination span { padding: 0.3rem 0.6rem; border-radius: 4px; font-size: 0.85rem; }
    .pagination span.current { background: #8b7cf6; color: white; }

    .detail-grid { display: grid; grid-template-columns: 1fr; gap: 0.3rem; }
    .detail-row { display: flex; justify-content: space-between; padding: 0.3rem 0; border-bottom: 1px solid #2a2d40; font-size: 0.85rem; }
    .detail-label { color: #888; }

    input[type="checkbox"] { accent-color: #8b7cf6; }

    .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; background: #252839; border: 1px solid #3a3d52; padding: 0.8rem 1.2rem; border-radius: 6px; font-size: 0.85rem; display: none; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .toast.success { border-color: #34d399; }
    .toast.error { border-color: #f87171; }

    @keyframes btn-pulse {
      0% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.6); }
      50% { box-shadow: 0 0 12px 4px rgba(96, 165, 250, 0.3); }
      100% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0); }
    }
    .btn-attention {
      animation: btn-pulse 1.5s ease-in-out infinite;
      border: 1px solid #60a5fa;
    }

    @keyframes loading-fade { 0%,100% { opacity: 0.3; } 50% { opacity: 0.8; } }
    .loading-dots { color: #555; font-size: 0.8rem; letter-spacing: 2px; animation: loading-fade 1.5s ease-in-out infinite; }

    .col-source { display: block; font-size: 0.55rem; font-weight: 400; letter-spacing: 0.08em; text-transform: uppercase; line-height: 1; margin-bottom: 2px; }
    .col-source.src-receipt { color: #8b7cf6; }
    .col-source.src-budget { color: #60a5fa; }
  </style>
</head>
<body>
  <nav>
    <span class="brand">actual-ai</span>
    <a href="/">Dashboard</a>
    <a href="/classifications">Classifications</a>
    <a href="/history">History</a>
    <span class="sep">|</span>
    <a href="/receipts/dashboard" class="${activeNav === 'dashboard' ? 'active' : ''}">Receipts</a>
    <a href="/receipts" class="${activeNav === 'queue' ? 'active' : ''}">Queue</a>
    <a href="/receipts/unmatched" class="${activeNav === 'unmatched' ? 'active' : ''}">Unmatched</a>
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

function renderPagination(
  basePath: string,
  page: number,
  totalPages: number,
  qs: (overrides: Record<string, string | number | undefined>) => string,
): string {
  if (totalPages <= 1) return '';
  const pages = Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
    const p = i + 1;
    return p === page ? `<span class="current">${p}</span>` : `<a href="${basePath}${qs({ page: p })}">${p}</a>`;
  }).join('');
  return `
    <div class="pagination">
      ${page > 1 ? `<a href="${basePath}${qs({ page: page - 1 })}">&laquo; Prev</a>` : ''}
      ${pages}
      ${totalPages > 10 ? '<span>...</span>' : ''}
      ${page < totalPages ? `<a href="${basePath}${qs({ page: page + 1 })}">Next &raquo;</a>` : ''}
    </div>`;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatAmount(cents: number, dashIfZero = false): string {
  if (cents == null) return '';
  if (dashIfZero && cents === 0) return '\u2014';
  const val = Math.abs(cents) / 100;
  return (cents < 0 ? '-' : '') + '$' + val.toFixed(2);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + '...' : s;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
