document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  const toggle = document.getElementById('menu-toggle');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('is-open');
      sidebar.classList.toggle('-translate-x-full');
      backdrop && backdrop.classList.toggle('hidden');
    });
    backdrop && backdrop.addEventListener('click', () => {
      sidebar.classList.add('-translate-x-full');
      sidebar.classList.remove('is-open');
      backdrop.classList.add('hidden');
    });
  }

  document.querySelectorAll('form[data-confirm]').forEach(form => {
    form.addEventListener('submit', e => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  initPeriodPrefill();
  initSelectAll();
  initInstantSearch();
});

// Recherche instantanée dans un tableau (aucun aller-retour serveur)
function initInstantSearch() {
  const box = document.querySelector('[data-search-box]');
  if (!box) return;
  const scope = document.querySelector(box.dataset.searchBox);
  if (!scope) return;
  const rows = Array.from(scope.querySelectorAll('tbody [data-search]'));
  const empty = scope.querySelector('[data-no-match]');
  const counter = box.parentElement.querySelector('[data-search-count]');
  let shown = rows.length;
  box.addEventListener('input', () => {
    const q = box.value.trim().toLowerCase();
    shown = 0;
    rows.forEach(row => {
      const hit = !q || row.dataset.search.includes(q);
      row.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    if (empty) empty.hidden = shown !== 0;
    if (counter) counter.textContent = q ? `${shown} / ${rows.length}` : '';
  });
}

// Préremplissage du formulaire de quittance à partir de /api/periode
function initPeriodPrefill() {
  const form = document.querySelector('[data-prefill-form]');
  if (!form) return;
  const tenantSel = form.querySelector('[name="tenancy_id"]');
  const yearEl = form.querySelector('[name="period_year"]');
  const monthEl = form.querySelector('[name="period_month"]');
  const box = form.querySelector('[data-prefill-box]');
  const amountEl = form.querySelector('[name="amount"]');
  const rentEl = form.querySelector('[name="monthly_rent"]');

  async function refresh() {
    if (!tenantSel.value || !yearEl.value || !monthEl.value) return;
    const option = tenantSel.selectedOptions[0];
    const tenantId = option && option.dataset.tenantId;
    if (!tenantId) return;
    const res = await fetch(`/api/periode?tenant_id=${encodeURIComponent(tenantId)}`
      + `&year=${yearEl.value}&month=${monthEl.value}`);
    if (!res.ok) return;
    const d = await res.json();
    if (!d.has_tenancy) { box.innerHTML = '<p class="text-sm text-ink-500">Ce locataire n\'a pas de location en cours.</p>'; return; }
    const fmt = n => new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';
    const labels = { paid: 'payé', partial: 'partiellement payé', pending: 'en attente', na: 'non applicable à cette période' };
    box.innerHTML = `
      <dl class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-sm">
        <div><dt class="text-ink-500 text-xs">Logement</dt><dd class="font-medium">${d.unit_name} — ${d.floor_label}</dd></div>
        <div><dt class="text-ink-500 text-xs">Type</dt><dd class="font-medium">${d.type_label}</dd></div>
        <div><dt class="text-ink-500 text-xs">Loyer attendu</dt><dd class="font-medium">${fmt(d.expected)}</dd></div>
        <div><dt class="text-ink-500 text-xs">Déjà payé</dt><dd class="font-medium">${fmt(d.paid)}</dd></div>
        <div><dt class="text-ink-500 text-xs">Solde restant</dt><dd class="font-medium">${fmt(d.balance)}</dd></div>
        <div><dt class="text-ink-500 text-xs">Statut du mois</dt><dd><span class="badge badge-${d.status === 'paid' ? 'paid' : d.status === 'partial' ? 'partial' : 'pending'}">${labels[d.status]}</span></dd></div>
        <div class="col-span-2">
          <dt class="text-ink-500 text-xs">Quittances de la période</dt>
          <dd class="font-medium">${d.receipts.length ? d.receipts.map(r => r.number + (r.type === 'recu_partiel' ? ' (partiel)' : '')).join(', ') : 'aucune'}</dd>
        </div>
      </dl>
      ${d.has_full_receipt ? '<p class="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">Une quittance intégrale existe déjà pour cette période : utilisez la réimpression pour l\'imprimer à nouveau.</p>' : ''}`;
    if (rentEl) rentEl.value = d.monthly_rent;
    if (amountEl && !amountEl.dataset.touched) {
      amountEl.value = d.balance > 0 ? d.balance : (d.has_full_receipt ? '' : d.monthly_rent);
      amountEl.placeholder = d.has_full_receipt && d.balance === 0
        ? 'Période déjà réglée' : String(d.monthly_rent);
    }
    form.dataset.status = d.status;
    form.dispatchEvent(new Event('change:status'));
    if (window.lucide) lucide.createIcons();
  }

  [tenantSel, yearEl, monthEl].forEach(el => el && el.addEventListener('change', refresh));
  amountEl && amountEl.addEventListener('input', () => { amountEl.dataset.touched = '1'; });
  if (tenantSel.value) refresh();
}

// Bascule "tout cocher" pour la sélection de quittances
function initSelectAll() {
  const boxes = Array.from(document.querySelectorAll('[data-selectable]'));
  const master = document.querySelector('[data-select-all]');
  const mode = document.querySelector('[data-print-mode]');
  const targets = [master, ...boxes, mode].filter(Boolean);
  targets.forEach(el => el.addEventListener('change', () => {
    if (el === master) boxes.forEach(cb => { cb.checked = master.checked; });
    updateSheetCount();
  }));
  updateSheetCount();
}

function updateSheetCount() {
  const boxes = Array.from(document.querySelectorAll('[data-selectable]'));
  const n = boxes.filter(cb => cb.checked).length;
  const modeEl = document.querySelector('[data-print-mode]');
  const mode = modeEl ? modeEl.value : 'trio';
  const sheets = mode === 'une' ? n : mode === 'copies' ? (n ? 1 : 0) : Math.ceil(n / 3);
  const per = mode === 'une' ? '1 page A4 par document'
    : mode === 'copies' ? '3 exemplaires identiques sur la même feuille'
    : '3 blocs par feuille, découpe sur les pointillés';
  const text = n === 0 ? 'Sélectionnez des quittances pour voir le nombre de feuilles.'
    : `${n} document${n > 1 ? 's' : ''} → ${sheets} page${sheets > 1 ? 's' : ''} A4 (${per}).`;
  const out = document.querySelector('[data-sheet-count]');
  if (out) out.textContent = text;
  const lot = document.querySelector('[data-lot-count]');
  if (lot) lot.textContent = text;
}
