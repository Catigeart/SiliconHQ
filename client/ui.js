import React from 'react';
import {
  Button,
  IconChevronDownOutlineRegular,
  Menu,
  MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** @type {import("./elements.js").CreateElement} */
export const h = React.createElement;

/** @type {import("react").CSSProperties} */
export const panelStyle = {
  display: 'grid',
  gap: 8,
  padding: '12px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
};

/** @type {import("react").CSSProperties} */
export const preStyle = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  maxHeight: '20rem',
  overflow: 'auto',
  userSelect: 'text',
};

/** @param {React.ComponentProps<typeof Button>} props */
export function button(text, onClick, disabled = false, props = {}) {
  return h(
    Button,
    { type: 'button', variant: 'ghost', size: 'sm', onClick, disabled, ...props },
    text,
  );
}

/** @param {HTMLDivElement | null} bar */
function keepEditorFocusVisible(bar) {
  const editor = bar?.closest('[data-sihq-editor]');
  if (!(editor instanceof HTMLElement)) return;
  const onFocus = (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement) || bar.contains(field)) return;
    // Chromium can finish native Tab scrolling with the focused field under the sticky bar.
    queueMicrotask(() => {
      if (document.activeElement !== field || !bar.isConnected) return;
      const rect = field.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (bar.contains(hit)) {
        field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      }
    });
  };
  editor.addEventListener('focusin', onFocus);
  return () => editor.removeEventListener('focusin', onFocus);
}

/** @param {React.HTMLAttributes<HTMLDivElement> & { sticky?: boolean }} props */
export function Actions({ children, sticky, style, ...props }) {
  return h(
    'div',
    {
      ...props,
      ref: sticky ? keepEditorFocusVisible : undefined,
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        ...(sticky && {
          position: 'sticky',
          top: 0,
          zIndex: 1,
          paddingBlock: 6,
          background: 'var(--dsw-alias-bg-base, Canvas)',
        }),
        ...style,
      },
    },
    children,
  );
}

/**
 * @param {{ label?: string, disabled?: boolean, items: {
 *   label: string, onClick: () => void, disabled?: boolean, danger?: boolean
 * }[] }} props
 */
export function ActionMenu({ label = '更多操作', disabled = false, items }) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const close = () => setOpen(false);
  const caption = h(React.Fragment, null, label, h(IconChevronDownOutlineRegular, { size: 12 }));
  const anchor = button(caption, () => setOpen((value) => !value), disabled, {
    'aria-haspopup': 'menu',
    'aria-expanded': open && !disabled,
    onKeyDown(event) {
      if (!open && event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
    },
  });
  return h(
    Menu,
    {
      open: open && !disabled,
      anchor,
      onClose: close,
      align: 'end',
      portal: true,
      autoFocus: true,
    },
    items.map((item) =>
      h(
        MenuItemButton,
        {
          key: item.label,
          disabled: item.disabled,
          danger: item.danger,
          onSelect() {
            close();
            item.onClick();
          },
        },
        item.label,
      ),
    ),
  );
}

// Closed HTML details keep their children mounted. Defer effects such as CLI catalog lookups.
export function Expandable({ summary, children, ...props }) {
  const [open, setOpen] = React.useState(false);
  return h(
    'details',
    {
      ...props,
      onToggle: (event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      },
    },
    h('summary', null, summary),
    open && children,
  );
}

export function DraftConflicts({ conflicts, resolve, disabled }) {
  const readable = (value) => (value === undefined ? '已删除' : JSON.stringify(value, null, 2));
  return h(
    'fieldset',
    { disabled, style: panelStyle },
    h('legend', null, '同一项已在其他页面修改'),
    h('p', null, '草稿已保留。核对重叠修改并选择使用的值，随后可以继续编辑或保存。'),
    conflicts.map((item) =>
      h(
        'details',
        { key: item.path },
        h('summary', null, item.path),
        h('strong', null, '我的草稿'),
        h('pre', null, readable(item.mine)),
        h('strong', null, '当前已保存'),
        h('pre', null, readable(item.current)),
      ),
    ),
    h(
      Actions,
      null,
      button('冲突处采用我的草稿', () => resolve('mine')),
      button('冲突处采用已保存值', () => resolve('current')),
    ),
  );
}
