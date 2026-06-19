const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const os = require('os');

// ── Custom userData path (must be set before app is ready) ──────
// Disable sandbox-related disk caches via command-line switches to avoid
// the "Unable to move the cache: 拒绝访问" errors. These are cosmetic
// warnings and do not affect the app's functionality.
const userDataPath = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.zcode-account-manager'
);
try {
  app.setPath('userData', userDataPath);
} catch (e) {
  // Fallback to default if custom path fails
  console.warn('Using default userData path');
}

// ── Config paths ──────────────────────────────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME;
const V2_DIR = path.join(HOME, '.zcode', 'v2');
const SETTING_PATH = path.join(V2_DIR, 'setting.json');
const CREDENTIALS_PATH = path.join(V2_DIR, 'credentials.json');
const CONFIG_PATH = path.join(V2_DIR, 'config.json');
const PLAN_CACHE_PATH = path.join(V2_DIR, 'coding-plan-cache.json');
const SNAPSHOTS_DIR = path.join(V2_DIR, 'account-snapshots');
const AUTO_BACKUP_DIR = path.join(SNAPSHOTS_DIR, '_auto-backup');

const ZCODE_HOST = 'zcode.z.ai';

// ── Helper: read JSON safely ──────────────────────────────────
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Helper: https GET request ──────────────────────────────────
function httpsGet(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: headers || {},
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Credential decryption (AES-256-GCM, machine-bound key) ─────
// Mirrors ZCode's own cipher: key = SHA256(secret), secret derives from
// ZCODE_CREDENTIAL_SECRET env var or a platform:homedir:username fallback.
// Format: enc:v1:<iv>.<authTag>.<ciphertext>  (all base64url).
const CRED_PREFIX = 'enc:v1:';

function resolveCredentialSecret() {
  const env = process.env.ZCODE_CREDENTIAL_SECRET;
  if (env && env.trim()) return env.trim();
  let user = 'unknown';
  try { user = os.userInfo().username; } catch (e) { /* ignore */ }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${user}`;
}

const CRED_KEY = crypto.createHash('sha256').update(resolveCredentialSecret()).digest();

function decryptCredential(enc) {
  if (!enc || typeof enc !== 'string' || !enc.startsWith(CRED_PREFIX)) return enc;
  const parts = enc.slice(CRED_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('invalid ciphertext format');
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const ct = Buffer.from(parts[2], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid iv/tag length');
  const d = crypto.createDecipheriv('aes-256-gcm', CRED_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf-8');
}

// Decrypt a field from the given credentials object; returns null on failure.
function decryptField(credentials, key) {
  try {
    const raw = credentials?.[key];
    if (!raw) return null;
    return decryptCredential(raw);
  } catch (e) {
    return null;
  }
}

// Extract { user_id, email, name, avatar } from a credentials blob.
// Falls back gracefully if user_info is missing or undecryptable.
function extractUserInfo(credentials) {
  const info = { userId: null, email: null, name: null, avatar: null };
  if (!credentials) return info;

  // 1. user_info is the richest source (email/name/avatar)
  const raw = decryptField(credentials, 'oauth:zai:user_info') ||
              decryptField(credentials, 'oauth:bigmodel:user_info');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      info.userId = parsed.user_id || info.userId;
      info.email = parsed.email || info.email;
      info.name = parsed.name || info.name;
      info.avatar = parsed.avatar || info.avatar;
    } catch (e) { /* malformed JSON, keep defaults */ }
  }

  // 2. JWT payload also carries user_id (no email, but stable id)
  if (!info.userId) {
    const jwt = decryptField(credentials, 'zcodejwttoken');
    if (jwt && jwt.split('.').length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
        info.userId = payload.user_id || payload.sub || info.userId;
      } catch (e) { /* ignore */ }
    }
  }

  return info;
}

// ── ZCode process management (auto-restart) ───────────────────
const { execSync, spawn } = require('child_process');

const ZCODE_EXE = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'),
  'Programs', 'ZCode', 'ZCode.exe'
);

function killZCodeProcesses() {
  try {
    // Gracefully close all ZCode windows first (WM_CLOSE)
    execSync('taskkill /IM ZCode.exe /T /F', { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    // No ZCode process running — that's fine
  }
}

function restartZCode() {
  try {
    killZCodeProcesses();
    // Wait a moment for processes to fully exit, then relaunch
    setTimeout(() => {
      try {
        spawn(ZCODE_EXE, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (e) {
        console.warn('Failed to relaunch ZCode:', e.message);
      }
    }, 1500);
  } catch (e) {
    console.warn('Failed to kill ZCode:', e.message);
  }
}

// ── Auto-backup before destructive operations ──────────────────
function autoBackup() {
  ensureDir(AUTO_BACKUP_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(CREDENTIALS_PATH)) {
    const dest = path.join(AUTO_BACKUP_DIR, `credentials_${ts}.json`);
    fs.copyFileSync(CREDENTIALS_PATH, dest);
  }
  if (fs.existsSync(SETTING_PATH)) {
    const dest = path.join(AUTO_BACKUP_DIR, `setting_${ts}.json`);
    fs.copyFileSync(SETTING_PATH, dest);
  }
  // Keep only last 10 auto-backups
  cleanupOldBackups(AUTO_BACKUP_DIR, 10);
}

function cleanupOldBackups(dir, keep) {
  ensureDir(dir);
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  files.slice(keep).forEach(f => {
    try { fs.unlinkSync(path.join(dir, f.name)); } catch (e) { /* ignore */ }
  });
}

// ── IPC Handlers ───────────────────────────────────────────────

// 1. Get current provider state
ipcMain.handle('get-provider-state', async () => {
  const settings = readJson(SETTING_PATH);
  const planCache = readJson(PLAN_CACHE_PATH);
  const credentials = readJson(CREDENTIALS_PATH);

  const currentFamily = settings?.providerFamilyDomain || 'zai';
  const familyModes = settings?.modelProviderFamilyModes || {};

  // Check login status by looking at credentials
  const zaiLoggedIn = !!(credentials?.['oauth:zai:access_token']);
  const bigmodelLoggedIn = !!(credentials?.['oauth:bigmodel:access_token']);

  // Check plan availability
  const planStatus = {};
  if (planCache?.entryStatus?.items) {
    for (const [id, info] of Object.entries(planCache.entryStatus.items)) {
      planStatus[id] = info;
    }
  }

  return {
    currentFamily,
    familyModes,
    zaiLoggedIn,
    bigmodelLoggedIn,
    planStatus,
    activeProvider: credentials?.['oauth:active_provider'] ? 'has_token' : 'none',
  };
});

// 2. Switch provider family
ipcMain.handle('switch-family', async (event, targetFamily) => {
  const settings = readJson(SETTING_PATH);
  if (!settings) {
    return { success: false, error: '无法读取 setting.json' };
  }

  const currentFamily = settings.providerFamilyDomain;
  if (currentFamily === targetFamily) {
    return { success: true, message: '已经是当前 family' };
  }

  autoBackup();
  settings.providerFamilyDomain = targetFamily;
  settings.providerFamilyDomainUpdatedAt = Date.now();
  writeJson(SETTING_PATH, settings);

  // Auto-restart ZCode so the switch takes effect immediately
  restartZCode();

  return { success: true, message: `已切换到 ${targetFamily === 'zai' ? 'Z.ai' : 'BigModel'}，ZCode 正在自动重启…` };
});

// 3. Get billing info
ipcMain.handle('get-billing', async () => {
  const config = readJson(CONFIG_PATH);
  if (!config?.provider) {
    return { success: false, error: '无法读取 config.json' };
  }

  // Try to find a start-plan provider with a valid JWT token
  const providers = ['builtin:zai-start-plan', 'builtin:bigmodel-start-plan'];
  let jwtToken = null;
  let activeProviderId = null;

  for (const pid of providers) {
    const p = config.provider[pid];
    if (p?.options?.apiKey && p.enabled) {
      jwtToken = p.options.apiKey;
      activeProviderId = pid;
      break;
    }
  }

  if (!jwtToken) {
    // Fallback: try any start-plan with apiKey regardless of enabled
    for (const pid of providers) {
      const p = config.provider[pid];
      if (p?.options?.apiKey) {
        jwtToken = p.options.apiKey;
        activeProviderId = pid;
        break;
      }
    }
  }

  if (!jwtToken) {
    return { success: false, error: '没有找到有效的 JWT token，请先登录' };
  }

  const headers = {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const [currentRes, balanceRes] = await Promise.all([
      httpsGet(`https://${ZCODE_HOST}/api/v1/zcode-plan/billing/current?app_version=3.1.2`, headers),
      httpsGet(`https://${ZCODE_HOST}/api/v1/zcode-plan/billing/balance?app_version=3.1.2`, headers),
    ]);

    return {
      success: true,
      provider: activeProviderId,
      current: currentRes.status === 200 ? currentRes.data : null,
      balance: balanceRes.status === 200 ? balanceRes.data : null,
      currentStatus: currentRes.status,
      balanceStatus: balanceRes.status,
    };
  } catch (e) {
    return { success: false, error: `API 请求失败: ${e.message}` };
  }
});

// ── Account auto-recording system ─────────────────────────────
// Accounts are keyed by a stable identity derived from the JWT user_id.
// Each account's encrypted credentials are stored separately; an index
// file (accounts.json) holds the metadata.

const ACCOUNTS_INDEX = path.join(SNAPSHOTS_DIR, 'accounts.json');
const ACCOUNTS_CRED_DIR = path.join(SNAPSHOTS_DIR, 'credentials');

function readAccountsIndex() {
  ensureDir(SNAPSHOTS_DIR);
  ensureDir(ACCOUNTS_CRED_DIR);
  const data = readJson(ACCOUNTS_INDEX);
  if (!data || !Array.isArray(data.accounts)) {
    return { accounts: [] };
  }
  // Merge legacy duplicates: old code created both "jwt:<uid>" and "uid:<uid>"
  // entries for the same user. Normalize ids, then collapse duplicates (keep
  // the richest entry: prefer one with email/name/avatar, preserve createdAt).
  const merged = {};
  for (const a of data.accounts) {
    const normId = normalizeAccountId(a.id);
    a.id = normId;
    if (a.userId) a.userId = normalizeAccountId(a.userId);
    const existing = merged[normId];
    if (!existing) {
      merged[normId] = a;
    } else {
      // Merge fields — prefer non-empty values from either entry
      const pick = (key) => a[key] || existing[key];
      merged[normId] = {
        ...existing,
        ...a,
        id: normId,
        label: (a.email || existing.email) ? (existing.email ? existing.label : a.label) : pick('label'),
        email: pick('email'),
        name: pick('name'),
        avatar: pick('avatar'),
        userId: pick('userId') || normId,
        family: pick('family'),
        source: pick('source'),
        // Keep earliest creation, latest activity
        createdAt: earliest(existing.createdAt, a.createdAt),
        updatedAt: latest(existing.updatedAt, a.updatedAt),
        lastSeen: latest(existing.lastSeen, a.lastSeen),
      };
      // Rename merged credential file to match normalized id
      const credDir = ACCOUNTS_CRED_DIR;
      const safeId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
      // Move legacy credential files (jwt:_... / uid:_...) onto normalized name
      for (const oldPrefix of ['jwt:_', 'uid:_']) {
        const legacyFile = path.join(credDir, oldPrefix + safeId(normId) + '.json');
        const normFile = path.join(credDir, safeId(normId) + '.json');
        if (normId.startsWith('tok:') || oldPrefix === 'jwt:_' && normId.startsWith('tok:')) continue;
        if (fs.existsSync(legacyFile) && !fs.existsSync(normFile)) {
          try { fs.copyFileSync(legacyFile, normFile); } catch (e) { /* ignore */ }
        } else if (fs.existsSync(legacyFile)) {
          try { fs.copyFileSync(legacyFile, normFile); } catch (e) { /* ignore */ }
        }
      }
    }
  }
  data.accounts = Object.values(merged);
  return data;
}

function earliest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) < new Date(b) ? a : b;
}

function latest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

function writeAccountsIndex(index) {
  ensureDir(SNAPSHOTS_DIR);
  writeJson(ACCOUNTS_INDEX, index);
}

// Derive account identity + profile from current state.
// Priority: credentials user_info (has email/name) > config JWT (user_id) > token hash.
// ID format is normalized to bare user_id (e.g. "7654cf51-...") so that the
// same user identified via different sources never produces duplicate entries.
function identifyAccount(credentials) {
  // 1. credentials.json carries encrypted user_info with user_id/email/name
  if (credentials) {
    const info = extractUserInfo(credentials);
    if (info.userId) {
      return {
        id: info.userId,
        userId: info.userId,
        email: info.email,
        name: info.name,
        avatar: info.avatar,
        source: info.email ? 'userinfo' : 'jwt',
      };
    }
  }
  // 2. Fallback: config.json start-plan JWT (unencrypted, has user_id)
  const config = readJson(CONFIG_PATH);
  if (config?.provider) {
    for (const pid of ['builtin:zai-start-plan', 'builtin:bigmodel-start-plan']) {
      const jwt = config.provider[pid]?.options?.apiKey;
      if (jwt && jwt.split('.').length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
          if (payload.user_id) {
            return { id: payload.user_id, userId: payload.user_id, email: null, name: null, avatar: null, source: 'jwt' };
          }
        } catch (e) { /* malformed */ }
      }
    }
  }
  // 3. Last resort: hash of encrypted access_token
  if (credentials) {
    const token = credentials['oauth:zai:access_token'] || credentials['oauth:bigmodel:access_token'];
    if (token) {
      const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
      return { id: 'tok:' + hash, userId: null, email: null, name: null, avatar: null, source: 'token' };
    }
  }
  return { id: null, userId: null, email: null, name: null, avatar: null, source: 'none' };
}

// Normalize a stored account id: legacy entries used prefixes "uid:" / "jwt:"
// that both pointed at the same user_id. Strip those so lookups are stable.
function normalizeAccountId(rawId) {
  if (!rawId) return rawId;
  if (rawId.startsWith('uid:') || rawId.startsWith('jwt:')) {
    return rawId.slice(4);
  }
  return rawId;
}

// Extract a usable JWT for billing calls from a credentials blob.
// Tries decrypted zcodejwttoken first, then falls back to config.json.
function getJwtFromCredentials(credentials) {
  if (credentials) {
    const jwt = decryptField(credentials, 'zcodejwttoken');
    if (jwt && jwt.split('.').length === 3) return jwt;
  }
  const config = readJson(CONFIG_PATH);
  if (config?.provider) {
    for (const pid of ['builtin:zai-start-plan', 'builtin:bigmodel-start-plan']) {
      const jwt = config.provider[pid]?.options?.apiKey;
      if (jwt && jwt.split('.').length === 3) return jwt;
    }
  }
  return null;
}

// 4. Sync (auto-record) the current account.
// Called on app start and on refresh. Creates or updates the account entry.
ipcMain.handle('sync-current-account', async () => {
  const credentials = readJson(CREDENTIALS_PATH);
  if (!credentials) {
    return { success: false, error: '当前没有凭证（未登录任何账号）' };
  }

  const ident = identifyAccount(credentials);
  if (!ident.id) {
    return { success: false, error: '无法识别当前账号身份' };
  }

  const settings = readJson(SETTING_PATH);
  const family = settings?.providerFamilyDomain || 'unknown';

  const index = readAccountsIndex();
  let account = index.accounts.find(a => a.id === ident.id);
  const now = new Date().toISOString();

  // Always write the latest credentials blob for this account
  const credFile = path.join(ACCOUNTS_CRED_DIR, `${ident.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  const prevCredRaw = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : '';
  const newCredRaw = JSON.stringify(credentials, null, 2);
  const credChanged = prevCredRaw.trim() !== newCredRaw.trim();
  writeJson(credFile, credentials);

  if (account) {
    // Update existing entry with fresh profile data
    account.family = family;
    account.lastSeen = now;
    account.source = ident.source;
    if (ident.userId) account.userId = ident.userId;
    if (ident.email) account.email = ident.email;
    if (ident.name) account.name = ident.name;
    if (ident.avatar) account.avatar = ident.avatar;
    if (credChanged) account.updatedAt = now;
  } else {
    // New account — use the real name or email if available
    const defaultLabel = ident.name || (ident.email ? ident.email.split('@')[0] : `账号 ${index.accounts.length + 1}`);
    account = {
      id: ident.id,
      label: defaultLabel,
      family,
      source: ident.source,
      userId: ident.userId,
      email: ident.email,
      name: ident.name,
      avatar: ident.avatar,
      createdAt: now,
      updatedAt: now,
      lastSeen: now,
    };
    index.accounts.push(account);
  }

  writeAccountsIndex(index);
  return { success: true, account, isNew: !account };
});

// 5. List all recorded accounts, marking the active one
ipcMain.handle('list-accounts', async () => {
  const index = readAccountsIndex();
  const credentials = readJson(CREDENTIALS_PATH);
  const { id: currentId } = identifyAccount(credentials);
  return {
    accounts: index.accounts.map(a => ({ ...a, isActive: a.id === currentId })),
    currentId,
  };
});

// 6. Switch to a recorded account (restore its credentials + family)
ipcMain.handle('switch-account', async (event, accountId) => {
  const index = readAccountsIndex();
  const account = index.accounts.find(a => a.id === accountId);
  if (!account) {
    return { success: false, error: '账号不存在' };
  }

  const credFile = path.join(ACCOUNTS_CRED_DIR, `${accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  if (!fs.existsSync(credFile)) {
    return { success: false, error: '账号凭证文件缺失' };
  }

  autoBackup();

  const credentials = readJson(credFile);
  if (!credentials) {
    return { success: false, error: '账号凭证文件损坏' };
  }
  writeJson(CREDENTIALS_PATH, credentials);

  // Restore the family this account belonged to
  if (account.family && account.family !== 'unknown') {
    const settings = readJson(SETTING_PATH);
    if (settings) {
      settings.providerFamilyDomain = account.family;
      settings.providerFamilyDomainUpdatedAt = Date.now();
      writeJson(SETTING_PATH, settings);
    }
  }

  // Auto-restart ZCode so the switch takes effect immediately
  restartZCode();

  return { success: true, message: `已切换到「${account.label}」，ZCode 正在自动重启…` };
});

// 7. Rename an account
ipcMain.handle('rename-account', async (event, accountId, newLabel) => {
  if (!newLabel || !newLabel.trim()) {
    return { success: false, error: '标签不能为空' };
  }
  const index = readAccountsIndex();
  const account = index.accounts.find(a => a.id === accountId);
  if (!account) {
    return { success: false, error: '账号不存在' };
  }
  account.label = newLabel.trim();
  writeAccountsIndex(index);
  return { success: true, message: '已重命名' };
});

// 8. Delete a recorded account
ipcMain.handle('delete-account', async (event, accountId) => {
  const index = readAccountsIndex();
  const before = index.accounts.length;
  index.accounts = index.accounts.filter(a => a.id !== accountId);
  if (index.accounts.length === before) {
    return { success: false, error: '账号不存在' };
  }
  writeAccountsIndex(index);
  // Remove credential file
  const credFile = path.join(ACCOUNTS_CRED_DIR, `${accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  try { fs.unlinkSync(credFile); } catch (e) { /* ignore */ }
  return { success: true, message: '账号已删除' };
});

// 9. Get quota/billing for ALL recorded accounts.
// Each account's credentials blob is decrypted to recover its JWT, which is
// then used to call the billing API. Accounts without a usable JWT are skipped.
// Sleep helper for rate-limit spacing
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fetch one account's plan + balances. Retries once on HTTP 429 after backoff.
async function fetchQuotaForAccount(jwt) {
  const headers = {
    'Authorization': `Bearer ${jwt}`,
    'Content-Type': 'application/json',
  };
  const url1 = `https://${ZCODE_HOST}/api/v1/zcode-plan/billing/current?app_version=3.1.2`;
  const url2 = `https://${ZCODE_HOST}/api/v1/zcode-plan/billing/balance?app_version=3.1.2`;

  let currentRes, balanceRes;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Serialize the two calls to avoid bursting requests
    currentRes = await httpsGet(url1, headers);
    await sleep(400);
    balanceRes = await httpsGet(url2, headers);
    // If either hit the rate limiter, back off and retry once
    if (currentRes.status !== 429 && balanceRes.status !== 429) break;
    await sleep(2000);
  }
  return { currentRes, balanceRes };
}

// 9. Get quota/billing for ALL recorded accounts.
// Each account's credentials blob is decrypted to recover its JWT, which is
// then used to call the billing API. Accounts are queried serially with a
// delay between them to avoid tripping the server's rate limiter (HTTP 429).
ipcMain.handle('get-all-quotas', async () => {
  const index = readAccountsIndex();
  const results = [];

  for (let i = 0; i < index.accounts.length; i++) {
    const account = index.accounts[i];
    const entry = {
      id: account.id,
      label: account.label,
      email: account.email,
      name: account.name,
      family: account.family,
      success: false,
      plan: null,
      balances: [],
      error: null,
    };

    const credFile = path.join(ACCOUNTS_CRED_DIR, `${account.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    if (!fs.existsSync(credFile)) {
      entry.error = '凭证文件缺失';
      results.push(entry);
      continue;
    }

    const credentials = readJson(credFile);
    const jwt = getJwtFromCredentials(credentials);
    if (!jwt) {
      entry.error = '无有效 JWT';
      results.push(entry);
      continue;
    }

    try {
      const { currentRes, balanceRes } = await fetchQuotaForAccount(jwt);

      if (currentRes.status === 200) {
        const plans = currentRes.data?.data?.plans || currentRes.data?.plans || [];
        if (plans.length > 0) {
          const p = plans[0];
          entry.plan = {
            name: p.name,
            status: p.status,
            startsAt: p.starts_at,
            endsAt: p.ends_at,
          };
        }
      }
      if (balanceRes.status === 200) {
        entry.balances = (balanceRes.data?.data?.balances || balanceRes.data?.balances || []).map(b => ({
          model: b.show_name,
          total: b.total_units,
          used: b.used_units,
          remaining: b.remaining_units,
          periodEnd: b.period_end,
        }));
      }
      entry.success = !!(entry.plan || entry.balances.length > 0);
      if (!entry.success) {
        entry.error = (currentRes.status === 429 || balanceRes.status === 429)
          ? '请求过于频繁（429），稍后重试'
          : `HTTP ${currentRes.status}/${balanceRes.status}`;
      }
    } catch (e) {
      entry.error = e.message;
    }
    results.push(entry);

    // Space out requests between accounts (skip after the last one)
    if (i < index.accounts.length - 1) {
      await sleep(600);
    }
  }

  return { success: true, accounts: results };
});

// 10. Refresh handler — kept for API symmetry (renderer re-syncs + re-lists).
ipcMain.handle('refresh-accounts', async () => {
  return { success: true };
});

// ── Electron window ────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 700,
    resizable: true,
    minWidth: 560,
    minHeight: 500,
    title: 'ZCode 账号管理器',
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Build a minimal menu (no default menu clutter)
  const menuTemplate = [
    {
      label: '文件',
      submenu: [
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
