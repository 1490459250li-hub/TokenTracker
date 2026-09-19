import React, { createContext, useContext } from "react";

/**
 * Local-only fork: cloud account view removed. The provider keeps the same
 * React contract (children render unchanged) but always resolves to local
 * per-device data — no InsForge auth, no cloud reads.
 */
const AccountViewContext = createContext(null);

export const CLOUD_SYNC_CHANGE_EVENT = "tt.cloudSyncChanged";

export function AccountViewProvider({ children }) {
  return (
    <AccountViewContext.Provider
      value={{ accountView: false, revision: 0, localHost: true, resolving: false }}
    >
      {children}
    </AccountViewContext.Provider>
  );
}

export function useAccountView() {
  const ctx = useContext(AccountViewContext);
  if (ctx) return ctx;
  return { accountView: false, revision: 0, localHost: true, resolving: false };
}
