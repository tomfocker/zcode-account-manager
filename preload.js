const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zcodeAPI', {
  // Provider state
  getProviderState: () => ipcRenderer.invoke('get-provider-state'),
  switchFamily: (targetFamily) => ipcRenderer.invoke('switch-family', targetFamily),

  // Billing / quota
  getBilling: () => ipcRenderer.invoke('get-billing'),

  // Account auto-recording
  syncCurrentAccount: () => ipcRenderer.invoke('sync-current-account'),
  listAccounts: () => ipcRenderer.invoke('list-accounts'),
  switchAccount: (accountId) => ipcRenderer.invoke('switch-account', accountId),
  renameAccount: (accountId, newLabel) => ipcRenderer.invoke('rename-account', accountId, newLabel),
  deleteAccount: (accountId) => ipcRenderer.invoke('delete-account', accountId),

  // Quota for all recorded accounts
  getAllQuotas: () => ipcRenderer.invoke('get-all-quotas'),
});
