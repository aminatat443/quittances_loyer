'use strict';

const { Router } = require('../utils/router');
const stats = require('../services/stats');

const router = Router();

function parsePeriod(q) {
  const now = new Date();
  const year = Math.min(2100, Math.max(2000, Number(q.year) || now.getFullYear()));
  const month = Math.min(12, Math.max(1, Number(q.month) || now.getMonth() + 1));
  return { year, month };
}

router.get('/', async (req, res) => {
  const { year, month } = parsePeriod(req.query);
  const [occ, totals, counts, pending, recent] = await Promise.all([
    stats.occupancyCounts(),
    stats.monthTotals(year, month),
    stats.paidCounts(year, month),
    stats.pendingCount(year, month),
    stats.recentReceipts(6),
  ]);

  res.render('dashboard', {
    title: 'Tableau de bord',
    year, month, occ, totals, counts, pending,
    recent: recent.map(r => ({ ...r, tenant_name: `${r.first_name} ${r.last_name}`.trim() })),
  });
});

module.exports = router;
