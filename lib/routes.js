export function registerRoutes(ctx) {
  const {
    route, sendJson, sendHtml, sendText, setCookie, clearCookie,
    loadConfig, saveConfig, netbirdExec,
    encryptSecret,
    pushNotification, sendNotification, _notifHistory, saveNotifHistory,
    inverterData, costState, dailyRecords, tuyaDevices, scenes, sceneTraces,
    controlDevice, fetchDeviceStatuses, syncDeviceNamesFromCloud, initTuya,
    loadScenes, saveScenes, checkScenes,
    deviceName, resolveInverterIP, saveDevices, resetInverterConnection,
    _inverterConsecutiveFails, pushSceneTrace,
    loadAuthFile, verifyPassword, hashPassword, createSession,
    getSessionCsrf, isSessionValid, destroySession, parseCookies,
    loginAttempts, sessions, clearSessions,
    log, logBuffer,
    rrdPickLevel, rrdGetPower, rrdGetSocket,
    fs, path, exec, execFile, os, __dirname,
    CONFIG_FILE, AUTH_FILE, SCENES_FILE, DEVICES_FILE, SESSIONS_FILE, DATA_DIR,
    getLoginPage, getWebUI,
  } = ctx;

  route('GET', '/healthz', (req, res) => {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const inverterOk = inverterData && inverterData.lastUpdate && (Date.now() - inverterData.lastUpdate) < 60000;
    const status = inverterOk ? 'ok' : 'degraded';
    sendJson(res, 200, {
      status,
      uptime: Math.round(uptime),
      memRss: mem.rss,
      memHeap: mem.heapUsed,
      inverterOnline: inverterOk,
      sessionCount: Object.keys(sessions).length,
    });
  });

  route('GET', '/login', (req, res) => {
    sendHtml(res, 200, getLoginPage());
  });

  route('POST', '/login', async (req, res) => {
    try {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      if (!loginAttempts[ip]) loginAttempts[ip] = [];
      loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < 60000);
      if (loginAttempts[ip].length >= 5) {
        return sendJson(res, 429, { success: false, message: 'Too many attempts. Please wait a minute.' });
      }
      const { username, password } = req.body || {};
      const auth0 = await loadAuthFile();
      const userOk = username === auth0.username;
      const passOk = userOk && verifyPassword(password || '', auth0.salt, auth0.hash);
      if (passOk) {
        delete loginAttempts[ip];
        const { token, csrf } = createSession();
        setCookie(res, 'ecm_session', token, 7 * 24 * 60 * 60, req);
        return sendJson(res, 200, { success: true, csrfToken: csrf, mustChangePassword: !!auth0.mustChangePassword });
      }
      loginAttempts[ip].push(now);
      return sendJson(res, 401, { success: false, message: 'Invalid login or password' });
    } catch (err) {
      return sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('POST', '/api/logout', (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.ecm_session) destroySession(cookies.ecm_session);
    clearCookie(res, 'ecm_session', req);
    sendJson(res, 200, { success: true });
  });

  route('POST', '/api/change-password', async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      const auth0 = await loadAuthFile();
      const curOk = verifyPassword(currentPassword || '', auth0.salt, auth0.hash);
      if (!curOk) return sendJson(res, 401, { success: false, message: 'Current password is incorrect' });
      if (!newPassword || newPassword.length < 6) return sendJson(res, 400, { success: false, message: 'Password must contain at least 6 characters' });
      const { salt, hash } = hashPassword(newPassword);
      auth0.salt = salt;
      auth0.hash = hash;
      auth0.mustChangePassword = false;
      await fs.promises.writeFile(AUTH_FILE, JSON.stringify(auth0, null, 2), { mode: 0o600 });
      clearSessions();
      log.info('Password changed, all sessions invalidated');
      sendJson(res, 200, { success: true, mustChangePassword: false });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('GET', '/api/status', async (req, res) => {
    const cookies = parseCookies(req);
    const csrfToken = getSessionCsrf(cookies.ecm_session);
    const cfg = await loadConfig();
    sendJson(res, 200, { csrfToken,
      costToday: { day: Math.round(costState.dayKwh * 100) / 100, night: Math.round(costState.nightKwh * 100) / 100 },
      tariff: cfg.tariff || { currency: 'UAH', type: 'daynight', flatRate: 0, dayRate: 0, nightRate: 0 },
      dailyRecords: dailyRecords.slice(-30),
      gridPower: inverterData.gridPower,
      gridRaw: inverterData.gridRaw,
      gridVoltage: inverterData.gridVoltage,
      batterySOC: inverterData.batterySOC,
      pvPower: inverterData.pvPower,
      pvPower2: inverterData.pvPower2,
      loadPower: inverterData.loadPower,
      batteryPower: inverterData.batteryPower,
      batteryTemp: inverterData.batteryTemp,
      envTemp: inverterData.envTemp,
      dayPV: inverterData.dayPV,
      dayGridImport: inverterData.dayGridImport,
      totalGridImport: inverterData.totalGridImport || 0,
      totalLoadEnergy: inverterData.totalLoadEnergy || 0,
      dayGridExport: inverterData.dayGridExport,
      dayBatCharge: inverterData.dayBatCharge,
      dayBatDischarge: inverterData.dayBatDischarge,
      dayLoadEnergy: inverterData.dayLoadEnergy,
      debug: inverterData.debug || {},
      tuyaDevices: tuyaDevices.map(d => ({ id: d.id, name: d.name, switch: d.switch, power: d.power || 0, voltage: d.voltage || 0, current: d.current || 0, group: d.group || '' })),
      scenes: scenes,
    });
  });

  route('GET', '/api/metrics', async (req, res) => {
    const cfg = await loadConfig();
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!cfg.metricsToken || token !== cfg.metricsToken) {
      return sendText(res, 401, '# unauthorized: missing or invalid ?token=\n');
    }
    const lines = [];
    const gauge = (name, help, value) => {
      lines.push('# HELP ' + name + ' ' + help);
      lines.push('# TYPE ' + name + ' gauge');
      lines.push(name + ' ' + (Number.isFinite(value) ? value : 0));
    };
    gauge('energy_controller_grid_up', 'Grid connection status (1=up, 0=down)', inverterData.gridPower ? 1 : 0);
    gauge('energy_controller_grid_voltage_volts', 'Grid voltage', inverterData.gridVoltage);
    gauge('energy_controller_battery_soc_percent', 'Battery state of charge', inverterData.batterySOC);
    gauge('energy_controller_battery_power_watts', 'Battery power (positive=discharging)', inverterData.batteryPower);
    gauge('energy_controller_battery_temp_celsius', 'Battery temperature', inverterData.batteryTemp);
    gauge('energy_controller_pv_power_watts', 'Total PV power (both strings)', (inverterData.pvPower || 0) + (inverterData.pvPower2 || 0));
    gauge('energy_controller_load_power_watts', 'House load power', inverterData.loadPower);
    gauge('energy_controller_day_pv_kwh', 'PV energy generated today', inverterData.dayPV);
    gauge('energy_controller_day_grid_import_kwh', 'Grid energy imported today', inverterData.dayGridImport);
    gauge('energy_controller_day_grid_export_kwh', 'Grid energy exported today', inverterData.dayGridExport);
    gauge('energy_controller_day_load_kwh', 'Load energy consumed today', inverterData.dayLoadEnergy);
    for (const dev of tuyaDevices) {
      const label = '{device="' + String(dev.name || dev.id).replace(/"/g, "'") + '"}';
      lines.push('energy_controller_socket_power_watts' + label + ' ' + (dev.power || 0));
      lines.push('energy_controller_socket_on' + label + ' ' + (dev.switch ? 1 : 0));
    }
    sendText(res, 200, lines.join('\n') + '\n');
  });

  route('GET', '/api/tuya-devices', (req, res) => {
    sendJson(res, 200, tuyaDevices.map(d => ({
      id: d.id, name: d.name, online: d.online, ip: d.ip || '', switch: d.switch, power: d.power || 0, voltage: d.voltage || 0, current: d.current || 0, group: d.group || '',
    })));
  });

  route('POST', '/api/tuya-control', async (req, res) => {
    const { deviceId, value } = req.body || {};
    try {
      await controlDevice(deviceId, value);
      sendJson(res, 200, { success: true, message: 'Device controlled' });
    } catch (err) {
      log.error('Control failed: ' + err.message);
      sendJson(res, 200, { success: false, message: err.message });
    }
  });

  route('POST', '/api/sync-tuya', async (req, res) => {
    try {
      await initTuya();
      saveDevices();
      sendJson(res, 200, { success: true, count: tuyaDevices.length });
    } catch (err) {
      sendJson(res, 200, { success: false, message: err.message });
    }
  });

  route('PATCH', '/api/tuya-devices/:id/group', async (req, res) => {
    try {
      const dev = tuyaDevices.find(d => d.id === req.params.id);
      if (!dev) return sendJson(res, 404, { success: false, message: 'Device not found' });
      dev.group = String(req.body.group || '').trim();
      saveDevices();
      sendJson(res, 200, { success: true, group: dev.group });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('GET', '/api/plugin-config', async (req, res) => {
    try {
      const cfg = await loadConfig();
      const safe = JSON.parse(JSON.stringify(cfg));
      if (safe.tuya && safe.tuya.password) safe.tuya.password = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      if (safe.tuya && safe.tuya.accessKey) safe.tuya.accessKey = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      if (safe.notifications && safe.notifications.telegramToken) safe.notifications.telegramToken = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      if (safe.netbird && safe.netbird.setupKey) safe.netbird.setupKey = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      sendJson(res, 200, { success: true, config: safe });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('POST', '/api/inverter/scan', async (req, res) => {
    try {
      const cfg = await loadConfig();
      const inv = cfg.inverter || {};
      if (!inv.mac) return sendJson(res, 400, { success: false, message: "MAC not configured" });
      const found = await resolveInverterIP(inv.mac, inv.ip);
      if (found) {
        if (found !== inv.ip) {
          cfg.inverter.ip = found;
          await saveConfig(cfg);
          log.info("Inverter scan: IP updated " + inv.ip + " -> " + found);
          resetInverterConnection();
        }
        sendJson(res, 200, { success: true, ip: found, updated: found !== inv.ip });
      } else {
        sendJson(res, 200, { success: false, message: "Inverter not found on network" });
      }
    } catch (e) {
      sendJson(res, 500, { success: false, message: e.message });
    }
  });

  route('GET', '/api/notifications', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const includeRead = url.searchParams.get('all') === '1';
    let list = includeRead ? _notifHistory : _notifHistory.filter(n => !n.dismissed);
    sendJson(res, 200, { success: true, notifications: list.reverse(), unread: list.filter(n => !n.read).length });
  });

  route('POST', '/api/notifications/dismiss', async (req, res) => {
    try {
      const b = req.body;
      const n = _notifHistory.find(x => x.id === b.id);
      if (n) n.dismissed = true;
      saveNotifHistory();
      sendJson(res, 200, { success: true });
    } catch (e) { sendJson(res, 400, { success: false, message: e.message }); }
  });

  route('POST', '/api/notifications/dismiss-all', async (req, res) => {
    _notifHistory.forEach(n => n.dismissed = true);
    saveNotifHistory();
    sendJson(res, 200, { success: true });
  });

    route('POST', '/api/notifications/mark-read', async (req, res) => {
    _notifHistory.forEach(n => n.read = true);
    saveNotifHistory();
    sendJson(res, 200, { success: true });
  });

  route('POST', '/api/notifications/add', async (req, res) => {
    try {
      const b = req.body;
      pushNotification(b.title || 'Notification', b.message || '', b.type || 'info');
      sendJson(res, 200, { success: true });
    } catch (e) { sendJson(res, 400, { success: false, message: e.message }); }
  });

  route('POST', '/api/plugin-config', async (req, res) => {
    try {
      const { config: newCfg } = req.body || {};
      if (!newCfg) return sendJson(res, 400, { success: false, message: 'No config provided' });
      const old = await loadConfig();
      const merged = JSON.parse(JSON.stringify(old));
      if (newCfg.inverter) merged.inverter = newCfg.inverter;
      if (newCfg.tuya) {
        merged.tuya = merged.tuya || {};
        for (const k of Object.keys(newCfg.tuya)) {
          if (newCfg.tuya[k] === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' || newCfg.tuya[k] === '') continue;
          if (k === 'password') {
            merged.tuya[k] = encryptSecret(newCfg.tuya[k]);
          } else {
            merged.tuya[k] = newCfg.tuya[k];
          }
        }
      }
      if (newCfg.webPort !== undefined) merged.webPort = parseInt(newCfg.webPort) || 8583;
      if (newCfg.notifications) {
        merged.notifications = merged.notifications || {};
        for (const k of ['ntfyTopic', 'telegramToken', 'telegramChatId']) {
          if (newCfg.notifications[k] === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' || newCfg.notifications[k] === '') continue;
          if (newCfg.notifications[k] !== undefined) merged.notifications[k] = newCfg.notifications[k];
        }
        if (newCfg.notifications.ntfyEnabled !== undefined) merged.notifications.ntfyEnabled = !!newCfg.notifications.ntfyEnabled;
        if (newCfg.notifications.telegramEnabled !== undefined) merged.notifications.telegramEnabled = !!newCfg.notifications.telegramEnabled;
        if (newCfg.notifications.criticalEnabled !== undefined) merged.notifications.criticalEnabled = !!newCfg.notifications.criticalEnabled;
        if (newCfg.notifications.lowSocAlert !== undefined) merged.notifications.lowSocAlert = parseInt(newCfg.notifications.lowSocAlert) || 20;
        if (newCfg.notifications.connTimeout !== undefined) merged.notifications.connTimeout = parseInt(newCfg.notifications.connTimeout) || 10;
        if (newCfg.notifications.gridOutageReport !== undefined) merged.notifications.gridOutageReport = newCfg.notifications.gridOutageReport;
      }
      if (newCfg.healthAlerts) {
        merged.healthAlerts = merged.healthAlerts || {};
        if (newCfg.healthAlerts.enabled !== undefined) merged.healthAlerts.enabled = !!newCfg.healthAlerts.enabled;
        if (newCfg.healthAlerts.diskThreshold !== undefined) merged.healthAlerts.diskThreshold = parseInt(newCfg.healthAlerts.diskThreshold) || 20;
        if (newCfg.healthAlerts.cpuTempThreshold !== undefined) merged.healthAlerts.cpuTempThreshold = parseInt(newCfg.healthAlerts.cpuTempThreshold) || 80;
        if (newCfg.healthAlerts.cpuLoadThreshold !== undefined) merged.healthAlerts.cpuLoadThreshold = parseFloat(newCfg.healthAlerts.cpuLoadThreshold) || 5;
        if (newCfg.healthAlerts.memThreshold !== undefined) merged.healthAlerts.memThreshold = parseInt(newCfg.healthAlerts.memThreshold) || 15;
      }
          if (newCfg.netbird) {
        merged.netbird = merged.netbird || {};
        for (const k of ['setupKey', 'managementUrl']) {
          if (newCfg.netbird[k] === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' || newCfg.netbird[k] === '') continue;
          merged.netbird[k] = newCfg.netbird[k];
        }
        if (newCfg.netbird.enabled !== undefined) merged.netbird.enabled = !!newCfg.netbird.enabled;
      }
      if (newCfg.tariff) {
        merged.tariff = merged.tariff || {};
        if (newCfg.tariff.currency !== undefined) merged.tariff.currency = String(newCfg.tariff.currency || 'UAH').slice(0, 8);
        if (newCfg.tariff.type !== undefined) merged.tariff.type = (newCfg.tariff.type === 'flat') ? 'flat' : 'daynight';
        if (newCfg.tariff.flatRate !== undefined) merged.tariff.flatRate = parseFloat(newCfg.tariff.flatRate) || 0;
        if (newCfg.tariff.dayRate !== undefined) merged.tariff.dayRate = parseFloat(newCfg.tariff.dayRate) || 0;
        if (newCfg.tariff.nightRate !== undefined) merged.tariff.nightRate = parseFloat(newCfg.tariff.nightRate) || 0;
        if (newCfg.tariff.dayStart !== undefined) merged.tariff.dayStart = newCfg.tariff.dayStart || '07:00';
        if (newCfg.tariff.nightStart !== undefined) merged.tariff.nightStart = newCfg.tariff.nightStart || '23:00';
      }
      await saveConfig(merged);
      sendJson(res, 200, { success: true, message: 'Config saved. Restart to apply.' });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('GET', '/api/netbird/status', async (req, res) => {
    try {
      const r = await netbirdExec(['status']);
      const cfg = await loadConfig();
      const nb = cfg.netbird || {};
      const daemonOk = !r.stderr.includes('no such file') && !r.stderr.includes('connect to daemon') && !r.stderr.includes('Daemon');
      sendJson(res, 200, { success: !!r.stdout || daemonOk, status: r.stdout || 'Daemon not running', enabled: !!nb.enabled });
    } catch (err) {
      sendJson(res, 200, { success: false, message: err.message });
    }
  });

  route('POST', '/api/netbird/up', async (req, res) => {
    try {
      const cfg = await loadConfig();
      const nb = cfg.netbird || {};
      if (!nb.setupKey || nb.setupKey === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022') {
        return sendJson(res, 400, { success: false, message: 'Setup key not configured. Save settings first.' });
      }
      await new Promise((resolve) => {
        exec('sudo netbird service start', { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) log.warn('netbird service start (non-fatal): ' + (stderr || err.message));
          resolve();
        });
      });
      const args = ['up', '--setup-key', nb.setupKey];
      if (nb.managementUrl) { args.push('--management-url', nb.managementUrl); }
      const r = await netbirdExec(args);
      if (r.err) {
        sendJson(res, 200, { success: false, message: r.stderr || r.err.message });
      } else {
        cfg.netbird = cfg.netbird || {}; cfg.netbird.enabled = true;
        await saveConfig(cfg);
        exec('sudo systemctl enable netbird', (err) => {
          if (err) log.warn('systemctl enable netbird (non-fatal): ' + err.message);
        });
        sendJson(res, 200, { success: true, message: 'Connected to NetBird' });
      }
    } catch (err) {
      sendJson(res, 200, { success: false, message: err.message });
    }
  });

  route('POST', '/api/netbird/down', async (req, res) => {
    try {
      const r = await netbirdExec(['down']);
      if (r.err) {
        exec('sudo netbird service stop && sudo systemctl disable netbird', (err) => {});
        sendJson(res, 200, { success: false, message: r.stderr || r.err.message });
      } else {
        await new Promise((resolve) => {
          exec('sudo netbird service stop && sudo systemctl disable netbird', { timeout: 15000 }, (err) => {
            if (err) log.warn('netbird service stop (non-fatal): ' + err.message);
            resolve();
          });
        });
        const cfg = await loadConfig();
        cfg.netbird = cfg.netbird || {}; cfg.netbird.enabled = false;
        await saveConfig(cfg);
        sendJson(res, 200, { success: true, message: 'Disconnected from NetBird' });
      }
    } catch (err) {
      sendJson(res, 200, { success: false, message: err.message });
    }
  });

  route('POST', '/api/test-notification', async (req, res) => {
    const results = await sendNotification('Test', 'Energy Controller notification test at ' + new Date().toLocaleString());
    sendJson(res, 200, { success: true, results });
  });

  route('GET', '/api/scenes', (req, res) => {
    sendJson(res, 200, scenes);
  });

  route('POST', '/api/scenes', async (req, res) => {
    const scene = req.body || {};
    scene.enabled = true;
    scenes.push(scene);
    await saveScenes();
    sendJson(res, 200, { success: true });
  });

  route('DELETE', '/api/scenes/:name', async (req, res) => {
    const idx = scenes.findIndex(s => s.name === req.params.name);
    if (idx >= 0) scenes.splice(idx, 1);
    await saveScenes();
    sendJson(res, 200, { success: true });
  });

  route('PATCH', '/api/scenes/:name', async (req, res) => {
    const scene = scenes.find(s => s.name === req.params.name);
    if (!scene) return sendJson(res, 404, { success: false, message: 'Scene not found' });
    scene.enabled = (req.body || {}).enabled === true;
    await saveScenes();
    sendJson(res, 200, { success: true, enabled: scene.enabled });
  });

  route('GET', '/api/scene-traces', (req, res) => {
    const last = parseInt(req.url.split('last=')[1]) || 5;
    const map = {};
    for (const t of sceneTraces) {
      if (!map[t.scene]) map[t.scene] = [];
      map[t.scene].push(t);
    }
    sendJson(res, 200, { success: true, traces: map });
  });

  route('POST', '/api/scenes/:name/run', async (req, res) => {
    const scene = scenes.find(s => s.name === req.params.name);
    if (!scene) return sendJson(res, 404, { success: false, message: 'Scene not found' });
    const results = [];
    for (const action of (scene.then && scene.then.actions) || []) {
      try {
          await controlDevice(action.device, action.value);
          pushNotification('Automation "' + scene.name + '" (manual)', deviceName(action.device) + ' = ' + (action.value ? 'ON' : 'OFF'), 'info');
          pushSceneTrace(scene.name, 'apply (manual)', action.device + '=' + (action.value ? 'ON' : 'OFF'));
          results.push({ ok: true, action: action.device });
      } catch (err) {
        pushNotification('Automation "' + scene.name + '" (manual)', 'Failed: ' + err.message, 'error');
        pushSceneTrace(scene.name, 'apply:error (manual)', err.message);
        results.push({ ok: false, action: action.device || 'notify', error: err.message });
      }
    }
    sendJson(res, 200, { success: true, results });
  });

  route('GET', '/api/device-ping/:ip', (req, res) => {
    const ip = req.params.ip;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return sendJson(res, 400, { success: false, message: 'Invalid IP address' });
    }
    execFile('ping', ['-c', '1', '-W', '1', ip], (error) => {
      sendJson(res, 200, { success: true, ip, online: error === null });
    });
  });

  route('GET', '/api/logs', (req, res) => {
    if (logBuffer.length > 0) {
      sendJson(res, 200, { success: true, logs: logBuffer.join('\n') });
      return;
    }
    try {
      exec('journalctl -u energy-controller --no-pager -n 100 --output=cat 2>/dev/null || echo ""', (err, stdout) => {
        const logs = (stdout || '').trim();
        sendJson(res, 200, { success: true, logs });
      });
    } catch (err) {
      sendJson(res, 200, { success: true, logs: '' });
    }
  });

  route('GET', '/api/history', (req, res) => {
    try {
      const period = (req.url.split('period=')[1] || 'day').split('&')[0];
      const level = rrdPickLevel(period);
      const today = new Date();
      const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      let cutoffMs;
      switch (period) {
        case '1h': cutoffMs = 60 * 60 * 1000; break;
        case '3h': cutoffMs = 3 * 60 * 60 * 1000; break;
        case '6h': cutoffMs = 6 * 60 * 60 * 1000; break;
        case '12h': cutoffMs = 12 * 60 * 60 * 1000; break;
        case 'week': { const day = today.getDay(); const diff = (day === 0 ? 6 : day - 1); cutoffMs = Date.now() - (midnight - diff * 24 * 60 * 60 * 1000); break; }
        case 'month': cutoffMs = Date.now() - new Date(today.getFullYear(), today.getMonth(), 1).getTime(); break;
        case 'year': cutoffMs = Date.now() - new Date(today.getFullYear(), 0, 1).getTime(); break;
        default: cutoffMs = Date.now() - midnight;
      }
      const points = rrdGetPower(level, cutoffMs);
      sendJson(res, 200, { success: true, period, points });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('GET', '/api/socket-history', (req, res) => {
    try {
      const period = (req.url.split('period=')[1] || 'day').split('&')[0];
      const level = rrdPickLevel(period);
      const today = new Date();
      const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      let cutoffMs;
      switch (period) {
        case '1h': cutoffMs = 60 * 60 * 1000; break;
        case '3h': cutoffMs = 3 * 60 * 60 * 1000; break;
        case '6h': cutoffMs = 6 * 60 * 60 * 1000; break;
        case '12h': cutoffMs = 12 * 60 * 60 * 1000; break;
        case 'week': { const day = today.getDay(); const diff = (day === 0 ? 6 : day - 1); cutoffMs = Date.now() - (midnight - diff * 24 * 60 * 60 * 1000); break; }
        case 'month': cutoffMs = Date.now() - new Date(today.getFullYear(), today.getMonth(), 1).getTime(); break;
        case 'year': cutoffMs = Date.now() - new Date(today.getFullYear(), 0, 1).getTime(); break;
        default: cutoffMs = Date.now() - midnight;
      }
      const points = rrdGetSocket(level, cutoffMs);
      const deviceNames = {};
      for (const dev of tuyaDevices) {
        deviceNames[dev.id] = dev.name;
      }
      sendJson(res, 200, { success: true, period, points, deviceNames });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('POST', '/api/restart', (req, res) => {
    sendJson(res, 200, { success: true, message: 'Restarting...' });
    setTimeout(() => {
      exec('sudo systemctl restart energy-controller', () => {});
    }, 500);
  });

  route('GET', '/api/system-info', async (req, res) => {
    let cpuTemp = null, cpuFreq = null;
    try {
      const tempRaw = await fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
      cpuTemp = (parseInt(tempRaw) / 1000).toFixed(1);
    } catch (_) {}
    try {
      const freqRaw = await fs.promises.readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8');
      cpuFreq = (parseInt(freqRaw) / 1000).toFixed(0);
    } catch (_) {}
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    let diskInfo = {};
    try {
      const df = await new Promise((resolve, reject) => {
        exec('df -k / | tail -1', (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
      });
      const parts = df.split(/\s+/);
      if (parts.length >= 5) {
        diskInfo = { total: parseInt(parts[1]) * 1024, used: parseInt(parts[2]) * 1024, available: parseInt(parts[3]) * 1024 };
      }
    } catch (_) {}
    sendJson(res, 200, {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: os.uptime(),
      nodeVersion: process.version,
      cpuModel: cpus[0]?.model || '',
      cpuCores: cpus.length,
      cpuLoad: os.loadavg(),
      cpuTemp,
      cpuFreq,
      totalMem,
      freeMem,
      usedMem: totalMem - freeMem,
      diskInfo,
    });
  });

  route('GET', '/api/app-version', async (req, res) => {
    try {
      const pkg = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'package.json'), 'utf8'));
      let version = pkg.version || '1.0.0';
      let gitHash = '', gitBranch = '', gitRemote = '', isGitRepo = false;
      try {
        gitHash = (await new Promise((resolve, reject) => {
          exec('git rev-parse --short HEAD', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
        }));
        gitBranch = (await new Promise((resolve, reject) => {
          exec('git branch --show-current', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
        }));
        gitRemote = (await new Promise((resolve, reject) => {
          exec('git remote get-url origin', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
        }));
        try {
          const desc = await new Promise((resolve, reject) => {
            exec('git describe --tags', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
          });
          version = desc;
        } catch {
          try {
            const cnt = await new Promise((resolve, reject) => {
              exec('git rev-list --count HEAD', { cwd: __dirname }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
            });
            version = 'r' + cnt;
          } catch {}
        }
        isGitRepo = true;
      } catch {}
      sendJson(res, 200, { success: true, version, gitHash, gitBranch, gitRemote, isGit: isGitRepo });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('POST', '/api/update-check', async (req, res) => {
    try {
      const isGit = (await new Promise(r => exec('git rev-parse --is-inside-work-tree', { cwd: __dirname }, (e, o) => r(!e && o.trim() === 'true'))));
      if (!isGit) return sendJson(res, 200, { success: true, isGit: false, message: 'Not a git repository' });
      try { await new Promise(r => { exec('git fetch --all --tags --force 2>/dev/null', { cwd: __dirname }, () => r()); }); } catch {}
      const tags = (await new Promise(r => exec('git tag --sort=-v:refname', { cwd: __dirname }, (e, o) => r(o || '')))).trim().split('\n').filter(Boolean);
      const currentTag = (await new Promise(r => exec('git describe --tags --exact-match 2>/dev/null || true', { cwd: __dirname }, (e, o) => r(o || '')))).trim();
      const currentBranch = (await new Promise(r => exec('git rev-parse --abbrev-ref HEAD', { cwd: __dirname }, (e, o) => r((o || '').trim())))).trim();
      const local = (await new Promise(r => exec('git rev-parse HEAD', { cwd: __dirname }, (e, o) => r(o.trim())))).trim();
      let branches = [];
      try {
        const remoteOutput = await new Promise(r => exec('git branch -r --format=%(refname:short) 2>/dev/null', { cwd: __dirname }, (e, o) => r(o || '')));
        const branchLines = remoteOutput.trim().split('\n').filter(Boolean);
        for (const b of branchLines) {
          const clean = b.replace(/^origin\//, '');
          if (clean === 'HEAD') continue;
          const commitInfo = await new Promise(r => exec('git log -1 --format=%h|%s|%ci ' + b.trim(), { cwd: __dirname }, (e, o) => r(o || '')));
          const parts = commitInfo.trim().split('|');
          branches.push({ name: clean, commit: parts[0] || '', message: parts[1] || '', date: parts[2] || '' });
        }
      } catch {}
      sendJson(res, 200, { success: true, isGit: true, tags, currentTag, currentBranch, branches, local: local.slice(0, 7) });
    } catch (err) {
      sendJson(res, 200, { success: false, message: err.message });
    }
  });

  route('POST', '/api/update-apply', (req, res) => {
    const tag = req.body && req.body.tag;
    const branch = req.body && req.body.branch;
    if (tag && branch) return sendJson(res, 400, { success: false, message: 'Specify either tag or branch, not both' });
    if (!tag && !branch) return sendJson(res, 400, { success: false, message: 'Tag or branch required' });
    const target = tag || branch;
    if (typeof target !== 'string' || target.length > 100 || /[^a-zA-Z0-9._\/-]/.test(target)) {
      return sendJson(res, 400, { success: false, message: 'Invalid target name' });
    }
    execFile('git', ['fetch', '--all', '--tags', '--force'], { cwd: __dirname, maxBuffer: 1024 * 1024 }, () => {
      if (tag) {
        execFile('git', ['tag', '--list'], { cwd: __dirname, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err) return sendJson(res, 500, { success: false, message: 'Failed to list tags' });
          const validTags = (stdout || '').trim().split('\n').filter(Boolean);
          if (!validTags.includes(tag)) return sendJson(res, 400, { success: false, message: 'Unknown tag: ' + tag + '. Available: ' + validTags.join(', ') });
          execFile('git', ['verify-tag', tag], { cwd: __dirname }, (verr) => {
            if (verr) log.warn('Tag signature verification failed for ' + tag + ': ' + verr.message + ' (continuing)');
            sendJson(res, 200, { success: true, message: 'Updating to tag ' + tag + '...' });
            setTimeout(() => {
              execFile('git', ['checkout', tag], { cwd: __dirname, maxBuffer: 1024 * 1024 }, (e2, o2) => {
                log.info('Git checkout ' + tag + ': ' + (e2 ? e2.message : (o2 || '').trim()));
                execFile('git', ['log', '-1', '--oneline'], { cwd: __dirname }, (e3, o3) => {
                  if (!e3) log.info('Checked out: ' + (o3 || '').trim());
                  setTimeout(() => { exec('sudo systemctl restart energy-controller', () => {}); }, 1000);
                });
              });
            }, 500);
          });
        });
      } else {
        execFile('git', ['branch', '-r', '--list', 'origin/' + branch], { cwd: __dirname, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err || !(stdout || '').trim()) return sendJson(res, 400, { success: false, message: 'Unknown remote branch: ' + branch });
          sendJson(res, 200, { success: true, message: 'Updating to branch ' + branch + '...' });
          setTimeout(() => {
            execFile('git', ['stash', '--include-untracked'], { cwd: __dirname }, () => {
              execFile('git', ['reset', '--hard', 'origin/' + branch], { cwd: __dirname, maxBuffer: 1024 * 1024 }, (e2, o2) => {
                log.info('Git reset --hard origin/' + branch + ': ' + (e2 ? e2.message : (o2 || '').trim()));
                execFile('git', ['log', '-1', '--oneline'], { cwd: __dirname }, (e3, o3) => {
                  if (!e3) log.info('Checked out: ' + (o3 || '').trim());
                  setTimeout(() => { exec('sudo systemctl restart energy-controller', () => {}); }, 1000);
                });
              });
            });
          }, 500);
        });
      }
    });
  });

  route('POST', '/api/backup', async (req, res) => {
    try {
      const { scope } = req.body || {};
      if (!Array.isArray(scope)) return sendJson(res, 400, { success: false, message: 'Invalid scope' });
      const data = {};
      for (const s of scope) {
        if (s === 'config') {
          try { data.config = JSON.parse(await fs.promises.readFile(CONFIG_FILE, 'utf8')); } catch { data.config = {}; }
        }
        if (s === 'auth') {
          try { data.auth = JSON.parse(await fs.promises.readFile(AUTH_FILE, 'utf8')); } catch { data.auth = {}; }
        }
        if (s === 'scenes') {
          try { data.scenes = JSON.parse(await fs.promises.readFile(SCENES_FILE, 'utf8')); } catch { data.scenes = []; }
        }
        if (s === 'history') {
          try { data.history = {}; for (const l of ['1m','15m','1h']) data.history[l] = JSON.parse(await fs.promises.readFile(DATA_DIR + '/history_' + l + '.json', 'utf8')); } catch { data.history = {}; }
          try { data.socketHistory = {}; for (const l of ['1m','15m','1h']) data.socketHistory[l] = JSON.parse(await fs.promises.readFile(DATA_DIR + '/sockets_' + l + '.json', 'utf8')); } catch { data.socketHistory = {}; }
        }
        if (s === 'devices') {
          try { data.devices = JSON.parse(await fs.promises.readFile(DEVICES_FILE, 'utf8')); } catch { data.devices = []; }
        }
      }
      const pkg = await new Promise(r => exec('git rev-parse --short HEAD', { cwd: __dirname }, (e, o) => r(e ? 'unknown' : o.trim())));
      sendJson(res, 200, { success: true, backup: { version: '1.0', createdAt: new Date().toISOString(), gitHash: pkg, data } });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('POST', '/api/backup/restore', async (req, res) => {
    try {
      const { data, overwrite, confirmPassword } = req.body || {};
      if (!data) return sendJson(res, 400, { success: false, message: 'No backup data' });
      const files = overwrite || ['config', 'auth', 'scenes', 'history'];
      
      if (files.includes('auth') && data.auth && data.auth.salt && data.auth.hash) {
        if (!confirmPassword) {
          return sendJson(res, 400, { success: false, message: 'Current password required to restore authentication settings' });
        }
        const auth0 = await loadAuthFile();
        const passOk = verifyPassword(confirmPassword, auth0.salt, auth0.hash);
        if (!passOk) {
          return sendJson(res, 401, { success: false, message: 'Incorrect password' });
        }
      }
      
      for (const f of files) {
        if (f === 'config' && data.config) {
          try { const cur = JSON.parse(await fs.promises.readFile(CONFIG_FILE, 'utf8')); const m = { ...cur, ...data.config }; await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(m, null, 2), { mode: 0o600 }); } catch { await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(data.config, null, 2), { mode: 0o600 }); }
        }
        if (f === 'auth' && data.auth && data.auth.salt && data.auth.hash) {
          await fs.promises.writeFile(AUTH_FILE, JSON.stringify(data.auth, null, 2), { mode: 0o600 });
        }
        if (f === 'scenes' && data.scenes) {
          await fs.promises.writeFile(SCENES_FILE, JSON.stringify(data.scenes, null, 2), { mode: 0o600 });
        }
        if (f === 'history' && data.history) {
          for (const l of ['1m','15m','1h']) {
            if (data.history[l]) await fs.promises.writeFile(DATA_DIR + '/history_' + l + '.json', JSON.stringify(data.history[l], null, 2), { mode: 0o600 });
          }
        }
        if (f === 'history' && data.socketHistory) {
          for (const l of ['1m','15m','1h']) {
            if (data.socketHistory[l]) await fs.promises.writeFile(DATA_DIR + '/sockets_' + l + '.json', JSON.stringify(data.socketHistory[l], null, 2), { mode: 0o600 });
          }
        }
        if (f === 'devices' && data.devices) {
          await fs.promises.writeFile(DEVICES_FILE, JSON.stringify(data.devices, null, 2), { mode: 0o600 });
        }
      }
      if (files.includes('scenes')) await loadScenes();
      sendJson(res, 200, { success: true, message: 'Restore complete. Changes applied immediately.' });
    } catch (err) {
      sendJson(res, 500, { success: false, message: err.message });
    }
  });

  route('GET', '/', (req, res) => {
    sendHtml(res, 200, getWebUI());
  });

  route('GET', '/manifest.json', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify({
      name: 'Energy Controller',
      short_name: 'Energy',
      description: 'Energy conservation controller dashboard',
      start_url: '/',
      display: 'standalone',
      background_color: '#000000',
      theme_color: '#000000',
      orientation: 'any',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    }));
  });

  route('GET', '/sw.js', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(`
  const CACHE = 'ecm-v5';
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.map(x => caches.delete(x))))); self.clients.claim(); });
  self.addEventListener('fetch', e => {
    if (e.request.url.includes('/api/') || e.request.destination === 'document') return;
    e.respondWith(fetch(e.request).then(resp => {
      if (resp.ok && e.request.method === 'GET') { const c = resp.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); }
      return resp;
    }).catch(() => caches.match(e.request)));
  });
  `);
  });

  }


