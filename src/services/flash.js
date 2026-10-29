'use strict';

module.exports = function flash(req, ok, err) {
  if (ok) req.session.flashOk = ok;
  if (err) req.session.flashErr = err;
};
