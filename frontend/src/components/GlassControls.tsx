'use client';

import type { CSSProperties, HTMLAttributes } from 'react';
import Link from 'next/link';
import { TabBar, type TabBarItem } from 'glisse';

/**
 * Glisse's tab bar for exclusive choices (an item with `href` navigates through Next's Link). Every tab has the same
 * width (`tabWidth` px, else Glisse's 84); the colours come from the `--lg-*` tokens mapped in base.css.
 */
export function GlassTabs({
  items,
  value,
  label,
  tabWidth,
  onValueChange,
  className,
  ...rest
}: {
  items: TabBarItem[];
  value: string | null;
  label: string;
  tabWidth?: number;
  onValueChange?: (value: string) => void;
} & Pick<HTMLAttributes<HTMLDivElement>, 'className' | 'onClickCapture'>) {
  const style = tabWidth === undefined ? undefined : ({ '--lg-tab-width': `${tabWidth}px` } as CSSProperties);
  return <TabBar aria-label={label} items={items} value={value} onValueChange={onValueChange} link={Link} className={className} style={style} {...rest} />;
}
