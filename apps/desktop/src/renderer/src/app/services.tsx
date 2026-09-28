/**
 * React access to the window services (`window-services.ts`): the provider, `useServices` and
 * `useFocusTarget`, plus the DOM fallback of `focusField` (the Bloqueo section root, then the
 * first section).
 */
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { FocusTargetName, WindowServices } from './window-services';

export { createWindowServices, type FocusTargetName, type WindowServices } from './window-services';

/** `focusField` fallback: a block hides the field, so the section root takes the focus. */
export function focusSectionRoot(): void {
  const root =
    document.querySelector<HTMLElement>('[data-section="bloqueo"]') ??
    document.querySelector<HTMLElement>('[data-section]');
  root?.focus({ preventScroll: true });
}

const ServicesContext = createContext<WindowServices | null>(null);

export function ServicesProvider(props: {
  services: WindowServices;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <ServicesContext.Provider value={props.services}>{props.children}</ServicesContext.Provider>
  );
}

export function useServices(): WindowServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices outside <ServicesProvider>');
  return services;
}

/**
 * Register a focus target while mounted. `focus` may change every render; the latest one is
 * called. Return `false` from it to decline (hidden, disabled).
 */
export function useFocusTarget(name: FocusTargetName, focus: () => boolean): void {
  const services = useServices();
  const latest = useRef(focus);
  useLayoutEffect(() => {
    latest.current = focus;
  });
  useLayoutEffect(() => services.registerFocus(name, () => latest.current()), [services, name]);
}
