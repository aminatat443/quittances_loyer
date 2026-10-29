'use strict';

const { Router } = require('../utils/router');
const { idOf } = require('../utils/params');
const unitsSvc = require('../services/units');
const flash = require('../services/flash');

const router = Router();

router.get('/', async (req, res) => {
  const [floors, types] = await Promise.all([unitsSvc.buildingByFloor(), unitsSvc.listUnitTypes()]);
  res.render('units/index', { title: 'Logements', floors, types });
});

router.get('/nouveau', async (req, res) => {
  const [floors, types] = await Promise.all([unitsSvc.listFloors(), unitsSvc.listUnitTypes()]);
  res.render('units/form', {
    title: 'Ajouter un logement',
    unit: null,
    floors,
    types,
    back: '/logements',
  });
});

router.post('/nouveau', async (req, res) => {
  try {
    await unitsSvc.createUnit(req.body);
    flash(req, 'Logement ajouté.');
    res.redirect('/logements');
  } catch (e) {
    flash(req, null, e.message);
    res.redirect('/logements/nouveau');
  }
});

router.get('/:id/modifier', async (req, res) => {
  const unit = await unitsSvc.getUnit(idOf(req.params.id));
  if (!unit) return res.status(404).render('error', { title: 'Introuvable', message: 'Logement inconnu.' });
  const [floors, types] = await Promise.all([unitsSvc.listFloors(), unitsSvc.listUnitTypes()]);
  res.render('units/form', {
    title: `Modifier ${unit.name}`,
    unit,
    floors,
    types,
    back: '/logements',
  });
});

router.post('/:id/modifier', async (req, res) => {
  try {
    await unitsSvc.updateUnit(idOf(req.params.id), req.body);
    flash(req, 'Logement mis à jour.');
  } catch (e) {
    flash(req, null, e.message);
  }
  res.redirect('/logements');
});

router.post('/:id/supprimer', async (req, res) => {
  try {
    await unitsSvc.deleteUnit(idOf(req.params.id));
    flash(req, 'Logement supprimé.');
  } catch (e) {
    flash(req, null, e.message);
  }
  res.redirect('/logements');
});

router.post('/etages', async (req, res) => {
  try {
    await unitsSvc.createFloor(req.body.label, req.body.short_label);
    flash(req, 'Étage ajouté.');
  } catch (e) {
    flash(req, null, e.message);
  }
  res.redirect('/logements');
});

module.exports = router;
