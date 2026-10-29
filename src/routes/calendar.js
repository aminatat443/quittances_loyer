'use strict';

const { Router } = require('../utils/router');
const stats = require('../services/stats');
const rent = require('../services/rent');
const db = require('../db');

const router = Router();

router.get('/', async (req, res) => {
  const now = new Date();
  let year = Number(req.query.year) || now.getFullYear();
  let month = Number(req.query.month) || now.getMonth() + 1;
  year = Math.min(2100, Math.max(2000, year));
  month = Math.min(12, Math.max(1, month));

  const board = (await stats.monthlyBoard(year, month)).map(r => ({
    ...r,
    period_status: r.status,
  }));
  const totals = {
    expected: board.reduce((s, r) => s + r.expected, 0),
    paid: board.reduce((s, r) => s + r.paid, 0),
    balance: board.reduce((s, r) => s + r.balance, 0),
  };
  res.render('calendar/index', {
    title: 'Suivi mensuel',
    year, month, board, totals,
    periodLabel: rent.decoratePeriodLabel(year, month),
    tenants: await db.prepare(`SELECT id, first_name, last_name FROM tenants WHERE status = 'active'
                         ORDER BY lower(last_name)`).all(),
  });
});

module.exports = router;
