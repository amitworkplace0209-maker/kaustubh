'use client';

import { createContext, useContext } from 'react';

/**
 * OrdersModuleContext — tells sub-pages (Trade / Basket Orders / Suggestion /
 * History) that they are rendered INSIDE the single Orders module instead of
 * as standalone routes. While embedded, the sub-pages suppress their own
 * URL-driven OrdersTabs bar because the module renders the tabs once at the
 * top; standalone routes keep the URL-driven bar (unchanged behaviour).
 */
const OrdersModuleContext = createContext(false);

export function OrdersModuleProvider({ children }: { children: React.ReactNode }) {
  return (
    <OrdersModuleContext.Provider value={true}>{children}</OrdersModuleContext.Provider>
  );
}

export function useOrdersModuleEmbedded(): boolean {
  return useContext(OrdersModuleContext);
}