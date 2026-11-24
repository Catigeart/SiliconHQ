import type { Attributes, ComponentType, JSX, ReactElement, ReactNode } from 'react';

type DataAttributes = { [key: `data-${string}`]: string | number | boolean };
type ElementProps<P> = Attributes & Omit<P, 'children'> & { children?: ReactNode };

// This client uses createElement directly. Infer the DOM event target from each tag,
// and allow function components to receive children as trailing arguments.
export interface CreateElement {
  <K extends keyof JSX.IntrinsicElements>(
    tag: K,
    props?: (JSX.IntrinsicElements[K] & DataAttributes) | null,
    ...children: ReactNode[]
  ): ReactElement;
  <P>(
    component: ComponentType<P>,
    props?: ElementProps<NoInfer<P>> | null,
    ...children: ReactNode[]
  ): ReactElement;
}
