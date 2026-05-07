(function () {
  var AUTH_PAGES = ['/login.html', '/register.html', '/logout.html', '/index.html', '/'];
  var ROLE_PATH_PREFIXES = {
    ristoratore: '/ristoratore/',
    cliente: '/cliente/'
  };

  function getCurrentPath() {
    return window.location.pathname || '/';
  }

  function normalizePathname(pathname) {
    if (!pathname) return '/';
    return pathname.split('?')[0].split('#')[0] || '/';
  }

  function isAuthPage(pathname) {
    return AUTH_PAGES.includes(normalizePathname(pathname));
  }

  function saveLastVisitedPath(pathname) {
    try {
      if (!isAuthPage(pathname)) {
        sessionStorage.setItem('lastVisitedPath', pathname + window.location.search + window.location.hash);
      }
    } catch (error) {
      console.warn('Impossibile salvare il percorso corrente:', error);
    }
  }

  function restoreLastVisitedPath(payload) {
    var pathname = getCurrentPath();
    if (pathname !== '/login.html' || !payload) return;

    try {
      var fallbackPath = payload.role === 'ristoratore' ? '/ristoratore/home.html' : '/cliente/home.html';
      var targetPath = sessionStorage.getItem('lastVisitedPath') || fallbackPath;

      if (targetPath && !isAuthPage(targetPath)) {
        window.location.replace(targetPath);
      }
    } catch (error) {
      console.warn('Impossibile ripristinare l’ultima pagina visitata:', error);
    }
  }

  function decodeJwtPayload(token) {
    var parts = token.split('.');
    if (parts.length < 2) return null;

    var base64Url = parts[1];
    var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    var padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

    try {
      return JSON.parse(atob(padded));
    } catch (error) {
      console.error('Token JWT non decodificabile:', error);
      return null;
    }
  }

  function showAuthIssue(message) {
    console.warn('Controllo autenticazione:', message);
    return false;
  }

  function inferRoleFromPath(pathname) {
    if (!pathname) return null;
    if (pathname.indexOf(ROLE_PATH_PREFIXES.ristoratore) === 0) return 'ristoratore';
    if (pathname.indexOf(ROLE_PATH_PREFIXES.cliente) === 0) return 'cliente';
    return null;
  }

  function getRoleScopedValue(baseKey, role) {
    if (!role) return null;
    return localStorage.getItem(baseKey + '_' + role);
  }

  function setRoleScopedValue(baseKey, role, value) {
    if (!role || value === null || value === undefined || value === '') return;
    localStorage.setItem(baseKey + '_' + role, value);
  }

  function validateSession(expectedRole) {
    var pathname = getCurrentPath();
    var roleFromPath = inferRoleFromPath(pathname);
    var activeRole = expectedRole || roleFromPath;

    var token = getRoleScopedValue('token', activeRole) || localStorage.getItem('token');
    if (!token) return null;

    var payload = decodeJwtPayload(token);
    if (!payload || !payload.role || !payload.userId) return null;

    if (activeRole && payload.role !== activeRole) {
      var fallbackToken = localStorage.getItem('token');
      var fallbackPayload = fallbackToken ? decodeJwtPayload(fallbackToken) : null;
      if (!fallbackPayload || fallbackPayload.role !== activeRole || !fallbackPayload.userId) {
        return null;
      }
      token = fallbackToken;
      payload = fallbackPayload;
    }

    localStorage.setItem('token', token);
    localStorage.setItem('role', payload.role);
    localStorage.setItem('userId', payload.userId);
    setRoleScopedValue('token', payload.role, token);
    setRoleScopedValue('userId', payload.role, payload.userId);

    saveLastVisitedPath(pathname);
    return payload;
  }

  (function bootstrapNavigationState() {
    var payload = validateSession();
    restoreLastVisitedPath(payload);
  })();

  window.handleAuthIssue = function (reason) {
    return showAuthIssue(reason || 'sessione non valida');
  };

  window.ensureAuthenticated = function () {
    var payload = validateSession();
    if (!payload) {
      return showAuthIssue('utente non autenticato');
    }
    return true;
  };

  window.ensureAuthenticatedRole = function (expectedRole) {
    var payload = validateSession(expectedRole);
    if (!payload) {
      return showAuthIssue('utente non autenticato');
    }

    // Evita redirect involontari su refresh: in caso di mismatch ruolo rimaniamo nella pagina.
    if (payload.role !== expectedRole) {
      return showAuthIssue('ruolo non autorizzato');
    }

    return true;
  };
})();
