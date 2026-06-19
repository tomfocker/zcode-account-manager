// ── ZCode Account Manager - Renderer ──────────────────────────
const api = window.zcodeAPI;

// ── Toast notification system ──────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// ── Format helpers ───────────────────────────────────────────
function formatTokens(n) {
  if (n == null) return '-';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (isNaN(num)) return n;
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
  return num.toString();
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return isoStr;
  }
}

function formatDateShort(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return isoStr;
  }
}

// ── 1. Provider State ───────────────────────────────────────
async function loadProviderState() {
  try {
    const state = await api.getProviderState();
    renderProviderCards(state);
  } catch (e) {
    console.error('Failed to load provider state:', e);
    document.getElementById('provider-cards').innerHTML =
      '<div class="billing-error">加载 Provider 状态失败</div>';
  }
}

function renderProviderCards(state) {
  const container = document.getElementById('provider-cards');
  const hintEl = document.getElementById('switch-hint');

  const families = [
    {
      id: 'zai',
      name: 'Z.ai',
      loggedIn: state.zaiLoggedIn,
      planStatus: state.planStatus,
    },
    {
      id: 'bigmodel',
      name: 'BigModel',
      loggedIn: state.bigmodelLoggedIn,
      planStatus: state.planStatus,
    },
  ];

  container.innerHTML = families.map(f => {
    const isActive = state.currentFamily === f.id;
    const loginText = f.loggedIn ? '已登录' : '未登录';
    const loginDot = f.loggedIn ? 'green' : 'red';

    // Find plan status for this family's start-plan
    const planId = `builtin:${f.id}-start-plan`;
    const planInfo = f.planStatus?.[planId];
    const planText = planInfo?.status === 'available' ? 'Start Plan ✓' : (planInfo?.status || '-');
    const planDot = planInfo?.status === 'available' ? 'green' : 'gray';

    return `
      <div class="provider-card ${isActive ? 'active' : ''}" data-family="${f.id}">
        <div class="card-header">
          <span class="card-name">${f.name}</span>
          ${isActive
            ? '<span class="card-badge badge-active">当前使用</span>'
            : '<span class="card-badge badge-inactive">未激活</span>'}
        </div>
        <div class="card-status">
          <div class="status-row">
            <span class="status-dot ${loginDot}"></span>
            <span>${loginText}</span>
          </div>
          <div class="status-row">
            <span class="status-dot ${planDot}"></span>
            <span>Coding Plan: ${planText}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Hint
  if (state.currentFamily === 'zai') {
    hintEl.textContent = '当前使用 Z.ai 家族。点击 BigModel 卡片可切换。';
  } else {
    hintEl.textContent = '当前使用 BigModel 家族。点击 Z.ai 卡片可切换。';
  }

  // Bind click
  container.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', async () => {
      const family = card.dataset.family;
      if (family === state.currentFamily) {
        showToast('已经是当前 family，无需切换', 'info');
        return;
      }
      // Confirm
      const familyName = family === 'zai' ? 'Z.ai' : 'BigModel';
      if (!confirm(`确认切换到 ${familyName}？\n\n切换后 ZCode 会自动重启。`)) return;

      card.style.opacity = '0.5';
      card.style.pointerEvents = 'none';
      try {
        const result = await api.switchFamily(family);
        showToast(result.message, result.success ? 'success' : 'error');
        await loadProviderState();
      } catch (e) {
        showToast('切换失败: ' + e.message, 'error');
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 3. Account auto-recording ────────────────────────────────
// On every refresh we sync the currently-logged-in account (creating
// or updating its entry), then list all known accounts WITH their quotas.

// Cache the latest quota results so re-renders (e.g. after rename) don't
// re-query the API. Refreshed by loadAccounts.
let quotaCache = null;

async function loadAccounts() {
  const container = document.getElementById('account-list');
  container.innerHTML = '<div class="loading"><span class="spinner"></span>同步账号中…</div>';

  try {
    // 1. Sync current account first (auto-record if new)
    const sync = await api.syncCurrentAccount();
    if (!sync.success) {
      // Not logged in or can't identify — still show the list
      const data = await api.listAccounts();
      if (data.accounts && data.accounts.length > 0) {
        // Try to fetch quotas even if current account can't sync
        quotaCache = await safeFetchQuotas();
        renderAccounts(data, quotaCache);
      } else {
        container.innerHTML = `<div class="account-empty">${escapeHtml(sync.error)}<br><br>登录 ZCode 后打开本工具即可自动记录。</div>`;
      }
      return;
    }

    // 2. Fetch accounts + their quotas in parallel
    const [data, quotas] = await Promise.all([
      api.listAccounts(),
      safeFetchQuotas(),
    ]);
    quotaCache = quotas;
    renderAccounts(data, quotas);
  } catch (e) {
    container.innerHTML = `<div class="billing-error">加载账号失败: ${escapeHtml(e.message)}</div>`;
  }
}

// Fetch quotas for all accounts; never throws (returns null on failure).
async function safeFetchQuotas() {
  try {
    return await api.getAllQuotas();
  } catch (e) {
    console.warn('getAllQuotas failed:', e);
    return null;
  }
}

function renderAccounts(data, quotas) {
  const container = document.getElementById('account-list');
  const accounts = data.accounts || [];

  if (accounts.length === 0) {
    container.innerHTML = '<div class="account-empty">暂无记录的账号。<br>登录 ZCode 后打开本工具即可自动记录。</div>';
    return;
  }

  // Build a quota lookup keyed by account id
  const quotaMap = {};
  if (quotas && Array.isArray(quotas.accounts)) {
    quotas.accounts.forEach(q => { quotaMap[q.id] = q; });
  }

  // Sort: active first, then by lastSeen desc
  accounts.sort((a, b) => {
    if (a.isActive && !b.isActive) return -1;
    if (!a.isActive && b.isActive) return 1;
    return new Date(b.lastSeen || b.createdAt) - new Date(a.lastSeen || a.createdAt);
  });

  container.innerHTML = accounts.map(a => {
    const familyLabel = a.family === 'zai' ? 'Z.ai' : a.family === 'bigmodel' ? 'BigModel' : (a.family || '-');
    const displayName = a.name || a.label;
    const emailOrId = a.email || (a.userId ? 'ID: ' + a.userId.slice(0, 8) : '未知身份');

    // Quota rows for this account
    const q = quotaMap[a.id];
    const quotaHtml = renderAccountQuota(q);

    return `
      <div class="account-card ${a.isActive ? 'active' : ''}" data-id="${escapeHtml(a.id)}">
        <div class="account-card-head">
          <div class="account-avatar">👤</div>
          <div class="account-id">
            <span class="account-label">
              ${escapeHtml(displayName)}
              ${a.isActive ? '<span class="account-badge-active">当前</span>' : ''}
            </span>
            <span class="account-email">${escapeHtml(emailOrId)}</span>
          </div>
          <div class="account-actions">
            ${a.isActive ? '' : `<button class="btn-sm btn-switch-account btn-switch" data-id="${escapeHtml(a.id)}">切换</button>`}
            <button class="btn-sm btn-rename" data-id="${escapeHtml(a.id)}" title="重命名">✏️</button>
            <button class="btn-danger btn-delete-account" data-id="${escapeHtml(a.id)}" title="删除">🗑</button>
          </div>
        </div>
        <div class="account-card-meta">
          <span>${familyLabel}</span>
          <span>·</span>
          <span>最近活跃 ${formatDate(a.lastSeen || a.createdAt)}</span>
          ${q && q.success && q.plan ? `<span>·</span><span class="account-plan">${escapeHtml(q.plan.name)}</span>` : ''}
        </div>
        ${quotaHtml}
      </div>
    `;
  }).join('');

  // Bind switch buttons
  container.querySelectorAll('.btn-switch').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('切换到此账号将替换当前凭证。\n\n当前凭证会自动备份，ZCode 将自动重启完成切换。确认？')) return;
      btn.disabled = true;
      btn.textContent = '切换中…';
      try {
        const result = await api.switchAccount(id);
        showToast(result.message, result.success ? 'success' : 'error');
        if (result.success) {
          await loadProviderState();
          await loadAccounts();
        }
      } catch (e) {
        showToast('切换失败: ' + e.message, 'error');
      }
    });
  });

  // Bind rename buttons
  container.querySelectorAll('.btn-rename').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const item = container.querySelector(`.account-card[data-id="${cssEscape(id)}"]`);
      const currentLabel = item?.querySelector('.account-label')?.textContent?.trim() || '';
      const newLabel = prompt('输入新的账号名称：', currentLabel);
      if (newLabel === null) return; // cancelled
      if (!newLabel.trim()) {
        showToast('名称不能为空', 'error');
        return;
      }
      try {
        const result = await api.renameAccount(id, newLabel);
        showToast(result.message, result.success ? 'success' : 'error');
        if (result.success) {
          // Re-render using cached quotas (rename doesn't change quotas)
          const data = await api.listAccounts();
          renderAccounts(data, quotaCache);
        }
      } catch (e) {
        showToast('重命名失败: ' + e.message, 'error');
      }
    });
  });

  // Bind delete buttons
  container.querySelectorAll('.btn-delete-account').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('确认删除此账号记录？此操作不可撤销。')) return;
      btn.disabled = true;
      try {
        const result = await api.deleteAccount(id);
        showToast(result.message, result.success ? 'success' : 'error');
        if (result.success) {
          const data = await api.listAccounts();
          renderAccounts(data, quotaCache);
        }
      } catch (e) {
        showToast('删除失败: ' + e.message, 'error');
      }
    });
  });
}

// Render the per-account quota bars (compact version).
function renderAccountQuota(q) {
  if (!q) {
    return '<div class="account-quota-loading">额度加载中…</div>';
  }
  if (!q.success) {
    return `<div class="account-quota-error">${escapeHtml(q.error || '无法查询额度')}</div>`;
  }
  if (!q.balances || q.balances.length === 0) {
    return '<div class="account-quota-empty">暂无额度数据</div>';
  }

  // Find period_end for reset countdown (take the earliest across all balances)
  let resetTimerHtml = '';
  const periodEnds = q.balances.map(b => b.periodEnd).filter(Boolean);
  if (periodEnds.length > 0) {
    const minPe = Math.min(...periodEnds);
    const peDate = new Date(minPe * 1000);
    const now = Date.now();
    const diffMs = peDate - now;
    if (diffMs > 0) {
      const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (diffHours < 24) {
        resetTimerHtml = `<div class="quota-reset-timer">🔄 ${diffHours} 小时后重置</div>`;
      } else {
        resetTimerHtml = `<div class="quota-reset-timer">🔄 剩余 ${diffDays} 天重置</div>`;
      }
    } else {
      resetTimerHtml = '<div class="quota-reset-timer">🔄 重置中…</div>';
    }
  }

  const rows = q.balances.map(b => {
    const total = b.total || 0;
    const used = b.used || 0;
    const remaining = Math.max(0, total - used);
    const pct = total > 0 ? Math.min((remaining / total) * 100, 100) : 0;
    let barClass = 'critical';
    if (pct > 50) barClass = 'healthy';
    else if (pct > 20) barClass = 'warning';
    return `
      <div class="quota-row">
        <span class="quota-model">${escapeHtml(b.model || 'Unknown')}</span>
        <div class="progress-track quota-track">
          <div class="progress-bar ${barClass}" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <span class="quota-values">剩余 ${formatTokens(remaining)} / ${formatTokens(total)}</span>
      </div>
    `;
  });
  return `<div class="account-quota">${resetTimerHtml}${rows.join('')}</div>`;
}

// Minimal CSS.escape polyfill for attribute selectors with special chars
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// ── Refresh all ───────────────────────────────────────────────
async function refreshAll() {
  await loadProviderState();
  await loadAccounts();
}

// ── Event Bindings ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Initial load
  refreshAll();

  // Refresh button
  document.getElementById('btn-refresh-all').addEventListener('click', refreshAll);
});
